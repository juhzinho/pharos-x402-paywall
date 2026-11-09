import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, createPermit2ApprovalTx, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, createWalletClient, decodeEventLog, getAddress, http, parseAbi } from "viem";
import { ASSETS, ATLANTIC_RPC, EXPLORER, NETWORK, USDC, atlantic } from "./config.js";

// The paying client, step by step — the whole x402 exchange made visible:
//   1. GET without payment            → 402 + PAYMENT-REQUIRED (what, how much, to whom, on which network)
//   2. sign the payment: a Permit2 witness transfer (TEST USDC; after a one-time approve of Permit2)
//      or an EIP-3009 authorization (USDC v2; fully gasless for the payer)
//   3. GET with PAYMENT-SIGNATURE     → 200 + PAYMENT-RESPONSE (the settlement, with its transaction hash)
//   4. read that transaction on Atlantic: USDC moved from the payer to payTo, exactly the price
// and the ways a payment must fail: underpaid, to the wrong address, a forged signature, a replay — each another 402.

const ERC20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "function balanceOf(address) view returns (uint256)"]);

export function makeClient(account, { rpc = ATLANTIC_RPC, asset = USDC } = {}) {
  if (typeof asset === "string") asset = ASSETS[asset];
  const chain = createPublicClient({ chain: atlantic, transport: http(rpc, { timeout: 30_000, retryCount: 3 }) });
  const core = new x402Client();
  core.register(NETWORK, new ExactEvmScheme(toClientEvmSigner(account, chain)));
  // only the one token it pays with, and never more than 0.01 per call
  core.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: asset.address, maxAmountPerPayment: "10000" }] });
  const wallet = account.signTransaction ? createWalletClient({ account, chain: atlantic, transport: http(rpc, { timeout: 30_000 }) }) : null;
  return { http: new x402HTTPClient(core), chain, wallet, account, asset };
}

const headersOf = (res) => Object.fromEntries([...res.headers.entries()].filter(([k]) => /^payment-|^content-type$/i.test(k)));

/** Step 1: the unpaid request. */
export async function ask(c, url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 402) return { status: res.status, body, headers: headersOf(res) };
  const required = c.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
  // the option this client pays with (the 402 offers every accepted token)
  const accepts = required.accepts.find((a) => getAddress(a.asset) === c.asset.address) ?? required.accepts[0];
  return { status: 402, headers: headersOf(res), body, required, accepts, offered: required.accepts.length };
}

/**
 * Permit2 payments need the payer to have approved Permit2 on the token once (the only transaction the payer ever
 * sends, and its only gas). Returns null when the allowance already covers `amount`, else the approval's receipt.
 */
export async function ensurePermit2Allowance(c, token, amount) {
  const allowance = await c.chain.readContract(getPermit2AllowanceReadParams({ tokenAddress: token, ownerAddress: c.account.address }));
  if (allowance >= BigInt(amount)) return null;
  if (!c.wallet) throw new Error("this account cannot send the one-time Permit2 approval");
  const hash = await c.wallet.sendTransaction(createPermit2ApprovalTx(token));
  const rc = await c.chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rc.status !== "success") throw new Error(`the Permit2 approval ${hash} reverted`);
  return { hash, explorer: `${EXPLORER}/tx/${hash}`, block: Number(rc.blockNumber) };
}

/** What was signed, the same shape for both methods. */
function summarize(p) {
  const sig = `${p.signature.slice(0, 18)}…`;
  if (p.permit2Authorization) {
    const a = p.permit2Authorization;
    return { method: "permit2", from: a.from, to: a.witness.to, value: String(a.permitted.amount), token: a.permitted.token, spender: a.spender, nonce: String(a.nonce), validBefore: String(a.deadline), signature: sig };
  }
  const a = p.authorization;
  return { method: "eip3009", from: a.from, to: a.to, value: String(a.value), nonce: a.nonce, validBefore: String(a.validBefore), signature: sig };
}

/** Steps 2–4. `tamper` builds a deliberately wrong payment (for the rejection demo). */
export async function pay(c, url, { tamper = null, header = null } = {}) {
  const first = await ask(c, url);
  if (first.status !== 402) return { first, error: `expected 402, got ${first.status}` };
  let required = first.required;
  if (tamper === "underpaid") required = { ...required, accepts: required.accepts.map((a) => ({ ...a, amount: String(BigInt(a.amount) - 1n) })) };
  if (tamper === "wrong-payTo") required = { ...required, accepts: required.accepts.map((a) => ({ ...a, payTo: getAddress("0x000000000000000000000000000000000000dEaD") })) };
  const approval = !header && first.accepts.extra?.assetTransferMethod === "permit2" ? await ensurePermit2Allowance(c, first.accepts.asset, first.accepts.amount) : null;
  let payload = header ? null : await c.http.createPaymentPayload(required);
  if (tamper === "forged") {
    const s = payload.payload.signature;
    payload = { ...payload, payload: { ...payload.payload, signature: `${s.slice(0, 10)}${s[10] === "a" ? "b" : "a"}${s.slice(11)}` } };
  }
  const sigHeaders = header ?? c.http.encodePaymentSignatureHeader(payload);
  const res = await fetch(url, { headers: { accept: "application/json", ...sigHeaders } });
  const body = await res.json().catch(() => ({}));
  const out = { first: { status: 402, accepts: first.accepts, paymentRequired: first.headers["payment-required"] ?? null }, signed: payload ? summarize(payload.payload) : null, approval, header: sigHeaders, second: { status: res.status, body, headers: headersOf(res) } };
  if (res.status === 200) {
    const settle = c.http.getPaymentSettleResponse((n) => res.headers.get(n));
    out.paymentResponse = settle;
    out.onchain = await checkOnChain(c, settle.transaction, { from: c.account.address, to: first.accepts.payTo, value: BigInt(first.accepts.amount) });
  }
  return out;
}

/** Reads the settlement transaction on Atlantic and checks the USDC Transfer matches the payment exactly. */
export async function checkOnChain(c, hash, { from, to, value }) {
  const rc = await c.chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const transfer = rc.logs.filter((l) => getAddress(l.address) === c.asset.address).map((l) => { try { return decodeEventLog({ abi: ERC20, data: l.data, topics: l.topics }).args; } catch { return null; } }).find(Boolean);
  const ok = rc.status === "success" && transfer && getAddress(transfer.from) === getAddress(from) && getAddress(transfer.to) === getAddress(to) && transfer.value === value;
  return { hash, explorer: `${EXPLORER}/tx/${hash}`, block: Number(rc.blockNumber), status: rc.status, gasUsed: rc.gasUsed.toString(), submittedBy: rc.from, transfer: transfer ? { from: transfer.from, to: transfer.to, value: transfer.value.toString() } : null, matches: !!ok };
}

export const usdcBalance = (c, who) => c.chain.readContract({ address: c.asset.address, abi: ERC20, functionName: "balanceOf", args: [who] });

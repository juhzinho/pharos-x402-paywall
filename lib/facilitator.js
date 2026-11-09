import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { NETWORK, atlantic, ATLANTIC_RPC } from "./config.js";

// This API's own x402 facilitator (the code from the Pharos x402 docs, on Atlantic): POST /verify, POST /settle,
// GET /supported. /settle submits the payment (through the x402 Permit2 proxy for TEST USDC, or
// transferWithAuthorization for USDC v2) and pays the gas in PHRS from its own key.
// The key comes from FACILITATOR_PRIVATE_KEY (env) or a .facilitator_key file — never from code or a prompt.
// Without a key it still answers /supported and /verify; /settle then says why it cannot settle.

/** A key from the environment only (locally .env is loaded into it; on Vercel it is a project secret). */
export const loadKey = (envName) => process.env[envName]?.trim() || null;

// It only settles payments to the payTo addresses it serves (PAY_TO_ADDRESS, or FACILITATOR_ALLOWED_PAYTO, comma
// separated): otherwise anyone could use it as a free relayer and spend its PHRS on their own transfers.
const allowedFromEnv = () => (process.env.FACILITATOR_ALLOWED_PAYTO ?? process.env.PAY_TO_ADDRESS ?? "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));

export function createFacilitator({ privateKey = loadKey("FACILITATOR_PRIVATE_KEY"), rpc = ATLANTIC_RPC, chain = atlantic, allowedPayTo = allowedFromEnv() } = {}) {
  const publicClient = createPublicClient({ chain, transport: http(rpc, { timeout: 30_000, retryCount: 3 }) });
  const account = privateKey && /^0x[0-9a-fA-F]{64}$/.test(privateKey) ? privateKeyToAccount(privateKey) : null;
  const wallet = account ? createWalletClient({ account, chain, transport: http(rpc, { timeout: 30_000 }) }) : null;
  const noKey = () => {
    throw new Error("this facilitator has no key configured (FACILITATOR_PRIVATE_KEY), so it cannot submit settlements");
  };
  const signer = toFacilitatorEvmSigner({
    address: account?.address ?? "0x0000000000000000000000000000000000000000",
    getCode: (a) => publicClient.getCode(a),
    readContract: (a) => publicClient.readContract({ ...a, args: a.args || [] }),
    verifyTypedData: (a) => publicClient.verifyTypedData(a),
    writeContract: (a) => (wallet ? wallet.writeContract({ ...a, args: a.args || [] }) : noKey()),
    sendTransaction: (a) => (wallet ? wallet.sendTransaction(a) : noKey()),
    waitForTransactionReceipt: (a) => publicClient.waitForTransactionReceipt({ ...a, timeout: 60_000 }),
  });
  const facilitator = new x402Facilitator();

  // Settlements go one at a time (the signer's transactions never race for the same account nonce), and a payment
  // already being settled, or settled, by this instance is refused at once instead of being sent again to fail on-chain.
  let queue = Promise.resolve();
  const seen = new Set();
  const paymentId = (p) => {
    const a = p?.payload?.permit2Authorization ?? p?.payload?.authorization;
    return a ? `${String(a.from).toLowerCase()}:${String(a.nonce)}` : null;
  };
  async function settleOnce(paymentPayload, paymentRequirements) {
    const id = paymentId(paymentPayload);
    if (id && seen.has(id)) return { success: false, errorReason: "duplicate_settlement", errorMessage: "this payment is already being settled or was settled", transaction: "", network: paymentRequirements.network };
    if (id) {
      seen.add(id);
      if (seen.size > 10_000) seen.delete(seen.values().next().value);
    }
    const run = queue.then(() => facilitator.settle(paymentPayload, paymentRequirements));
    queue = run.catch(() => {});
    const out = await run;
    if (!out.success && id && !/nonce|already|simulation/i.test(`${out.errorReason}`)) seen.delete(id); // a transient failure may be retried
    return out;
  }
  facilitator.register(NETWORK, new ExactEvmScheme(signer));

  const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  async function body(req) {
    if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    let s = "";
    for await (const d of req) {
      s += d;
      if (s.length > 64_000) throw new Error("body too large");
    }
    return s ? JSON.parse(s) : {};
  }

  /** Mounted under …/facilitator: GET /supported, POST /verify, POST /settle (and GET / for its state). */
  async function handle(req, res, sub) {
    const send = (status, b) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" }).end(json(b));
    try {
      if (sub === "/supported" && req.method === "GET") return send(200, facilitator.getSupported());
      if (sub === "" || sub === "/") {
        const gas = account ? await publicClient.getBalance({ address: account.address }).catch(() => null) : null;
        return send(200, { network: NETWORK, signer: account?.address ?? null, canSettle: !!account, gasBalancePHRS: gas == null ? null : formatEther(gas), routes: ["GET /supported", "POST /verify", "POST /settle"], servesPayTo: allowedPayTo.length });
      }
      if (req.method !== "POST" || !["/verify", "/settle"].includes(sub)) return send(404, { error: "GET /supported, POST /verify, POST /settle" });
      let b;
      try {
        b = await body(req);
      } catch {
        return send(400, { error: "the body is not valid JSON" });
      }
      const { paymentPayload, paymentRequirements } = b ?? {};
      if (!paymentPayload || !paymentRequirements) return send(400, { error: "send { paymentPayload, paymentRequirements }" });
      if (!allowedPayTo.includes(String(paymentRequirements.payTo ?? "").toLowerCase())) {
        const reason = "payto_not_served";
        const message = "this facilitator only settles payments to the API it serves";
        return send(200, sub === "/verify" ? { isValid: false, invalidReason: reason, invalidMessage: message } : { success: false, errorReason: reason, errorMessage: message, transaction: "", network: paymentRequirements.network ?? NETWORK });
      }
      if (sub === "/verify") return send(200, await facilitator.verify(paymentPayload, paymentRequirements));
      return send(200, await settleOnce(paymentPayload, paymentRequirements));
    } catch (e) {
      return send(500, { error: e.shortMessage ?? e.message });
    }
  }
  return { handle, address: account?.address ?? null, publicClient };
}

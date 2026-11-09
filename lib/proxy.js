import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getContractAddress, http, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ATLANTIC_RPC, EXACT_PERMIT2_PROXY, PERMIT2, atlantic } from "./config.js";

// The official x402ExactPermit2Proxy, the contract that executes Permit2 payments for the "exact" scheme. The x402 SDK
// expects it at 0x402085c2…0001 on every chain; it was not deployed on Atlantic. Anyone can put it there: it is a
// CREATE2 deployment through Arachnid's deployer with the initcode and salt published in coinbase/x402
// (contracts/evm/script/data/exact-proxy-initcode.hex and Deploy.s.sol, commit ad2658a). This file only ever deploys
// that exact initcode, and refuses unless it hashes to the published address.

export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const EXACT_SALT = "0x0000000000000000000000000000000000000000000000003000000007263b0e";
export const INITCODE_HASH = "0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c";
const ABI = parseAbi(["function PERMIT2() view returns (address)"]);

export function officialInitcode() {
  const raw = readFileSync(new URL("../contracts/x402ExactPermit2Proxy.initcode.hex", import.meta.url), "utf8").trim();
  const code = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (keccak256(code) !== INITCODE_HASH) throw new Error("the vendored initcode is not the published one");
  const at = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: EXACT_SALT, bytecode: code });
  if (at !== EXACT_PERMIT2_PROXY) throw new Error(`the initcode deploys to ${at}, not ${EXACT_PERMIT2_PROXY}`);
  return code;
}

/** Is the proxy there, and does it point at the canonical Permit2? */
export async function proxyStatus({ rpc = ATLANTIC_RPC } = {}) {
  const c = createPublicClient({ chain: atlantic, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) });
  const code = await c.getCode({ address: EXACT_PERMIT2_PROXY });
  if (!code || code === "0x") return { address: EXACT_PERMIT2_PROXY, deployed: false };
  const permit2 = await c.readContract({ address: EXACT_PERMIT2_PROXY, abi: ABI, functionName: "PERMIT2" });
  return { address: EXACT_PERMIT2_PROXY, deployed: true, permit2, ok: permit2 === PERMIT2 };
}

/** Deploys it (once per chain) from `privateKey`. Returns the status and, if it sent one, the transaction. */
export async function deployProxy({ privateKey, rpc = ATLANTIC_RPC }) {
  const before = await proxyStatus({ rpc });
  if (before.deployed) return { ...before, tx: null };
  const c = createPublicClient({ chain: atlantic, transport: http(rpc, { timeout: 30_000, retryCount: 3 }) });
  for (const [what, a] of [["CREATE2 deployer", CREATE2_DEPLOYER], ["Permit2", PERMIT2]]) {
    const code = await c.getCode({ address: a });
    if (!code || code === "0x") throw new Error(`${what} (${a}) is not on this chain`);
  }
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: atlantic, transport: http(rpc, { timeout: 30_000 }) });
  const data = `${EXACT_SALT}${officialInitcode().slice(2)}`;
  const tx = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data });
  const rc = await c.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });
  if (rc.status !== "success") throw new Error(`the deployment ${tx} reverted`);
  const after = await proxyStatus({ rpc });
  if (!after.ok) throw new Error("deployed, but PERMIT2() is not the canonical Permit2");
  return { ...after, tx, block: Number(rc.blockNumber) };
}

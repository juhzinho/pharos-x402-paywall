import { createPublicClient, formatEther, formatUnits, getAddress, http, isAddress, parseAbi } from "viem";
import { ATLANTIC_RPC, PACIFIC, PACIFIC_RPC, atlantic } from "./config.js";

// What the paid routes sell — real data, read live when the request is paid:
//   /api/atlantic/block   the Atlantic head block (what this API settles on)
//   /api/pacific/gas      Pacific Mainnet's fee market: the base fee and what senders really paid on top, recent blocks
//   /api/pacific/wallet   a Pacific wallet: PROS, USDC, WPROS, nonce, account type, USDC blacklist

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = (rpc, chain) => createPublicClient({ chain, transport: http(rpc, { timeout: 20_000, retryCount: 4, retryDelay: 600 }) });
export const atlanticClient = () => client(ATLANTIC_RPC, atlantic);
export const pacificClient = () => client(PACIFIC_RPC, { id: 1672, name: "Pharos Pacific", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [PACIFIC_RPC] } } });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function isBlacklisted(address) view returns (bool)"]);
const g = (wei) => Number(wei) / 1e9;

export async function atlanticBlock() {
  const b = await atlanticClient().getBlock();
  return { network: "Pharos Atlantic Testnet", block: Number(b.number), hash: b.hash, time: new Date(Number(b.timestamp) * 1000).toISOString(), ageSeconds: Math.max(0, Math.round(Date.now() / 1000 - Number(b.timestamp))), transactions: b.transactions.length, gasUsed: Number(b.gasUsed), gasLimit: Number(b.gasLimit), baseFeeGwei: g(b.baseFeePerGas ?? 0n) };
}

export async function pacificGas({ blocks = 64 } = {}) {
  const c = pacificClient();
  const h = await c.request({ method: "eth_feeHistory", params: [`0x${blocks.toString(16)}`, "latest", [50, 90]] });
  const first = Number(BigInt(h.oldestBlock));
  const rows = h.gasUsedRatio.map((u, i) => ({ block: first + i, baseFeeGwei: g(BigInt(h.baseFeePerGas[i])), used: u }));
  const busy = rows.filter((r) => r.used > 0).map((r) => r.block);
  const txs = [];
  for (let i = 0; i < busy.length; i += 6) {
    const got = await Promise.all(busy.slice(i, i + 6).map((n) => c.getBlock({ blockNumber: BigInt(n), includeTransactions: true }).catch(async () => (await sleep(800), c.getBlock({ blockNumber: BigInt(n), includeTransactions: true })))));
    for (const b of got) for (const tx of b.transactions) {
      const base = b.baseFeePerGas ?? 0n;
      const eff = tx.type === "legacy" || tx.type === "eip2930" ? tx.gasPrice : base + (tx.maxPriorityFeePerGas < tx.maxFeePerGas - base ? tx.maxPriorityFeePerGas : tx.maxFeePerGas - base);
      txs.push(g(eff - base));
    }
  }
  const over = txs.filter((x) => x > 0).sort((a, b) => a - b);
  const bases = rows.map((r) => r.baseFeeGwei);
  return {
    network: "Pharos Pacific Mainnet", blocks: { from: rows[0].block, to: rows.at(-1).block },
    baseFeeGwei: { now: bases.at(-1), min: Math.min(...bases), max: Math.max(...bases) },
    transactions: txs.length, paidAboveBaseFee: over.length, share: txs.length ? over.length / txs.length : 0,
    overpayGwei: over.length ? { median: over[Math.floor(over.length / 2)], max: over.at(-1) } : null,
    advice: over.length ? `Send with a tip of 0: ${txs.length - over.length} of ${txs.length} transactions in these blocks paid exactly the base fee and were included.` : "Every transaction paid exactly the base fee.",
  };
}

export const validWallet = (q) => (isAddress(String(q.address ?? ""), { strict: false }) ? null : "address: a Pacific address (0x…) is required");

export async function pacificWallet(q) {
  const a = getAddress(String(q.address).toLowerCase());
  const c = pacificClient();
  const [pros, usdc, wpros, nonce, code, black] = await Promise.all([
    c.getBalance({ address: a }),
    c.readContract({ address: PACIFIC.USDC, abi: ERC20, functionName: "balanceOf", args: [a] }),
    c.readContract({ address: PACIFIC.WPROS, abi: ERC20, functionName: "balanceOf", args: [a] }),
    c.getTransactionCount({ address: a }),
    c.getCode({ address: a }),
    c.readContract({ address: PACIFIC.USDC, abi: ERC20, functionName: "isBlacklisted", args: [a] }),
  ]);
  const kind = !code || code === "0x" ? "wallet (EOA)" : code.startsWith("0xef0100") ? "wallet with an EIP-7702 delegation" : "contract";
  return { network: "Pharos Pacific Mainnet", address: a, kind, nonce, balances: { PROS: formatEther(pros), USDC: formatUnits(usdc, 6), WPROS: formatEther(wpros) }, usdcBlacklisted: black };
}

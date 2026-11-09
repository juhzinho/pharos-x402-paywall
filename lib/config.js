import { getAddress } from "viem";

// Pharos Atlantic Testnet — where this API is paid. Every value below was checked on chain (see
// skill/pharos-x402-paywall/references/atlantic.md).
//
// Two test USDCs live on Atlantic, and x402 "exact" moves each one differently:
//   test-usdc  0xb691…6a2c "TEST USDC" — a widely held Atlantic test token. A plain ERC-20 (no EIP-3009, no permit),
//              so it is paid through Permit2: the payer approves Permit2 once, then signs a Permit2 witness transfer
//              that the official x402ExactPermit2Proxy (0x4020…0001) executes. This is the default.
//   usdc-v2    0xcfC8…Fc8B "USDC" — Circle's testnet USDC on Pharos (FiatToken v2.2, EIP-3009, domain { USDC, 2, 688689 }):
//              fully gasless for the payer. From Circle's faucet (faucet.circle.com) or CCTP. ASSET=usdc-v2 to use it.
// (The address on the x402 docs page, 0xE0BE…4ec8, has no version(), no authorizationState() and no permit: neither
// method can move it, so it is not offered.)

export const NETWORK = "eip155:688689";
export const CHAIN_ID = 688689;
export const ATLANTIC_RPC = process.env.ATLANTIC_RPC_URL ?? "https://atlantic.dplabs-internal.com";
export const EXPLORER = "https://atlantic.pharosscan.xyz";
export const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const EXACT_PERMIT2_PROXY = getAddress("0x402085c248EeA27D92E8b30b2C58ed07f9E20001");
export const ASSETS = {
  "test-usdc": { key: "test-usdc", symbol: "USDC", name: "TEST USDC", decimals: 6, address: getAddress("0xb691f00682feef63bc73f41c380ff648d73c6a2c"), method: "permit2", balanceSlot: 0n },
  "usdc-v2": { key: "usdc-v2", symbol: "USDC", name: "USDC", version: "2", decimals: 6, address: getAddress("0xcfc8330f4bcab529c625d12781b1c19466a9fc8b"), method: "eip3009", balanceSlot: 9n },
};
const chosen = process.env.ASSET ?? "test-usdc";
if (!ASSETS[chosen]) throw new Error(`ASSET must be one of: ${Object.keys(ASSETS).join(", ")}`);
export const USDC = ASSETS[chosen];
/** The `extra` field of the payment requirements: how the "exact" scheme must move this token. */
export const assetExtra = (a = USDC) => (a.method === "permit2" ? { name: a.name, assetTransferMethod: "permit2" } : { name: a.name, version: a.version });
export const atlantic = { id: CHAIN_ID, name: "Pharos Atlantic Testnet", nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 }, rpcUrls: { default: { http: [ATLANTIC_RPC] } }, blockExplorers: { default: { name: "PharosScan", url: EXPLORER } } };

// The data the paid routes sell is read live: Atlantic for its own head, Pacific Mainnet for gas and wallets.
export const PACIFIC_RPC = process.env.PACIFIC_RPC_URL ?? "https://rpc.pharos.xyz";
export const PACIFIC = {
  USDC: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"),
  WPROS: getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"),
};

export const usd = (atomic) => `$${(Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

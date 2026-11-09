# Pharos x402 Paywall

A pay-per-request API on **Pharos Atlantic Testnet** (`eip155:688689`), priced in test USDC, settled by **its own x402 facilitator**.
Ask without paying and you get `402` with the price. Sign a USDC transfer and you get the data, a `200`, and a `PAYMENT-RESPONSE` header carrying the settlement transaction hash.

**Test USDC used:** [`0xB691f00682fEef63bc73f41C380fF648d73c6A2c`](https://atlantic.pharosscan.xyz/token/0xB691f00682fEef63bc73f41C380fF648d73c6A2c) — "TEST USDC", 6 decimals. Circle's testnet USDC (`0xcfC8…Fc8B`, EIP-3009) works too with `ASSET=usdc-v2`.

**Live demo:** https://pharos-x402-paywall.vercel.app

```
GET /api/pacific/gas                         → 402  PAYMENT-REQUIRED: 0.002 USDC to payTo on eip155:688689
sign a Permit2 witness transfer              (one-time approve of Permit2 before the first payment)
GET /api/pacific/gas + PAYMENT-SIGNATURE     → /facilitator/verify → /facilitator/settle
                                             → 200  PAYMENT-RESPONSE: { success, transaction: 0x…, payer }
```

## Requirements

| # | Requirement | Where it is met | Proof |
|---|---|---|---|
| 1 | Atlantic Testnet, priced in test USDC | `lib/config.js`: `eip155:688689`, TEST USDC `0xB691…6A2c` paid through Permit2 (USDC v2 `0xcfC8…Fc8B` via EIP-3009 with `ASSET=usdc-v2`) | `PAYMENT-REQUIRED` on any paid route; [references/atlantic.md](skill/pharos-x402-paywall/references/atlantic.md) |
| 2 | ≥ 2 paid routes at different prices, 1 free route | `lib/paywall.js`: `/api/atlantic/block` 0.001, `/api/pacific/gas` 0.002, `/api/pacific/wallet` 0.005; free `/health`, `/catalog` | [/catalog](https://pharos-x402-paywall.vercel.app/catalog), [/health](https://pharos-x402-paywall.vercel.app/health) |
| 3 | Its own facilitator: `/verify`, `/settle`, `/supported` | `lib/facilitator.js`, served at `/facilitator/*` next to the API; the paywall reaches it over HTTP like any facilitator | [/facilitator/supported](https://pharos-x402-paywall.vercel.app/facilitator/supported) |
| 4 | Demo: 402 → signed payment → 200 + `PAYMENT-RESPONSE` with tx hash on the explorer | `scripts/client.js demo --record` → `public/runs/demo.json`, shown step by step on the site | [0.001](https://atlantic.pharosscan.xyz/tx/0xa2ef338e9b84f025e7b3c63556db1e29ad3f6cfac739f858a25f0db522703d38) · [0.002](https://atlantic.pharosscan.xyz/tx/0x014ecd5aa6702632bce6841e71247c82e87105ef14b52ee6e5b796f905818de0) · [0.005](https://atlantic.pharosscan.xyz/tx/0x1b237958abb7f2ca4e825a5f0d3a048be13db174fdfbba64851739994b150af3) USDC settlements |
| 5 | Bad or underpaid payment → another 402 | underpaid by 1 unit, wrong payTo, tampered signature, replay: all 402 (`No matching payment requirements` ×2, `invalid_permit2_signature`, `permit2_simulation_failed`); balance spent = exactly 0.008 | site section “Payments that must fail”; `npm test`; `npm run fork` |
| 6 | Keys in env vars or a file, never in code or prompts | `.env` (git-ignored) or `.private_key`; on Vercel, project env vars; `scripts/keys.js` prints only addresses | `.gitignore`, `.env.example`, test “no private key is written in tracked files” |

## Proof on Atlantic (recorded 2026-11-09 against the deployed API)

| What | Transaction |
|---|---|
| official `x402ExactPermit2Proxy` deployed at `0x4020…0001` | [0x94dd57f1…](https://atlantic.pharosscan.xyz/tx/0x94dd57f19ef95d914a3707b88c320b8794f5b29d30c55cc0360ffa79c3665aa8) (block 32,537,534) |
| client's one-time Permit2 approval | [0x2c338fe0…](https://atlantic.pharosscan.xyz/tx/0x2c338fe01e822a111aef441bcb9ea060c31f783e310034ab83317a084bc2eedc) |
| `/api/atlantic/block` paid, 0.001 USDC | [0xa2ef338e…](https://atlantic.pharosscan.xyz/tx/0xa2ef338e9b84f025e7b3c63556db1e29ad3f6cfac739f858a25f0db522703d38) (block 32,544,778) |
| `/api/pacific/gas` paid, 0.002 USDC | [0x014ecd5a…](https://atlantic.pharosscan.xyz/tx/0x014ecd5aa6702632bce6841e71247c82e87105ef14b52ee6e5b796f905818de0) (block 32,544,789) |
| `/api/pacific/wallet` paid, 0.005 USDC | [0x1b237958…](https://atlantic.pharosscan.xyz/tx/0x1b237958abb7f2ca4e825a5f0d3a048be13db174fdfbba64851739994b150af3) (block 32,544,800) |

Each settlement is sent by the facilitator (`0x4A21…3815`) to the proxy and moves TEST USDC from the client (`0x1fe2…48Cc`) to payTo (`0x67E2…07AA`); the client checked every `Transfer` against the price and payTo.

## Which test USDC, and why Permit2

Atlantic has three "test USDC" addresses; each was checked on-chain ([references/atlantic.md](skill/pharos-x402-paywall/references/atlantic.md)):

| Token | EIP-3009 | Used |
|---|---|---|
| `0xB691…6A2c` TEST USDC | no — plain ERC-20 | **yes, through Permit2** (default) |
| `0xcfC8…Fc8B` USDC v2 (FiatToken) | yes | optional, `ASSET=usdc-v2` — Circle's testnet USDC, from [faucet.circle.com](https://faucet.circle.com) or CCTP |
| `0xE0BE…4ec8` (on the x402 docs page) | no, and no `version()` | no — neither method can move it |

The x402 "exact" scheme pays a plain ERC-20 through Permit2 and the official `x402ExactPermit2Proxy`, which the SDK expects at `0x402085c2…0001`. It was not on Atlantic. `scripts/deploy-proxy.js` deployed it with the initcode and salt published in [coinbase/x402](https://github.com/coinbase/x402/tree/main/contracts/evm/script) (vendored in `contracts/`, hash-checked, and refused unless it computes to that address). Now any x402 client can pay with TEST USDC on Atlantic.

## Routes

| Route | Price | Returns |
|---|---|---|
| `GET /health` | free | status, payTo, the facilitator's signer and PHRS gas balance |
| `GET /catalog` | free | routes and prices |
| `GET /api/atlantic/block` | 0.001 USDC | the latest Atlantic block: number, time, transactions, gas |
| `GET /api/pacific/gas` | 0.002 USDC | Pacific Mainnet's fee market over 64 blocks: base fee and how many senders paid above it |
| `GET /api/pacific/wallet?address=0x…` | 0.005 USDC | a Pacific Mainnet wallet: PROS, USDC, WPROS, nonce, EOA/contract/EIP-7702, USDC blacklist |
| `GET /facilitator/supported` · `POST /facilitator/verify` · `POST /facilitator/settle` | — | the facilitator |

The data is read **live** when the request is paid. Order inside a paid route: validate the request (a bad address is a `400` and costs nothing) → check the payment → produce the data → settle → `200`. If the data source fails, nothing is settled.

## Run it

```bash
npm install
node scripts/keys.js          # writes .env with fresh TEST keys, prints only the three addresses
```

Fund the printed addresses on Atlantic: a little **PHRS** to the facilitator (gas for settlements) and to the client (one Permit2 approval), and some **TEST USDC** (`0xB691f00682fEef63bc73f41C380fF648d73c6A2c`) to the client. `node scripts/deploy-proxy.js --check` confirms the proxy is there.

```bash
npm run server                                      # http://localhost:3180 — site, API and facilitator
npm run client -- quote /api/pacific/gas            # just the 402, decoded
npm run client -- pay /api/pacific/gas              # 402 → sign → 200 + PAYMENT-RESPONSE → checks the Transfer on-chain
npm run client -- pay /api/pacific/wallet --address 0x…
npm run client -- reject                            # underpaid, wrong payTo, forged, replay → each a 402
npm run client -- demo --record                     # everything above, saved for the site
npm run client -- demo --base https://pharos-x402-paywall.vercel.app
```

No funds yet? `npm run fork` runs the whole thing on an **Anvil fork of Atlantic**: fresh in-memory keys, PHRS and test USDC given on the fork only, server and facilitator in-process, then the client's demo and every rejection. It ends with a balance check: the client spent exactly the sum of the three prices, so the rejections cost nothing.

## Facilitator safety

- **Only its own payTo.** `/verify` and `/settle` refuse requirements whose `payTo` is not `PAY_TO_ADDRESS` (`payto_not_served`), so nobody can use this facilitator as a free relayer for their own transfers.
- **One settlement at a time, never twice.** Settlements are queued, so the signer's transactions never race for a nonce; a payment already being settled is refused at once. Tested live: the same signed payment sent twice at the same moment gave one `200` and one `402 duplicate_settlement`, one transaction, one charge.
- **Pinned facilitator URL.** The paywall never builds the facilitator URL from the request's `Host` header (a forged Host could point it at a facilitator that approves anything): `FACILITATOR_URL`, else the Vercel production domain, else loopback.
- **Short errors.** A failed settlement answers `402` with the first line of the reason, never the node's full RPC dump.

## Client safety

The client (`lib/client.js`) uses the SDK's spend controls: it only pays **Atlantic TEST USDC** and never more than **0.01 USDC** per request, whatever a server asks. After each payment it reads the receipt and checks that the USDC `Transfer` went from the payer to `payTo` for exactly the price.

## Tests

```bash
npm test        # offline: free routes, /supported, 402 for each price, 400 before payment, garbage/underpaid/wrong-payTo → 402, the asset and proxy initcode, spend controls, no keys in tracked files
npm run fork    # on an Atlantic fork: proxy, approval, three settlements with Transfer checks, then underpaid, wrong payTo, forged signature, replay
```

## Deploy (Vercel)

One function (`api/index.js`) serves everything; `vercel.json` rewrites `/facilitator/*`, `/health`, `/catalog` and the paid routes to it. Set `FACILITATOR_PRIVATE_KEY` and `PAY_TO_ADDRESS` as project environment variables (never in the repo). Without `FACILITATOR_PRIVATE_KEY` the API still answers 402s and `/verify`, and `/health` says it cannot settle.

## Agent skill

[`skill/pharos-x402-paywall`](skill/pharos-x402-paywall/SKILL.md) packages the pattern for an agent: the checked Atlantic facts, the order of operations, the five ways a payment must fail and where each one stops, and the fork recipe. It builds on the official [`x402-pharos`](https://github.com/PharosNetwork/examples/tree/main/skills/x402-pharos) skill, which leaves the USDC address to the user; this one names both test USDCs, the Permit2 path that pays the plain ERC-20 one, and why the address on the docs page cannot be used.

## Layout

```
lib/config.js        network, RPC, explorer, test USDC
lib/facilitator.js   the facilitator: /supported, /verify, /settle
lib/paywall.js       the routes and prices, x402HTTPResourceServer, the paid-request order
lib/app.js           one handler for both (local server and Vercel)
lib/data.js          what the paid routes sell (live Atlantic and Pacific reads)
lib/client.js        the paying client, its one-time Permit2 approval and the on-chain check
lib/proxy.js         the official x402ExactPermit2Proxy: status and CREATE2 deployment
contracts/           its published initcode
lib/fork.js          Anvil fork of Atlantic
scripts/             server, client, keys, deploy-proxy, fork-run
public/              the demo site and recorded runs
```

MIT

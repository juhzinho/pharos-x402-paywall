---
name: pharos-x402-paywall
description: Put an HTTP API behind x402 payments on Pharos Atlantic Testnet (eip155:688689), priced in test USDC, with its own facilitator (/verify, /settle, /supported) and a client that pays. Use when asked to "monetize an endpoint on Pharos", "x402 on Atlantic", "paid API with test USDC", "run my own x402 facilitator", or to test a paywall end to end on a fork.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  builds-on: PharosNetwork/examples skills/x402-pharos
---

# Pharos x402 Paywall (Atlantic Testnet)

A working pattern, not a template: every value below was checked on Atlantic and every step runs in `npm run fork`.

## Facts to use (checked on-chain, see references/atlantic.md)

| | |
|---|---|
| network | `eip155:688689` · chain id 688689 |
| RPC | `https://atlantic.dplabs-internal.com` |
| explorer | `https://atlantic.pharosscan.xyz` |
| Circle USDC | `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` · domain `{ name: "USDC", version: "2" }` · EIP-3009 (payer only signs) · faucet.circle.com → "Pharos Testnet" (= Atlantic) |
| TEST USDC | `0xB691f00682fEef63bc73f41C380fF648d73c6A2c` · "TEST USDC" · 6 decimals · plain ERC-20 → pay with **Permit2** |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical) |
| x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` — deployed on Atlantic by this project from the coinbase/x402 initcode + salt |
| gas | PHRS, about 10 gwei; the facilitator pays settlements, the payer pays one Permit2 approval |

Do **not** use `0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8` (the address on the x402 docs page): no `version()`, `authorizationState` reverts, no `permit` — neither EIP-3009 nor a Permit2 setup from the docs covers it.

## Steps

1. **Keys outside the code.** `FACILITATOR_PRIVATE_KEY`, `PAY_TO_ADDRESS`, `CLIENT_PRIVATE_KEY` in `.env` (git-ignored) or a `.private_key` file; on Vercel, project environment variables. Never in source, prompts or logs. `scripts/keys.js` writes fresh test keys and prints only addresses.
2. **Fund (the user does this):** PHRS to the facilitator, Circle USDC to the client (no PHRS needed) — or TEST USDC with `ASSET=test-usdc`, plus a little PHRS for its one Permit2 approval.
3. **Proxy:** `node scripts/deploy-proxy.js --check`. If a chain lacks `0x4020…0001`, the script deploys the published initcode through Arachnid's CREATE2 deployer and refuses anything that does not hash to that address.
4. **Facilitator** (`lib/facilitator.js`): `x402Facilitator` + `ExactEvmScheme(toFacilitatorEvmSigner(...))` registered for `eip155:688689`; serve `GET /supported`, `POST /verify`, `POST /settle` with body `{ paymentPayload, paymentRequirements }`.
5. **Paywall** (`lib/paywall.js`): `x402HTTPResourceServer` over `HTTPFacilitatorClient({ url })`. Register a money parser — or, as here, give each route an `accepts` array of explicit `{ amount, asset, extra }` prices, one per token: Circle USDC with `extra: { name: "USDC", version: "2" }`, TEST USDC with `extra: { name: "TEST USDC", assetTransferMethod: "permit2" }`. The SDK has no default asset for Atlantic, so the asset must always be explicit. Keep at least one free route (`/health`).
6. **Order inside a paid handler:** validate the request (400, no charge) → `processHTTPRequest` (402 on missing or bad payment) → produce the data → `processSettlement` → 200 with `settle.headers` (the SDK's own `PAYMENT-RESPONSE`). Producing the data before settling means a failing data source charges nobody. Do not re-encode the settle result into the header: it already contains `headers` and would nest itself.
7. **Client** (`lib/client.js`): `x402Client` + `ExactEvmScheme(toClientEvmSigner(account, publicClient))`, and `setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment }] })` so it never pays another token or an unexpected price. Before the first Permit2 payment, read `allowance(payer, Permit2)` and send `createPermit2ApprovalTx(token)` if it is short.
8. **Prove it:** read the settlement receipt and check the USDC `Transfer(from = payer, to = payTo, value = price)`; link `explorer/tx/<hash>`.

## Must fail with another 402

| attempt | where it stops | reason |
|---|---|---|
| amount 1 unit below the price | resource server | `No matching payment requirements` |
| signed to another payTo | resource server | `No matching payment requirements` |
| tampered signature | facilitator /verify | `invalid_permit2_signature` (EIP-3009: `invalid_exact_evm_signature`) |
| the same payment sent twice | facilitator /verify | `permit2_simulation_failed` — the Permit2 nonce is spent (EIP-3009: `invalid_exact_evm_nonce_already_used`) |
| payer without USDC | facilitator /verify | EIP-3009: `invalid_exact_evm_insufficient_balance` |

## Testing without funds

`npm run fork` starts an Anvil fork of Atlantic, gives fresh in-memory keys PHRS (`anvil_setBalance`) and TEST USDC (balance mapping at **slot 0**; USDC v2 uses slot 9) with `anvil_setStorageAt`, deploys the proxy if missing, and runs the full demo and every rejection. Pitfall seen while building it: set `ATLANTIC_RPC_URL` before any module that reads it is imported (use dynamic `import()`), or the server checks balances on the real chain while the client reads the fork.

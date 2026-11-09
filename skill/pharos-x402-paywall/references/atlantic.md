# Atlantic Testnet facts, and how each was checked

Checked with `eth_call` / `eth_getStorageAt` against `https://atlantic.dplabs-internal.com` (chain id `0xa8231` = 688689).

| fact | value | how |
|---|---|---|
| TEST USDC | `0xB691f00682fEef63bc73f41C380fF648d73c6A2c` | `name()` = TEST USDC, `symbol()` = USDC, `decimals()` = 6. `version()`, `DOMAIN_SEPARATOR()`, `authorizationState()` revert; no `permit` or `transferWithAuthorization` selector in its code → Permit2 |
| its balance slot | 0 | `eth_getStorageAt(keccak(addr, 0))` equals `balanceOf(addr)` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | has code on Atlantic |
| x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | had no code; deployed in tx `0x94dd57f19ef95d914a3707b88c320b8794f5b29d30c55cc0360ffa79c3665aa8` (block 32,537,534); `PERMIT2()` = canonical Permit2; initcode keccak `0xe774d1d5…604c` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | has code on Atlantic |
| USDC v2 (Circle) | `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` | Pharos Atlantic token registry and Circle's Pharos announcement; `symbol()` = USDC, `decimals()` = 6 |
| EIP-712 domain | name `USDC`, version `2`, chainId 688689 | `name()`, `version()`; `DOMAIN_SEPARATOR()` equals the hash of that domain with the token as verifyingContract |
| EIP-3009 | supported | `authorizationState(addr, nonce)` answers; `transferWithAuthorization` settles in `npm run fork` |
| USDC v2 balance storage slot | 9 | writing slot `keccak(addr, 9)` on a fork changes `balanceOf(addr)` |
| minting | restricted | `mint` reverts "FiatToken: caller is not a minter"; get it from Circle's faucet (faucet.circle.com) or CCTP |
| the other address in the docs | `0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8` | no `version()`, `authorizationState` reverts: not usable for `exact` |
| gas price | about 10 gwei | `eth_gasPrice` |

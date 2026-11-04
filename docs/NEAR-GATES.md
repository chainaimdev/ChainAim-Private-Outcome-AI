# NEAR gates: answers and sources

The gates of `DESIGN/design-plan - private-ai-NEAR`, section 4, as resolved on 2026-11-04 while adding the NEAR USDC rail.
Each line says what was read. "Not loaded" means the page the design named was not read in this session; the answer
then rests on the other source given, and should be checked against that page before MainNet.

| Gate | Answer | Source read |
|---|---|---|
| G1 x402 scheme for NEAR | **Exists: Design A.** `@x402/near` 2.29.0 (x402 Foundation, Apache-2.0), exports `exact/server`, `exact/client`, `exact/facilitator`. Needs `@x402/core ~2.29.0`, so `@x402/core`, `@x402/hono`, `@x402/extensions` and `@x402/xrpl` moved from 2.27.0 to 2.29.0 together (one `@x402/core` in the tree). No public NEAR facilitator was found, so the paywall can be its own facilitator (`NEAR_RELAYER_*`) or use one by URL (`NEAR_FACILITATOR_URL_<NETWORK>`). | npm registry (`npm view @x402/near`, `npm search x402 near`); the package's own code and README; the x402 spec `specs/schemes/exact/scheme_exact_near.md` (raw.githubusercontent.com/x402-foundation/x402/main) |
| G2 USDC contract | TestNet `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`, MainNet `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals. The same ids are `@x402/near`'s `DEFAULT_ASSETS`. Still a required variable (`NEAR_USDC_CONTRACT_<NETWORK>`, `NEAR_USDC_DECIMALS_<NETWORK>`), read back from `ft_metadata` when the paywall starts. | developers.circle.com/stablecoins/usdc-contract-addresses (loaded); docs.near.org/integrations/fungible-tokens: not loaded |
| G3 ft_transfer rules | Exactly 1 yoctoNEAR attached; one `ft_transfer {receiver_id, amount}` inside a NEP-366 SignedDelegate; payTo must be registered with the token (NEP-145 `storage_balance_of` non-null); a full-access key is required (a function-call key is refused). Default gas 30 TGas, relayer cap 100 TGas (`NEAR_MAX_GAS`). The spec defines no `memo`, so the delegate does not name the invoice: see "Replay" below. | x402 NEAR exact spec (loaded); `@x402/near` facilitator code; docs.near.org/primitives/ft/standard and /smart-contracts/security/one_yocto: not loaded |
| G4 CAIP-2 ids | `near:testnet`, `near:mainnet`. These are the only two `@x402/near` accepts, so there is no `NEAR_CAIP2_<NETWORK>` variable (the design listed one "until G4 fixes a default"). | x402 NEAR exact spec; `@x402/near` `NEAR_NETWORKS`. ChainAgnostic namespace registry: not loaded |
| G5 browser wallet connector | `@hot-labs/near-connect` 0.12.0 has `signDelegateActions({delegateActions: [{receiverId, actions}]})` returning base64 SignedDelegates, behind a per-wallet `features.signDelegateActions` flag. Wired into the page with **Intear Wallet** (owner approved 2026-11-04, with limits): see "Web wallet and CSP" below. | docs.near.org/tools/near-connect (loaded: names sign-in and transactions only); the package's code and type declarations (`npm pack`); its manifest (fetched 2026-11-04) |
| G6 signing library, validity window | `@near-js/*` 2.5.1 (what `@x402/near` uses). The delegate's `max_block_height` is `current_final_height + ceil(maxTimeoutSeconds / 1)`; the facilitator refuses one already expired or with a longer window. So the design's `NEAR_TX_MAX_AGE_BLOCKS` is not needed: the window is `XRPL_MAX_TIMEOUT_SECONDS` (600) blocks, the same timeout as the quote. | x402 NEAR exact spec section 5; `@x402/near` code. docs.near.org/tools/near-api and /protocol/transactions/transaction-anatomy: not loaded |
| G7 RPC methods | Used through `@near-js/providers`: `block` (final), `query` `view_account` / `view_access_key` / `call_function` (final), `send_tx` with `wait_until: FINAL`. The paywall's own reads (`ft_metadata`, `storage_balance_of` at start) are one JSON-RPC object per POST, primary then fallback. | `@near-js/providers` 2.5.1 source; docs.near.org/api/rpc/*: not loaded (the design marks one-request-per-POST as already verified) |

## Replay

The x402 NEAR spec's replay protection is the on-chain access-key nonce plus a cache that stops the same delegate being
settled twice. Neither stops a delegate from a refused (never settled) call being presented again under a new invoice,
which would reach the gateway a second time without paying. The paywall therefore claims each delegate once by its
SHA-256 (the spec's own cache key) in `onBeforeVerify`, next to the invoice claim (`src/invoices.ts`, `SeenPayments`).
Tested in `services/paywall/test/near-rail.test.ts`.

## Web wallet and CSP (G5, 2026-11-04)

### Which wallets declare `signDelegateActions` on testnet

Source: near-connect's manifest, the first of its two defaults in `@hot-labs/near-connect` 0.12.0 (`build/NearConnector.js`
`defaultManifests`): `https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json`,
fetched 2026-11-04, `version` 1.0.4, 14 wallets. The second default, `https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json`,
was the same list with an older `version` (1.0.3). near-connect offers a wallet on testnet only if `features.testnet` is true.

| Wallet id | testnet | signDelegateActions | Executor (wallet code) |
|---|---|---|---|
| meteor-wallet | yes | yes | raw.githubusercontent.com/Meteor-Wallet/... (2.0 MB; refers to about 30 hosts) |
| **intear-wallet** | yes | yes | wallet.intear.tech/near-selector.js (13.8 KB) |
| ledger | yes | yes | raw.githubusercontent.com/near/near-connect-ledger/... (hardware device) |
| near-cli | yes | yes | raw.githubusercontent.com/near/near-cli-connect/... (signs in a terminal) |
| hot-wallet, near-mobile | no | yes | (mainnet only) |
| nightly-wallet, wallet-connect, unity-wallet, ethereum-wallets | yes | no | |
| mynearwallet, okx-wallet, trezu-wallet, hana-wallet | no | no | |

**Chosen: Intear Wallet.** It is a web wallet (nothing to install), and its executor is small enough to read whole: in its
default `iframe:https://wallet.intear.tech` mode it makes no `fetch`, loads `https://wallet.intear.tech/hot-wallet-connector-iframe.html`
in a nested iframe and talks to it by `postMessage`. Its `wss://logout-bridge-service.intear.tech` socket is used only with
`walletUrl: "intear://"` (the native app), which the page does not use. Meteor's 2 MB executor refers to about 30 hosts, which
could not be pinned to an exact list without a live trace.

### CSP changes, each with its reason

Only when the web service has `NEAR_WALLET=intear-wallet`. Unset, the CSP is the Crossmark-only policy, character for character
(pinned in `services/web/test/near-wallet.test.ts`). No wildcard is added. Hosts are listed in `services/web/src/near-wallets.ts`.

| Directive | Added | Why |
|---|---|---|
| `connect-src` | `https://raw.githubusercontent.com` | The page fetches near-connect's manifest (above) itself, keeps only Intear's entry, and checks its executor URL, `type` and features (`pickNearWallet`) before the connector can load anything. |
| `connect-src` | `https://wallet.intear.tech` | near-connect fetches the executor (`https://wallet.intear.tech/near-selector.js?nonce=...`) from the page. |
| `frame-src` | `'self' https://wallet.intear.tech` | The executor runs in near-connect's sandboxed `srcdoc` iframe, which inherits the page's CSP, and it frames `https://wallet.intear.tech/hot-wallet-connector-iframe.html`. `'self'` keeps what `default-src 'self'` already allowed. |

Not changed, and why that is enough:
- `script-src` stays `'self' 'unsafe-inline'`: `/near-wallet.js` is served by the page, and near-connect puts the executor in the `srcdoc` as an inline script, which `'unsafe-inline'` (already there for the page's own module) covers.
- `img-src` stays `'self' data:`: Intear's icon in the manifest is a `data:` URL. The connector's wallet-picker popup (which has a remote image) is never shown, because the page connects by wallet id.
- The wallet's own windows open through near-connect's `window.open`, which CSP does not govern; near-connect allows only the `allowsOpen` origins in the manifest.
- The page's RPC needs: none. The page reads no NEAR balance; the paywall checks funds and refuses with a 402, and nothing is paid.

Other limits: `public/near-wallet.js` is a bundle of its own, loaded by `import()` only when the visitor picks "USDC · NEAR", so an
RLUSD visitor loads no NEAR code; `public/wallet.js` (Crossmark) is byte-identical apart from its source-hash banner. The connector is given
`autoConnect: false`, so a NEAR extension announcing itself cannot open a window the visitor did not ask for. The cookie policy
(`public/cookies.html`) lists the browser storage this adds.

### Still to check live

Intear chooses the delegate's `max_block_height`. The paywall refuses a window longer than the quote's `maxTimeoutSeconds` (600 blocks).
Whether Intear's window fits is known only from a live TestNet payment (MANUAL_SETUP.md, 2026-11-04, "Web NEAR wallet"). The page in a
real browser has not been run in this session: the CSP and wallet behaviour are checked only by tests and by reading the code.

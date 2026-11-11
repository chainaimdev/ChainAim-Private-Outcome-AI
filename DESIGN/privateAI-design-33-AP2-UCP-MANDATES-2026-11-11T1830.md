# privateAI-design-33: AP2 mandates over UCP checkout (ARCH-626 to ARCH-633)

Chat nearao-impl-7, 2026-11-11 ~18:30Z. Status: DESIGN. Owner decisions 2026-11-11 18:24Z: D1 = option A (ES256 only for
AP2; the receipt keeps Ed25519), D2 = option A (--price-round cent|micro, default micro; cent under --ap2 on).
Follows design-32 (firm quote, receipt, agent policy, agent receipt check) and the RESUME POINT "AP2 / UCP integration
decided" in STATE.md.

## 0. Sources read in this chat (Rule 4)

| Source | What it fixes |
| --- | --- |
| https://ucp.dev/latest/specification/payment/extensions/ap2-mandates/ | merchant_authorization = JWS detached content (RFC 7515 App. F) `<header>..<sig>` over JCS (RFC 8785) of the checkout minus `ap2`; header `{alg, kid}`; kid -> business profile `keys[]`; "AP2 v0.2 requires ECDSA (ES256/ES384/ES512)"; business verification steps 1-5; error codes; `expires_at` optional (default TTL 6 h); extension active only in the capability intersection |
| https://ucp.dev/2026-08-25/schemas/common/payment_ap2_mandate.json | same alg list (ES256/ES384/ES512) in the schema; `ap2` omitted on create/update, required on complete; 7 error codes |
| https://ucp.dev/2026-08-25/schemas/shopping/checkout.json | required `ucp, id, line_items, status, currency, totals, links`; status enum; additionalProperties true |
| .../shopping/types/line_item.json, item.json | line item required `id, item, quantity, totals`; item required `id, title, price` |
| .../common/types/totals.json, total.json, amount.json | totals = array with exactly one `subtotal` and one `total`; amount = **integer, ISO 4217 minor units, minimum 0** |
| .../common/types/link.json | link required `type, url` |
| .../ucp.json, https://ucp.dev/latest/specification/overview/ | response `ucp` requires `version` and `payment_handlers`; profile `/.well-known/ucp` requires `ucp.version, ucp.services, ucp.payment_handlers`; signing keys MUST be in top-level `keys[]` (JWK Set), example EC P-256 with `kid, kty, crv, x, y, use: "sig", alg: "ES256"` |
| https://ap2-protocol.org/specification | Cart Mandate concept only; no SD-JWT claims |
| https://ap2-protocol.org/ap2/checkout_mandate/ | closed Checkout Mandate: `vct` (type section and example: `mandate.checkout.1`; schema table says `mandate.checkout`), `checkout_jwt` (SD, the merchant-signed JWT of the UCP Checkout), `checkout_hash` = base64url(hash(checkout_jwt)) with `_sd_alg` or sha-256, `iat`, `exp` optional; example KB carries `iat, aud, nonce, sd_hash`, `typ: kb+sd-jwt`, alg ES256 |

Not read: AP2 Payment Mandate verification at a PSP (out of scope: our settlement is x402 on NEAR, not a card PSP).

## 1. Conflicts with the owner decisions (answered 18:24Z: A and A)

**D1. Algorithm.** Owner decision was "BOTH, --ap2-alg ES256|EdDSA, EdDSA = the existing receipt key". The UCP AP2 page
and the mandate schema both allow only ES256/ES384/ES512 for merchant_authorization (the page says AP2 v0.2 is
internally inconsistent and to follow AP2; AP2's own examples are ES256). A checkout signed with EdDSA is not a
conformant AP2 merchant authorization.
- Option A (recommended): ES256 only for AP2; the receipt keeps its Ed25519 key unchanged. `--ap2-alg` accepts ES256
  only today (ES384/ES512 can be added later without a format change). One new key, desk.ps1 -Ap2Key.
- Option B: keep EdDSA behind `--ap2-alg EdDSA`, labelled non-conformant in the flag help, /.well-known/ucp and the
  page step ("signed, EdDSA, not AP2 v0.2"). More code and tests for a mode no AP2 verifier will accept.

**D2. Money units.** UCP totals are integers in ISO 4217 minor units (USD = cents). Our quotes are USDC to 6 decimals
(packages/crossask cost.ts rounds UP to 6 decimals, e.g. 0.012001). A sub-cent price cannot be written in a conformant
checkout, and AP2 scope matching (totals vs what is paid) would then compare different numbers.
- Option A (recommended): with `--ap2 on`, the console rounds the job total UP to whole cents (new cost.ts option,
  flag `--price-round cent|micro`, default micro so nothing changes with --ap2 off). The checkout carries
  currency "USD" and cents; the x402 amount is cents x 10^4 USDC base units; the agent and paywall check
  `amountUnits == total_cents * 10^(usdcDecimals-2)` exactly. Cost to the buyer: at most 0.009999 USD more per job.
  Today's live jobs are at the 0.01 minimum, so their price does not change.
- Option B: keep 6-decimal prices and put the exact amount in a ChainAim extension field beside a rounded `total`.
  Not recommended: the signed `total` would differ from what is paid, which is what mandate_scope_mismatch exists to catch.
- Option C: currency "USDC" with exponent 6. Violates the schema (ISO 4217 has no USDC).

## 2. Mapping the paid job to a UCP checkout (Phase 1)

The console (seller, "business") builds the checkout when it registers the quoted job (test-console/console/server.ts
POST /jobs/crossask, after registerJob). Ids, sizes, hashes and amounts only, never question, SQL, rows or answer
(same rule as the receipt, ARCH-613).

```
{
  "ucp": { "version": "2026-08-25",
           "capabilities": { "dev.ucp.shopping.checkout": [{"version":"2026-08-25"}],
                             "dev.ucp.common.payment.ap2_mandate": [{"version":"2026-08-25"}] },
           "payment_handlers": { "x402.near.exact": [{ "id": "x402_near_exact", "version": "2026-08-25" }] } },
  "id": "<jobId>",
  "status": "ready_for_complete",
  "currency": "USD",
  "line_items": [{ "id": "job", "quantity": 1,
                   "item": { "id": "chainaim.crossask.<route>", "title": "ChainAim private analysis job", "price": <cents> },
                   "totals": [{ "type": "subtotal", "amount": <cents> }, { "type": "total", "amount": <cents> }] }],
  "totals": [{ "type": "subtotal", "amount": <cents> }, { "type": "total", "amount": <cents> }],
  "links": [{ "type": "terms_of_service", "url": "<--ap2-terms-url>" }],
  "expires_at": "<ISO of the job's expiresAt>",
  "dev.chainaim.job": { "network": "near:testnet", "asset": "<usdc contract>", "payTo": "<account>",
                        "amountUnits": "<x402 amount>", "usdcDecimals": 6, "datasetId": "...", "filesRoot": "<sha256>" }
}
```
- `payment_handlers` key name `x402.near.exact` is ours (reverse-domain style); the ap2 page does not constrain it.
  To confirm with the owner only if a real UCP platform will read it; for the agent it is informational.
- `dev.chainaim.job` uses additionalProperties (allowed by the schema) so the signature also commits to where the
  money goes (network, asset, payTo, base units), which plain UCP totals do not.

merchant_authorization (ARCH-626, packages/ap2):
- payload bytes P = UTF-8 of JCS(checkout without `ap2`). JCS per RFC 8785 (numbers in ECMAScript form; keys sorted by
  UTF-16 code units; this is what packages/receipt canonicalJson already does for our value set, but packages/ap2 gets
  its own JCS with the RFC 8785 test vectors so the two never drift silently).
- header H = `{"alg":"ES256","kid":"<kid>"}` (JCS too), base64url without padding.
- signature = ECDSA P-256 SHA-256 over ASCII(b64u(H) + "." + b64u(P)), IEEE P1363 (r||s, 64 bytes), node:crypto
  `dsaEncoding: "ieee-p1363"`.
- value `<b64u(H)>..<b64u(sig)>`.
- kid = first 16 bytes hex of SHA-256 over the JWK thumbprint input (RFC 7638) - deterministic from the key, like the
  receipt key id. Published in GET /.well-known/ucp `keys[]` as `{kid, kty:"EC", crv:"P-256", x, y, use:"sig", alg:"ES256"}`.
- AP2's `checkout_jwt` (Phase 2) is the attached form of the same JWS: `b64u(H).b64u(P).b64u(sig)`. No second signature.

## 3. Phase 1 flow and components

1. Console /jobs/crossask: quote -> registerJob -> build checkout -> sign -> hold `{checkout, merchantAuthorization}`
   in HeldJob (test-console/console/jobs.ts, beside `receipt`) -> answer adds `ap2: {checkout, merchant_authorization}`.
2. Agent (services/paywall/scripts/agent-jobs-core.ts runAndPay), after `quoted` and before `policy`:
   verify with the PINNED public JWK (config/ap2-public-key.jwk.json, --ap2-public-key), never the one sent; then
   bind: checkout.id == jobId, total cents == quote, `dev.chainaim.job` network/asset/payTo/amountUnits == the quote
   and later the 402 offer, expires_at not passed (skew --ap2-skew-sec, lesson 7). Event `quote_signed {jobId, kid}`.
   Any failure = `refused` with the AP2 error code in the reason (merchant_authorization_missing / _invalid,
   mandate_scope_mismatch), nothing signed or paid.
3. Receipt (ARCH-631): optional `merchantAuthSha256` = sha256 hex of the merchant_authorization string in the receipt
   body, so the receipt points at the signed quote. Optional field: old receipts still verify.
4. Page step "[Agent tNN] Quote signed by ChainAim ✓"; agent-ask-core.ts step line; verify-receipt.ts prints the hash.

Flags (console): `--ap2 on|off` (default off), `--ap2-key-env NAME` (default AP2_SIGNING_KEY), `--ap2-alg ES256`,
`--ap2-terms-url URL`, `--price-round cent|micro` (D2). `--ap2 on` needs `--paid-jobs on`.
Flags (agent): `--ap2-verify on|off` (default off), `--ap2-public-key PATH` (default config/ap2-public-key.jwk.json),
`--ap2-skew-sec N` (default 30).
Key tool: scripts/receipt-key-core.ts gains `--alg ed25519|ES256` (default ed25519, so -ReceiptKey is unchanged);
desk.ps1 -Ap2Key = `--alg ES256 --var AP2_SIGNING_KEY --public-out config/ap2-public-key.jwk.json`.

## 4. Phase 2 (outline; detailed after Phase 1 ships)

- Agent builds a closed Checkout Mandate: issuer-signed SD-JWT by the tenant's mandate key (ES256, kid in the agent's
  GET /.well-known/ucp `keys[]`, per tenant), payload `{vct:"mandate.checkout.1", checkout_hash, _sd:[digest of the
  checkout_jwt disclosure], _sd_alg:"sha-256", iat, exp}`, one disclosure `[salt, "checkout_jwt", <attached JWS>]`,
  plus KB-JWT `{typ:"kb+jwt", aud:<business id>, nonce:<paywall invoiceId>, iat, sd_hash}`. vct uses the `.1` form
  (type section and example) over the schema table's `mandate.checkout`.
- Sent with the release as header `x-ap2-checkout-mandate` (payAndFetchNear carries extra headers already through
  init.headers). Paywall release guard (services/paywall/src/app.ts, before the payment middleware so nothing settles):
  verify SD-JWT + KB + exp, recompute checkout_hash, verify the embedded merchant_authorization with the console's
  public key, and match id/totals/amountUnits to the job; AP2 error codes as 4xx bodies. PAID_JOBS_AP2=on|off,
  PAID_JOBS_AP2_PLATFORM_KEYS (path of the agents' public JWK set).
- Mandate hash into the receipt settlement part (optional field).

## 5. ARCH-IDs (new, unused before this doc)

| ID | Requirement |
| --- | --- |
| ARCH-626 | packages/ap2: JCS (RFC 8785 vectors), detached JWS ES256 sign/verify (P1363), JWK + kid, error codes |
| ARCH-627 | ES256 key tooling: receipt-key --alg ES256, desk.ps1 -Ap2Key, public JWK file |
| ARCH-628 | console: paid job -> UCP checkout + merchant_authorization, GET /.well-known/ucp, flags, held with the job |
| ARCH-629 | cent rounding of the quote under --ap2 on (D2 option A) |
| ARCH-630 | agent verifies merchant_authorization with the pinned key and binds it to the quote, before policy |
| ARCH-631 | receipt merchantAuthSha256 (optional) and its display (page, -AgentAsk, -VerifyReceipt) |
| ARCH-632 | Phase 2: agent checkout mandate SD-JWT+kb, per-tenant keys, agent /.well-known/ucp |
| ARCH-633 | Phase 2: paywall verifies the mandate before settle, AP2 error codes |

## 6. File list check against the handoff (corrections)

- "jobs.ts holds the signed checkout" = test-console/console/jobs.ts (HeldJob), not services/paywall/src/jobs.ts.
  The paywall JobBook keeps ids/amounts only and needs a change only in Phase 2 (amount check stays where it is).
- services/paywall/src/config.ts: PaidJobsConfig gains `ap2?: {platformKeys}` in Phase 2 only.
- scripts/near.ts payAndFetchNear: no change needed for Phase 2 transport (headers pass through init.headers on both
  requests); confirm the first, unpaid request may carry the mandate too (it is the same POST).
- console.Dockerfile + console.Dockerfile.dockerignore: add `packages/ap2/package.json` and `packages/ap2/src`
  (lesson 1; console-docker.test.ts walks the imports). agent.Dockerfile + its .dockerignore: same, plus
  `config/ap2-public-key.jwk.json`.
- New: cost.ts `--price-round` (D2 A) is not in the handoff list.

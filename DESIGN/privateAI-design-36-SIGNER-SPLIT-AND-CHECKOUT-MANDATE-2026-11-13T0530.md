# privateAI-design-36: the signer split (control plane) and the two-sided AP2 deal (Checkout Mandate)

Chat near-ai-impl-10, 2026-11-13 ~04:15Z to ~06:00Z. Follows the plan in DESIGN-REF/near-hackathon-session-2026-11-13T0405Z.md
section 7 (owner 2026-11-13 04:12 local: "1a proceed, 2 proceed, 1c write-up, 3 adjust the demo script; name the
containers cleanly"). Release: v2.0.0 (signer + mandate). Status: BUILT and tested on the PC's Linux shell; NOT yet
run on the desk (owner: -Test, 1b steps, -MandateKey, -All, live run).

## 0. Sources read (Rule 4)

- https://ap2-protocol.org/ap2/checkout_mandate/ (2026-11-13, through the fetch tool, which summarizes): open vs closed
  mandates; closed vct `mandate.checkout.1` (the schema table says `mandate.checkout`: conflict noted, `.1` kept as in
  design-33); claims vct, checkout_jwt (selectively disclosable), checkout_hash (base64url hash of checkout_jwt with the
  `_sd_alg`, else SHA-256), iat, exp; the closed example: an ES256 JWT typed `kb+sd-jwt` whose payload holds
  `delegate_payload: [{"...": digest}]`, iat, aud, nonce, sd_hash, `_sd_alg: sha-256`, and two disclosures (the mandate
  object; the checkout_jwt). The raw markdown on GitHub could not be fetched (robots), so where the page is not explicit
  our choices are listed in packages/ap2/src/mandate.ts and in section 3 below.
- Code: test-console/console/{server.ts, ap2.ts, receipt.ts, offers.ts, jobs.ts, paid-jobs.html}, packages/{ap2, receipt,
  offer}, services/paywall/{src/app.ts, scripts/agent-jobs*.ts, scripts/near.ts, scripts/agent-receipt.ts},
  test-console/{up.ps1, desk.ps1, down.ps1}, docker-compose.yml, scripts/verify-receipt.ts.

## 1. The split

| Plane | Containers | Holds | Sees |
|---|---|---|---|
| Data (buyer side) | ca-gateway, ca-presidio, ca-analyst, ca-console-api, ca-agent, ca-attest (project chainaim-private-ai, network chainaim-test) | files, question, result, unmasking; tenant NEAR keys and tenant mandate keys (agent); the request key | everything of the buyer |
| Control (ChainAim) | **ca-control-signer** (project **chainaim-control-plane**, network **chainaim-control**, 127.0.0.1:8780) | AP2 quote key (ES256, 83816e6f...), receipt key (Ed25519, d27d1e9f...), the request key | sizes, model ids, token counts, ids, hashes, amounts, payee, invoice id |
| Control, still local | ca-paywall (+ relayer key) | NEAR settlement | payment headers, the held result in transit (Stage 3 moves it) |

Naming: the new service is `ca-control-signer` everywhere (container, image `chainaim-control-signer:local`, compose
service `control-signer`, label `chainaim.plane=control`). Existing containers keep their names (stack.ps1, desk.ps1,
smoke tests and the admin UI use them); `desk.ps1 -Planes` prints each with its plane. Caveat (said in README and the
demo script): on one PC this is separation by design, not by hardware.

## 2. ARCH-IDs (new)

| ARCH | What | Where | Tests |
|---|---|---|---|
| ARCH-660 | ca-control-signer service: zero npm deps, flags only, keys from env only, /healthz, /.well-known/keys, /.well-known/ucp, X-Signer-Key, stateless but the nonce set | services/signer/src/main.ts, Dockerfile (+ .dockerignore), compose.yml | services/signer/test/signer-service.test.ts (4), scripts/test/signer-deploy.test.ts |
| ARCH-661 | allowlist: every request member, file, call, price and quote-basis member checked; anything else 400 by name | packages/signer parse* / onlyFields | packages/signer/test (allowlist tests), signer-service 400 |
| ARCH-662 | the signer prices every job itself (offer: packages/offer + cost model; run-hold: metered calls) and signs only the amount it computed (409 otherwise) | packages/signer SellerSigner.price / signQuote; server.ts /offers and /jobs/crossask call it | signer test 409; console-signer "the price is the signer's own (its margin)" |
| ARCH-663 | console --signer local\|remote, --signer-url, --signer-key-env, start-up waits for the signer's public keys; with remote, the console holds no ChainAim key (AP2/receipt configs carry the public half; signing with them throws) | test-console/console/signer-client.ts, ap2.ts ap2ConfigRemote, receipt.ts receiptConfigRemote, server.ts | scripts/test/console-signer.test.ts (7) |
| ARCH-664 | deployment: up.ps1 -Signer auto\|separate\|in-console, -SellerSecretsFile, -SignerClientFile, -SignerUrl; desk.ps1 -SignerKeys, -MandateKey, -Planes, settings sellerSecretsDir / signer.mode / signer.url; down.ps1 stops the control plane | test-console/*.ps1, scripts/signer-keys*.ts, docker-compose.yml (SIGNER_REQUEST_KEY, extra_hosts) | signer-deploy.test.ts (5), signer-keys.test.ts (3), desk.test.ts |
| ARCH-665 | closed Checkout Mandate format, build + verify, registry of tenants' public keys | packages/ap2/src/mandate.ts | packages/signer/test ARCH-665 (every tampered part, with its AP2 code) |
| ARCH-666 | the agent signs the mandate right before the payment signature (after the policy), nonce = the 402's invoice id, header x-ap2-checkout-mandate; a tenant with no key cannot pay a mandate-checked job | services/paywall/scripts/agent-mandate.ts, agent-jobs-core.ts, near.ts headersFor, agent-jobs.ts --ap2-mandate | services/paywall/test/agent-mandate.test.ts (3, real paywall) |
| ARCH-667 | the paywall forwards {invoiceId, checkoutMandate} to the console's run step; the console has the signer verify it BEFORE anything runs (--ap2-mandate off\|optional\|required, default optional with --ap2 on); refused 422, signer down 502: nothing settles | services/paywall/src/app.ts runOffer, jobs.ts parseRunNotice, server.ts runOffer | console-signer (refused, required, signer down), agent-mandate (refused -> no transfer) |
| ARCH-668 | the receipt records the mandate {sha256, kid, tenant, accountId, nonce}; the signer re-verifies it when signing and checks at settlement that the invoice is the nonce and the payer the tenant; verify-receipt checks it offline with config/ap2-mandate-keys.json | packages/receipt (mandate field), packages/signer signReceipt/settle, receipt.ts, scripts/verify-receipt.ts, agent-ask.ts, paid-jobs.html, agent-ask-core.ts | signer test ARCH-668, console-signer (verify-receipt OK with mandate), agent-ask test |

## 3. Choices where the AP2 page is not explicit (ours, stated)

1. Standalone closed mandate (no user-signed open mandate): the tenant's spending policy plays the open mandate's role;
   the agent signs both the mandate and its binding with one tenant key, so the signed JWT carries `kid`.
2. `sd_hash` = the digest of the checkout_jwt disclosure, as in the page's closed example (as read through the fetch tool).
3. `iat` / `exp` inside the mandate object (the claims table) and `iat` in the signed JWT (the example).
4. checkout_jwt = the attached form of ChainAim's merchant_authorization (design-33: the checkout is signed once).
5. Verification place (design-33 §4 had the paywall): ChainAim's signer, in the console's run step, after the paywall
   verified the payment and before any work. The paywall only forwards. Owner confirmed by "2. proceed" on the plan that
   stated it (treated as the confirmation the handoff asked for).

## 4. Estimate-first order, pinned by tests

size (console, stat only) -> signer prices and signs the checkout -> agent verifies the quote with the pinned key ->
policy says pay -> paywall 402 names the invoice -> agent signs the mandate (nonce = invoice) -> agent signs the NEAR
payment -> paywall verifies the payment, does not settle -> console asks the signer to verify the mandate -> the job runs
-> the paywall settles only a 200 -> the signer signs the receipt (records the mandate) and the settlement (invoice =
nonce, payer = tenant). A refused mandate, a missing one under `required`, or an unreachable signer settles nothing.

## 5. Not done / later

- Run-hold jobs carry no mandate (the console's run step is where it is checked; run-hold has none). Estimate-first is the
  default.
- A release retried after a run whose settlement failed answers the held result without a second mandate check (as
  before: the first run's mandate was verified).
- Stage 3 (paywall/relayer to the control plane, release locally), Stage 4 (signer in a TEE): roadmap.
- The paywall's spawn tests (agent-jobs.test.ts start the agent service) could not run in this chat's Linux shell (agent
  start-up takes ~40 s there against their 20-30 s limits); they run on the PC (-Test).

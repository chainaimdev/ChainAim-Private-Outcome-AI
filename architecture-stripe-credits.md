# ChainAim private AI: Stripe credit top-ups as a second way to pay paid jobs (USDC on NEAR unchanged) — Architecture

Build plan for a second way to pay a tab 03 paid job: next to **"Pay with USDC on NEAR"** (built, live-proven 2026-11-05), a
tenant can **top up credits with Stripe** (card, wallet or bank, on Stripe's hosted Checkout page) and **pay jobs from that
credit balance**. US tenants first; India (Razorpay) is a later plan that reuses the same ledger.

Written 2026-11-23. **[read]** = read in the repository on that date. **[owner]** = manual step, or proven by the owner.
**[verify]** = not yet proven, checked first in the build (section 5). **[proposed]** = a default the owner can change. No mocks in
product code; what cannot be proven locally is an owner step with a live acceptance.

Requirement IDs: **ARCH-801 … ARCH-819** (ARCH IDs up to ARCH-737 are taken).

## 1. Decisions (owner)

- **USDC on NEAR stays exactly as it is.** Credits are an additional option, chosen per job: "Pay with USDC (Intear)" or
  "Pay from credits".
- **US first, Stripe only.** Razorpay, India, login and AWS are separate plans (section 11).
- **Hosted Stripe Checkout** for every top-up. Card details are typed on Stripe's page, never on ChainAim's.
- **Credits are the same units as the quote:** 6-decimal USD base units, the `amount` that `cost.ts` already produces
  (1 USD = 1,000,000 units). A job costs the same number whichever way it is paid.
- **Fixed top-up options, set by the server:** $5, $20, $50, default $20 **[proposed]**. The browser never sends an amount.
- **No personal or health data in Stripe:** metadata holds only `tenant_id` and `topup_id`; the product is "ChainAim credits".
- **Stripe sandbox first.** Live keys are a later owner step after every case in section 7 passes.
- **Off by default everywhere:** nothing starts or changes unless credits are switched on (`-Credits on`, `CREDITS=on`).
- **No hardcoding:** every URL, port, amount, tenant and timeout is a flag or a setting with a default; keys by NAME only.

## 2. What a credit payment is, next to USDC

| | USDC on NEAR (today) | Credits (this build) |
|---|---|---|
| Money in | per job, from the buyer's wallet | in advance, a Stripe top-up ($5/$20/$50) |
| Price of a job | `cost.ts` quote, `amount` in 6-decimal units | the same quote, the same `amount` |
| NEAR gas fee in the quote | yes (`--near-gas-fee-usd`) | no (0) |
| What pays the job | a signed NEP-366 delegate, settled by x402 | a ledger debit in one database transaction |
| Route | `POST /v1/jobs/<id>/release` (x402) | `POST /v1/jobs/<id>/pay-credits` (internal key) |
| Proof | NEAR transaction hash | ledger entry id + Stripe event id of the top-up |
| Failed job | refund on chain (upfront flow, ca-control-signer) | credits returned by a ledger entry |
| Seen in | near-watch Jobs tab | admin UI Credits tab (ARCH-815) |

## 3. Facts this plan relies on

| # | Fact | Source |
|---|---|---|
| F1 | Stripe sandbox account "New business · sandbox" works: a $20 test payment (card 4242…) succeeded, card 4000…0002 was declined, a refund went through, and `stripe listen` showed the events. Stripe CLI 1.55.14 is installed in `C:\tools\stripe` and logged in to the sandbox. | owner, 2026-11-23 |
| F2 | `cost.ts` returns `totalUsd` (exactly 6 decimals) and `amount` (the same in 6-decimal base units); fees are `perModelCallUsd`, `analystUsd`, `nearGasUsd`, `marginPct`, `minPriceUsd`; exact BigInt arithmetic; fails closed. | `packages/crossask/src/cost.ts` header [read] |
| F3 | The console registers a quoted job with the paywall (`registerJob`) and refuses the answer unless the offer's network starts with `near:`. | `test-console/console/jobs.ts` line 275 [read] |
| F4 | Paywall middleware order: body limit (4 MiB), then the chat capacity guard, then `POST /internal/jobs`, then the x402 payment middleware; `POST /v1/jobs/:id/release` is registered when paid jobs are on. A route not in the x402 routes config is not asked to pay. | `services/paywall/src/app.ts` lines 481–570 [read] |
| F5 | `JobBook` keeps `{jobId, amount, expiresAt, run?}` in memory, ids, amounts and times only; the result is read from the console's internal listener (`PAID_JOBS_RESULT_URL`, `http://console-api:8731` in compose). | `services/paywall/src/jobs.ts`, `docker-compose.yml` [read] |
| F6 | `PAY_RAILS` accepts only `xrpl`, `near` or `xrpl,near`. | `services/paywall/src/config.ts` lines 279–284 [read] |
| F7 | The console relays `POST /paid/jobs/<id>/release` to the paywall, checks the Host header (`hostOk`), and logs status, job id and timing only. The manual pay box sends **no tenant**. | `test-console/console/server.ts` lines 1350–1382 [read] |
| F8 | The paywall image is `node:24-slim` with `npm ci`; the paywall already has runtime dependencies (Hono, x402, near-js). | `services/paywall/Dockerfile`, `package.json` [read] |
| F9 | near-watch stores in SQLite through Node's built-in `node:sqlite` (Node 24). | `chainaim-adminUI-NEAR/README.md` [read] |
| F10 | The paywall publishes `127.0.0.1:8080` only, on the network `chainaim-test`. | `docker-compose.yml` [read] |
| F11 | Dependency rule: an app (`test-console`) must not import a service (`services/paywall`); apps call services over HTTP. | `config/deps/rules.json` (per `architecture-tab03-agent-mode.md` F7) |
| F12 | `up.ps1` reads secrets from `C:\PRIV-AI-SECRETS` through allowlists and passes names, not values, to compose. | `architecture-tab03-agent-mode.md` F13 |
| F13 | Repository rules: every requirement has an ARCH-ID and a test named with it; every new environment variable goes into `MANUAL_SETUP.md` in the same change; one consolidated `desk.ps1` command for the owner. | `CLAUDE.md` [read] |

## 4. Design

```
PC                                        Docker network chainaim-test
──                                        ────────────────────────────
Browser ─▶ UI 8730 (tab 03)
  Pay box: ( ) USDC on NEAR (Intear)   — unchanged
           ( ) Credits  Balance $19.95  [Top up $5 | $20 | $50]
   │
   ▼
                                ca-console-api :8735
                                  POST /credits/checkout ─────────┐
                                  GET  /credits/balance ──────────┤ internal key
                                  POST /paid/jobs/<id>/pay-credits┤
                                                                  ▼
                                ca-paywall :8080 (127.0.0.1 on the PC)
                                  credits/ledger.ts  (node:sqlite, volume chainaim-credits)
                                  POST /v1/credits/checkout   → Stripe API: create Checkout Session
                                  POST /v1/webhooks/stripe    ← Stripe events (signature checked)
                                  POST /v1/jobs/<id>/pay-credits → debit, read result from console :8731, release

Stripe sandbox ──webhook──▶ stripe listen (PC) ──forward──▶ http://127.0.0.1:8080/v1/webhooks/stripe
```

### Top-up

1. Tenant clicks **Top up $20**. Console → paywall `POST /v1/credits/checkout {tenant, option: 20}`.
2. Paywall records a **pending top-up** `{topup_id, tenant_id, units: 20000000}`, creates a Checkout Session
   (`mode=payment`, USD 2000 cents, `client_reference_id=topup_id`, metadata `{tenant_id, topup_id}`) and returns its URL.
3. Tenant pays on Stripe's page and returns to `…/?topup=<topup_id>`; the page polls the balance.
4. Stripe sends `checkout.session.completed`. The paywall checks the signature, stores the event id, finds the pending top-up
   by `topup_id` and credits **the units stored at step 2**, never an amount read from the event.

### Paying a job from credits

1. The job is quoted and held as today (`POST /jobs/crossask`), registered with `rail: "credits"`, `nearGasUsd = 0`.
2. Tenant clicks **Pay from credits**. Console → paywall `POST /v1/jobs/<id>/pay-credits {tenant}`.
3. Paywall checks the job is open and not expired, debits `amount` in one transaction (refused if the balance is too low),
   reads the held result from the console, marks the job released, returns the result.
4. If reading or running the job fails after the debit, a **return** entry gives the credits back.

### Refund

Stripe sends `charge.refunded`. The paywall finds the top-up through the payment and writes a **reversal** of the refunded
units. The balance may not go below zero: if the credits were already spent, the reversal is recorded as owed and the
tenant cannot pay from credits until topped up again.

## 5. Verify first (before any code) [verify]

| # | Check | How |
|---|---|---|
| V1 | Exact pinned version of Stripe's official Node library (`stripe`) that runs on `node:24-slim` | install in a scratch folder, run a Checkout Session create against the sandbox |
| V2 | Hono gives the **raw** body for signature checking (`c.req.text()` before any JSON parse) through the existing body limit | a test with a signed sample event |
| V3 | `stripe listen --forward-to http://127.0.0.1:8080/v1/webhooks/stripe` reaches the paywall container from Windows | live, sandbox |
| V4 | `stripe listen --print-secret` prints only the signing secret, so `up.ps1` can capture it into the environment without showing it | live, owner watches |
| V5 | Event names on this account's API version for refunds and bank payments (`charge.refunded`, `checkout.session.async_payment_succeeded`, `…_failed`) | `stripe trigger` + dashboard |
| V6 | `node:sqlite` in `node:24-slim` without extra flags | container start |
| V7 | Adaptive Pricing (enabled on the sandbox) does not change what is credited; owner decides whether to turn it off for top-ups | one top-up with a non-US test card |

## 6. Components

| Component | Where | New / changed |
|---|---|---|
| Credit ledger | `services/paywall/src/credits/ledger.ts` | new |
| Stripe client wrapper | `services/paywall/src/credits/stripe.ts` | new |
| Credit routes | `services/paywall/src/credits/routes.ts`, mounted in `app.ts` outside the x402 routes | new + small change |
| Configuration | `services/paywall/src/config.ts` (`CREDITS`, `STRIPE_*`, `CREDITS_*`) | changed, additive |
| Pay-from-credits release | `services/paywall/src/credits/release.ts`, uses `JobBook` | new |
| Per-rail fees | `packages/crossask/src/cost.ts` callers in the console (`nearGasUsd` only for NEAR) | changed |
| Job registration | `test-console/console/jobs.ts` `registerJob` (rail `near` or `credits`) | changed |
| Console routes | `test-console/console/server.ts` | new routes |
| Tab 03 pay box | `test-console/console/paid-jobs.html` | changed |
| Receipt | `packages/receipt` (`rail`, ledger entry id) | changed |
| Job feed events | console job feed → near-watch `/ingest/job` (admin repo accepts new kinds) | changed, both repos |
| Admin Credits tab | `chainaim-adminUI-NEAR` | new, separate change |
| Start and secrets | `test-console/up.ps1`, `desk.ps1`, `docker-compose.yml` | changed |
| Docs | `MANUAL_SETUP.md`, `cmd.md`, this file | changed |

## 7. Requirements

### ARCH-801 — Off by default, nothing else changes
With `CREDITS` unset or `off`, no credit route is mounted, no Stripe call is made, no database is opened, and every existing
suite passes unchanged (root, analyst, paywall, gateway, console, admin UI). Test: the paywall's route list with credits off
equals today's.

### ARCH-802 — Configuration by name
Paywall: `CREDITS=on|off`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CREDITS_DB_PATH` (default `/data/credits/credits.sqlite`),
`CREDITS_TOPUP_OPTIONS_USD` (default `5,20,50`), `CREDITS_CURRENCY` (default `usd`), `CREDITS_RETURN_URL`,
`CREDITS_TENANTS` (tenants allowed to use credits, e.g. `t-us-test`), `CREDITS_KEY_ENV` (name of the variable holding the
internal key, default `PAID_JOBS_KEY`). A secret key that does not start with `sk_test_` is refused unless
`CREDITS_LIVE=on` **[proposed]**. Errors name variables, never values. Every name goes into `MANUAL_SETUP.md`.

### ARCH-803 — Ledger
Tables: `topups(topup_id, tenant_id, units, status, checkout_session_id, payment_intent_id, created_at)`,
`entries(entry_id, tenant_id, kind, units, ref, created_at)` with kind `topup | spend | return | reversal`, and
`stripe_events(event_id PRIMARY KEY, type, received_at)`. Balance = sum of entries. Units are 6-decimal integers as text,
added with BigInt (no floating point, like `cost.ts`). A spend runs in one transaction and is refused when it would take
the balance below zero. Ids, units and times only; never a question, a result or a name.

### ARCH-804 — Top-up route
`POST /v1/credits/checkout` (internal key, JSON `{tenant, option}`): option must be one of `CREDITS_TOPUP_OPTIONS_USD`,
tenant one of `CREDITS_TENANTS`. Creates the pending top-up, then a Checkout Session with `client_reference_id = topup_id`
and metadata `{tenant_id, topup_id}`, success URL `CREDITS_RETURN_URL?topup=<id>`. Answers `{url, topupId}`.

### ARCH-805 — Webhook route
`POST /v1/webhooks/stripe`, not behind the x402 middleware and not behind the internal key. Reads the raw body, checks the
`Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET` (Stripe library, default tolerance), answers 400 on failure and
records the refusal by type and time only. Stores each event id once; a repeat answers 200 and changes nothing.
`checkout.session.completed` with `payment_status = paid` → credit the pending top-up's units;
`checkout.session.async_payment_succeeded` → credit; `checkout.session.async_payment_failed` → top-up `failed`;
`charge.refunded` → reversal (ARCH-807). Other types answer 200 and are ignored.

### ARCH-806 — Balance route
`GET /v1/credits/balance?tenant=` (internal key): `{tenant, balanceUnits, balanceUsd, owedUnits}`.

### ARCH-807 — Refunds
On `charge.refunded`, the newly refunded amount (in cents, against what was already reversed for that payment) becomes a
reversal of the matching units. If the balance is lower than the reversal, the remainder is recorded as owed and credits
cannot be spent until it is cleared by a new top-up.

### ARCH-808 — Pay a job from credits
`POST /v1/jobs/:id/pay-credits` (internal key, `{tenant}`): the job must be open in `JobBook`, registered with rail
`credits`, not expired (same clock-skew rule as today). One transaction debits `amount`; then the result is read from the
console's internal listener exactly as `release` does; the job is marked released. Any failure after the debit writes a
`return` entry. A second call for the same job answers 409 with nothing debited.

### ARCH-809 — Per-rail quote
A job registered for credits is priced with `nearGasUsd = 0`; all other fees, the margin and the minimum price are unchanged.
The quote shown names the rail.

### ARCH-810 — Console routes
`POST /credits/checkout`, `GET /credits/balance`, `POST /paid/jobs/<id>/pay-credits`: Host-checked like the existing guarded
routes, relayed over HTTP to the paywall with the internal key (F11), logging route, tenant, ids, status and time only.

### ARCH-811 — Tenant identity (until login exists)
The tenant comes from the console's setting `--credits-tenant` (and must be in `CREDITS_TENANTS`), never from the browser.
Credit routes refuse to run unless the console binds to loopback. Production requires the login plan (section 11) before
`CREDITS_LIVE=on`.

### ARCH-812 — Tab 03 pay box
Shows the existing NEAR option unchanged, plus "Pay from credits" with the balance and Top up buttons for each option. After
returning from Stripe it polls the balance until the top-up is credited or 60 s pass **[proposed]**, then says so. Messages
are worded to build confidence, per the UI rule.

### ARCH-813 — No personal data at Stripe
Product name "ChainAim credits"; metadata and description hold only `tenant_id` and `topup_id`. No question text, dataset,
file or person name is ever sent. Test: a recorded Checkout Session request body contains no other fields.

### ARCH-814 — Receipt
A job paid from credits gets the same signed receipt with `rail: "credits"` and the ledger entry id in place of a NEAR
transaction. `scripts/verify-receipt.ts` accepts both rails.

### ARCH-815 — Admin view (admin repo, separate change)
The console's job feed sends `credit_topup`, `credit_spend`, `credit_return`, `credit_reversal` (ids and units only) to
near-watch; near-watch stores them; the admin UI gets a Credits tab with balance per tenant and the entries, totals beside
the Stripe dashboard's for the same period.

### ARCH-816 — One command
`desk.ps1 -Credits on|off` (default off). With on, `up.ps1` reads `STRIPE_SECRET_KEY` from
`C:\PRIV-AI-SECRETS\payments-test.env` through an allowlist, captures the signing secret from
`stripe listen --print-secret` into the paywall's environment without printing it (V4), starts
`stripe listen --forward-to http://127.0.0.1:8080/v1/webhooks/stripe` in its own window, and adds the credits volume.
`desk.ps1 -Check` reports credits on/off and whether the listener is running, never a key.

### ARCH-817 — Tests
Ledger (credit, spend, refuse below zero, return, reversal, owed); webhook (good signature, bad signature, repeat event,
each event type) using the Stripe library's test signature helper; checkout (option and tenant checks, no extra metadata);
pay-credits (open, expired, twice, failure returns credits); console routes (Host check, no tenant from the body); a guard
that credits-off leaves the route list unchanged. Each test name carries its ARCH-ID.

### ARCH-818 — Live proof in the sandbox [owner]
With `desk.ps1 -All -Credits on`: top up $20 with `4242 4242 4242 4242` → balance $20.00; pay a job from credits → balance
drops by the quote, receipt shows `rail: credits`; card `4000 0000 0000 0002` → no credit; refund in the dashboard →
reversal; repeat an event from the dashboard → credited once; the NEAR option still pays a job as before.

### ARCH-819 — Manual setup entries
`MANUAL_SETUP.md` gets: the Stripe sandbox account, the secrets file `payments-test.env` with `STRIPE_SECRET_KEY`, the Stripe
CLI location and login, the payment methods to switch on in the dashboard, and the rule that test and live keys never share
a file or are pasted anywhere.

## 8. AI work vs owner work

| Item | AI | Owner |
|---|---|---|
| Section 5 checks | runs V1, V2, V5, V6 | V3, V4, V7 live, decides on Adaptive Pricing |
| ARCH-801 … 817 | writes code and tests, runs all suites | reviews |
| Secrets | names only | puts `STRIPE_SECRET_KEY` in `C:\PRIV-AI-SECRETS\payments-test.env` |
| ARCH-818 | gives the one command | runs it, confirms each result |
| Stripe dashboard | lists what to switch | switches payment methods on or off |
| Commits and pushes | gives one command | runs it |

## 9. Build order

1. Section 5 checks.
2. ARCH-802, 803 ledger and configuration, with tests.
3. ARCH-804 top-up route; ARCH-805, 807 webhook and refunds, proven with `stripe listen` and `stripe trigger`.
4. ARCH-806 balance; ARCH-808, 809 pay a job from credits.
5. ARCH-810, 811, 812 console routes and tab 03 pay box.
6. ARCH-813, 814 privacy check and receipts.
7. ARCH-816 `desk.ps1 -Credits`; ARCH-819 manual setup.
8. ARCH-817 full test run; ARCH-818 live proof.
9. ARCH-815 admin Credits tab in `chainaim-adminUI-NEAR`.

## 10. Security checklist

- Amounts come only from `CREDITS_TOPUP_OPTIONS_USD` and the stored quote; the browser sends an option, never a number.
- Webhook: signature checked on the raw body, event ids stored once, 2xx answered quickly, failures logged without payloads.
- The webhook route is the only credit route reachable without the internal key, and it changes nothing without a valid signature.
- Balance can never go negative; every change is an entry (append only), so the balance can be rebuilt and audited.
- Stripe secrets by name only; test keys refused in live mode and live keys refused unless `CREDITS_LIVE=on`.
- Only ids and units in logs, the job feed and Stripe metadata.

## 11. Out of scope (separate plans)

- Login (Cognito), tenant from the token, roles: required before `CREDITS_LIVE=on`.
- Razorpay and Indian tenants; regions in AWS; Postgres in place of SQLite.
- The AI agent (agent mode) paying from credits, with the agent-policy caps.
- Stripe Tax, invoices, subscriptions, Managed Payments.
- Moving credits between tenants, credit expiry, promotional credits.

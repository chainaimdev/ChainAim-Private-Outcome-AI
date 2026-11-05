# ChainAim private AI: pay-after-quote for "Private Chat and AI (Across Files)" in NEAR USDC — Architecture

Build plan for option A ("run, hold, quote, pay, release") on tab 03 of the test console (port 8730), paid in USDC on NEAR TestNet through x402.
Written 2026-11-05. Every fact marked **[read]** was read in this repository or in the published package named, on 2026-11-05.
Every item marked **[owner]** is a manual step. Nothing here is a mock: anything that cannot be proven locally is an owner step with a live acceptance.

## 1. What this is

Today tab 03 ("Private Chat and AI (Across Files)") runs `crossAsk` for free: the analyst reads the CSVs on this PC, a model writes one SQL query from the column names, the query runs locally, and an optional second model words the answer through the gateway (Presidio mask, residual check, model, restore, number check).
This build makes that tab pay-after-quote: the job runs exactly as today, the console meters every model call and computes **one total in USD**, holds the result, and shows only the cost. The client pays that exact amount in USDC on NEAR with the Intear Wallet (x402 `exact`, NEP-366 delegate, ChainAim's relayer pays the gas). The result is released only after the payment has settled.

## 2. Stack and constraints

- Language / runtime: TypeScript run directly by Node (as today; the gateway keeps **no** npm runtime dependencies).
- Paywall: Hono + `@x402/hono` / `@x402/core` / `@x402/near` **2.29.0** [read: `services/paywall/package.json`].
- Web bundle: `services/web` (`@hot-labs/near-connect` 0.12.0, `@x402/near` 2.29.0) [read].
- Test runner: `node --test` per package (as today; see "Baseline" in §6).
- Must run on: Windows (owner PC, Docker Desktop for presidio, gateway, paywall) and Linux CI.
- Hard constraints:
  1. **No change to current behaviour when the new flags are off.** Every existing route, price, test and log line stays identical.
  2. **Surgical, additive edits only.** No file under `services/gateway`, `services/presidio`, `packages/route-engine` or `config/` is modified (keeps ARCH-002 of `architecture-xrpl-migration.md`).
  3. **NEAR USDC only.** XRPL stays exactly as it is; it is not offered on the new route.
  4. **No text, placeholder, placeholder map, SQL result or answer is ever written to a log, the payment log or the gateway ledger.**
  5. **Fail closed.** Missing token usage, an unpriced model or an unreachable service means no quote and nothing charged, never a guessed price.
  6. Secrets are environment variable names only (`.env.example`, `MANUAL_SETUP.md`); keys are never logged or returned.

## 3. Step 0 — facts checked before this plan (2026-11-05)

| # | Question | Finding | Source |
|---|---|---|---|
| S0-a | Does the gateway's non-streaming reply carry the provider's `usage`? | **Yes, if the provider sends it.** The non-streaming path returns the parsed upstream completion object whole (`sendJson(res, 200, result.completion)`), restored in place. | [read] `services/gateway/src/server.ts:146`, `chat.ts:389-393`, `dispatch.ts:38` `parseCompletion` |
| S0-b | Is the paid body released if settlement fails? | **No.** `@x402/hono` 2.29.0 buffers the handler's body, calls `processSettlement`, and on failure **replaces** the body with the settlement-failure response; the handler's body is sent only on success. Handler status ≥ 400 → no settlement. | [read] `@x402/hono@2.29.0` `dist/esm/index.mjs` lines 269-333 |
| S0-c | Can the price differ per request, and can a route carry an id? | **Yes.** `price` may be a function `(context: HTTPRequestContext) => Price \| Promise<Price>`, and `context.path` is given. Route patterns accept `:param` (`[^/]+`). The paywall already prices per request (`routes.ts` line 184). | [read] `@x402/core@2.29.0` `x402Client-*.d.mts` 863, 988-995; `chunk-4NCAR6KR.mjs` 1182, 3281 |
| S0-d | How does the page's NEAR payment get its quote? | `payNearChat` asks the URL itself, takes the 402's NEAR offer, and **refuses to sign** unless asset, payTo and amount equal the quote the page showed (`NEAR_PRICE_CHANGED`). It reads the paid answer with the chat reader `readAnswer`, so a non-chat body needs its own reader. | [read] `services/web/src/near-pay.ts:61-130` |
| S0-e | Can `ca-paywall` reach a service on the host? | It already does: the payment log is sent to `http://host.docker.internal:8790/ingest/claim`. The console binds `127.0.0.1` only (`server.ts:600`). Whether Docker Desktop reaches a `127.0.0.1`-bound host port is **not proven** → owner check M2. | [read] `test-console/stack.ps1:19`, `test-console/console/server.ts:600` |
| S0-f | What gas does one x402 NEAR payment burn? | Real TestNet payment `H3ZFsVY1zDSQKsL3dktYBcNHSLiE8GpR5JtytFLjnbqD`: signer `chainaim-relayer-seller.testnet` (the relayer), one `Delegate` action; total **3.772 TGas, 0.000332587 NEAR burnt**; current TestNet gas price 100,000,000 yoctoNEAR/gas. | [read] NEAR TestNet RPC `tx` and `gas_price`, 2026-11-05 |
| S0-g | Does `crossAsk` keep per-call model info? | It returns `served: ChatReply[]` (`{text, model, zone}`), but `gatewayChat` drops `usage`. | [read] `packages/crossask/src/index.ts:55-62, 187-200` |
| S0-h | Where are model prices? | `pricing.inputPerM` / `outputPerM` per model in the catalog; Bedrock Nemotron 0.0618 / 0.2472 USD per 1M tokens, local models 0. | [read] `config/catalog.bedrock.json` |

Not checked here (owner, live): **M1** Bedrock's OpenAI-compatible endpoint returns `usage` (S0-a passes it through only if present). **M2** reachability from `ca-paywall` to the console's internal listener.

## 4. Components

| Component | Change | Responsibility | Talks to |
|---|---|---|---|
| `packages/crossask` | edit (additive) | `ChatReply.usage` (optional); `gatewayChat` copies `usage` from the gateway reply | gateway 8720 |
| `packages/crossask/src/cost.ts` | **new** | Pure cost function: meter lines + fees → total USD and NEAR base units, with breakdown | — |
| Console job runner (`test-console/console/server.ts` + new `test-console/console/jobs.ts`) | edit (flag-gated) + new | `POST /jobs/crossask`: run, meter, quote, hold, register with paywall. Internal listener: `GET /internal/jobs/:id`, `POST /internal/jobs/:id/released` | analyst 8740, gateway 8720, paywall 8080 |
| Paywall jobs (`services/paywall/src/jobs.ts` new; `app.ts`, `routes.ts`, `config.ts` edits) | new + flag-gated edits | `POST /internal/jobs` intake (key); paid `POST /v1/jobs/:id/release` priced from the job; fetch held result; mark released after settle | console internal listener, NEAR relayer/RPC |
| Web NEAR bundle (`services/web/src/near-pay.ts`, `near-wallet-entry.ts`) | edit (additive exports) | `payNearRelease` / `nearPayAndRelease`: same signing and checks as `payNearChat`, JSON result reader | console relay |
| Tab 03 UI (`test-console/console/index.html`) | edit (flag-gated) | "Pay with USDC · NEAR" box, cost line, Pay button, result in the existing view | console |

## 5. Data flow

```
Page tab 03 ──POST /jobs/crossask {folder, question, model, answerModel, phrase, sql?}──▶ console 8730
  console: crossAsk (unchanged pipeline) ─▶ meter lines from served[].usage ─▶ cost.ts ─▶ total USD, amount (USDC base units)
  console: hold {jobId, result, amount, expiresAt} in memory
  console ──POST /internal/jobs {jobId, amount, expiresAt} (key)──▶ paywall 8080 JobBook
Page ◀── {jobId, total, amount, network, asset, payTo, expiresAt}   (no result)

Page "Pay" ─▶ nearPayAndRelease ─▶ console POST /paid/jobs/:id/release (relay, no key added) ─▶ paywall POST /v1/jobs/:id/release
  paywall pre-check: job known, not expired, not released (else 404 / 410 / 409, nothing quoted)
  402: one NEAR offer, amount = job amount, invoice bound to the job
  Intear signs NEP-366 delegate (page checks offer == shown quote) ─▶ resend with PAYMENT-SIGNATURE
  paywall: verify ─▶ handler GET console /internal/jobs/:id (key) ─▶ settle (relayer submits, pays gas)
     settle ok  ─▶ body released + PAYMENT-RESPONSE; onAfterSettle: payment_settled line, JobBook released,
                   POST console /internal/jobs/:id/released (console drops the result)
     settle bad ─▶ settlement-failure body (S0-b); job stays held until expiry; nothing released
Page ◀── result rendered in the existing tab 03 view + nearblocks tx link
near-watch (adminUI-NEAR) sees the payment_settled claim and the chain transfer as today (no change there).
```

## 6. External dependencies

| Service | Used for | Real local option | Credential |
|---|---|---|---|
| Presidio, gateway, paywall containers | masking, routing, payment | `test-console\stack.ps1` (as today) | `CHAINAIM_GATEWAY_KEY` (existing) |
| Analyst | tab 03 data | `test-console\start-analyst.cmd` (as today) | none |
| NEAR TestNet RPC + USDC contract | price check at start, settlement | public RPC (as today) | relayer key `NEAR_RELAYER_KEY_TESTNET` (existing) |
| Intear Wallet (browser) | buyer signature | none — real wallet | owner's TestNet account with USDC |
| Amazon Bedrock (mode `bedrock`) | model, if chosen | local Ollama models (price 0) | `BEDROCK_API_KEY` (existing) |

Baseline (run before the first edit and after every task, all must pass unchanged; commands from PROJECT_CONTEXT.md):
`npm test`, `npm run test:paywall`, `npm run test:engine`, `npm --prefix packages/crossask test`, `npm --prefix services/analyst test`, `npm --prefix services/web test`, `npm --prefix packages/actus test`, `npm --prefix services/lending test`, `npm --prefix services/lending run typecheck`.

---

# Requirements

IDs start at **ARCH-101** so they never collide with `ARCH-001…018` of `architecture-xrpl-migration.md`, which existing tests already carry.

### ARCH-101 — Off by default, nothing else changes
**Requirement:** With `PAID_JOBS` unset (paywall) and `--paid-jobs` absent or `off` (console), the paywall's route table, prices, 402 bodies, log lines and the console's routes and page MUST be byte-for-byte what they are today. No file in `services/gateway`, `services/presidio`, `packages/route-engine`, `config/` is modified.
**Acceptance:** The full baseline (§6) passes with the same counts as before the build, recorded in BUILD_LOG.md before and after. Test `ARCH-101: routesConfig without PAID_JOBS equals today's` compares the route table keys and offers to the pre-build snapshot. Test `ARCH-101: console page without --paid-jobs has no pay box in tab 03`.

### ARCH-102 — Token usage is carried, not dropped
**Requirement:** `ChatReply` gains an optional `usage: { promptTokens: number; completionTokens: number }`. `gatewayChat` fills it from the gateway reply's `usage.prompt_tokens` / `usage.completion_tokens` when both are non-negative integers, and leaves it undefined otherwise. Existing callers and fields are unchanged.
**Acceptance:** `npm --prefix packages/crossask test`: `ARCH-102: gatewayChat copies usage` (real HTTP server returning a completion with usage) and `ARCH-102: gatewayChat without usage leaves it undefined`; all existing crossask tests pass unchanged.

### ARCH-103 — One total cost, computed, never guessed
**Requirement:** `cost.ts` exports `quoteJob(meter, prices, fees)` where `meter` is one line per model call `{model, promptTokens, completionTokens}`, `prices` maps model id → `{inputPerM, outputPerM}` (read from the catalog given by `--pricing-catalog`), and `fees` = `{perModelCallUsd, analystUsd, nearGasUsd, marginPct, minPriceUsd}`.
Total USD = Σ(promptTokens × inputPerM + completionTokens × outputPerM) / 1e6 + calls × perModelCallUsd + analystUsd + nearGasUsd, then × (1 + marginPct/100), then max(…, minPriceUsd), then rounded **up** to 6 decimals; the NEAR amount is that value in USDC base units (6 decimals), computed with exact integer arithmetic on decimal strings, never floating point. `cost.ts` does not import from `services/paywall` (the dependency rules in `scripts/check-deps.ts` apply); a test checks it gives the same base units as the paywall's `usdToBaseUnits` for the same inputs. A model id ending `:free` (OpenRouter free pool, as `routing/freepool.ts` filters them) is priced 0. It MUST throw — and the job MUST NOT be quoted or held — when a call has no usage or its model has no price. It returns `{totalUsd, amount, breakdown}`; the breakdown is kept with the job, the page shows only the total.
**Acceptance:** `ARCH-103:` tests in `packages/crossask`: worked example with Nemotron prices from `config/catalog.bedrock.json`; rounding up at the 7th decimal; min price applied; `:free` priced 0; throws on missing usage; throws on unpriced model; zero model calls (user-typed SQL, phrase none) = fees only.

### ARCH-104 — Console creates a paid job and returns only its cost
**Requirement:** With `--paid-jobs on`, the console serves `POST /jobs/crossask` (same body as `/crossask`, same 127.0.0.1 host check). It runs `crossAsk` unchanged, builds the meter from `served[]`, calls `quoteJob`, holds `{jobId (128-bit random hex), result, amount, breakdown, expiresAt}` in memory, registers `{jobId, amount, expiresAt}` with the paywall (ARCH-106), and answers `{jobId, totalUsd, amount, network, asset, payTo, expiresAt}` — never the result. If `crossAsk` errors, the quote throws, or registration fails, it answers an error, holds nothing, and nothing can be paid. Limits: `--job-ttl-min` (default 15), `--job-max` (default 100 open jobs; over it → 503). `/crossask` is unchanged.
**Acceptance:** `ARCH-104:` tests in `scripts/test/` against real local HTTP servers (an analyst and gateway started from their real code with the stand-in models the existing console tests use, and a paywall built by `buildApp`): the response has no `result`, `answer`, `sql` or rows; the held job is retrievable only via ARCH-105; registration failure → error and no held job; expiry removes the job.

### ARCH-105 — Console internal listener
**Requirement:** With `--paid-jobs on` the console opens a second listener on `--jobs-internal-host` (default `127.0.0.1`) and `--jobs-internal-port` (default `8731`), serving only `GET /internal/jobs/:id` (returns `{jobId, result}`) and `POST /internal/jobs/:id/released` (drops the job). Both require header `x-jobs-key` equal to the env var named by `--paid-jobs-key-env` (default `PAID_JOBS_KEY`, ≥ 24 chars; start-up refuses otherwise). Wrong or missing key → 401; unknown or expired job → 404. The browser-facing listener on 8730 is unchanged.
**Acceptance:** `ARCH-105:` tests: 401 without key, 401 wrong key, 404 unknown, 200 with result, released → later GET 404; start-up error text when the key env is unset or short.

### ARCH-106 — Paywall job intake
**Requirement:** With `PAID_JOBS=on`, the paywall accepts `POST /internal/jobs` with header `x-jobs-key` = `PAID_JOBS_KEY` (≥ 24 chars). Body `{jobId, amount, expiresAt}` is validated (jobId 32 hex chars, amount a positive integer string of USDC base units, expiresAt in the future and ≤ `PAID_JOBS_TTL_SEC` from now). It stores the job in a `JobBook` capped at `PAID_JOBS_MAX` (default 1000). `PAID_JOBS=on` without the NEAR rail in `PAY_RAILS`, without `PAID_JOBS_KEY`, or without `PAID_JOBS_RESULT_URL` stops start-up with what to set. The key is never logged.
**Acceptance:** `npm run test:paywall`: `ARCH-106:` 401 without/with wrong key, 400 per invalid field, 201 stored, 503 at the cap, start-up errors for each missing variable, and a log capture showing the key never appears.

### ARCH-107 — Paid release route, priced from the job, NEAR only
**Requirement:** With `PAID_JOBS=on`, `POST /v1/jobs/:id/release` is paid. A guard **before** the payment middleware answers 404 (unknown), 410 (expired) or 409 (already released) with no 402 and nothing charged. The route offers exactly one option: NEAR, `asset` = `NEAR_USDC_CONTRACT_*`, `payTo` = `NEAR_PAY_TO_*`, `amount` = the job's amount, through the existing NEAR rail (`src/near/rail.ts`, facilitator and relayer unchanged).
**Acceptance:** `ARCH-107:` tests: 404/410/409 cases return no `payment-required` header; a known job's 402 has one NEAR offer with the job's amount; two jobs with different amounts get different 402 amounts.

### ARCH-108 — The result is released only after settlement
**Requirement:** The release handler fetches the result from `PAID_JOBS_RESULT_URL` + `/internal/jobs/:id` with `x-jobs-key` and returns it as `application/json`; if that fetch fails it answers 502 (no settlement, per S0-b). Settlement failure MUST NOT release the result (relies on S0-b, proven by test).
**Acceptance:** `ARCH-108:` tests with the paywall's existing NEAR JSON-RPC protocol double and real ed25519-signed delegates (the same double the NEAR rail tests use today): settle success → 200 body equals the held result and has `payment-response`; settle failure → response body does not contain the result; result fetch failure → 502 and no settle call recorded.

### ARCH-109 — One payment pays one job
**Requirement:** The invoice id in the job's 402 is bound to that job; a payment whose `accepted.extra.invoiceId` was issued for another job, or for another route, is refused before verification. The existing once-only guards (`InvoiceBook`, `SeenPayments`) stay in force.
**Acceptance:** `ARCH-109:` tests: a delegate signed for job A presented to job B → refused, not settled; the same delegate presented twice to job A → second refused (`payment_already_used`).

### ARCH-110 — After settlement
**Requirement:** On successful settlement the existing `payment_settled` line is written unchanged in shape (route `POST /v1/jobs/<id>/release`, amount, asset, network, payer, transaction, invoiceId when the sink is on). The `JobBook` marks the job released, and the paywall calls `POST /internal/jobs/:id/released` on the console; a failure there is logged as `job_release_notify_failed` (job id and reason only) and the console's TTL still removes the job.
**Acceptance:** `ARCH-110:` tests: the log line matches today's schema; a second release call → 409; the console's job is gone after settlement; notify failure produces the log line and nothing else.

### ARCH-111 — Browser: pay exactly what was shown
**Requirement:** `services/web/src/near-pay.ts` gains `payNearRelease(deps, accountId, quote, releaseUrl)` reusing the existing private steps of `payNearChat` (decode 402, pick the NEAR offer, refuse unless asset/payTo/amount equal the shown quote, sign with the wallet, check the signed delegate, resend) and returning `{result, transaction}` or the same `Failure` messages. `near-wallet-entry.ts` exports `nearPayAndRelease`. `payNearChat`, `nearPayAndChat` and their messages are unchanged. The bundle is rebuilt with `npm --prefix services/web run build:near-wallet`.
**Acceptance:** `npm --prefix services/web test`: `ARCH-111:` tests with real ed25519-signed delegates: amount mismatch → `NEAR_PRICE_CHANGED`, nothing signed; success returns the JSON result and tx; all existing web tests pass unchanged.

### ARCH-112 — Tab 03 UI
**Requirement:** With `--paid-jobs on` and `--near-wallet intear-wallet`, tab 03 shows "Pay with USDC · NEAR". Ticked: Ask calls `/jobs/crossask` and shows "Total cost <total> USDC (expires <time>)" and a Pay button; Pay calls `nearPayAndRelease` via the console relay `POST /paid/jobs/:id/release` (relayed to the paywall without the gateway key, like `/paid/chat`); the released result is rendered by the existing tab 03 renderer, plus the nearblocks link. Unticked or flags off: tab 03 behaves as today. The result is kept in page memory only.
**Acceptance:** `ARCH-112:` tests in `scripts/test/` (same style as `console-near.test.ts`): relay adds no gateway key; box absent without the flags; page script calls `/jobs/crossask` only when ticked. Live: M3.

### ARCH-113 — Nothing sensitive leaves through logs or the admin path
**Requirement:** No new log line, payment log line or HTTP error body contains a question, SQL, rows, answer, placeholder, key or file path. Only job id, amounts, network, tx hash, status and reason codes.
**Acceptance:** `ARCH-113:` test runs a full job with a question and rows containing a synthetic marker string and asserts the marker appears in no captured log output of console or paywall.

### ARCH-114 — Fees are configured, never defaulted
**Requirement:** With `--paid-jobs on`, the console requires `--pricing-catalog`, `--fee-per-model-call-usd`, `--fee-analyst-usd`, `--near-gas-fee-usd`, `--margin-pct`, `--min-price-usd` (non-negative decimals; start-up error naming the missing flag). MANUAL_SETUP.md records how `--near-gas-fee-usd` is derived: measured gas from S0-f (0.000332587 NEAR per payment on TestNet, 2026-11-05) × the owner's chosen NEAR/USD rate × the owner's buffer.
**Acceptance:** `ARCH-114:` one start-up test per missing flag; MANUAL_SETUP.md entry present.

### ARCH-115 — Live proof on TestNet [owner]
**Requirement:** One real paid tab 03 job on NEAR TestNet.
**Acceptance:** Owner run, evidence in BUILD_LOG.md: page shows the total; Intear approval; result shown; nearblocks shows the USDC transfer of exactly that amount to `NEAR_PAY_TO_TESTNET`, signed by the relayer; paywall log has `payment_settled` for `POST /v1/jobs/<id>/release`; adminUI-NEAR near-watch shows the claim `matched`. Plus M1 and M2 below.

---

## Owner steps (manual, given one at a time during the build)

| ID | Step | Proves |
|---|---|---|
| M1 | One tab 03 run in mode `bedrock`, answer model Bedrock; console prints the meter line | Bedrock returns `usage` through the gateway |
| M2 | Start the console with `--paid-jobs on`; from inside `ca-paywall`, request `http://host.docker.internal:8731/internal/jobs/x` | Docker Desktop reaches the internal listener (404 expected). If not: set `--jobs-internal-host` to the host's Docker interface address and repeat |
| M3 | ARCH-115 live run | End to end |
| M4 | Set `PAID_JOBS`, `PAID_JOBS_KEY`, `PAID_JOBS_RESULT_URL`, `PAID_JOBS_TTL_SEC`, `PAID_JOBS_MAX` on `ca-paywall` (stack.ps1) and the same key in the console's environment | Configuration |
| M5 | Check the relayer `chainaim-relayer-seller.testnet` NEAR balance before the live run | Relayer can pay gas |

Never paste `PAID_JOBS_KEY`, the relayer key or any wallet key into a chat.

## Build order (each task: snapshot, code, tests, baseline, BUILD_LOG entry)

1. Baseline run, recorded (ARCH-101 "before").
2. ARCH-102 → ARCH-103 (crossask, pure code).
3. ARCH-106 → ARCH-107 → ARCH-109 → ARCH-108 → ARCH-110 (paywall).
4. ARCH-104 → ARCH-105 → ARCH-114 (console runner).
5. ARCH-111 (web bundle) → ARCH-112 (tab 03).
6. ARCH-113, then ARCH-101 "after" (full baseline).
7. Owner: M4, M2, M1, M5, M3/ARCH-115.

## Out of scope

- XRPL / RLUSD on the new route (later; must then work with the same JobBook and cost).
- Options B (x402 `upto`) and C (estimate first) — revisit after this build is checked working.
- adminUI-NEAR "Jobs" tab and process-step view, relayer balance alert, two payment-log targets — after private chat works and basic testing is done.
- TEE wallet (OutLayer custody) and the `chain-core` signer interface change.
- Running the pipeline inside a TEE with attestation (second enhancement).
- Re-fetching a released result after the page lost it (the result is sent once, in the settling response).
- Tab 02, tab 01, `/crossask`, `/packask`, "Show how the files relate": unchanged and free as today.

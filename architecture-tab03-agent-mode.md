# ChainAim private AI: tab 03 "agent mode" — a Strands agent pays the paid job in NEAR USDC — Architecture

Build plan for a second way to pay in tab 03 ("Private Chat and AI (Across Files)") of the test console: next to "Me — Intear Wallet" (built, live-proven 2026-11-05), an **AI agent** per tenant asks the question, gets the job's quote and pays it by itself in USDC on NEAR; the page shows the agent's steps live and then the job's result.
Written 2026-11-05. **[read]** = read in the repository or on chain on 2026-11-05. **[owner]** = manual step. No mocks: what cannot be proven locally is an owner step with a live acceptance.

Requirement IDs start at **ARCH-301** (ARCH-001…018 XRPL migration, ARCH-101…115 paid jobs, ARCH-201…211 admin UI Jobs tab are taken).

## 1. Decisions (owner, 2026-11-05)

- One agent account **per tenant** (t01, t02, t03), using each tenant's existing NEAR account.
- **No spending limits in this build** (no per-job or daily cap, no ask-above-cap). Limits are a later build (owner reminder). The plan keeps a `--agent-max-amount` flag that is **unset by default**, so limits can be switched on later without new payment code.
- The agent returns **only the job's result** (the same table and worded answer tab 03 shows today). The agent does not write its own summary, so the result rows never go to the agent's model.
- NEAR USDC only. Manual tab 03 (Intear) and everything else unchanged.

**Recommendation on "one agent per tenant" (agreed):** separate accounts give per-tenant billing that reconciles on chain, a separate buyer card per tenant in the admin UI, and isolation (one tenant's key cannot spend another tenant's USDC). Each tenant later gets its own TEE wallet through the same signer seam (`near-signer.ts`) without changing payment code. A shared agent would mix tenants' payments in one account and one key.

## 2. Facts this plan relies on (read 2026-11-05)

| # | Fact | Source |
|---|---|---|
| F1 | Tenants already name their NEAR account and key variable: t01 `chainaim-buyer-seller.testnet` / `NEAR_BUYER_KEY`, t02 `chainaim-t02-seller.testnet` / `NEAR_T02_KEY`, t03 `chainaim-t03-seller.testnet` / `NEAR_T03_KEY`. | `rig/tenants/t0N/tenant.json` |
| F2 | Their USDC on TestNet: t01 18.83, t02 19.34, t03 19.30. No NEAR is needed for gas (the paywall's relayer pays). | NEAR TestNet RPC `ft_balance_of`, 2026-11-05 |
| F3 | The key values exist in `C:\PRIV-AI-SECRETS\near-testnet.env` as `NEAR_BUYER_KEY_TESTNET`, `NEAR_T02_KEY_TESTNET`, `NEAR_T03_KEY_TESTNET` (names only checked). | owner's names-only check, 2026-11-05 |
| F4 | `nearBuyer(env, {accountId, keyPrefix})` builds a NEAR payer from those; `payAndFetchNear(url, init, buyer, options)` reads the 402, picks the NEAR offer, refuses a price above `--max-amount` **only when given**, signs the NEP-366 delegate (`keySigner`), checks it, resends, reads the receipt. | `services/paywall/scripts/near.ts` lines 1-19, 44-101 |
| F5 | The existing Strands buyer agent (`agent-core.ts`, `agent.ts`) runs on Bedrock (`--region ap-southeast-2`, `--model-id nvidia.nemotron-nano-3-30b`, AWS SDK credential chain), masks the typed prompt before Bedrock (`PromptScan`: client patterns + Presidio, fail closed, `--presidio-url` default `http://127.0.0.1:5002`), has one tool, and pays XRPL RLUSD. It was proven live on XRPL on 2026-10-24 (STATE.md F2, P13–P15). | `agent-core.ts` header, `agent.ts` flags |
| F6 | The paid-job route of the console: `POST /jobs/crossask` runs the job, quotes, holds the result, registers it with the paywall and answers `{jobId, totalUsd, amount, network, asset, payTo, expiresAt}`; the paywall's `POST /v1/jobs/<id>/release` is paid in NEAR USDC and releases the result after settlement. Live-proven 2026-11-05 (tx `6RoFLY…BtZ8`, reconcile `matched`). | `test-console/console/server.ts` 545-577; admin UI |
| F7 | Dependency rule: an **app** (`test-console`) must not import a **service** (`services/paywall`): "apps call services over HTTP" (`npm test` runs `scripts/check-deps.ts`). | `config/deps/rules.json` |
| F8 | One NEAR access key signs one delegate at a time with a nonce; payments from one account must be serialized. | `agent-core.ts` header ("Payments run one at a time per session"); `near-signer.ts` |

Not verified here (owner checks): the tenant Presidio at `127.0.0.1:5002` is running (M2); the AWS credential chain on this PC can call Bedrock for the agent (M1).

## 3. Design

Because of F7, the agent does **not** live inside the console. It is a small **agent service** in `services/paywall/scripts/` (where Strands, the NEAR payer and prompt masking already are), and the console talks to it over HTTP. This is also the production shape (a private agent-service container, see the frontend/backend separation reminder).

```
Tab 03 page: Who pays? (•) AI agent   Tenant [t02 ▾]   [Ask]
   │  POST /agent/crossask {tenant, folder, question, model, answerModel}   (127.0.0.1 only)
   ▼
Console 8730 ── relays the SSE stream ──▶ Agent service 8760 (new, services/paywall/scripts/agent-jobs.ts)
                                            1. mask the typed question (PromptScan, fail closed)
                                            2. Strands agent on Bedrock decides to call tool "chainaim_ask_across_files"
                                            3. tool → POST console /jobs/crossask (the existing paid-job route)  → quote
                                            4. tool → payAndFetchNear(paywall /v1/jobs/<id>/release, tenant's NEAR payer)
                                               (no max amount: no limit in this build)
                                            5. receipt + released result
                                            6. agent's model gets only {paid, amount, tx, rows, status} — never the result
   ◀── SSE steps: masked · tool_called · job_ran · quoted · signed · settled · released · done (+ the result)
Page: live agent timeline, then the result in the existing tab 03 view
```

Unchanged: the job pipeline (analyst, gateway, Presidio, models), pricing, holding, the paywall, the relayer, near-watch. The paywall sees an ordinary NEAR payment from the tenant's account; near-watch records and reconciles it like the manual one.

## 4. Components

| Component | Change | Responsibility |
|---|---|---|
| `services/paywall/scripts/agent-jobs-core.ts` | **new** | Tool `chainaim_ask_across_files` (calls console `/jobs/crossask`, then `payAndFetchNear` on the release route with the tenant's `nearBuyer`), the step events, per-tenant payment queue, `buildJobsAgent()` reusing `PromptScan`, Bedrock model setup and agent options from `agent-core.ts` (imported, not changed). |
| `services/paywall/scripts/agent-jobs.ts` | **new** | HTTP server (default `127.0.0.1:8760`): `GET /healthz`, `GET /tenants` (ids, names, NEAR accounts; no keys), `POST /run` → SSE stream of steps. Flags below. |
| `test-console/console/server.ts` | edit, flag `--agent-service URL` (default unset = off) | `GET /agent/config` (tenants from the agent service) and `POST /agent/crossask` relaying the agent service's SSE stream (127.0.0.1 host check, no key added). |
| `test-console/console/paid-jobs.html` | edit (only served with `--paid-jobs on`) | "Who pays?" switch (Me / AI agent), tenant picker, live agent timeline, result rendered by the existing tab 03 renderer. Shown only when `/agent/config` answers. |
| Docs | edit | `MANUAL_SETUP.md` (flags, env names, owner steps), `STATE.md`, `BUILD_LOG.md`. |

Agent service flags (all with defaults except where required):
`--port 8760` · `--host 127.0.0.1` · `--console http://127.0.0.1:8730` · `--paywall http://127.0.0.1:8080` · `--tenants rig/tenants` · `--agent-tenants t01,t02,t03` · `--region ap-southeast-2` · `--model-id nvidia.nemotron-nano-3-30b` · `--prompt-mask on` · `--prompt-scanner both` · `--presidio-url http://127.0.0.1:5002` · `--max-turns 6` · `--agent-max-tokens 1024` · `--agent-max-amount` (unset = no limit) · `--run-timeout-sec 300`. Tenant keys come from the environment (`NEAR_BUYER_KEY_TESTNET`, `NEAR_T02_KEY_TESTNET`, `NEAR_T03_KEY_TESTNET`), never from flags; start-up refuses a listed tenant whose key is missing, naming the variable.

---

# Requirements

### ARCH-301 — Off by default, nothing else changes
**Requirement:** Without `--agent-service`, the console's routes and page are exactly as after ARCH-101…115; the agent service is a new process nothing else depends on. No change to `agent-core.ts`, `agent.ts`, `near.ts`, the gateway, the paywall or near-watch.
**Acceptance:** Full baseline (`npm test`, `npm run test:paywall`, `npm --prefix packages/crossask test`, `npm --prefix services/web test`) passes with the same counts before and after, recorded in BUILD_LOG.md. `ARCH-301: console without --agent-service has no /agent routes and no agent controls`. `scripts/check-deps.ts` passes with no new allow entry.

### ARCH-302 — Tenants and keys
**Requirement:** The agent service loads each tenant in `--agent-tenants` from `<tenants>/<id>/tenant.json` (`near.accountId`, `near.keyEnv`) and builds its payer with `nearBuyer`. A missing tenant, NEAR entry or key stops start-up with the tenant id and variable name. `GET /tenants` returns `[{id, name, accountId}]` only; no key, prefix value or path appears in any response or log.
**Acceptance:** `ARCH-302:` tests: three tenants loaded from the repository's real tenant files with throwaway keys in the test environment; missing key error names the variable; a log capture contains no key.

### ARCH-303 — The question is masked before the agent's model sees it
**Requirement:** The typed question goes through `PromptScan` (`--prompt-scanner both`, residual check on) before any Bedrock call; if Presidio does not answer, the run is refused with nothing sent anywhere (fail closed, as F5). The SSE step `masked` carries kinds and counts only.
**Acceptance:** `ARCH-303:` tests with the Presidio stand-in the existing prompt-scan tests use: a name is masked before the model call; Presidio down → refused, no model call and no job.

### ARCH-304 — The tool runs the existing paid job and pays it
**Requirement:** Tool `chainaim_ask_across_files({question})` posts `{folder, question, model, answerModel, phrase:"llm"}` (folder and models from the page's request, the question as the agent passes it, masked) to the console's `/jobs/crossask`, then pays `<paywall>/v1/jobs/<jobId>/release` with `payAndFetchNear` and the tenant's payer, and returns the released result to the run (not to the model). With `--agent-max-amount` unset no maximum is passed (no limit); when set, a higher quote is refused before signing. Payments from one tenant account run one at a time (queue per tenant).
**Acceptance:** `ARCH-304:` tests with the real console job code, a real paywall built by `buildApp` and the paywall's existing NEAR RPC protocol double with real signed delegates (as ARCH-108): job quoted → paid → result released; with `--agent-max-amount` below the quote → refused, nothing signed; two runs for one tenant settle in order.

### ARCH-305 — The agent's model never sees the result
**Requirement:** The tool's reply to the model is `{status, amountUsdc, transaction, rows}` only. The result table and worded answer go only to the SSE stream for the page. The agent does not write a summary.
**Acceptance:** `ARCH-305:` test with a synthetic marker value in the result rows: the marker never appears in anything sent to the model (captured model requests), and does appear in the SSE `released` event.

### ARCH-306 — Live steps for the page
**Requirement:** `POST /run` answers an SSE stream of events in order: `masked`, `tool_called`, `job_ran` (calls, rows), `quoted` (amount, totalUsd, network, payTo), `signed` (tenant account), `settled` (transaction, network), `released` (the job result), `done`; or `refused` / `error` with a plain reason and, after signing, the transaction if any. A client hang-up before signing cancels the run; after signing the run completes and is logged.
**Acceptance:** `ARCH-306:` tests: event order on success; `refused` on Presidio down; `error` with the transaction when the release fails after signing.

### ARCH-307 — Console relay
**Requirement:** With `--agent-service URL`, the console serves `GET /agent/config` and `POST /agent/crossask` (127.0.0.1 host check, same body checks as `/jobs/crossask`, plus `tenant` from `/agent/config`), and relays the SSE stream byte for byte; it adds no key. The console logs only `{route:"agent", tenant, jobId, status, ms}`.
**Acceptance:** `ARCH-307:` tests: relay passes events through unchanged; unknown tenant → 400; log capture has no question or result.

### ARCH-308 — Tab 03 controls
**Requirement:** With `--paid-jobs on` and `--agent-service`, tab 03 shows "Who pays? ( ) Me — Intear Wallet · ( ) AI agent" and, for the agent, a tenant picker with each tenant's NEAR account. Agent mode shows the live timeline (one line per SSE event) and then the result in the existing renderer with the nearblocks link. "Me" behaves exactly as today.
**Acceptance:** `ARCH-308:` tests in `scripts/test/` (style of `console-paid-jobs.test.ts`): controls absent without the flag; agent mode posts to `/agent/crossask`; manual mode still posts to `/jobs/crossask`. Live: ARCH-309.

### ARCH-309 — Live proof on TestNet [owner]
**Requirement:** One agent-paid tab 03 job per tenant (t01, t02, t03) and one manual job in the same session.
**Acceptance:** Owner run recorded in BUILD_LOG.md: for each agent job the timeline reaches `done`, the result is shown, nearblocks shows the quoted USDC from that tenant's account to `chainaim-payto-seller.testnet` signed by the relayer, the paywall logs `payment_settled` for the job's release route, and the admin UI Reconcile tab shows it `matched` with the tenant's account as payer; the manual job still works as on 2026-11-05.

---

## Owner steps (given one at a time during the build)

| ID | Step |
|---|---|
| M1 | AWS sign-in for the agent's Bedrock calls on this PC (`aws login --profile chainaim --remote`, region ap-southeast-2), as for the 2026-10-24 agent runs. |
| M2 | Tenant Presidio reachable at `http://127.0.0.1:5002` (the `presidio` container `start.cmd` starts); check with the agent service's start-up line. |
| M3 | Start the agent service in its own window with the three tenant keys loaded from `C:\PRIV-AI-SECRETS\near-testnet.env` (names only; never pasted). |
| M4 | Restart the console with `--agent-service http://127.0.0.1:8760` added to the 2026-11-05 command. |
| M5 | near-watch: `-Watch "t01=buyer=chainaim-buyer-seller.testnet" -Watch "t02=buyer=chainaim-t02-seller.testnet" -Watch "t03=buyer=chainaim-t03-seller.testnet"` so each tenant gets a buyer card. |
| M6 | ARCH-309 live run. |

Never paste a tenant key, `PAID_JOBS_KEY` or any other secret into a chat.

## Build order

1. Baseline (ARCH-301 "before").
2. ARCH-302 → ARCH-303 → ARCH-304 → ARCH-305 → ARCH-306 (agent service).
3. ARCH-307 → ARCH-308 (console).
4. ARCH-301 "after".
5. Owner: M1–M6 (ARCH-309).

## Out of scope (later, owner reminders)

- Spending limits: per-job cap, daily cap per agent, ask-me-above-cap (the `--agent-max-amount` flag is the hook).
- TEE wallet per tenant (OutLayer) replacing the dev key signer.
- The agent writing its own summary of the result.
- Showing agent jobs as "paid by agent" in the admin UI Jobs tab (fold into ARCH-201…211 when that is built).
- XRPL for agent mode; options B and C; frontend/backend separation and containers.

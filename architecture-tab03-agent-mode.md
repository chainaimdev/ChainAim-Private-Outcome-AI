# ChainAim private AI: tab 03 "agent mode" — a programmatic wallet pays the paid job in NEAR USDC — Architecture (Docker edition)

Build plan for a second way to pay in tab 03 ("Private Chat and AI (Across Files)"): next to **"Me — Intear Wallet"** (built, live-proven 2026-11-05), an **AI agent** per tenant asks the question, gets the job's quote and pays it by itself in USDC on NEAR from the tenant's own account (a programmatic wallet: the account plus its key, held by the agent service). The page shows the agent's steps live, then the job's result.

Written 2026-11-05, **rewritten 2026-11-06 for the dockerized backend** (backend in Docker, both UIs on the PC). **[read]** = read in the repository on the date given. **[owner]** = manual step. **[verify]** = not yet proven, checked first in the build (section 5). No mocks in product code; what cannot be proven locally is an owner step with a live acceptance.

Requirement IDs: **ARCH-301 … ARCH-314** (ARCH-001…018, 101…115, 201…211 are taken).

## 1. Decisions (owner)

- **Both options in tab 03:** "Who pays? ( ) Me — Intear Wallet · ( ) AI agent". The choice is per job; manual stays exactly as today.
- One agent account **per tenant** (t01, t02, t03), each tenant's existing NEAR account.
- **No spending limits in this build.** `--agent-max-amount` exists but is **unset by default** (no limit), so limits come later without new payment code.
- The agent returns **only the job's result** (the same table and worded answer tab 03 shows). The agent writes no summary; result rows never go to the agent's model.
- NEAR USDC only. XRPL, the gateway, the paywall, the relayer and the job pipeline are unchanged.
- **Off by default everywhere:** nothing starts or changes unless `-Agent on` is passed.
- **No hardcoding:** every address, port, model, tenant list, timeout and watch list is a flag or a setting with a default; keys are referred to by NAME only.

## 2. What "programmatic wallet" means here

| | Manual (today) | Agent mode (this build) |
|---|---|---|
| Who pays | You, in the Intear pop-up | The agent service, no pop-up |
| Account | your wallet account | the tenant's account, e.g. `chainaim-t02-seller.testnet` |
| What is signed | a NEP-366 delegate (off-chain signature) | the same |
| Who submits and pays gas | ChainAim's relayer | the same |
| Route, paywall, near-watch, reconcile | `/v1/jobs/<id>/release` | the same |

The tenant account needs **USDC only, no NEAR** (the relayer pays gas). The key must be a **full-access** key (`near.ts` header). Later a TEE wallet replaces the key through `near-signer.ts` without changing payment code.

## 3. Facts this plan relies on

| # | Fact | Source |
|---|---|---|
| F1 | Tenants name their NEAR account and key prefix: t01 `chainaim-buyer-seller.testnet` / `NEAR_BUYER_KEY`, t02 `chainaim-t02-seller.testnet` / `NEAR_T02_KEY`, t03 `chainaim-t03-seller.testnet` / `NEAR_T03_KEY`. | `rig/tenants/t0N/tenant.json` [read 11-05; t02 re-read 11-06] |
| F2 | USDC on TestNet: t01 18.83, t02 19.34, t03 19.30. | NEAR RPC `ft_balance_of`, 11-05 (may have changed) |
| F3 | The key values are in `C:\PRIV-AI-SECRETS\near-testnet.env` as `NEAR_BUYER_KEY_TESTNET`, `NEAR_T02_KEY_TESTNET`, `NEAR_T03_KEY_TESTNET` (names only checked). That file also holds the relayer key. | owner, 11-05 |
| F4 | `near.ts`: key variable is `<PREFIX>_<NETWORK>`, a **full-access** secret key; `payAndFetchNear` reads the 402, picks the NEAR offer, refuses a price above max-amount only when given, signs, checks, resends, reads the receipt. It imports `../../web/src/near-payment.ts`, `../src/config.ts`, `../src/near/rpc.ts`, `./near-signer.ts`, `./xrpl.ts`. | `services/paywall/scripts/near.ts` lines 1-45 [read 11-06] |
| F5 | The existing Strands buyer agent (`agent-core.ts`, `agent.ts`) uses `@strands-agents/sdk`, `zod`, `PromptScan` (client masker + Presidio, fail closed); proven live on XRPL 2026-10-24. | `agent-core.ts` header and imports [read 11-06] |
| F6 | Console paid-job route `POST /jobs/crossask` (run, meter, quote, hold, register) and paywall `POST /v1/jobs/<id>/release` (paid in NEAR USDC, releases after settlement). Live-proven 11-05. | `server.ts`; admin UI |
| F7 | Dependency rule: an app (`test-console`) must not import a service (`services/paywall`); apps call services over HTTP. | `config/deps/rules.json` |
| F8 | One NEAR key signs one delegate at a time (nonce): payments per account must be serialized. | `agent-core.ts`, `near-signer.ts` |
| F9 | The paywall image is built from `services/paywall` with `npm ci --omit=dev`, and its `.dockerignore` leaves out `scripts/`. Strands, the AWS SDK and zod are **devDependencies**. So the paywall image cannot run the agent. | `services/paywall/Dockerfile`, `.dockerignore`, `package.json` [read 11-06] |
| F10 | Console `--allowed-hosts` defaults to `127.0.0.1:<port>,localhost:<port>`; every guarded route (incl. `/jobs/crossask`) checks the Host header. The compose `console-api` command passes no `--allowed-hosts`, so a call to `http://console-api:8735` gets 403. | `server.ts` line 247, 371, 650; `docker-compose.yml` [read 11-06] |
| F11 | In ui mode the 8730 process forwards each request and reads the **whole** answer (`r.arrayBuffer()`) before replying, with timeout `--forward-timeout-sec`. A server-sent event stream would reach the page only at the end. | `server.ts` lines 862-884 [read 11-06] |
| F12 | `ca-presidio` (presidio-analyzer 2.2.362) listens on port **3000**, network alias `presidio.railway.internal`, not published to the PC. | `services/presidio/Dockerfile`, `docker-compose.yml` [read 11-06] |
| F13 | `up.ps1` reads `near-testnet.env` through an allowlist that **ignores buyer keys**; the paywall never gets tenant keys. It already reads `BEDROCK_API_KEY` from `C:\PRIV-AI-SECRETS\chainaim.env` for the gateway. | `test-console/up.ps1` [read 11-06] |
| F14 | near-watch in Docker watches a **fixed** list in the admin UI repo's `docker-compose.yml`: `buyer1=buyer=chainaim-buyer-seller.testnet` (= t01) and the relayer, plus `--gas-per-payment-near 0.000333`. | `chainaim-adminUI-NEAR/docker-compose.yml` [read 11-06] |
| F15 | All containers are on the external network `chainaim-test`; ports are published on 127.0.0.1 only. | both `docker-compose.yml` [read 11-06] |

## 4. Design

```
PC                                         Docker network chainaim-test
──                                         ────────────────────────────
Browser ─▶ UI 8730 (server.ts --mode ui)
  tab 03: Who pays? (•) AI agent  [t02 ▾]
   │  POST /agent/crossask  (streamed through, ARCH-308)
   ▼
                                  ca-console-api :8735  ──relay SSE──▶  ca-agent :8760  (new, ARCH-310)
                                   (--agent-service http://agent:8760)    1. mask question (PromptScan → presidio.railway.internal:3000, fail closed)
                                                                          2. Strands agent on Bedrock calls tool "chainaim_ask_across_files"
                                    ◀── POST /jobs/crossask (Host console-api:8735, ARCH-307) ── 3. run + quote (existing paid-job route)
                                                                          4. payAndFetchNear(http://paywall:8080/v1/jobs/<id>/release, tenant payer)
                                  ca-paywall :8080 ◀──────────────────────     relayer submits, settles, releases
                                  ca-near-watch :8790 ◀── claim (as today)
                                                                          5. agent's model gets {status, amountUsdc, transaction, rows} only
   ◀── SSE: masked · tool_called · job_ran · quoted · signed · settled · released(result) · done
Page: live timeline, then the result in the existing tab 03 view
```

Secrets: tenant keys only in `ca-agent` (mounted read-only file, ARCH-302); Bedrock key passed by name by `up.ps1` (ARCH-311). Nothing else gets them.

Unchanged: job pipeline (analyst, gateway, Presidio, models), pricing, holding, the paywall, the relayer, near-watch code. The paywall sees an ordinary NEAR payment from the tenant's account; near-watch records and reconciles it like the manual one.

## 5. Verify first (before any code) [verify]

| ID | Check | If it fails |
|---|---|---|
| V1 | Bedrock from inside a container with `AWS_BEARER_TOKEN_BEDROCK` (the value of `BEDROCK_API_KEY`), region `ap-southeast-2`, model `nvidia.nemotron-nano-3-30b`, one Strands tool call. SDK 3.1156.0 supports the variable; not live-tested. | Stop and report; option: mount AWS SSO credentials read-only (owner decides). |
| V2 | `PromptScan` works against `ca-presidio` (`http://presidio.railway.internal:3000`): a name in a question is masked. | Stop and report. |
| V3 | The three tenant keys are full-access keys of their accounts (owner checks with public keys only, M1). | Owner adds a full-access key; no workaround. |

## 6. Components

| Component | Change | Responsibility |
|---|---|---|
| `services/paywall/scripts/agent-jobs-core.ts` | **new** | Tool `chainaim_ask_across_files` (console `/jobs/crossask`, then `payAndFetchNear` on the release route with the tenant's `nearBuyer`), step events, per-tenant payment queue, `buildJobsAgent()` reusing `PromptScan`, Bedrock model setup and agent options from `agent-core.ts` (imported, not changed). |
| `services/paywall/scripts/agent-jobs.ts` | **new** | HTTP server: `GET /healthz`, `GET /tenants` (ids, names, NEAR accounts; no keys), `POST /run` → SSE stream. Host check with `--allowed-hosts`. |
| `services/paywall/agent.Dockerfile` + its `.dockerignore` | **new** | Image `chainaim-agent:local`; build context `services/` (F4 imports `services/web/src`); installs paywall dependencies **including dev** (F9); copies only `paywall/src`, `paywall/scripts`, `web/src/near-payment.ts` (+ what it imports); no `.env`, keys or data in the context. |
| `docker-compose.yml` (private-ai) | edit: new service `agent`, **profile `agent`** (not started unless asked); `console-api` gets `console-api:8735` in `--allowed-hosts` | ARCH-307, 310 |
| `test-console/up.ps1`, `down.ps1` | edit: `-Agent on|off` (default **off**) and agent flags | ARCH-312 |
| `test-console/console/server.ts` | edit: `--agent-service URL` (default unset = off); api mode: `GET /agent/config`, `POST /agent/crossask` relay; ui mode: streamed pass-through for `/agent/crossask` only | ARCH-307, 308 |
| `test-console/console/paid-jobs.html` | edit: "Who pays?" switch, tenant picker, live timeline; shown only when `/agent/config` answers | ARCH-309 |
| `chainaim-adminUI-NEAR/docker-compose.yml`, `up.ps1` | edit: watch list and gas-per-payment from a setting, default = today's exact values | ARCH-313 |
| Docs | edit | `MANUAL_SETUP.md`, `cmd.md` (both repos), `STATE.md`, `BUILD_LOG.md` |

**Agent service flags** (defaults suit a PC run; compose passes the container values):

| Flag | Default | In compose |
|---|---|---|
| `--host` | `127.0.0.1` | `0.0.0.0` |
| `--port` | `8760` | `8760` |
| `--allowed-hosts` | `127.0.0.1:<port>,localhost:<port>` | `agent:8760,127.0.0.1:8760,localhost:8760` |
| `--console` | `http://127.0.0.1:8730` | `http://console-api:8735` |
| `--paywall` | `http://127.0.0.1:8080` | `http://paywall:8080` |
| `--tenants` | `rig/tenants` | `/app/rig/tenants` (mounted read-only) |
| `--agent-tenants` | `t01,t02,t03` | from `up.ps1 -AgentTenants` |
| `--region` / `--model-id` | `ap-southeast-2` / `nvidia.nemotron-nano-3-30b` | from `up.ps1 -AgentRegion / -AgentModelId` |
| `--prompt-mask` / `--prompt-scanner` | `on` / `both` | same |
| `--presidio-url` | `http://127.0.0.1:5002` | `http://presidio.railway.internal:3000` |
| `--max-turns` / `--agent-max-tokens` | `6` / `1024` | same |
| `--agent-max-amount` | unset (no limit) | unset |
| `--run-timeout-sec` | `300` | from `up.ps1 -AgentTimeoutSec` |

Keys never come from flags. Start-up refuses a listed tenant whose key is missing, naming the variable only.

---

# Requirements

### ARCH-301 — Off by default, nothing else changes
**Requirement:** Without `-Agent on`: no `ca-agent` container, the console runs without `--agent-service`, routes and page exactly as after ARCH-101…115. No change to `agent-core.ts`, `agent.ts`, `near.ts`, `near-signer.ts`, the gateway, the paywall source or near-watch source. ARCH-313 defaults reproduce today's near-watch command exactly.
**Acceptance:** Before and after, same counts: root `node --test` 427, paywall 274, crossask 30, web 133, chain-query 11, analyst 177 (+1 known Windows exit crash), near-watch 50, admin-console 43 (recorded in BUILD_LOG.md). `ARCH-301: console without --agent-service has no /agent routes and no agent controls`. `scripts/check-deps.ts` gains no new allow entry. `up.ps1` without `-Agent` starts the same six containers as today.

### ARCH-302 — Tenants and keys
**Requirement:** The agent loads each tenant in `--agent-tenants` from `<tenants>/<id>/tenant.json` (`near.accountId`, `near.keyEnv`) and builds its payer with `nearBuyer`. Keys come from `C:\PRIV-AI-SECRETS\agent-tenants.env` (path = `up.ps1 -AgentEnvFile`), **mounted read-only** into `ca-agent` and read by Node's `--env-file` (as near-watch), so values are not in `docker inspect`. Allowed names: `NEAR_NETWORK`, `NEAR_RPC_URL_<NET>`, `NEAR_USDC_CONTRACT_<NET>`, and each tenant's `<keyEnv>_<NET>`; the relayer key is never in this file. Missing tenant, NEAR entry or key stops start-up naming the tenant and variable. `GET /tenants` returns `[{id, name, accountId}]` only.
**Acceptance:** `ARCH-302:` tests: three tenants from the real tenant files with throwaway keys; missing key error names the variable; log capture contains no key.

### ARCH-303 — The question is masked before the agent's model sees it
**Requirement:** The typed question goes through `PromptScan` (`--prompt-scanner both`, residual check on) before any Bedrock call; Presidio not answering → refused, nothing sent (fail closed). The `masked` step carries kinds and counts only.
**Acceptance:** `ARCH-303:` tests with the Presidio stand-in the existing prompt-scan tests use: a name is masked before the model call; Presidio down → refused, no model call, no job. Live: V2.

### ARCH-304 — The tool runs the existing paid job and pays it
**Requirement:** Tool `chainaim_ask_across_files({question})` posts `{folder, question, model, answerModel, phrase:"llm"}` to `<console>/jobs/crossask`, then pays `<paywall>/v1/jobs/<jobId>/release` with `payAndFetchNear` and the tenant's payer, and returns the released result to the run (not the model). `--agent-max-amount` unset → no maximum passed; set → a higher quote is refused before signing. One payment at a time per tenant account (queue).
**Acceptance:** `ARCH-304:` tests with the real console job code, a real paywall from `buildApp` and the paywall's existing NEAR RPC protocol double with real signed delegates (as ARCH-108): quoted → paid → released; max below quote → refused, nothing signed; two runs for one tenant settle in order.

### ARCH-305 — The agent's model never sees the result
**Requirement:** The tool's reply to the model is `{status, amountUsdc, transaction, rows}` only; the table and worded answer go only to the SSE stream. No agent summary.
**Acceptance:** `ARCH-305:` a marker value in the result rows never appears in captured model requests and does appear in the SSE `released` event.

### ARCH-306 — Live steps
**Requirement:** `POST /run` answers SSE events in order: `masked`, `tool_called`, `job_ran` (calls, rows), `quoted` (amount, totalUsd, network, payTo), `signed` (tenant account), `settled` (transaction, network), `released` (result), `done`; or `refused` / `error` with a plain reason and, after signing, the transaction. Hang-up before signing cancels; after signing the run completes and is logged.
**Acceptance:** `ARCH-306:` event order on success; `refused` on Presidio down; `error` with the transaction when release fails after signing.

### ARCH-307 — Console relay (api mode, in Docker)
**Requirement:** With `--agent-service URL`, console-api serves `GET /agent/config` and `POST /agent/crossask` (host check, same body checks as `/jobs/crossask`, plus `tenant` from `/agent/config`) and relays the SSE stream byte for byte as it arrives; adds no key; logs only `{route:"agent", tenant, jobId, status, ms}`. The compose `console-api` command adds `console-api:8735` to `--allowed-hosts` (keeping `127.0.0.1:8735,localhost:8735`) so the agent's `/jobs/crossask` call passes the host check (F10); the value comes from `up.ps1`, not a fixed string in code.
**Acceptance:** `ARCH-307:` relay passes events unchanged and incrementally; unknown tenant → 400; log capture has no question or result; a request with Host `console-api:8735` is accepted only when listed.

### ARCH-308 — UI streaming pass-through (ui mode, on the PC)
**Requirement:** In ui mode, `POST /agent/crossask` is forwarded with its response **streamed** to the browser as it arrives (not buffered, F11), with the same host check and header allowlist (adding `text/event-stream` handling), limited by `--agent-forward-timeout-sec` (default = the agent's run timeout + 30). Every other route keeps today's buffered `forward()` unchanged.
**Acceptance:** `ARCH-308:` test with a real api-mode console relaying a staged SSE source: events reach the client one by one before the stream ends; other routes byte-identical to today.

### ARCH-309 — Tab 03 controls
**Requirement:** With `--paid-jobs-page on` and `/agent/config` answering, tab 03 shows "Who pays? ( ) Me — Intear Wallet · ( ) AI agent" and, for the agent, a tenant picker with each tenant's NEAR account; agent mode shows the live timeline then the result in the existing renderer with the nearblocks link. "Me" behaves exactly as today. Also fix the known bug: wallet config is loaded when the page opens with the box already ticked.
**Acceptance:** `ARCH-309:` tests (style of `console-paid-jobs.test.ts`): controls absent without the agent service; agent mode posts to `/agent/crossask`; manual mode still posts to `/jobs/crossask`.

### ARCH-310 — Agent container
**Requirement:** `agent.Dockerfile` (F9, F4) builds `chainaim-agent:local`, user `node`, no secrets in the image or build context. Compose service `agent`: container `ca-agent`, profile `agent`, network `chainaim-test` (alias `agent`), port `127.0.0.1:8760:8760`, mounts `rig/tenants` read-only and the agent env file read-only, `depends_on: [console-api, paywall, presidio]`, entrypoint `node --env-file=/run/secrets/agent-tenants.env services/paywall/scripts/agent-jobs.ts`, command = the flags from `up.ps1`.
**Acceptance:** image builds; `docker run` without the env file refuses to start naming the file; `GET /healthz` 200 and `GET /tenants` lists three tenants with no key.

### ARCH-311 — Bedrock credentials in the container
**Requirement:** `up.ps1 -Agent on` passes `AWS_BEARER_TOKEN_BEDROCK` (by name) with the value of `BEDROCK_API_KEY` read from `-SecretsFile` (as it already does for the gateway, F13); never printed or written. Flag `--aws-auth bearer|chain` on the agent (default `chain` for PC runs; compose `bearer`).
**Acceptance:** V1 passes; start-up line says which auth is used, not the value.

### ARCH-312 — `up.ps1` / `down.ps1`
**Requirement:** New params: `-Agent on|off` (default `off`), `-AgentEnvFile` (default `C:\PRIV-AI-SECRETS\agent-tenants.env`), `-AgentTenants` (default `t01,t02,t03`), `-AgentRegion`, `-AgentModelId`, `-AgentTimeoutSec`, `-AgentPort` (default 8760). With `on`: needs `-PaidJobs on`, checks the env file exists (values not read or printed), writes the agent command and console `--agent-service http://agent:8760` into `runtime/compose/commands.yml`, adds `--profile agent`, waits for `127.0.0.1:8760/healthz`, starts the UI as today. `down.ps1` stops the `agent` profile too.
**Acceptance:** `-DryRun -Agent on` writes the expected commands file; without `-Agent` the commands file equals today's.

### ARCH-313 — near-watch watch list (admin UI repo)
**Requirement:** The `--watch` entries and `--gas-per-payment-near` come from a setting (`up.ps1 -Watch ... -GasPerPaymentNear ...`, or a committed, non-secret `config/near-watch-watch.conf`) instead of fixed lines in `docker-compose.yml`. Default = today's exact values (F14). For agent mode the owner adds `t01=buyer=chainaim-buyer-seller.testnet`, `t02=buyer=chainaim-t02-seller.testnet`, `t03=buyer=chainaim-t03-seller.testnet`, and the manual wallet account.
**Acceptance:** near-watch 50/50; default start gives the same `docker` command as today; with the list set, the admin UI shows a buyer card per tenant.

### ARCH-314 — Live proof on TestNet [owner]
**Requirement:** One agent-paid tab 03 job per tenant (t01, t02, t03) and one manual Intear job in the same session.
**Acceptance:** recorded in BUILD_LOG.md: each agent timeline reaches `done` and shows the result; nearblocks shows the quoted USDC from that tenant's account to `chainaim-payto-seller.testnet`, submitted by the relayer; `docker logs ca-paywall` has `payment_settled` for each release; admin UI Reconcile shows each `matched` with the tenant as payer; the manual job works as on 2026-11-05.

---

## AI work vs owner work

**AI can do this:** V1/V2 test scripts, ARCH-301…313 code, Dockerfile, compose entries, `up.ps1`/`down.ps1` switches, tests, docs, BUILD_LOG entries.

**Owner steps (given one at a time during the build; never paste a key, `docker inspect` or `docker compose config` output):**

| ID | Step |
|---|---|
| M1 | Check each tenant key is full-access (public keys only, e.g. `near account list-keys <account> network-config testnet now`). Do not run any export command that prints a private key. (V3) |
| M2 | Create `C:\PRIV-AI-SECRETS\agent-tenants.env` with the allowed names (ARCH-302), copying the three tenant key values from `near-testnet.env` on the PC; never into chat or git. |
| M3 | Confirm `BEDROCK_API_KEY` is in `C:\PRIV-AI-SECRETS\chainaim.env` (name only). (V1) |
| M4 | Admin UI: start near-watch with the tenant watch list (ARCH-313). |
| M5 | `.\test-console\up.ps1 -Agent on -Build` and report the READY lines. |
| M6 | ARCH-314 live run. |

## Build order

1. Baseline counts (ARCH-301 "before").
2. V1, V2 (stop and report on failure); owner M1–M3.
3. ARCH-302 → 303 → 304 → 305 → 306 (agent service, tests).
4. ARCH-310 → 311 (container, credentials).
5. ARCH-307 → 308 → 309 (console relay, UI streaming, tab 03).
6. ARCH-312 (up/down), ARCH-313 (near-watch list).
7. ARCH-301 "after" (same counts).
8. Owner M4–M6 (ARCH-314).

Rollback: `up.ps1` without `-Agent` (agent container not started; console without `--agent-service`).

## Out of scope (later, owner reminders)

- Spending limits: per-job cap, daily cap per agent, ask-me-above-cap (`--agent-max-amount` is the hook).
- TEE wallet per tenant (OutLayer / Phala) replacing the dev key signer.
- The agent writing its own summary of the result.
- "Paid by agent" label in the admin UI Jobs tab.
- XRPL for agent mode; options B and C.

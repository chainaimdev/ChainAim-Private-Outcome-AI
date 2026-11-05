# DOCKERIZE-PLAN — chainiam-private-ai (backend fully in Docker, UI local)

Status: PLAN ONLY. No code has been changed. Written 2026-11-06.
Companion plan: `chainaim-adminUI-NEAR/DOCKERIZE-PLAN.md`.

## 1. Goal

Run every backend part of this repo in Docker with one command, keep the 8730 UI on the PC, and keep every
current working exactly as it is. This is the local step before NEAR TEE (Phala Cloud / dstack): the same
`docker-compose.yml` is what a CVM runs later.

Hard rules for this work:
- Nothing that works today may break. Every code change is a new flag whose default is today's behaviour.
- No mocks in production code. Existing doubles (OpenRouter stub, NEAR RPC double) stay test-only.
- No hardcoding. Ports, URLs, binds, paths and timeouts are flags or env vars; defaults equal today's values.
- No new features. No change to masking, Bedrock routing, paywall, NEAR payment, analyst logic, crossask,
  pricing, UI pages, file reading or PDF extraction (PDF text stays extracted in the browser).
- Every file is read in full before it is edited. Anything unverified is listed in section 10.

Out of scope (later, TEE step): file upload instead of reading C:\, server-side PDF extraction, pushing
images to a registry, encrypted secrets, attestation.

## 2. What runs today (verified from the files)

| Part | How it runs | Port | Source |
|---|---|---|---|
| test-console (UI + backend in one) | Node, `start-ui.ps1` | 127.0.0.1:8730 | `test-console/console/server.ts` (`.listen(PORT, "127.0.0.1")`) |
| console paid-jobs internal listener | Node, same process, only with `--paid-jobs on` | 127.0.0.1:8731 | `--jobs-internal-host/--jobs-internal-port` |
| analyst (DuckDB) | Node, `start-analyst.cmd` | 127.0.0.1:8740 | `services/analyst/src/main.ts` |
| chain-query | Node, `start-chain-query.cmd` | 127.0.0.1:8750 | `services/chain-query` (code NOT read yet) |
| ca-gateway (masking + routing + Bedrock) | Docker, `switch-models.ps1` | host 127.0.0.1:8720 → 8700 | `services/gateway/Dockerfile` |
| ca-presidio | Docker, `stack.ps1` | none on host; 3000 on network | alias `presidio.railway.internal` |
| ca-paywall (x402, NEAR USDC rail) | Docker, `stack.ps1 -NearEnvFile` | 127.0.0.1:8080 | `services/paywall/Dockerfile` |
| ca-openrouter-stub (spy, tests only) | Docker, `stack.ps1` | 127.0.0.1:5004 | `test-console/spy/spy-openrouter.ts` |
| tenant Presidio for `agent.ts` | Docker container `presidio` | 127.0.0.1:5002 | STATE.md F2 — NOT touched by this plan |

Docker network today: `chainaim-test`. Gateway key: `test-console/local-gateway-key.txt` (read by the console,
`stack.ps1` and `switch-models.ps1`).

## 3. Target

```
YOUR PC (no keys, no processing)              DOCKER (network chainaim-test)
------------------------------------          ---------------------------------------------------------
Browser + Intear wallet                       console-api  (server.ts --mode api)   :8735 (host 127.0.0.1)
8730 UI (server.ts --mode ui) --forwards-->     |- analyst      :8740
  serves /, /wallet.js, /near-wallet.js         |- chain-query  :8750
  everything else forwarded unchanged           |- paywall      :8080 (host 127.0.0.1:8080, as now)
                                                |- gateway      :8700 (host 127.0.0.1:8720, as now)
                                                |- presidio     :3000 (no host port, as now)
                                                |- near-watch   :8790 (from the adminUI-NEAR compose)
                                              console-api internal listener :8731 (network only)
C:\PRIV-AI-DATA  --read-only mount-->  console-api and analyst at /data/priv-ai-data
```

### 3.1 Node -> Docker

| Service | Today | Docker service / container | Port on PC |
|---|---|---|---|
| console backend | Node 8730 | `console-api` | 127.0.0.1:8735 |
| console internal listener | Node 8731 | `console-api:8731` | none |
| analyst | Node 8740 | `analyst` | 127.0.0.1:8740 (debug) |
| chain-query | Node 8750 | `chain-query` | 127.0.0.1:8750 (debug) |
| gateway | Docker (script) | `gateway` / `ca-gateway` | 127.0.0.1:8720 |
| presidio | Docker (script) | `presidio` / `ca-presidio` | none |
| paywall | Docker (script) | `paywall` / `ca-paywall` | 127.0.0.1:8080 |
| stub / spy | Docker (script) | `openrouter-stub` / `ca-openrouter-stub`, compose profile `test` | 127.0.0.1:5004 |

Stays outside Docker: the 8730 UI process, the browser, Intear wallet, CLI scripts run by hand
(`agent.ts`, `pay.ts`, `near-storage.ts`, `private-ask.ts`), and the tenant Presidio on 5002.

### 3.2 Call-by-call URL changes (all already flags or env; set in compose, no code change)

| Caller -> callee | Today | In Docker | Set by |
|---|---|---|---|
| 8730 UI -> console-api | (same process) | `http://127.0.0.1:8735` | new `--api` (UI mode) |
| console-api -> gateway | `http://127.0.0.1:8720` | `http://gateway.railway.internal:8700` | `--gateway` |
| console-api -> paywall | `http://127.0.0.1:8080` | `http://paywall:8080` | `--paywall` |
| console-api -> analyst | `http://127.0.0.1:8740` | `http://analyst:8740` | `--analyst` |
| console-api -> chain-query | `http://127.0.0.1:8750` | `http://chain-query:8750` | `--chain-query` |
| console-api -> spy | `http://127.0.0.1:5004` | `http://openrouter-stub:5004` | `--spy` |
| console-api -> near-watch (job feed) | `http://127.0.0.1:8790/ingest/job` | `http://near-watch:8790/ingest/job` | `--job-feed-url` |
| paywall -> gateway | `http://gateway.railway.internal:8700` | unchanged (alias kept) | `GATEWAY_URL` |
| paywall -> console (paid jobs) | `http://host.docker.internal:8731` (M2) | `http://console-api:8731` | `PAID_JOBS_RESULT_URL` |
| paywall -> near-watch (claims) | `host.docker.internal:8790` | `http://near-watch:8790/ingest/claim` | `PAYMENT_LOG_URL` |
| gateway -> presidio | `http://presidio.railway.internal:3000` | unchanged | `--presidio-url` |
| browser -> UI | `http://127.0.0.1:8730` | unchanged | — |

## 4. Code changes needed (to be done in the build phase, NOT now)

Each is additive; default = today's behaviour; each gets its own tests.

### 4.1 `test-console/console/server.ts`

Verified facts from reading the whole file:
- Listens on `127.0.0.1` (hardcoded) on `--port` (default 8730).
- Reads the gateway key from `test-console/local-gateway-key.txt` at start-up.
- Static parts: `GET /` (index.html, plus `paid-jobs.html` injected before `</body>` only with `--paid-jobs on`),
  `GET /wallet.js`, `GET /near-wallet.js`.
- Backend routes: `/gateway/models`, `/gateway/{scan,mask,chat}`, `/paywall/{scan,mask,chat}`, `/view` (POST),
  `/view/<id>` (GET, in-memory pages, own CSP), `/data/{config,folders,files,file}`, `/analyst/<route>`,
  `/chain/<route>`, `/datasets`, `/packask`, `/crossask`, `/jobs/{config,crossask}`, `/paid/jobs/<id>/release`,
  `/paid/{near,network,chat}`, `/leaving`, `/ledger`.
- `hostOk(req)` refuses data, analyst, chain, datasets, packask, crossask, jobs and paid routes unless the
  `Host` header is exactly `127.0.0.1:<PORT>` or `localhost:<PORT>` (DNS-rebinding guard).
- `/ledger` runs `docker exec ca-gateway sh -c "tail -n 6 /data/ledger/*.jsonl"`; on error it returns `{lines: []}`.
- Data routes resolve `allowedRoots` from `--data-config` relative to the repo root; `/datasets` reads
  `config/datasets.json`.

Changes:

| # | Flag | Default (= today) | Why |
|---|---|---|---|
| C1 | `--mode all\|ui\|api` | `all` | split without changing today's single process |
| C2 | `--bind HOST` | `127.0.0.1` | container must listen on `0.0.0.0` |
| C3 | `--api URL` (ui mode only) | none (required in ui mode) | where the UI forwards to |
| C4 | `--allowed-hosts LIST` | `127.0.0.1:<port>,localhost:<port>` | keep `hostOk` strict; api mode accepts the forwarded Host |
| C5 | `--ledger-source docker-exec\|dir:<path>\|off` | `docker-exec` | in Docker read the gateway ledger volume mounted read-only |
| C6 | `--gateway-key-file PATH` | `test-console/local-gateway-key.txt` | mount the key file as a read-only secret |
| C7 | `--paid-jobs-page on\|off` (ui mode) | follows `--paid-jobs` | UI injects the tab-03 fragment without running jobs |

UI mode behaviour (C1/C3): serve `/`, `/wallet.js`, `/near-wallet.js` locally; forward every other request to
`--api` byte for byte (method, path, query, body, `content-type`, `payment-signature`), and pass back status,
body and the headers the server sets today (`content-type`, `cache-control`, `content-disposition`,
`content-security-policy` and the other `/view` headers, `payment-required`, `payment-response`, `retry-after`,
`x-chainaim-*`). Forward timeout = the longest of today's (`--paid-timeout-sec` 240,
`--crossask-timeout-sec` 300) unless set. UI mode holds no key and reads no files.

Host guard (C4): the UI keeps its own `hostOk` for the browser; when forwarding it sets `Host` to the api's
address, and api mode accepts only the hosts in `--allowed-hosts`. Docker publishes console-api on
`127.0.0.1:8735` with the same port inside, so the guard stays exact.

### 4.2 `services/analyst/src/main.ts` (+ `config.ts`)

Verified from the main.ts header: listens on 127.0.0.1, default port 8740; routes require `Host` to be
`127.0.0.1:<port>` or `localhost:<port>`; `--data-config`, `--work-dir` exist.

| # | Flag | Default | Why |
|---|---|---|---|
| A1 | `--bind HOST` | `127.0.0.1` | listen on `0.0.0.0` in Docker |
| A2 | `--allowed-hosts LIST` | `127.0.0.1:<port>,localhost:<port>` | accept `analyst:8740` from console-api |

NOT yet read: `config.ts` (`insideRoots`, `readDataConfig`) and where the listen/Host check is coded. Read first.

### 4.3 `services/chain-query`

NOT read yet. Expected: a `--bind` flag (default `127.0.0.1`) and possibly a Host check like the analyst.
Confirm by reading before planning the exact change.

### 4.4 Packaging (new files)

| File | Notes |
|---|---|
| `test-console/Dockerfile` | `node:24-slim`; context = repo root (imports `services/web/src`, `packages/crossask`, `config/`); builds `services/web/public/wallet.js` and `near-wallet.js` in a build stage |
| `services/analyst/Dockerfile` | `node:24-slim`; `npm ci` inside (Linux DuckDB binary — never copy Windows `node_modules`); context = repo root (imports `packages/crossask`) |
| `services/chain-query/Dockerfile` | after reading its code |
| `docker-compose.yml` (repo root) | all services, network `chainaim-test` (external), named volumes, `env_file` from `C:\PRIV-AI-SECRETS`, ports on `127.0.0.1` only |
| `config/data-sources.docker.json` | `allowedRoots: ["/data/priv-ai-data"]`, `defaultFolder` under it |
| `up.ps1` / `down.ps1` | compose up, wait for `/healthz`, start the 8730 UI window; down stops both |

Existing Dockerfiles (paywall, gateway, presidio) are reused unchanged.

### 4.5 Compose details

- Container names kept (`ca-gateway`, `ca-paywall`, `ca-presidio`, `ca-openrouter-stub`) so `stack.ps1 -Check`
  still recognises them and old and new cannot run at the same time by accident.
- Gateway: same command `switch-models.ps1` builds today (`--host :: --port 8700 --model-source catalog
  --catalog /config/catalog.bedrock.json --presidio-url http://presidio.railway.internal:3000 --ledger /data/ledger`,
  plus the chosen mode's flags), `config/` mounted read-only at `/config`, volume `chainaim-test-ledger:/data`
  (the existing volume, so the ledger history is kept), `BEDROCK_API_KEY` from the secrets env file.
- Paywall: `PAY_RAILS`, `NEAR_*` from `C:\PRIV-AI-SECRETS\near-testnet.env`; adds `PAID_JOBS=on`,
  `PAID_JOBS_KEY`, `PAID_JOBS_RESULT_URL=http://console-api:8731` (closes M2 and M4),
  `PAYMENT_LOG_URL=http://near-watch:8790/ingest/claim`, `PAYMENT_LOG_KEY`.
- console-api: `--mode api --bind 0.0.0.0 --port 8735 --jobs-internal-host 0.0.0.0 --data-config
  /app/config/data-sources.docker.json --ledger-source dir:/ledger` + the same paid-jobs and pricing flags used
  today; `C:\PRIV-AI-DATA` mounted read-only at `/data/priv-ai-data`; gateway ledger volume read-only at `/ledger`;
  run log to a named volume.
- analyst: `--bind 0.0.0.0 --allowed-hosts analyst:8740 --data-config ... --work-dir /work`; data read-only;
  `/work` named volume (recipes and manifests).
- Stub only with `docker compose --profile test up`.

Visible difference: the folder picker shows `/data/priv-ai-data/...` instead of `C:\PRIV-AI-DATA\...` (same files).

## 5. Phases

| Phase | Work | Who | Gate to pass before next phase |
|---|---|---|---|
| P0 | Git branch `dockerize`; record running containers and ports; run all baselines (section 7) | Manual (AI gives commands) | All baselines pass and are written in BUILD_LOG.md |
| P1 | Read analyst `config.ts`, chain-query code; add A1/A2 and chain-query bind; tests | AI | Analyst + chain-query tests pass; old `start-ui.ps1` still works |
| P2 | Dockerfiles for analyst and chain-query; compose with only these two; console still local Node pointed at them | AI writes, you run | "Ask across files" and Blockchain queries work from the UI |
| P3 | server.ts C1–C7 + tests for UI mode, forwarding, Host guard, ledger source | AI | Root `npm test` passes with new tests; `--mode all` identical to today |
| P4 | console-api Dockerfile; gateway, presidio, paywall into compose (same names, same volume) | AI writes, you run | `stack.ps1 -Check` passes; 402 quote correct |
| P5 | Wire paywall ↔ console-api ↔ near-watch by service name; `up.ps1`/`down.ps1` | AI writes, you run | Paid job: quoted → paid in NEAR USDC → released; admin UI shows matched |
| P6 | Docs: README, MANUAL_SETUP, RUN-ON-ANOTHER-PC, STATE.md | AI | Docs match what ran |

One phase at a time; a failed gate stops the work and is fixed before moving on.

## 6. AI vs manual

- AI can do: read code, write Dockerfiles, compose, flags, tests, scripts, docs; give exact commands.
- Manual — you: run commands on the PC (Docker, npm test), keep secrets in `C:\PRIV-AI-SECRETS`,
  the TestNet paid-job check in the browser with Intear, approve each phase.

## 7. Verification (before and after every phase)

Baselines (from STATE.md 2026-11-05):
- root `npm test` 397/397
- `services/paywall` `npm test` 274/274
- `packages/crossask` 23/23
- `services/web` 133/133
- `services/analyst` (its own suite; note the pre-existing Windows libuv exit crash in reconcile-explain)

Known pre-existing issues (not caused by this work): console-paid-jobs ARCH-104/105 TTL-boundary flake;
route-engine check needs tsc; root `npm test` check-deps 2 stale allows.

End-to-end proof (P5): one unpaid crossask; one paid chat in NEAR USDC; one paid tab-03 job released;
`docker logs ca-paywall` shows `payment_settled`; the adminUI shows the job and a `matched` reconcile.

## 8. Rollback (any phase)

1. `docker compose down` (volumes are kept).
2. `docker start ca-presidio ca-openrouter-stub ca-gateway ca-paywall` if they were stopped, or
   `stack.ps1 -Rebuild paywall -NearEnvFile ...` / `switch-models.ps1 -To <mode>` as today.
3. `start-ui.ps1` (unchanged).
Code rollback: switch back to `main`; every new flag's default is today's behaviour anyway.

## 9. Secrets

- Never in images, never in compose files, never printed. Compose reads `env_file` from
  `C:\PRIV-AI-SECRETS\` (gateway key file mounted read-only; Bedrock key; NEAR relayer key; paid-jobs key;
  near-watch ingest key).
- Do not paste `docker inspect` or `docker compose config` output into chat: both print environment values.

## 10. Open items to verify before building

1. chain-query code (bind, Host check, routes) — not read.
2. analyst `config.ts` and where the Host check and listen live — not read.
3. Which gateway mode the live `ca-gateway` runs now (`docker logs ca-gateway --tail 20`).
4. The exact flags the current console is started with for paid jobs (pricing catalog, fees, margin) — from
   your current start command or MANUAL_SETUP.md; they must be copied into compose unchanged.
5. `services/web` bundle build commands inside the Linux image (`build:wallet`, `build:near-wallet`).
6. Whether the gateway image's `route-engine/dist` is present in this checkout (Dockerfile copies it).

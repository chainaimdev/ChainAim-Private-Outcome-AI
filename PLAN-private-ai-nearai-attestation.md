# chainiam-private-ai — NEAR AI Cloud model (DeepSeek reasoning, in a TEE) + model attestation shown in tab 03 — Plan

Written 2026-11-06. PLAN ONLY: no code is changed by this file. Companion plan (admin UI side):
`PLAN-adminui-nearai-attestation.md`.

Labels: **[read]** = read in the repo or the official docs on 2026-11-06 · **[verify]** = not proven yet, checked first in
the build (section 4), stop and report if it fails · **[owner]** = manual step.

Requirement IDs: **ARCH-401 … ARCH-414** (A = ARCH-401…406, B = ARCH-407…414). Taken: ARCH-001…018, 101…115, 201…211, 301…314.

## 1. Goal and decisions (owner, 2026-11-06)

- **A — the model.** Add NEAR AI Cloud's **`deepseek-ai/DeepSeek-V4.1-Flash-1017`** (reasoning, runs in NEAR AI's own TEE)
  as one more model the tab 03 job can use. Bedrock, OpenRouter and local models stay exactly as they are.
- **B — the proof.** For every call to that model, collect NEAR AI's attestation evidence and reply signature, verify them
  in Docker, and show the result in **tab 03** (this plan) and in the **admin UI Jobs tab** (companion plan).
- **Docker only, UIs outside.** Every new backend part runs in a container on network `chainaim-test`. On the PC only the
  two UIs run (8730 `server.ts --mode ui`, 8800 admin UI) plus the launcher scripts (`up.ps1`, `switch-models.ps1`).
- **Key.** `NEARAI_API_KEY`: in `C:\PRIV-AI-SECRETS\chainaim.env` **or** typed at `switch-models.ps1`'s hidden prompt
  (same as `BEDROCK_API_KEY` today). Never in git, never on a command line, never printed.
- No mocks in product code; no hardcoding (every URL, model id, timeout, refresh interval is a setting with a default);
  everything off or unchanged unless NEAR AI is used.

## 2. Facts this plan relies on

| # | Fact | Source |
|---|---|---|
| F1 | Model `deepseek-ai/DeepSeek-V4.1-Flash-1017`: `ownedBy: nearai`, `verifiable: true`, `attestationSupported: true`, features `tools`, `reasoning`, context 1,048,576. Price $0.30 / $1.20 per 1M input/output tokens. The look-alike `deepseek/deepseek-v4.1-flash*` ids are forwarded to OpenRouter (`verifiable: false`) and must NOT be used. | `GET https://cloud-api.near.ai/v1/model/list` [read] |
| F2 | OpenAI-compatible: base URL `https://cloud-api.near.ai/v1`, `POST /chat/completions`, `Authorization: Bearer <key>`. Credits are prepaid. | docs.near.ai/cloud/quickstart [read] |
| F3 | Attestation report: `GET /v1/attestation/report?model=…&provider=near&signing_algo=…&nonce=…` (API key; **non-billable**); header `x-no-aliasing: true` so the model is not rewritten. Fields: `gateway_attestation`, `model_attestations[]` (`intel_quote`, `event_log`, `request_nonce`, `signing_address`, `signing_algo`, `nvidia_payload`, `info.tcb_info.app_compose`). | docs.near.ai api-reference + model-attestations [read] |
| F4 | Reply signature: `GET /v1/signature/{chat_id}?model=…&signing_algo=…`; `text` = `<MODEL_ID>:<request_hash>:<response_hash>` (`provider_tee`) or `<request_hash>:<response_hash>` (`gateway`); hashes = **SHA-256 of the exact request / response body bytes**; send `Accept-Encoding: identity`; ecdsa = EIP-191 recover → `signing_address`; 404 = retry for a short bounded time, then unverified. Evidence must be gathered **before** the completion (preflight). | docs.near.ai response-signatures [read] |
| F5 | Official verifier `nearai/nearai-cloud-verifier` (MIT): Python and TypeScript (Node 20+); TDX quote with `dcap-qvl`, GPU evidence via NVIDIA NRAS, ECDSA signature recovery, compose measurement. README shows `import { fetchReport, checkTdxQuote } from 'nearai-cloud-verifier'`. | github.com/nearai/nearai-cloud-verifier [read] |
| F6 | Gateway calls a deployment with `fetch(baseUrl + "/chat/completions")`, body `{...masked body, model: servedModel, stream: false, provider: { data_collection } }`, reads the reply as text, and returns the parsed completion (its `id` included) to the caller. It never streams upstream. | `services/gateway/src/dispatch.ts` [read] |
| F7 | The registry entry fields `id, servedModel, baseUrl, apiKeyEnv, zone, pricing` become catalog deployments; requests get the **smallest** `maxOutputTokens` of all entries (2048 today). | `scripts/local-models.ts`, `config/local-models.cpu-all.json` [read] |
| F8 | The console's model call (`gatewayChat`) reads the completion JSON and `x-chainaim-*` headers into `ChatReply` (text, model, zone, usage, entityCounts, residual). | `packages/crossask/src/index.ts` [read] |
| F9 | The mode file lists the keys `switch-models.ps1` asks for (`secretEnv`); compose passes gateway keys by name; `up.ps1` reads only `OPENROUTER_API_KEY|BEDROCK_API_KEY` from `chainaim.env` or the running gateway. | `test-console/modes/ollama-cpu-8gb-all.json`, `docker-compose.yml`, `test-console/up.ps1` [read] |
| F10 | Gateway README rule: gateway uses Node built-ins only. | README.md repository layout [read] |

## 3. Design

```
PC (UI only)                         Docker, network chainaim-test
8730 UI ──▶ ca-console-api ──▶ ca-gateway ──(masked body, sha256 of exact bytes)──▶ NEAR AI Cloud (TEE)
              │   reply + x-chainaim-provider-id / -req-sha256 / -resp-sha256 headers ◀──┘
              │
              └──▶ ca-attest (NEW)  ── preflight: attestation report per model, verified, refreshed ──▶ NEAR AI
                     verify(call): signature for chat_id, EIP-191 recover, hashes equal, signer in a verified
                     report fetched before the call, TDX quote (dcap-qvl), GPU evidence (NRAS)
                     ──▶ result per call ──▶ console-api: tab 03 badge  +  job feed job_attested ──▶ near-watch
```

- **Why the gateway computes the hashes:** only it holds the exact bytes sent to and received from NEAR AI (F4, F6). It
  exports **hashes and the provider's chat id only** (no text) as response headers, like `x-chainaim-entity-counts` today.
- **Why a new container `ca-attest`:** the verifier needs npm packages and outbound calls (Intel collateral, NVIDIA
  NRAS); the gateway stays Node-built-ins-only (F10) and holds no verifier code. `ca-attest` holds `NEARAI_API_KEY`
  (needed for report and signature calls); the UIs never do.
- **Preflight rule (F4):** `ca-attest` fetches and verifies the report for each attested model at start and every
  `--report-refresh-sec`; a call is checked only against a report fetched **before** that call's time.

## 4. Verify first (before code) [verify]

| ID | Check | If it fails |
|---|---|---|
| V1 | One chat completion with the gateway's exact body shape (incl. `provider: {data_collection}` and `max_tokens 2048`) to `deepseek-ai/DeepSeek-V4.1-Flash-1017`: answered, non-empty `content`, `usage` present. | `provider` refused → per-deployment flag to omit it (ARCH-402). Empty content (reasoning used the budget) → raise that entry's output budget or a per-model cap; report before choosing. |
| V2 | `GET /v1/signature/{id}` for that reply returns a signature whose hashes equal SHA-256 of the exact bytes the gateway sent/received. | Stop: B cannot be built as designed. |
| V3 | `nearai-cloud-verifier` TypeScript is installable in a Node 24 image (npm or a pinned git commit) and runs `fetchReport` / `checkTdxQuote` / signature recovery. | Use its Python verifier in the `ca-attest` image instead (same checks), or report. |
| V4 | NVIDIA NRAS and Intel collateral reachable from a container on this PC. | GPU / TDX shown as "not checked: unreachable", never as passed. |
| V5 | Which `signature_kind` the DeepSeek replies carry (`provider_tee` or `gateway`). | Both are handled (F4); the badge says which one. |

**Gate results (owner PC, 2026-11-06; BUILD_LOG):** V1 PASS (tab 03 job + probe) · V2 PASS (provider_tee, exact-byte hashes,
signer = preflight candidate; scripts/nearai-v2-probe.ts) · V3 PASS (official verifier @ 94554726 via npm in node:24: TDX
UpToDate, report binds signer + nonce, NVIDIA true, mr_config = compose hash; non-streaming chat provider_tee valid; streaming
chat = gateway kind, not model-attested) · V4 PASS (NRAS, Intel reachable) · V5 provider_tee for non-streaming.

## 5. Components

| Component | Change | Responsibility |
|---|---|---|
| `config/local-models.cpu-all.json` | **one new entry** (A) | `nearai/deepseek-v4.1-flash` → `servedModel deepseek-ai/DeepSeek-V4.1-Flash-1017`, `baseUrl https://cloud-api.near.ai/v1`, `apiKeyEnv NEARAI_API_KEY`, `zone private-cloud`, `pricing {0.30, 1.20}`, `supportsTools true`, tasks incl. `reasoning`, plus `"attest": "nearai"` (B). |
| `scripts/local-models.ts` | edit (B) | pass an optional `attest` field through to the deployment; unknown values refused. |
| `services/gateway/src/catalog.ts`, `dispatch.ts`, `server.ts` | edit (B) | for deployments with `attest: "nearai"` only: send `Accept-Encoding: identity` and `x-no-aliasing: true`, SHA-256 the exact request and response bytes, return `x-chainaim-provider-id`, `x-chainaim-req-sha256`, `x-chainaim-resp-sha256`, `x-chainaim-served-model`; ledger records the chat id and hashes (no text). Other deployments: byte-identical behaviour. Optional per-deployment `omitProviderField` only if V1 requires it. |
| `services/paywall` | edit (B) | strip the new `x-chainaim-provider-id/-req-sha256/-resp-sha256/-served-model` headers from public responses, as it already strips the entity-count headers. |
| `services/attest/` | **new** service + Dockerfile (B) | `GET /healthz`, `GET /reports` (per model: fetched at, verified, signer, reasons), `POST /verify` `{calls:[{chatId, servedModel, requestSha256, responseSha256, calledAt}]}` → per call result. Uses the official verifier (V3). Host check like the other services. |
| `packages/crossask/src/index.ts` | edit (B) | `ChatReply.attest?` = `{providerId, servedModel, requestSha256, responseSha256}` from the new headers; absent when absent. |
| `test-console/console/server.ts` (+ `job-feed.ts`) | edit (B) | `--attest-url` (default unset = off). After a job is quoted: ask `ca-attest` to verify its NEAR AI calls (async, never blocks or fails the job); keep the result on the held job; `GET /jobs/:id/attestation` (host check); job feed event `job_attested`. |
| `test-console/console/paid-jobs.html` | edit (B, UI) | under the quote and the released result: **"Model attested ✓ — DeepSeek V4.1 Flash · NEAR AI TEE · signature verified"** or the exact reason it is not; signer address, signature kind, report time; a "How to verify" link to `https://cloud.near.ai/verify`. Agent mode timeline: one extra line "model attested". |
| `docker-compose.yml` | edit | gateway `environment` gains `NEARAI_API_KEY`; new service `attest` (`ca-attest`, profile `attest`, network `chainaim-test`, no published port or `127.0.0.1` only, `NEARAI_API_KEY` by name). |
| `test-console/modes/ollama-cpu-8gb-all.json` | edit (A) | `secretEnv` adds `NEARAI_API_KEY` (asked at the hidden prompt when not in `chainaim.env`). |
| `test-console/up.ps1` | edit | key allowlist adds `NEARAI_API_KEY`; `-Attest on|off` (default on, switched off with an INFO line when no `NEARAI_API_KEY`, like `-Agent`); console flag `--attest-url http://attest:8770`. |
| Docs | edit | `cmd.md` (key, flags, checks), `README.md`, `MANUAL_SETUP.md` (dated section), `BUILD_LOG.md`, `STATE.md`. |

Settings with defaults (no hardcoding): `ca-attest` `--port 8770`, `--nearai-base https://cloud-api.near.ai/v1`,
`--signing-algo ecdsa`, `--report-refresh-sec 900`, `--signature-retry-sec 30`, `--models <from the catalog's attest entries>`,
`--gpu-check on|off` (default on), `--allowed-hosts`; console `--attest-url`, `--attest-timeout-ms 20000`.

---

# Requirements

### A — the model

**ARCH-401 — Nothing else changes.** Without the new entry chosen in tab 03, every route, model, price and test behaves as
today. Acceptance: all suites keep their counts (root 442, paywall 292, crossask 30, web 133, chain-query 11, analyst 177
+1 known) plus the new tests; `check-deps.ts` gains no new allow entry.

**ARCH-402 — Registry entry.** The entry in section 5 (values from F1/F2). Generated catalog contains it with zone
`private-cloud` (so `--phi-zones local` keeps health data off it and `chainaim/auto` never picks it), pricing 0.30 / 1.20.
Acceptance: `ARCH-402:` generator test; V1 passes live.

**ARCH-403 — Key plumbing.** `NEARAI_API_KEY` reaches only `ca-gateway` (and `ca-attest`, B) by name: mode `secretEnv`,
compose `environment`, `up.ps1` allowlist. Never printed, never in a file the scripts write. Acceptance: `up.ps1 -DryRun`
prints `NEARAI_API_KEY from …chainaim.env` or `kept from the running ca-gateway`, never the value.

**ARCH-404 — Paid-job price.** Tab 03 jobs using the model are priced from its catalog entry and the reply's `usage`.
Acceptance: one live job quoted with `calls[i].model = nearai/deepseek-v4.1-flash` and tokens > 0.

**ARCH-405 — Reasoning output budget.** If V1 shows reasoning tokens exhaust the shared 2048 budget, the entry's budget
is set from measured values (a setting, not a guess). Acceptance: V1 record in BUILD_LOG.md.

**ARCH-406 — Live A [owner].** One tab 03 job with both models = `nearai/deepseek-v4.1-flash`: answered, quoted, paid in
NEAR USDC, released; NEAR AI usage page shows the calls.

### B — the proof

**ARCH-407 — Exact-byte hashes in the gateway.** Only for `attest: "nearai"` deployments; headers in ARCH-408. Acceptance:
`ARCH-407:` test against a real HTTP server on loopback recording the bytes: header hashes equal SHA-256 of what it
received and sent; a non-attested deployment's request is byte-identical to today's.

**ARCH-408 — Headers and ledger, never text.** `x-chainaim-provider-id`, `-req-sha256`, `-resp-sha256`, `-served-model`;
ledger adds `providerId`, hashes. The paywall strips them from public responses. Acceptance: tests; a ledger capture holds
no message text.

**ARCH-409 — `ca-attest` preflight reports.** Fetch with a fresh random nonce, `provider=near`, `x-no-aliasing: true`;
verify TDX quote (dcap-qvl), nonce and signer binding, RTMR3 replay, app-compose hash vs MRCONFIGID, GPU evidence (NRAS)
via the official verifier. **Owner decision 2026-11-06 (option a): no RTMR3 replay** — the official verifier @ 94554726 has
none (read 2026-11-06), and ca-attest adds no unaudited check of its own; the other checks are the official verifier's. Keeps the last verified report per model with its fetch time. Acceptance: `ARCH-409:` tests on a
recorded real report (fixture saved from a live call, as near-watch's tests use a recorded real tx); V3/V4 live.

**ARCH-410 — Verify one call.** Signature fetched with bounded retry; EIP-191 recover = `signing_address`; text's hashes =
gateway's hashes; text's model = served model (`provider_tee`); signer + algo match exactly one report verified **before**
`calledAt`. Result: `verified | unverified(reason) | unavailable(reason)`. Acceptance: tests on recorded real signature +
report; a changed byte → `unverified: hash mismatch`; a report fetched after the call → not used.

**ARCH-411 — Console wiring.** `--attest-url` off by default; after `job_quoted`, verify the job's NEAR AI calls without
blocking the job; `GET /jobs/:id/attestation`; non-NEAR-AI calls listed as `not_applicable`. Acceptance: tests with a real
`ca-attest` process and recorded fixtures; job flow unchanged when `ca-attest` is down (`unavailable: attest service`).

**ARCH-412 — Job feed `job_attested`.** `{v:1, event:"job_attested", ts, jobId, network, summary, calls:[{step, model,
servedModel, providerId, signatureKind, signingAlgo, signingAddress, reportFetchedAt, tdx, gpu, signature, hashes, status,
reason}]}` — ids, addresses, booleans and reasons only. Acceptance: builder test proves no text field; companion plan ARCH-501
accepts it.

**ARCH-413 — Tab 03 badge (UI).** As in section 5; "model attested" wording only (masking is not covered by this proof).
Acceptance: `ARCH-413:` page tests (style of `console-paid-jobs.test.ts`); manual job unchanged when attestation is off.

**ARCH-414 — Live B [owner].** One NEAR AI job: badge shows verified; the same `chat_id` checked once by hand at
`https://cloud.near.ai/verify`; admin UI shows the same result (companion ARCH-506).

## 6. AI work vs owner work

**AI can do:** V1–V5 scripts, ARCH-401…413 code, Dockerfile, compose, `up.ps1`, tests, docs, BUILD_LOG.

**Owner, one step at a time (never paste the key or `docker inspect` / `docker compose config` output):**

| ID | Step |
|---|---|
| M1 | Put `NEARAI_API_KEY=...` in `C:\PRIV-AI-SECRETS\chainaim.env` in Notepad (or type it at `switch-models.ps1`'s hidden prompt, right-click paste). Check names only: `Get-Content C:\PRIV-AI-SECRETS\chainaim.env \| ForEach-Object { ($_ -split '=')[0] }`. |
| M2 | Confirm the NEAR AI account has credits (cloud.near.ai, Credits). |
| M3 | `switch-models.ps1 -To ollama-cpu-8gb-all`, then `.\test-console\up.ps1 -ReplaceRunning -Build`. |
| M4 | ARCH-406 and ARCH-414 live runs. |

## 7. Build order

1. Baseline counts. 2. V1–V5 (stop and report on failure). 3. A: ARCH-402 → 403 → 404 → 405, owner M1–M3, ARCH-406.
4. B: ARCH-407 → 408 → 409 → 410 → 411 → 412 → 413. 5. Companion admin plan ARCH-501…505. 6. ARCH-401 "after".
7. Owner ARCH-414 / ARCH-506.

Rollback: choose another model in tab 03 (A); `up.ps1 -Attest off` (B).

## 8. Out of scope

- The agent's own model (Strands Bedrock connection) — separate change.
- Proof of the masking step itself (needs the containers in a TEE: Phala, later).
- Streaming upstream calls (the gateway never streams upstream, F6).

Sources: [model list](https://cloud-api.near.ai/v1/model/list) · [quickstart](https://docs.near.ai/cloud/quickstart.md) ·
[attestation report](https://docs.near.ai/api-reference/attestation/get-attestation-report.md) ·
[signature](https://docs.near.ai/api-reference/attestation/get-completion-or-responses-api-signature.md) ·
[response signatures](https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md) ·
[model attestations](https://docs.near.ai/cloud/verification/cloud-api/model-attestations.md) ·
[verifier](https://github.com/nearai/nearai-cloud-verifier)

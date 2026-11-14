# privateAI-design-42: the deal on the admin Jobs tab (item 13, R1) and the pre-payment re-estimate (item 12 part 1, R3)

Chat near-ai-impl-15, 2026-11-14. Built and tested in the same chat (BUILD_LOG.md). Both are additive and behind
flags; with the flags off every message, event and step is byte-for-byte as before. (The Apprentice design planned
as design-42 in near-ai-impl-14 takes the next free number, design-43.)

## 1. Item 13 (R1): the admin UI shows the deal, both signatures

Today the admin Jobs tab shows ChainAim's signed quote (job_quoted.ap2, adminUI ARCH-702) and the receipt (ARCH-701).
The buyer side of the AP2 deal, the tenant's closed checkout mandate (design-36 ARCH-666..668), is in the receipt
(`body.mandate {sha256, kid, tenant, accountId, nonce}`) but never reached near-watch.

| ID | Where | What |
|---|---|---|
| ARCH-710 | private-ai `test-console/console/job-feed.ts`, `server.ts` | `--job-feed-mandate on\|off` (default off; needs `--job-feed-url` and `--job-feed-receipts on`). On: `job_receipt` carries `mandate {kid, tenant, sha256}` when the receipt records one. Never `accountId` or `nonce`, never the mandate token. up.ps1 adds it when checkout mandates are on and `job_receipt` is already sent. |
| adminUI ARCH-704 | near-watch `src/jobs.ts`, `src/store.ts` | `job_receipt.mandate` parsed strictly (`kid` 32 hex, `tenant` `^[a-z0-9_-]{1,32}$`, `sha256` 64 hex, any other field refused, the whole event with it). New table `job_mandates`, written and cleared with the job's receipt (a newer receipt without a mandate drops the old one). `JobView.mandate` only when stored. |
| adminUI ARCH-705 | admin-console `lib/proof-view.ts`, `lib/types.ts`, `lib/live-store.ts`, `components/tabs/jobs.tsx` | Jobs table column "tenant mandate" (✓ tenant / –), the detail panel's deal line "ChainAim signed the quote ✓ · tenant t01 signed the mandate ✓" and three rows (tenant, key id, hash), a "Where this comes from" row. The strict reader refuses a malformed mandate. |

Nothing is re-verified on the admin side: near-watch holds key ids and hashes, never a signature or a key. Who verified
what is said in the titles: the agent signed the mandate with the tenant's key; ChainAim's signer verified it before the
run; the signed receipt records its hash (verify-receipt re-checks it offline).

## 2. Item 12 part 1 (R3): re-measure at mandate time, before any money moves

With upfront pay (design-37) the folder is re-sized only inside the paid run (ARCH-638), after the payment settled, so a
folder that grew between the estimate and the payment costs a refund round-trip (gas both ways, refund latency). Part 1
moves the same check in front of the payment, for the AI agent's estimate-first jobs.

| ID | Where | What |
|---|---|---|
| ARCH-711 | private-ai console `server.ts` | `GET /offers/<id>/recheck` (same host check as `POST /offers`). The held offer's folder re-sized by the paid run's own rule: the signed limits when there are some (`heldLimits`, moved unchanged out of runOffer), else the held basis and `--offer-size-tolerance-pct` (`offerSize`). 200 `{jobId, ok, files, totalBytes, estimated {files, totalBytes, sizeTolerancePct}, signedLimits}`; 409 `{error, code: "estimate_stale", files, totalBytes}`; 404 no such offer; 400 bad id; 422 held quote not checkable. Runs, holds, signs and pays nothing. Log line `offer_rechecked` (ids and sizes). runOffer's own answers are unchanged (409 `{error}` as before). |
| ARCH-712 | private-ai agent `agent-jobs-core.ts`, `agent-jobs.ts` | `--re-estimate on\|off` (default off). On, for estimate-first jobs: after the policy, before the mandate and the payment are signed, the agent asks ARCH-711. 200 → step `rechecked` (sizes now vs estimated); 409 → `refused` code `estimate_stale` ("ask again for a new estimate"); anything else (offer gone, console unreachable, unreadable answer) → `refused`. Nothing signed or paid in every refusal, so no refund is needed. |
| ARCH-713 | `test-console/up.ps1`, `desk.ps1`, `config/local/desk.example.json` | `desk.ps1 -ReEstimate on\|off` (else desk.json `paidJobs.reEstimate`, else off) → `up.ps1 -ReEstimate` → agent `--re-estimate=on` when the agent runs. Tab 03 and `-AgentAsk` show the step "Size re-checked before paying". |

Part 2 (not built): when the re-check says stale, re-estimate automatically and ask the policy again (a new quote, a new
signed quote, a new mandate). Left for after the deadline: it changes the run's flow, not only adds a check.

Known limit: the re-check narrows the window, it does not close it. A file added between the re-check and the run is
still caught by the run's own check (409) and refunded, as before.

# privateAI-design-32b — Step B: the paying agent verifies the job's receipt (pinned key)

Part of privateAI-design-32 (ARCH-613 "console signs, the buyer's agent verifies with the same code", ARCH-615 receipt
route + tab 03, ARCH-616 settlement). No new ARCH-ID: step B is the verify side of ARCH-613/615/616 in the agent.
Owner decision (near-ai-impl-5/6): commit the receipt PUBLIC key as `config/receipt-public-key.pem`.

## Flow (agent service, `services/paywall/scripts/agent-receipt.ts`)

After `released`, outside the tenant's payment queue slot (the next payment need not wait):

1. `GET <console>/jobs/<jobId>/receipt` up to `--receipt-poll-max` times (default 15), `--receipt-poll-ms` apart (1000):
   the console builds the receipt just after the release and never awaits it. Only `{receipt}` is read; the
   `publicKeyPem` beside it is ignored.
2. `packages/receipt verifyReceipt(receipt, PINNED pem, releasedResult)`: body shape, Ed25519 body signature, settlement
   signature, sha256(canonical released result) == resultSha256.
3. Bound to what the agent saw itself: `body.jobId` == the job it ran; `body.price.amountUnits` == the quoted amount it
   capped its signer at; `settlement.transaction` == the transaction it paid with.
4. A valid receipt without settlement is asked for again; after the last try it is reported verified with settled false.
5. Event `receipt_verified {jobId, receiptId, keyId, settled, transaction?}` or `receipt_failed {jobId, reason}`. Never
   `refused`: the payment already went through, and the run still ends `done`. Console 404 "receipts are off" stops at once.

Order: masked, tool_called, job_ran, quoted, policy, signed, settled, released, receipt_verified | receipt_failed, done.

## Flags (agent-jobs.ts)

`--receipt-verify on|off` (default on; on = start-up refuses a missing / non-Ed25519 key file, naming the path) ·
`--receipt-public-key PATH` (default `<repo>/config/receipt-public-key.pem`; `/app/config/...` in the image) ·
`--receipt-poll-ms 1000` · `--receipt-poll-max 15`. up.ps1 passes `--receipt-verify=on` and stops `-Agent on` without the file.

## Image

`agent.Dockerfile` copies `packages/receipt` (package.json, src) and `config/receipt-public-key.pem`; its ignore file keeps
exactly those (guard `scripts/test/agent-docker.test.ts`, which also proves no private key / env / receipt is kept).

## Key export

`desk.ps1 -ReceiptKey` now always passes `--public-out config\receipt-public-key.pem` (the flag already existed in
`scripts/receipt-key.ts`, verified 2026-11-10). Keep or rotate, the file follows the signing key.

## Tab 03

Agent step `[Agent tNN] Agent verified the receipt ✓ · signed by the pinned key d27d1e9f… · result, job and amount and
transaction match`, or `Receipt check failed ✗: <reason> (the payment stands)`. Receipt panel head adds
`· verified by Agent tNN ✓` (or `· Agent tNN's check failed ✗`); the Me path is unchanged.

Cosmetic fixes in the same step: the policy check values and refusal reasons use plain decimals (`plainUsd`:
"0.010000" -> "0.01"); after a refused/failed agent run the status line returns to the idle text (`explain()`), no longer
"...is running and paying the job…".

## Tests

`services/paywall/test/agent-receipt.test.ts` (14): pinned vs console key, tampered result, job/amount/transaction binding,
polling, unsettled, receipts off, unreachable console, key loading, the committed key id, plainUsd, and the whole run with
the real paywall + NEAR double (released -> receipt_verified -> done; other key -> receipt_failed -> done).
`agent-docker.test.ts` +1, `desk.test.ts` +1 (and -ReceiptKey --public-out), `console-agent.test.ts` +3,
`paid-jobs-receipt.test.ts` +1 (pinned line updated), `agent-policy.test.ts` plain decimals.

## Steps C and D (added 2026-11-11)

C. `desk.ps1 -AgentAsk -Tenant t01 [-Dataset smb-fin-1] [-Template 1|LABEL] [-AgentQuestion "..."] [-AgentSet NAME]
[-AgentAnswerModel default|none|ID]` -> `scripts/agent-ask.ts` (pure parts `scripts/agent-ask-core.ts`). Reads GET
/datasets, /agent/config, /gateway/models from the console API (8735), then POST /agent/crossask with the page's exact body
(folder, question, template sql, datasetId, templateLabel, answerModel/phrase), so the terminal and tab 03 share the relay,
agent, policy, payment and receipt check. Prints each step with its actor tag and the result; saves
`runtime/agent-ask/chainaim-receipt-<jobId>.json` ({receipt, publicKeyPem}, the page's download format) and
`chainaim-result-<jobId>.json`. Exit 0 paid + receipt verified; 1 refused / error / receipt check failed; 2 usage / unreachable.
Crossask datasets only (domain-pack datasets use tab 03's pack path, not the agent).

D. `desk.ps1 -VerifyReceipt FILE [-VerifyResult auto|none|FILE]` -> `scripts/verify-receipt.ts`: offline, pinned
`config/receipt-public-key.pem`, packages/receipt verifyReceipt; the key inside the file is only compared, never trusted;
auto = the chainaim-result-<jobId>.json beside the receipt. Prints ids, dataset, template, files, hashes, calls, price,
settlement + explorer link. Exit 0 valid, 1 not valid (reason), 2 usage.

Tests: scripts/test/agent-ask.test.ts (10: run body, steps, real CLIs vs a loopback console API, tampering, pinned key),
desk.test.ts +1.

# privateAI-design-31 — Console notes (honesty / curation) and the "Ask across files" run log

Owner request 2026-11-05 12:06, after a chiro test in the console showed "Numbers or placeholders not in the result: 2,880":
(1) the UI must increase users' confidence: no negative tone, particularly when the information shown may well be correct;
(2) such notes are labelled as honesty or curation notes. Also: runs from the UI were not saved anywhere, so the 2,880 could
not be traced afterwards (only `dental-test.ps1` writes `sample-data/prms/_runs/*.log`, a PowerShell transcript of a CLI run).

## 1. NOTE CONTRACT (owner, 12:06 — must not regress)
- Two labelled kinds, `.note.curation` (green rule) and `.note.honesty` (amber rule), built by `note(kind, ...)` in
  `test-console/console/index.html`. Calm wording; each honesty note also says what IS exact (e.g. "The result table is
  computed exactly on this PC.").
  - **Curation note**: what the console did to keep a result reliable (every figure checked and found; the computed facts shown
    instead of a model's wording that did not match).
  - **Honesty note**: a limit on what the console can vouch for (a figure in the sentence that is not a value in the result; a
    masked value the model did not copy back; a join that may count rows twice; a run that could not be saved).
- `.flag` (red) stays for real errors only: a request that failed, a service not running.
- Replaced: "Numbers or placeholders not in the result: …" -> honesty note (with the possible derivation, §2);
  "Every number in the answer is in the result." -> curation note; "Warning: … Do not trust these totals." -> honesty note;
  dental Explained "problem(s) … Why the model's text was not shown" -> curation note + "What did not match" (collapsed).
- Guard: `scripts/test/console-notes.test.ts` (run by root `npm test`). Change the contract only together with that test.

## 2. Possible derivation of an unchecked figure (packages/crossask/src/derive.ts)
- `deriveFigure(raw, result)`: the first simple arithmetic on the result that gives the figure exactly, in cents: a column total,
  rows × a value, two cells of one row (×, +, −), a column average. Never rounds to make a match; null when nothing simple fits.
- `crossAsk` fills `derivations[figure]` for each figure in `unverified`. The note says "2,880 equals the total of Price over
  6 rows, so the model most likely worked it out from the result" and still marks it as not checked against the data.
- Tests: `packages/crossask/test/derive.test.ts` (incl. crossAsk end to end with stand-ins). Golden master unchanged (not exported).

## 3. Run log (test-console/console/run-log.ts, wired in server.ts POST /crossask)
- One JSON line per question in `<dir>/crossask-YYYY-MM-DD.jsonl`, also for failed runs; the response carries
  `runLog { id, mode, file }` and the page shows "Saved as run <id> (<mode>) in test-console\runs\<file>".
- Flags (server.ts): `--run-log off|meta|full` (default meta), `--run-log-dir` (default test-console/runs, git-ignored),
  `--run-log-max-rows` (default 50), `--run-log-keep-days` (default 14). `start-ui.ps1 -RunLog off|meta|full -RunLogDir PATH`.
- meta: question, folder, models, every SQL attempt and error, result columns, row count, figures checked / not found, warnings,
  the schema the query model was given (headers only),
  what was sent to a model. No data values (safe on real data). full: + result rows (capped), answer, not-found figures and their
  derivations, model reply texts (synthetic data only). Pruning touches only `crossask-YYYY-MM-DD.jsonl` files in that folder.
- Not logged (unchanged): paid chat text and payments; the dental reconcile / pack routes (their runs are re-computable).
- Tests: `scripts/test/console-notes.test.ts`. Linux workspace: the real server.ts started with --run-log full and saved a run.

## 4. Tests that need another repository: not tied to one folder layout (owner, 12:32)
- The ARCH-205 tests (paid jobs -> adminUI-NEAR near-watch) found near-watch only beside this repo or by an env var resolved from
  the current folder, and failed when it was elsewhere (owner PC: CHAINAIM-DEV\BLK-LIVEOPS\BLK-NEAR\chainaim-adminUI-NEAR).
- Now `locateNearWatch` (identical block in scripts/test and test-console/test near-watch-server.ts, compared by a test because
  check-deps forbids the import): env NEAR_WATCH_DIR, then config/local/repos.json `nearWatchDir` (per PC, git-ignored, like
  ai-profile / chain-profile; repos.example.json committed), then the sibling folder. Relative paths resolve from the repository
  root. Not found -> the two tests are skipped with the reason; REQUIRE_NEAR_WATCH=1 -> they fail (exit 1) with the same reason.
- Absolute or relative: relative in repos.json when the team agrees one layout (same value on every PC); absolute for the env var.
- Tests: scripts/test/near-watch-locate.test.ts (7). Workspace: default run skips with the reason (exit 0); strict run exit 1.

## 5. One command for the desk (owner, 13:00: "1 consolidated script, not piecemeal")
- Problem seen 12:15-13:00: the console, analyst, chain-query, near-watch and admin UI each had their own launcher and window;
  a closed window lost its error (analyst down, tab 03 "the job did not run"); paid jobs needed a hand-typed console command
  and a long stack.ps1 -PassEnv line; the console's model file did not match the gateway (3b default, 8b and Bedrock missing).
- test-console/desk.ps1: settings in config/local/desk.json (per PC; desk.example.json committed with no prices, ARCH-114);
  secrets read by name from secretsDir into the process (never printed); containers started or docker-restarted; the paywall
  rebuilt with the paid-jobs names only when its env differs from paid-jobs.env (compared in memory) or -RebuildPaywall;
  analyst, chain-query, near-watch, admin UI and console started hidden with per-service logs, each health-checked before
  the next; models file = the config/local-models*.json whose model set equals summary.json (default model from it); the
  paid-jobs listener and the paywall->console reachability (401) checked; one READY / NOT READY table with each fix or log.
- -Restart, -Stop, -Check, -Test, -RebuildPaywall, -NoBrowser, -Settings, -WaitSec. Guard: scripts/test/desk.test.ts (5).
- Not run in the workspace (no PowerShell); first run on the owner PC.

### 5b. 2026-11-06: desk.ps1 rewritten as a conductor (owner: "putting it all together so I can run 1 script, not intertwine")
- New upstream (Nisha, v1.3.5-v1.3.7; adminUI e87028e): private test-console/up.ps1 + down.ps1 run the backend in Docker
  (compose: gateway, paywall, presidio, analyst, chain-query, console-api 8735) and the 8730 page on the PC; adminUI
  nearadminup.ps1 + down.ps1 run near-watch in Docker (ca-near-watch on network chainaim-test, so http://near-watch:8790
  works from the private stack) and the 8800 admin UI; watch list from -Watch / -WatchFile.
- desk.ps1 v1.3.4 started the same services as PC processes and stopped port owners: collides with compose (same ports;
  a Docker-published port's owner is Docker Desktop's relay). Rewritten: pre-flight checks (Docker, launchers present,
  secrets files by name, NEAR_RPC_URL_TESTNET present) -> stop leftover node processes only on 8730/8740/8750/8790/8800 ->
  nearadminup.ps1 -Secrets -Watch -GasPerPaymentNear (this PC's accounts from desk.json) -> up.ps1 -ReplaceRunning -PaidJobs
  -> one table incl. the paywall's NEAR RPC tested from inside ca-paywall and near-watch RUN + honesty note while not live.
  -Stop = both down.ps1. No secret value is read; no secrets file is edited; prices only in up.ps1's files; nothing renamed.
- The RPC failover of 5 (candidates, rebuild) is gone: compose owns the paywall, so the RPC is a one-time line in
  near-testnet.env / near-watch.env, checked on every run. Guard: scripts/test/desk.test.ts (5).

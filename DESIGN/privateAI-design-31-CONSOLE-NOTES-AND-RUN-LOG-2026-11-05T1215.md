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

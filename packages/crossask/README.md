# @chainaim/crossask

A question across the CSV/TSV files of one folder, answered with DuckDB first and a model only where it helps: the
analyst relates the files and runs ONE checked SELECT; a model may write that query (from headers and relations only, no
values) and word the answer; every number in the worded answer is checked against the result (`verifyAnswer`).
Pure: the analyst and the model are passed in (`CrossAskDeps`), so the console, the terminal (`ask.ts`) and the tests run
the same steps.

Moved from `services/analyst/src/crossask.ts` (and `verifyAnswer` from `services/analyst/src/report.ts`) in Phase 2 of
the decoupling plan (DESIGN/xrplh-24 §6-7, xrplh-25 §7): it is an orchestrator that calls the gateway, so it does not
belong inside the compute-only analyst. Only change: crossask's `import { verifyAnswer }` now reads `./verify.ts`.

| Export | Where | What |
|---|---|---|
| `crossAsk(input, deps)` | src/index.ts | relations -> query -> run -> answer, with retries and checks |
| `analystClient(url, timeoutMs)`, `gatewayChat({url, key, timeoutMs})` | src/index.ts | the two deps over HTTP |
| `extractSql`, `resultText`, `fanOutJoins`, `SQL_SYSTEM`, `ANSWER_SYSTEM` | src/index.ts | pure helpers and prompts |
| `verifyAnswer(answer, evidence)` | src/verify.ts (`@chainaim/crossask/verify`) | numbers in an answer not found in the evidence |

## Tests

```
npm --prefix packages/crossask test   # golden masters (tools/golden/golden.ts), synthetic inputs, recorded before the move
npm --prefix services/analyst test    # relations.test.ts: crossAsk end to end with a stand-in model and the real analyst
```

# xrplh-19 — Split architecture: private books, private models, public proof (built 2026-10-25)

| Stage | Where | Reads | Writes |
|---|---|---|---|
| `scripts/facts.ts` | borrower's PC | books + `config/scenarios.json` (questions: book settings, stress scenarios, product grid, loan defaults — no pass marks) | `<id>.facts.json`: name-free facts, measured answers for the request and every grid candidate, document checks, GLEIF identity, ACTUS evidence; raw GLEIF/ACTUS request+response |
| `scripts/decide.ts` | lender's side | facts pack + `config/lender-policy.json` (cut-offs, broker) — private | `<id>.pack.json` (decision pack, sha256 → `LoanSet.Data`), `<id>.attestation.json`, `<id>.outcome.json` (borrower-facing) |
| `scripts/underwrite.ts` | one machine (demo) | both | same files; output as before |

- Engine (`packages/underwrite`): `measureScenario` (numbers) / `judgeScenario` (cut-offs, on the EXACT coverage), `answerQuestions` / `judge` / `offersFromAnswers` / `decideFromAnswers`; `evaluate` and `counterOffers` are compositions. Verified identical to the pre-split engine on Orion, Jupiter Knitting and Mercury Textiles (verdicts, scenarios, reasons, all counter-offers); the comparison found and fixed a rounding issue (judging the 2-decimal coverage).
- Decision pack (`chainaim.underwriting.v2`): no `rules` field; commits to `factsHash`, `questionsHash`, `policyVersionHash`, plus identity/evidence/ACTUS from the facts. The lender refuses facts answering other questions (`--questions` hash check).
- Broker check at co-signing (`lending.ts loan`): also re-hashes `<id>.facts.json` against the decision's `factsHash`.
- Outcome: verdict, terms, conditions without the lender's limits, counter-offer amounts only.
- Request ids unchanged (uw-9b8485ee7e, uw-d50f1908c4, uw-1876489c04); same verdicts. Pack hashes changed (v2 pack): loans originated before the split reconcile against a pack that no longer matches; originate again.
- Limits: the lender trusts the borrower-side computation via open deterministic code (ZK-PRET: input authenticity, next); proof the lender applied its stated policy is the policy-version hash (auditor check), stronger = enclave / ZK proof of the decision (later).
- Tests: 40/40 (+6 split tests). Legacy `config/underwriting.json` kept and still accepted by `underwrite.ts --policy`.

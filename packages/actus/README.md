# @chainaim/actus

ACTUS cash flows for fixed-rate, fixed-term loans (the XRPL Lending Protocol's kind).
Moved unchanged from `services/analyst/src/actus.ts` in Phase 1 of the decoupling plan
(DESIGN/xrplh-24 §6–7): a package must not import from a service, and `packages/underwrite` did.

No runtime dependencies. No file access. The only I/O is `fetch` in the three network functions.

## Exports

| Export | Kind | What it does |
|---|---|---|
| `Terms`, `Payload`, `ActusEvent`, `ActusResult`, `ContractType` | types | loan terms, ACTUS eventsBatch body and answer |
| `checkTerms(t)` | pure | throws a plain message when terms are incomplete or out of range |
| `addMonths(d, n)`, `maturityOf(t)` | pure | date helpers (UTC; JS month overflow: 2026-01-31 + 1 = 2026-03-03) |
| `buildContract(t)` | pure | ACTUS PAM / ANN contract in the shape of the ACTUS example contracts |
| `mentorRequest(t)` | pure | the plain-English request sent to ACTUS Mentor (terms only, no party names) |
| `intentChecks(p, t)` | pure | a contract (e.g. Mentor's) checked against the terms asked for |
| `scheduleChecks(r, notional, maturity)` | pure | ACTUS's answer checked before anything is saved |
| `scheduleRows(r, source)`, `SCHEDULE_HEADER`, `EVENT_NAMES` | pure | schedule CSV rows (PRF events dropped) |
| `firstPayload(text)` | pure | first `{"contracts": [...]}` JSON inside a text |
| `TERMS_SYSTEM`, `parseTerms(text)` | pure | prompt for reading terms from a document; parser for the model's JSON |
| `termsInDocument(t, doc)` | pure | every value must appear in the document; returns the failed checks |
| `runDirect(url, payload, timeoutMs)` | network | POST `<url>/eventsBatch` |
| `mentorBuild(url, key, t, timeoutMs)`, `mentorRun(url, key, payload, timeoutMs)` | network | ACTUS Mentor `/generate-contract`, `/run-contract` |

## Tests

```
npm --prefix packages/actus test        # golden master (also run by services/lending npm test)
npm --prefix services/analyst test      # test/actus.test.ts: behaviour tests, with stand-in servers
```

## Golden master

`tools/golden/golden.ts` (shared with packages/crossask) runs every pure export on the synthetic inputs in
`test/golden/cases.json` and compares the output with `test/golden/actus.golden.json` (sorted keys, LF). It refuses to run
if an export has no case, so a new export must get one. The network functions are skipped.

```
npm --prefix packages/actus run golden:check             # exit 0 identical, 1 different, 2 usage
npm --prefix packages/actus run golden:record -- --force  # only after an intended behaviour change
```

All inputs are made up. The golden file was recorded from `services/analyst/src/actus.ts` at tag `phase-1-pre`
(sha256 `d91e044a8021cba2a97e612897599cbb6ac9607cc41352fe2fd9bf6c7b8323d9`) before the move. The runner lived in
`packages/actus/scripts/golden.ts` until Phase 2 promoted it to `tools/golden/` (its second user).

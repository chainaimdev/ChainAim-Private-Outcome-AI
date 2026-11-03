# xrplh-20 — Session record: split architecture review, isolation design, port to CreditSeal, v1.1.0

**Session:** 2026-10-26 21:42 → 2026-10-27 11:57 (UTC-5)
**Repos involved:**
- Source (now retired for lending): `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2-TR2\chainaim-router-private-ai-2` (origin `github.com/chainaim-nisha/chainaim-router-private-ai-2`)
- Target (home of lending from now on): `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\CreditSeal\CreditSeal` (origin `github.com/chainaim-sathya/CreditSeal`)

**Outcome:** the split architecture is committed as `afbb2e1` on `main` and tagged **`v1.1.0`** (pushed). Tests 40/40, `prove-split.ts` 6/6 PASS.

This is a summary record of the session (questions, findings, decisions, commands and results), not a verbatim transcript.
Statements marked *(unverified)* were not checked against a file or a run.

---

## 1. Locating the split architecture

- Found in past chat **mid-check-2-TR-2-2-imp** (https://claude.ai/chat/16258d3c-00f4-481a-a648-255823e7d649), 2026-10-25.
- Built in `PRIVAI2-TR2` between 12:05 and 13:07 on 2026-10-25 (file timestamps). Design doc: `DESIGN/xrplh-19-SPLIT-ARCHITECTURE-FACTS-DECIDE-2026-10-25T1230.md`.
- PRIVAI2-TR2 git: only one entry in `.git/logs/HEAD` (the clone, 2026-10-24 ~21:40). The whole lending feature and the split were never committed there.

## 2. The problem and the solution (plain terms)

- **Borrower's secret:** raw books (`bank.csv`, `invoices.csv`, `customers.csv` e.g. "Atlas Build Supply (demo)", `bills.csv`, `receipts.csv`, `sales_orders.csv`).
- **Lender's secret:** the rulebook, `config/lender-policy.json`: `minCashBufferBase 10000`, `minCoverageBase 1.25`, `minCashStress 0`, `maxCustomerShare 0.4`, `concentrationAction "condition"`.
- **Solution (exam analogy: the teacher hands out questions, keeps the answer key):**
  1. Lender publishes questions only: `config/scenarios.json` (5 scenarios: base, rate +2 %, all customers 30 days late, largest customer 60 days late, open order cancelled), books settings, product grid, loan defaults. No cut-offs.
  2. `scripts/facts.ts` on the borrower's PC: books → facts pack (`<id>.facts.json`): numbers only, no names, no pass/fail, no verdict.
  3. `scripts/decide.ts` on the lender's side: facts + rulebook → verdict, decision pack (`<id>.pack.json`), borrower outcome (`<id>.outcome.json`, limits hidden).
  4. Fingerprints (SHA-256) in the decision pack: `factsHash`, `questionsHash`, `policyVersionHash`; the decision pack's hash goes into `LoanSet.Data`.
- **One line:** borrowers keep their books, lenders keep their rulebook, the ledger keeps the fingerprints.
- **Honest limits:** borrower-side computation trusted via open deterministic code (ZK-PRET for input authenticity: not built); policy hash proves *which* rules, not that they were run correctly (enclave/ZK later); both halves run on one machine; encrypted relay not built.

## 3. Files of the split (20)

| Status | File |
|---|---|
| new | `config/scenarios.json`, `config/lender-policy.json` |
| new | `services/lending/src/stages.ts`, `services/lending/src/stage-io.ts` |
| new | `services/lending/scripts/facts.ts`, `decide.ts`, `prove-split.ts` |
| new | `packages/underwrite/test/split.test.ts`, `services/lending/test/split.test.ts` |
| new | `DESIGN/xrplh-19-…md`, `services/lending/start-desk.ps1` (launcher, this session) |
| changed | `packages/underwrite/src/underwrite.ts` (measure vs judge) |
| changed | `services/lending/scripts/underwrite.ts` (one-machine wrapper), `lending.ts` (broker re-hashes facts), `cockpit.ts` (`/api/split`), `cockpit.html` (Facts/Decision lines, split links) |
| changed | `config/underwriting.json` (legacy, reformatted + note), `services/lending/README.md`, `BUILD_LOG.md` (LEND-3), `services/lending/demo/start-demo.ps1` (2-line fix) |

Not carried over: `packages/underwrite/src/zz_old_engine.ts` (no importers; comparison scaffolding), `services/lending/_to_delete/`.

## 4. Test cases designed

**Ten cases (UI and/or terminal):** 1 Orion APPROVE (no cut-offs in facts, no `rules` in pack, outcome hides limits) · 2 Jupiter APPROVE with live GLEIF · 3 deterministic decision · 4 the real loan carries the proof (Desk 8 → 11) · 5 Mercury DECLINE (reasons without pass marks) · 6 same facts, stricter lender (policy hash changes; verdict not APPROVE *(unverified)*) · 7 easier questions refused · 8 rulebook given to the borrower side refused · 9 tampered facts detected · 10 forged bigger loan refused (Desk 7).

**"Who sees what" demonstration (two simulated PCs, terminal):**
- Act 1: run `facts.ts` with `config/lender-policy.json` temporarily renamed (try/finally restores it): works without the rulebook.
- Act 2: no customer name or invoice id from the books appears in the facts pack.
- Act 3: delete the books copy, run `decide.ts`: decides without books.
- Act 4: no cut-off keys in `scenarios.json` or the outcome.
- UI: Desk step 6 → open "facts pack" link, Ctrl+F `Atlas Build Supply` (absent) and `minCashBufferBase` (absent); "borrower outcome" link shows the condition without the 40 % limit.

## 5. Design discussions (not built)

- **Isolation proof, extensible:** directory split (`data/borrowers/<id>/…`, `data/lenders/<id>/…`, `data/exchange/`), Windows accounts + folder ACLs; Docker containers with only their own mounts (`docker inspect` + negative reads as proof); encrypted exchange; separate cloud accounts (audit logs). Docker on one laptop proves the software cannot cross, not that the laptop owner cannot look.
- **Aggregates to the lender:** sound under data minimisation (GDPR Art. 5(1)(c)) and mirrors real lending; keep the fact list fixed (questions hash), record consent, watch for identifying aggregates.
- **Reapply policy:** clerical rejections up to 3 / 30 days; DECLINE → cooldown (e.g. 90 days) unless books cover a newer period; one application = one request, return only the best 1–2 counter-offers; enforced lender-side in `decide.ts` via an application log keyed by LEI; flags `--applications-log --max-clerical --clerical-window-days --cooldown-days --material-change-months --max-offers-returned`; anchor decision hashes on XRPL for fairness audits. Regulation B adverse-action reasons: the outcome already gives reasons without thresholds; confirm legally *(not legal advice)*.
- **MPC (later):** secret sharing lets the judge step (`judgeScenario`, the only place both secrets meet) run jointly on shares; both learn only the agreed outputs; ChainAim could run one compute party data-blind. Small computation (5 scenarios × rules × 210 candidates). Does not prove inputs are real (pair with ZK-PRET); outputs still leak (reapply policy still needed). Roadmap order: split → isolation proof → ZK-PRET → MPC or enclave.
- **Docker separation (item 3) recap:** `services/lending/Dockerfile` (one image), `test-console/lending-isolation.ps1`, `prove-isolation.ts --mode docker`, `services/lending/src/isolation.ts` (party → allowed folders), runtime image digest in packs (format v3), Desk card mode switch, tests; split the network-needing evidence step from the no-network facts step.

## 6. Port to CreditSeal (this session)

**Analysis (read-only diff of both repos):**
- CreditSeal initial commit `5fd0dee` (2026-10-25 ~11:42) predates the split; since then CreditSeal changed only `README.md`, `docs/privacy-gateway-README.md`, `services/lending/scripts/cockpit.ts` (Desk crash fix, `--devnet-timeout-ms`, commit `12ab20c`, tag `v1.0.2`).
- Only `cockpit.ts` changed on both sides. Three-way merge (base `5fd0dee`): kept CreditSeal's `/api/status` line, added the 6-line `/api/split` route.

**AI actions:**
1. Copied 19 files + merged `cockpit.ts` into CreditSeal (git status: 9 M, 11 ??).
2. Copied git-ignored local data from TR2: `data/lending/books/*`, `data/lending/devnet-run.json`, `data/lending/fees.jsonl`; later `test-console/local-gateway-key.txt` and `config/data-sources.json` (both confirmed ignored by `.gitignore` lines 16 and 26). Both repos now point at the same Devnet vault: run the Desk only from CreditSeal.
3. `start-desk.ps1` upgraded: port owners classified this-repo / other / docker (other copies' processes and their windows closed; `-Restart`, `-KeepForeign`), starts Docker Desktop (`-NoStartDocker`, `-DockerWaitSec`), `stack.ps1 -Check` (warn; `-StrictStack`), `start-ui.ps1`, cheat sheet, "already running → open and exit", pre-flight for the console's two local files.
4. README: new section "Start the whole demo with one command"; "What is where" table updated for the split.

**Owner runs:**
- `npm ci` + `start-desk.ps1`: pre-flight OK (Node v24.22.0), ports FREE, tests 40/40, prove-split 6/6, Docker started, containers started, analyst up; console crashed on the missing `local-gateway-key.txt` (fixed as above).
- `stack.ps1 -Check`: 10 problems, expected: `ca-*` containers built from / mounting PRIVAI2-TR2.
- Re-run `npm test` + `prove-split.ts`: 40/40 and 6/6; identical `factsHash 350c5321f348be7c…` and `policyVersionHash 9a1a0fd150abbeb8…` (deterministic).
- Commit `afbb2e1` (20 files, +1130 / −272), tag `v1.1.0`, pushed (`12ab20c..afbb2e1 main`, `[new tag] v1.1.0`).

## 7. Open items

1. Blank the exposed `CHAINAIM_GATEWAY_KEY` value in `.env.example` (separate commit); rotate the live key.
2. Optional: rebuild `ca-*` containers from CreditSeal (`stack.ps1 -Rebuild …`, `switch-models.ps1`, needs model keys).
3. Build item 1: `scripts/prove-isolation.ts` (4 acts per borrower, PASS/FAIL table, `--books… --lender-policy --out --json`) + Desk "Isolation" card.
4. Build item 2: directory split + reapply policy, with tests.
5. Later: Docker separation (item 3), encrypted relay, ZK-PRET, MPC/enclave.
6. Level 2/3 terminal walkthroughs (Orion/Mercury halves, refusals, two simulated PCs) written but not yet run by the owner.

## 8. Continuation prompt (paste into a new chat)

```
Project: ChainAim CreditSeal (private loan underwriting on XRPL Devnet, XLS-65/66).
Repo: C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\CreditSeal\CreditSeal  (origin github.com/chainaim-sathya/CreditSeal)
Read first: PROJECT_CONTEXT.md, services\lending\README.md ("Split architecture", "Start the whole demo with one command"),
DESIGN\xrplh-19-SPLIT-ARCHITECTURE-FACTS-DECIDE-2026-10-25T1230.md, DESIGN\xrplh-20-SESSION-SPLIT-REVIEW-PORT-V1.1.0-2026-10-27T1157.md.
Follow my userPreferences. AI edits code; I run git and tests in my own terminal.
STATE: main = afbb2e1, tag v1.1.0 pushed; npm test 40/40; prove-split 6/6. Open items: see xrplh-20 §7.
EXACT NEXT STEP: propose (no code yet) the implementation plan for item 1 (prove-isolation.ts + Desk Isolation card): files, flags, tests,
expected output table. Then build test-first after I approve.
```

# xrplh-29 — Datasets in tab 03, sample-data / runtime / private data, dental query bank in the console

Session 2026-11-03 (UTC-5) 18:08–19:10. Status: **BUILT, uncommitted; owner PC test pending.**

## 1. Decisions (owner)
- Real data is never in git and never inside the repository: `C:\PRIV-AI-DATA\chainaim3003\` (outside the Claude filesystem connector's folders).
- Sample datasets: `<repo>\sample-data\` (git-ignored). Owner's layout: `smb-fin\statements`, `prms\dent-prms-c-sample\{SET-2, sample-prms-fin, _parked}`, `pers-fin` (empty).
- Program output: `<repo>\runtime\` (git-ignored): `runtime\analyst` (analyst --work-dir), `runtime\logs\dental` (dental-test.ps1), `runtime\paywall-log`.
  Data roots stay read-only; nothing is written into a data root.
- `data\` is legacy: CreditSeal-era paths (`data\lending`, `data\live`) belong to chainaim-creditseal / chainaim-liveops after the 3-way split.

## 2. Git and Docker hygiene (done 18:41)
`.gitignore`: `sample-data/`, `runtime/` (sample-data/ was NOT ignored before: `git add -A` would have committed it). `.dockerignore`: `sample-data`,
`runtime`, `config/local`, `config/data-sources.json` (the gateway image's `COPY config config` copied per-PC settings). Guard: `scripts/test/repo-hygiene.test.ts`.

## 3. Datasets
- `config/datasets.json` (committed): roots `samples` = `sample-data`, `private` = `C:\PRIV-AI-DATA\chainaim3003`; datasets with id, label, a 1–2 sentence
  description, a folder relative to the root, engine, templates. Same layout under both roots. Guard: `scripts/test/datasets.test.ts`.
- `config/data-sources(.example).json`: `allowedRoots: ["sample-data", "C:\\PRIV-AI-DATA\\chainaim3003"]`, `defaultFolder: "sample-data/smb-fin/statements"`.
  Relative paths are resolved against the repository by the console (`server.ts readDataConfig`) and the analyst (`config.ts readDataConfig`, `REPO_ROOT`).
- Console `GET /datasets?root=samples|private`: each dataset's absolute folder, exists, allowed, data files, and (subfolders) the sets inside (depth 2, `_*` hidden).

## 4. Engines
- `crossask` (Small Biz Financials - 1, Personal Financials): unchanged; templates from the registry.
- `domain-pack` (Practice Management - Dental, pack `finance/rcm/dental`):
  - `services/analyst/src/packquery.ts` (new): query bank (`loadBank`, `bankPathOf`), reconciliation tables (`buildTables`), fact sheets (`factSheet`) —
    moved unchanged from `scripts/dental.ts`, which now imports them.
  - Analyst routes: `/pack-queries {pack}`, `/pack-run {folder, pack, ids | sql, maxRows}` (one reconciliation, the picked SQL entries or your own SELECT,
    fact sheets for question entries; returns results, file kinds, exception count, sheets, FACT_SYSTEM), `/pack-verify {runId, id, answer}`.
  - Console: `/analyst/pack-queries` and `/analyst/pack-run` forwarded; `POST /packask {folder, pack, id, model}` = pack-run -> gateway (masked) -> pack-verify;
    a failed check shows the computed facts, the model's text folded below.
- Tab 03: Data (Samples | Private), Dataset, Set (when the dataset has sets); description + "puts together N file(s)"; templates grouped "Exact answers,
  no model (25)" and "Model-worded, every figure checked (14)". Own SQL over the reconciliation tables works in Dental. A free-text question without a
  picked template goes through crossask (generic files) as before.

## 5. Path changes
`dental.ts`, `test/data-root.ts`, `dental-test.ps1`: default root `sample-data\prms\dent-prms-c-sample` (owner's names); dental-test logs `runtime\logs\dental`;
`test/data-root.ts` samples folder `sample-prms-fin`; `start-analyst.cmd` passes `--work-dir <repo>\runtime\analyst`.

## 6. Tests
New: `scripts/test/datasets.test.ts` (2), `scripts/test/repo-hygiene.test.ts` (3), `services/analyst/test/packquery.test.ts` (2).
Linux workspace: datasets 2/2, hygiene 3/3, page script syntax OK, `/datasets` answers. Not run there: analyst tests (DuckDB binary is Windows-only on this PC).

## 7. Open
- `prms` / `dent-prms-c-sample` / `sample-prms-fin` are the owner's names (were `pms`); docs still say `data\pms\...` in places.
- Remove or move liveops leftovers (`test-console/start-live.ps1`, `services/paywall/scripts/stream-core.ts`) after a diff with chainaim-liveops.
- Stale check-deps entries (ledger-watch, admin-console).

## 8. Dental page redesign (owner 20:16 -> built 20:53)
- `queries.json`: `topics` (Leaks overview, Insurance payers & EFT, Deposits & bank matching, Card processing, Cash & branch deposits, Production &
  patient balances, Financing, Office actions & controls, Data quality & posting), a `topic` per entry, and `pair` linking an exact entry with the
  model entry that answers the same intent (8 pairs: leak-summary/ask-priorities, money-at-risk/ask-loss-vs-timing, leaks-by-payer/ask-payers,
  group-reconciliation/ask-reconciled, unmatched-curve/ask-missing-money, unmatched-bank/ask-extra-money, card-batches/ask-card-batches,
  eft-by-payer/ask-eft-followup). Mapping from titles; SQL per entry not re-read. `loadBank` checks topics and pairs; `/pack-queries` returns them.
- `datasets.json`: `setLabels` (scenario names: "NEG-ALL - all 8 leaks planted", ...) and `fileKinds` (file-name prefix -> Bank statement, Deposit
  detail, Ledger (day sheet), Patient list, CareCredit / Cherry / HFD financing, Procedures report); `/datasets` passes them on.
- Tab 03 for a domain-pack dataset: Topic picklist; the topic's questions as one list (an exact + model pair is one row); "Answer as: Table (exact,
  no model) | Explained (model words the computed facts, every figure checked)"; the model picker only for Explained; the generic model pickers hidden;
  own SQL under "Advanced"; every answer starts with "How this was answered" (files reconciled, query run or fact sheet built, what was sent where,
  model/zone/seconds, figure check). Guard test extended (console-progress.test.ts).

## 9. Console header and naming (owner, 21:13-21:55)
- Tab 03 renamed "Private Chat and AI (Across Files)".
- Header: "Private AI Desk" / "powered by ChainAim" / tagline "AI on your business data, without exposing it." and six equal cards: Stays here,
  Hidden first, What AI does, Verified, Your choice of AI, Pay per use (card, bank transfer or regulated stablecoins on several blockchains;
  owner chose to drop the "demo settles in RLUSD on XRPL TestNet" qualifier; only XRPL RLUSD (TestNet) is implemented today).
- Folder shown relative to the data root ("Samples > smb-fin/statements"; full path in the tooltip).
- Fixed: `#t5 [hidden]` must win over `.xmodels { display: grid }` (the generic model pickers showed for Dental).

# xrplh-28 — Chain query (multi-chain picklist), settings without terminal exposure, one gateway mode for all models

Session: 2026-11-03 (UTC-5), 10:33–11:48. Status: **DESIGN, not built.** Nothing in this document is implemented yet.

Tags: **[CODE]** read in this repository this session · **[RUN]** seen in the owner's run output this session ·
**[INFER]** inference, not verified · **[TODO-VERIFY]** must be checked against an official source before building.

---

## 1. Goal (owner)

1. Separate blockchain connectivity and queries from the private-chat UI. The UI must offer a **picklist of blockchain and
   environment** (not only XRPL), including **NEAR testnet**, and query vaults, loan terms and similar on the chosen chain.
2. Stop passing XRPL addresses on the PowerShell command line (`stack.ps1 -PayTo r...`). Needed details are set once, with
   masked entry, and read from config files that are **not in git**.
3. Stop switching the gateway between modes: Bedrock and any local model must both be available, picked per request on
   screen; terminal scripts read their model choice from config (flag overrides).

## 2. Findings this session

### 2.1 Run and setup facts
- [RUN] `stack.ps1` rejected the placeholder `-PayTo rYOUR_TESTNET_ADDRESS` at `Resolve-PayTo` (regex `^r[1-9A-HJ-NP-Za-km-z]{24,34}$`).
- [CODE] `Resolve-PayTo` order: `-PayTo` → env `XRPL_PAY_TO_<NET>` → the running `ca-paywall`'s env → error. No address is written in the script.
- [CODE] `stack.ps1` never recreates `ca-gateway`; `switch-models.ps1` owns it. Both this repo and CreditSeal use container
  name `ca-gateway` and host port 8720, so only one gateway exists at a time; running `switch-models.ps1` here replaced
  CreditSeal's gateway (it mounted `FINAGENTS\CreditSeal\CreditSeal\config`) [RUN].
- [CODE] `use-stand-in.cmd` and `start-analyst.cmd` end with `pause`; in a pasted multi-line block the `pause` stops everything after it.
- [CODE] The documented key line `node -e "...writeFileSync('test-console/local-gateway-key.txt'...)"` makes a NEW key on every run;
  `stack.ps1` warns against a new key while containers use the old one (RUN-ON-ANOTHER-PC.md trap 3). Create it only if missing.
- [CODE] Gitignored (nothing to commit from setup): `test-console/local-gateway-key.txt`, `config/data-sources.json`,
  `config/generated/`, `node_modules/`.

### 2.2 Private Chat (Across Files)
- [RUN] Stub mode: the echo model returns the instruction text, so DuckDB fails ("syntax error at or near SELECT"). Stub is for plumbing only.
- [RUN] Bedrock mode: query by `bedrock/nemotron-nano-3-30b` invented columns (`STRUCTURE`, `TERM IN MONTHS`, `ANNUAL RATE`,
  `GRACE DAYS`, `LATE CHARGES AND FEES`) for the preset "XRPL vault loan terms"; the folder held only
  `sample_bofa_full_statement.csv` (`SECTION, DATE, DESCRIPTION, AMOUNT, BALANCE`). Both tries were identical.
- [RUN] Own query (no model) returned DEPOSITS 1500, DEBITS_ATM -172.35, DEBITS_OTHER -585.4, FEES 0 — equal to the file's
  SUMMARY rows; the Bedrock-worded answer correctly said the result does not answer the loan-terms question.
  Pipeline (analyst → gateway masking → Bedrock) works end to end.
- [CODE] `test-console/console/index.html` line 284: "XRPL vault loan terms" is only a canned crossask question; no on-chain read
  exists in this repository. Lines 239 and 263 hardcode "XRPL TestNet".
- [CODE] `packages/crossask/src/index.ts`: the "same query as before" hint only fires on a later attempt; with
  `--crossask-sql-retries 1` there is no third try. `extractSql` falls back to cutting prose at the first `select`/`with`
  (did not cause this failure, but can).

### 2.3 Existing pieces this design reuses
- [CODE] `services/paywall/src/env.ts`: loads a KEY=VALUE file named by `CHAINAIM_ENV_FILE` (default repo `.env`) and reports shadowed names.
- [CODE] `services/paywall/src/config.ts`: `XRPL_NETWORK`, `XRPL_PAY_TO_<NET>`, `RLUSD_ISSUER_<NET>`, `FACILITATOR_URL_<NET>`.
- [CODE] `services/web/src/balance.ts`: `NETWORKS` hardcodes XRPL `testnet` and `mainnet` only.
- [CODE] `scripts/local-models.ts`: registry entries support `baseUrl`, `apiKeyEnv`, `zone`, `pricing` (hosted entries next to Ollama ones).
- [CODE] `config/catalog.bedrock.json`: Bedrock Nemotron + local Qwen 3b/1.5b variants; `modes/bedrock.json` asks `BEDROCK_API_KEY`.
- [CODE] `test-console/console/server.ts`: model pick list comes from the gateway; `--models-file` sets only the default pick; `--default-model` exists.
- DESIGN/xrplh-24 §5.4 (settlement service, `config/billing/networks.json`) and §5.5 (loose coupling, HTTP between services,
  shared shapes in `packages/`, `scripts/check-deps.ts`).
- [CODE] Vault/loan reading for XRPL lives in CreditSeal `services/lending/src/ledger.ts` and `packages/xls66` (files listed, **not read**).
- [CODE] No NEAR code in this repository; NEAR notes only in `CreditSeal-session-2026-11-02-encryption-TEE-NEAR.md` (TEE, Intents).

## 3. Design

### 3.1 Chain registry — committed, no secrets
`config/chains/networks.json`. The UI and services build every chain/environment list from it; no code names a chain.
This is the same registry xrplh-24 §5.4 planned as `config/billing/networks.json`: keep ONE file.

```json
{
  "xrpl": { "label": "XRP Ledger", "adapter": "xrpl", "addressRule": "xrpl-classic",
    "environments": {
      "testnet": { "rpc": "wss://s.altnet.rippletest.net:51233/", "caip2": "xrpl:1", "explorer": "https://testnet.xrpl.org",
                   "capabilities": ["payments"], "sources": [ { "id": "ledger", "kind": "native" } ] },
      "devnet":  { "rpc": "<TODO-VERIFY>", "caip2": "<TODO-VERIFY>", "capabilities": ["payments", "vaults", "loans"],
                   "sources": [ { "id": "ledger", "kind": "native" } ] },
      "mainnet": { "rpc": "wss://s1.ripple.com:51233/", "caip2": "xrpl:0", "capabilities": ["payments"],
                   "sources": [ { "id": "ledger", "kind": "native" } ] } } },
  "near": { "label": "NEAR", "adapter": "near", "addressRule": "near-account",
    "environments": {
      "testnet": { "rpc": "<TODO-VERIFY official docs>", "explorer": "<TODO-VERIFY>", "capabilities": ["vaults", "loans"],
                   "sources": [ "<see 3.2>" ] } } }
}
```
- `capabilities` enable or grey out UI buttons (with the reason shown). XLS-65/66 availability per XRPL network is [TODO-VERIFY].
- XRPL URLs above are the ones already in `balance.ts` [CODE]; every `<TODO-VERIFY>` is filled from official docs, not memory.

### 3.2 Contract sources as configuration (NEAR now; any contract chain later)
Owner decision: BOTH the owner's own NEAR contract and an existing lending protocol on testnet. Contract IDs, view-method
names, arguments and field mappings are configuration, never code.

```json
{ "id": "chainaim-own", "label": "ChainAim contract", "kind": "own", "contract": "<your-contract>.testnet",
  "methods": {
    "vaults":    { "view": "<method>", "args": {}, "list": "$",
                   "map": { "vaultId": "$.id", "asset": "$.token", "available": "$.available" },
                   "units": { "available": { "decimalsFrom": "$.decimals" } } },
    "loanTerms": { "view": "<method>", "args": {}, "list": "$.terms",
                   "map": { "lender": "$.lender", "structure": "$.kind", "termMonths": "$.term_months",
                            "annualRate": "$.rate_bps", "graceDays": "$.grace_days", "lateFee": "$.late_fee" },
                   "units": { "annualRate": { "bpsToPercent": true } } } } }
```
Rules: `map` is plain JSON paths into the view result (no eval, no code in config); an unmapped field is empty, never
invented; `units` makes every conversion explicit; each result row carries its `source.id`. XRPL uses `"kind": "native"`
(ledger objects), so one model covers both chains.

### 3.3 Settings without terminal exposure
| What | Where | In git |
|---|---|---|
| Chain registry, contract IDs, method maps | `config/chains/networks.json` | yes |
| Choices + public addresses per chain/env | `config/local/chain-profile.json` (example: `chain-profile.example.json`) | **no** (`config/local/` added to `.gitignore`) |
| Model defaults for UI and terminal | `config/local/ai-profile.json` (example committed) | **no** |
| Secrets (BEDROCK_API_KEY, OPENROUTER_API_KEY, ingest keys, any signing key) | `C:\PRIV-AI-SECRETS\chainaim.env` (same pattern as `ledger-watch.env`) | **no**, outside every repo |

```json
// config/local/chain-profile.json
{ "selected": { "chain": "near", "env": "testnet" },
  "accounts": { "xrpl:testnet": { "payTo": "r..." }, "near:testnet": { "account": "<you>.testnet" } } }
```
One resolution order in every script and service: **flag → environment variable → profile / secrets file → hidden prompt**.
Implemented once in `test-console/lib/settings.psm1` (PowerShell) and a small reader in `packages/chain-contracts` (Node).
Display is always masked (`rn5h…gBej`; secrets only "set / not set"). Secrets are never written by any script except
`chain-config.ps1 -SetSecret`, which reads them with `Read-Host -AsSecureString`.

New script `test-console/chain-config.ps1`:
```
chain-config.ps1 -Set -Chain <id> -Env <env> [-ProfileFile config\local\chain-profile.json]   # validated per addressRule
chain-config.ps1 -SetSecret <NAME> [-SecretsFile C:\PRIV-AI-SECRETS\chainaim.env]            # hidden prompt
chain-config.ps1 -Show            # selected chain/env, masked addresses, which secrets are set
chain-config.ps1 -List            # chains and environments from the registry
```
`stack.ps1`: `Resolve-PayTo` gains a profile step via `settings.psm1`; `-PayTo` stays as an override. The paywall still
receives `XRPL_PAY_TO_<NET>` as an environment variable (paywall code unchanged).

### 3.4 Read-only service `services/chain-query`
```
node src/main.ts --registry config/chains/networks.json --profile config/local/chain-profile.json
                 --port 8750 --timeout-ms 8000 [--validate]

GET /chains                                   registry (UI dropdowns)
GET /vaults?chain=&env=&source=               common Vault shape, source column
GET /loan-terms?chain=&env=&source=           lender, amount available, structure, term, rate, grace, fees
GET /export?chain=&env=&source=&to=<folder>   CSV snapshot into an allowed data folder, so crossask can join it with bank data
```
- Structure: `core/` (registry, mapper with JSON paths + units, routes, export), `adapters/xrpl` (ledger objects; ported
  from CreditSeal `ledger.ts` after reading it), `adapters/near` (read-only contract view calls; exact RPC call form
  [TODO-VERIFY] against NEAR's official RPC docs).
- Adapter interface: `validateAddress`, `listVaults(env, source)`, `loanTerms(env, source)`; shapes in `packages/chain-contracts`.
- Holds no keys (read-only). Public ledger data: no model, does not pass through the gateway.
- `--validate` calls each configured method once and reports, per source, mapped fields that came back empty or unparsable.
- Follows xrplh-24 §5.5: HTTP only between services; rules added to `scripts/check-deps.ts`.
- Runs on the host like the analyst (own window), not in Docker.

### 3.5 Console UI
- Owner decision 11:51: blockchain queries go in a **twisty** (collapsible `<details>` section, closed by default),
  "Blockchain queries", not a new tab. Inside: Chain, Environment (filtered by chain), Source (All or one contract)
  picklists from `/chains`; buttons Vaults, Loan terms, Export for analysis, enabled per capability. The twisty's summary
  line shows the selected chain/env (e.g. "Blockchain queries — NEAR testnet"). Placement on the page: [TODO-VERIFY] read
  index.html layout first; proposed next to tab 03 so an export can be used right away.
- Tab 03: remove the "XRPL vault loan terms" preset; cross-file questions read the exported CSV instead.
- Tab 04 and header: replace hardcoded "XRPL TestNet" with the network from the paywall's live quote (CAIP-2).
- `server.ts`: new flag `--chain-query URL` (default `http://127.0.0.1:8750`), forwards only the known routes (as `--analyst` does).
- Paywall stays XRPL/RLUSD (x402). Payments on other chains = a new rail under the settlement service (xrplh-24 §5.4), out of scope.

### 3.6 One gateway mode for all models (no per-question switching)
- [CODE] `switch-models.ps1` recreates `ca-gateway` in one mode; the mode decides catalog, required keys (`secretEnv`) and flags;
  keys enter the container as environment variables at creation.
- [RUN] The gateway already picks the model per request: in Bedrock mode the UI listed Bedrock + two local models and used the one picked.
- Gap: `catalog.bedrock.json` lacks `deepseek-r1-1.5b` and hosted models.
- Design:
  1. `config/local-models.all-sources.json` (format of `local-models.cpu-hosted.json`): all local Ollama models + the Bedrock
     entry (`baseUrl`, `apiKeyEnv: BEDROCK_API_KEY`, `zone: private-cloud`, `pricing`) + optional OpenRouter entries
     (`apiKeyEnv: OPENROUTER_API_KEY`, `zone: public-api`). [TODO-VERIFY] that `local-models.ts` generates the Bedrock entry
     equivalent to `catalog.bedrock.json` (scores, max output tokens).
  2. `test-console/modes/all.json` using that registry.
  3. `switch-models.ps1`: keys from the secrets file when present, else hidden prompt; keys marked optional are skipped with
     a warning (today a missing key stops the switch), so the models that have keys still load.
  4. Run `switch-models.ps1 -To all` only when the model list or a key changes. The console picklists choose per question
     (Bedrock, any local model, or `chainaim/auto`).
- Terminal: `config/local/ai-profile.json`
  ```json
  { "gatewayMode": "all",
    "defaults": { "chat": "chainaim/auto", "query": "bedrock/nemotron-nano-3-30b", "answer": "local/qwen2.5-3b" } }
  ```
  Order: `--model` / `-Model` flag → environment variable → profile → gateway default. `start-ui.ps1` passes the default
  to the console as `--default-model`. [TODO-VERIFY] `scripts/ask.ts` and other terminal scripts' current flags (not read).

## 4. Run flow after the change
One time:
```powershell
.\test-console\chain-config.ps1 -Set -Chain xrpl -Env testnet
.\test-console\chain-config.ps1 -Set -Chain near -Env testnet
.\test-console\chain-config.ps1 -SetSecret BEDROCK_API_KEY
.\test-console\chain-config.ps1 -Show
```
Each run:
| Step | Today | After |
|---|---|---|
| Build stack | `stack.ps1 -Rebuild all -XrplNetwork testnet -PayTo r...` | `stack.ps1 -Rebuild all` |
| Models | `switch-models.ps1 -To <mode>`, key typed each time, re-run to change mode | `switch-models.ps1 -To all` once; key from secrets file |
| UI | `start-ui.ps1` (analyst + console) | also starts chain-query (8750); flags `-ChainQueryPort`, `-RestartChainQuery` |
| Check | `stack.ps1 -Check` | same + `node services\chain-query\src\main.ts --validate` |
| Tests | suites in PROJECT_CONTEXT.md | same + `npm --prefix services/chain-query test` |

## 5. Files (estimate; assumes chain-query lives in this repository)
New (~25): `config/chains/networks.json`; `config/local/chain-profile.example.json`; `config/local/ai-profile.example.json`;
`config/local-models.all-sources.json`; `test-console/modes/all.json`; `test-console/lib/settings.psm1`;
`test-console/chain-config.ps1`; `test-console/start-chain-query.cmd`; `packages/chain-contracts/{package.json,src/index.ts}`;
`services/chain-query/{package.json, src/main.ts, src/core/{registry,mapper,routes,export}.ts, src/adapters/{xrpl,near}.ts}`;
`services/chain-query/test/{registry,mapper,xrpl,near}.test.ts` + `test/fixtures/` (recorded RPC replies); this document.
Changed (~10): `.gitignore`; `test-console/stack.ps1`; `test-console/switch-models.ps1`; `test-console/start-ui.ps1`;
`test-console/console/server.ts`; `test-console/console/index.html`; `scripts/check-deps.ts`; `scripts/ask.ts` (+ other
terminal scripts taking a model, not yet listed); `README.md`; `RUN-ON-ANOTHER-PC.md`.
Unchanged: gateway, paywall code, Presidio, analyst, crossask, Dockerfiles.
If chain-query lives in CreditSeal instead: this repository only changes `server.ts`, `index.html`, `start-ui.ps1`,
`stack.ps1`, `switch-models.ps1`, `.gitignore` plus the model-profile files.

## 6. Phases
| # | Work | Who |
|---|---|---|
| 1 | This document | AI (done) |
| 2 | Registry, settings module, `chain-config.ps1`, `.gitignore`, `stack.ps1` profile step, `all` mode + optional keys, ai-profile; tests | AI |
| 3 | Read CreditSeal `ledger.ts` + `packages/xls66`; NEAR RPC docs; build chain-query with both adapters; recorded-reply tests | AI |
| 4 | "Blockchain queries" twisty, tab 03 preset removal, dynamic network labels, `--chain-query` flag | AI |
| 5 | `chain-config.ps1 -Set/-SetSecret`, verify XLS-65/66 per network, fill NEAR contract sources, full baseline suites | Manual, one step at a time |

## 7. Open items
1. **Decided 11:51 (owner):** chain-query lives in THIS repository for now; may be cleaned up / moved later
   (xrplh-24 "one owner per piece of data" would point to CreditSeal `services/lending`).
2. **Placeholder (owner, 12:25):** owner's NEAR testnet contract account ID and repo path — not built yet; `<PLACEHOLDER>` in
   `config/chains/networks.json` source `chainaim-own`.
3. **Placeholder (owner, 12:25):** existing NEAR testnet lending protocol — not chosen yet; `<PLACEHOLDER>` source in the same file.
4. **Researched 12:25 → `config/chains/networks.json`.** XRPL (xrpl.org faucet page, parallel-networks page, Known Amendments
   snapshot 2026-09-16): Testnet `wss://s.altnet.rippletest.net:51233/`; Devnet `wss://s.devnet.rippletest.net:51233/`;
   **Lending-Devnet `wss://lend.devnet.rippletest.net:51233/`** ("preview of XLS-66d"); Mainnet: SingleAssetVault Open for Voting
   45.71 %, LendingProtocol 37.14 %, LendingProtocolV1_1 0.00 % (none enabled); Testnet mirrors Mainnet; Ripple's XLS-66 docs say
   vaults/lending are disabled on Devnet → only `lending-devnet` gets capabilities vaults+loans. Still open: Devnet and
   Lending-Devnet network IDs (CAIP-2) and explorers. chain-query re-checks amendment status live instead of trusting the file.
5. **Researched 12:25.** NEAR (docs.near.org RPC Providers, Networks, NearBlocks): testnet RPC `https://test.rpc.fastnear.com`
   with fallbacks `https://near-testnet.drpc.org`, `https://testnet-rpc.intea.rs` (NEAR's own `rpc.testnet.near.org` is listed as
   severely rate limited); explorer `https://testnet.nearblocks.io`, API `https://api-testnet.nearblocks.io`. View calls:
   `query` + `request_type: call_function`, `finality`, `account_id`, `method_name`, `args_base64`; result bytes are UTF-8 JSON;
   one request per POST (no batches).
5b. **Read 12:25:** CreditSeal `services/lending/src/ledger.ts` (xrpl.js 5.3.0; reads Vault / LoanBroker / Loan entries by ID with
   `ledger_entry`; field names now listed in `networks.json` `ledgerEntries`) and `packages/xls66/src/units.ts` (rates in 1/10 bp,
   time in Ripple-epoch seconds). Open: discovering vaults by owner (`account_objects` type filter) — verify before building.
6. Optional crossask fix: check generated SQL columns against the schema before running; answer "this folder has no data for …"
   instead of retrying blindly.
7. Shared `ca-gateway` name and port 8720 between this repo and CreditSeal: decide whether to give one of them its own
   container name/port so both can run.

## 8. BUILT 2026-11-03 12:28-13:00 (uncommitted; tests below)
| File | What |
|---|---|
| `packages/chain-contracts/` (new) | registry loader/checks, `<PLACEHOLDER>` detection with paths, JSON-path mapper with explicit units (bps, 1/10 bp, decimals, decimalsFrom; exact decimal scaling), address rules, masking, CSV; 8 tests |
| `services/chain-query/` (new) | read-only HTTP service 127.0.0.1:8750 (`/healthz`, `/chains`, `/vaults`, `/loan-terms`, `/export`), `--validate`; XRPL adapter (JSON-RPC: `ledger_entry` by ID, `account_objects` filtered by LedgerEntryType here, `server_info`); NEAR adapter (`query`/`call_function`, fallback endpoints, `status`); one failing source never hides another; 7 tests with a fake RPC; no runtime dependencies |
| `config/chains/networks.json` (new) | registry with researched endpoints; NEAR sources and Lending-Devnet `vaultOwners` are placeholders |
| `config/local/chain-profile.example.json`, `ai-profile.example.json` (new) | examples; real files git-ignored (`config/local/*`) |
| `test-console/lib/settings.psm1` (new) | flag -> env -> profile/secrets file -> hidden prompt; masked display; secrets file refused inside the repo |
| `test-console/chain-config.ps1` (new) | `-List`, `-Set` (hidden prompt, validated), `-Select`, `-SetSecret`, `-Show` |
| `test-console/start-chain-query.cmd` (new) | starts chain-query |
| `test-console/stack.ps1` | `Resolve-PayTo` reads the profile (`-ProfileFile`); `-PayTo` still overrides |
| `test-console/switch-models.ps1` | `-SecretsFile` (default `C:\PRIV-AI-SECRETS\chainaim.env`) read before the hidden prompt |
| `test-console/start-ui.ps1` | starts chain-query (`-ChainQueryPort 8750`, `-RestartChainQuery`, `-NoChainQuery`); console gets `--chain-query` |
| `test-console/console/server.ts` | `--chain-query URL`; GET `/chain/<healthz|chains|vaults|loan-terms|export>` forwarded, known routes only |
| `test-console/console/index.html` | "Blockchain queries" twisty in tab 03 (closed by default; Chain / Environment / Source; Vaults, Loan terms, Export CSV); the "XRPL vault loan terms" preset removed |
Not built yet: dynamic network labels in tab 04 (still "XRPL TestNet"); `modes/all.json` single gateway mode (3.6).
Verified in the Linux workspace: chain-contracts 8/8, chain-query 7/7, crossask 8/8; `/chains` and the console proxy answer.
Not verified there: live RPC (the workspace has no route to the ledgers), PowerShell scripts (no PowerShell there), `scripts/check-deps.ts`
reports 2 stale-allow entries (ledger-watch, admin-console) that predate this change.

## 9. Correction 12:47 (owner): XLS-65/66 run on XRPL **Devnet**
§7 item 4 relied on an older opensource.ripple.com note ("disabled on Devnet"). The repo's own records say otherwise:
xrplh-12 row 175 (`feature` on s.devnet, owner run 2026-10-24: LendingProtocol, LendingProtocolV1_1, SingleAssetVault enabled),
xrplh-18 (CreditSeal Devnet run, every transaction tesSUCCESS), xrplh-22 row 28. Live check 12:46: Devnet answers (xrpld 3.4.1,
network 2), Lending-Devnet does not (fetch failed). `networks.json` now: devnet = payments + vaults + loans, source `ledger` reads
CreditSeal's current vault `B426...C108` and loan broker `856C...F4F6` (data/lending/devnet-run.json); lending-devnet has no
capabilities until it is reachable again. Not yet read: individual Loan entries (per-loan rate/term); a broker row leaves those empty.

## 10. UI CONTRACT: visible progress on every long action (owner, 17:40 — must not regress)
- `test-console/console/index.html`: a fixed activity bar at the bottom (`#activity`, role=status, aria-live) with a moving bar,
  a spinner, what is being waited for, and the seconds waited; after 8 s "still working", after 30 s a note that reasoning / CPU
  models think before answering. The clicked button shows its own spinner (`aria-busy`). Driven by `busy()` (every server
  action: scan, mask, send, routes, ledger, ask across files, relations) and by `chainRun()` (Blockchain queries). Labels per
  button in `data-busy` (e.g. ask across files names its stages). Disabled-but-idle buttons show a not-allowed cursor, not a busy one.
- Guard: `scripts/test/console-progress.test.ts` (run by `npm test`) fails if the bar, the button spinner, the seconds counter,
  busy()/chainRun() wiring or the labels on the slow buttons are removed. Change the contract only together with that test.
- The dental CLI has the same idea in the terminal (`dental.ts --progress`, `dental-test.ps1 -Progress`).
- Also 17:37: one gateway mode for every model: `test-console/modes/all.json` + `config/local-models.all-sources.json` (GPU local
  models + Bedrock Nemotron, zone private-cloud; auto and health data stay local). Owner confirmed Bedrock now shows in tab 03.
- 17:43: the activity bar's mark is now a live-activity glyph cycling through · ✢ ✳ ✶ ✻ ✽ every 120 ms (orange, pulsing) with a
  shimmer over the label, as in Claude's apps; the guard test checks the frames, the 120 ms turn and the shimmer keyframes.
- 17:43 spelling: "instalment(s)" -> "installment(s)" in the console, README, docs, analyst fixture scripts and packages/actus
  (messages, prompt text, golden master re-checked identical: 46 cases). Kept on purpose: the actus alias INSTALMENT (accepts a
  model's British spelling) and the document matcher now accepting both spellings (/instal{1,2}ments?/); BUILD_LOG and DESIGN
  history and the sample statement fixtures (.txt/.pdf pair) are unchanged.

# OutcomeAI — quote-agents design (Jupiter private data plane + NEAR AI TEE reasoning)

Codebase: `C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai` · Date: 2026-11-14 · Status: **OA-1..OA-6 BUILT and tested 2026-11-14 (ARCH-730..737, §11); OA-7 DONE 2026-11-14 (live T02 through Signatory, attest verified); OA-8 open**
Companion: `SIGNATORY-quote-flow-design-01.md` (the caller). Shared contract: §4 (identical in both files; additions marked **BUILT+** in §4 are additive and must be copied to the companion).
Place in repo: this file, design number **44** (O10 closed).

Tags: **V-READ** read in code today · **CALC** computed by the generator this session · **DESIGN** proposed · **ASSUMED** · **OPEN** · **DECIDED** owner decision in chat.

---

## 1. Role of OutcomeAI in this flow
OutcomeAI is **Jupiter's private data plane**. It answers questions from Jupiter's vLEI-identified agents (called from Signatory) using:
- Jupiter's private business data: stock, sailings, costs, AR/AP, business policy (DECIDED: this data lives **only** here);
- the reasoning model in the **NEAR AI TEE**, through the existing gateway + attest (DECIDED: path A).

It **does not** decide authority, store negotiation state or talk to Tommy. Signatory does that.

## 2. Verified facts (V-READ)
| Fact | Source |
|---|---|
| Gateway: no npm runtime deps, Node runs TypeScript; secrets by env var **name** only in `.env.example`; Presidio down → chat 503; everything sent to a model is masked | `PROJECT_CONTEXT.md` |
| Gateway default `--port 8700`, `--presidio-url http://127.0.0.1:5002`; compose host port **127.0.0.1:8720 → 8700**; network alias `gateway.railway.internal` | `services/gateway/src/main.ts`, `docker-compose.yml` |
| Gateway auth: `Authorization: Bearer <key>`, timing-safe compare; no key configured = open; compose passes env `CHAINAIM_GATEWAY_KEY`, secret file `test-console/local-gateway-key.txt` | `gateway/src/server.ts` `authorized()`, `docker-compose.yml` |
| Attested replies carry headers `x-chainaim-provider-id`, `x-chainaim-served-model`, `x-chainaim-req-sha256`, `x-chainaim-resp-sha256` | `gateway/src/server.ts` L61–68 |
| Residual guard: refuses runs of **≥ 9 digits** (`digits`), ≥ 10 (`spaced_digits`), intl phone, e-mail, titled name; ISO dates/times stripped first; `.` not a joiner (amounts pass) | `gateway/src/privacy/residual.ts` |
| Attest: port 8770, `POST /verify {calls:[{chatId, servedModel, requestSha256, responseSha256, calledAt}]}`, `GET /healthz`; holds `NEARAI_API_KEY`; compose profile `attest`, `127.0.0.1:8770` | `services/attest/src/main.ts`, `docker-compose.yml` |
| Models: `nearai/deepseek-v4.1-flash` (reasoning, NEAR AI TEE), `bedrock/nemotron-nano-3-30b`, `hosted/nemotron-nano-reasoning` | `config/local-models.cpu-all-nearai.json`, `config/catalog.bedrock.json` |
| Compose host ports in use: 8080 paywall, 8720 gateway, 8735 console-api, 8740 analyst, 8750 chain-query, 8760 agent (profile `agent`), 8770 attest, 5004 openrouter-stub (profile `test`) | `docker-compose.yml` |
| **Port 8780 is in use on the owner's PC** (PID 12400, `netstat`): it is ca-control-signer (desk.ps1 `signer.url` default `http://host.docker.internal:8780`). **8785 is free** (`netstat`, 2026-11-14) | owner output, 2026-11-14; V-READ `test-console/desk.ps1` |
| Jupiter ERPNext data exists: `sample-data/smb-2-erp-fin/erpnext/jupiter-knitting/jupiter-knitting.erpnext-data.json`; schema has `Item`, `Customer`, `Sales Order`; **no** `Quotation`, `Request for Quotation`, `Bin`, `Warehouse` | `_source/jupiter-knitting.erpnext-schema.json` |
| `rig/tenants/t01/tenant.json` = paywall **payer** tenant ("Jupiter Knitting (synthetic test tenant)", XRPL/NEAR accounts, spend policy) — a different purpose from quote tenancy | `rig/tenants/t01/tenant.json` |
| Existing start scripts: `test-console/desk.ps1`, `up.ps1`, `down.ps1`, `stack.ps1` (contents not read) | directory listing |

## 3. New service: `services/quote-agents` (DESIGN)

### 3.1 Runtime and flags
- Node 24, TypeScript run directly, **no npm runtime dependencies** (same rule as the gateway).
- `node services/quote-agents/src/main.ts` with flags (all have defaults; nothing hard-coded):

| Flag | Default | Meaning |
|---|---|---|
| `--port` | **8785** (free, checked 2026-11-14) | listen port |
| `--host` | `127.0.0.1` (`0.0.0.0` in compose) | bind address |
| `--data-root` | `sample-data/quote` | tenant data root |
| `--tenants` | `config/quote-tenants.json` | tenant registry |
| `--as-of` | `2026-11-16` | fixed "today" so runs repeat |
| `--ai` | `off` | `off` (rules) · `nearai` · `bedrock` |
| `--model` | `nearai/deepseek-v4.1-flash` | gateway model id (`bedrock/nemotron-nano-3-30b` with `--ai bedrock`) |
| ~~`--llm-via`~~ | — | **NOT BUILT**: only the gateway path (DECIDED, masked) exists; a `direct` path would put the NEAR AI key in this service (O12) |
| `--gateway-url` | `http://127.0.0.1:8720` (compose: `http://gateway.railway.internal:8700`, the gateway's network alias) | gateway base |
| `--gateway-key-env` / `--gateway-key-file` | `CHAINAIM_GATEWAY_KEY` / unset (compose: `/run/secrets/gateway-key`, the existing secret) | **BUILT+** where the gateway key comes from |
| `--attest-url` | `http://127.0.0.1:8770` (compose: `http://attest:8770`) | attest base |
| `--attest` | `on` when `--ai nearai`, else `off` | verify each AI call |
| `--attest-wait-ms` | `5000` | **BUILT+** wait this long for the verdict, else `"pending"` (§6 step 3) |
| `--timeout-ms` | `60000` | per model call (and per attest call) |
| `--temperature`, `--prompts-dir`, `--probe-ms`, `--allow-non-loopback` | `0.2`, `config/quote-prompts`, `3000`, off | **BUILT+** model temperature; prompt folder; `/healthz` probe timeout; a non-loopback `--host` needs it (container) |

- Env var **names** (added to `.env.example`; values never in git or chat): `QUOTE_TOKEN_JUPITER`, `QUOTE_TOKEN_TOMMY`. Reuses `CHAINAIM_GATEWAY_KEY` (existing) for the gateway call. **BUILT:** in Docker the tokens come from `C:\PRIV-AI-SECRETS\quote-agents.env` mounted read-only (Node `--env-file-if-exists`, the same pattern as ca-agent), not from compose `environment:`; `QUOTE_AI` (compose interpolation) picks `--ai`.

### 3.2 Files
| ✚ new / ✎ edit | Path | Content |
|---|---|---|
| ✚ | `services/quote-agents/src/main.ts` | flags, HTTP server (node:http), routing, JSON errors, `/healthz` |
| ✚ | `services/quote-agents/src/tenants.ts` | load `config/quote-tenants.json`; caller check (token, alias → path, LEI) |
| ✚ | `services/quote-agents/src/data.ts` | load and validate tenant JSON data (as-of date) |
| ✚ | `services/quote-agents/src/inventory.ts` | stock available to promise, WIP, production, reallocatable lots, grade alternatives |
| ✚ | `services/quote-agents/src/logistics.ts` | sailing by cutoff, delivered = ETA + customs + drayage, sea → express → air |
| ✚ | `services/quote-agents/src/treasury.ts` | landed cost, prices at requested margins, liquidity (AR/AP 30d), advance lever, buyer credit; **never returns unit cost** |
| ✚ | `services/quote-agents/src/synthesize.ts` | rules proposal; AI branch (Q5): prompt → gateway → parse → async attest |
| ✚ | `services/quote-agents/src/rules.ts` | concession schedule 15% → 13.5% → floor (rules fallback, same maths as the generator) |
| ✚ | `services/quote-agents/package.json` | `"type":"module"`, scripts `start`, `test` (no dependencies) |
| ✚ | `services/quote-agents/Dockerfile` | node:24-slim, copy src + config + sample-data/quote |
| ✚ | `services/quote-agents/test/*.test.ts` | §7 |
| ✚ | `config/quote-tenants.json` | §3.3 |
| ✚ | `config/quote-prompts/seller-round.md`, `ceo-brief.md` | T5 system prompts (Q5) |
| ✚ | `sample-data/quote/jupiter-knitting/` | `products.json`, `customers.json`, `inventory-lots.json`, `sailings.json`, `air.json`, `treasury-ledger.json`, `business-policy.json` + `README.md`. **BUILT differently:** the "pack" is not on disk in either repo (only three CSVs with May dates and no lots/tiers in `enh-3-signatory/Claude outputs`), so the set is **synthetic, written to the §5 rules and calibrated to the companion's T01/T02/T03/T08 prices** (O11) |
| ✚ | `sample-data/quote/tommy-hilfiger-europe/README.md` | the later buyer tenant (no data in the MVP: its paths answer 404 after the caller check) |
| ✚ | `services/quote-agents/Dockerfile.dockerignore`, `test/helpers.ts` | **BUILT+** build context limited to what the image copies; test helpers (real data, real local HTTP servers) |
| ✎ | `docker-compose.yml` | service `quote-agents` (container `ca-quote-agents`): profile `quote`, ports `127.0.0.1:8785:8785`, tokens from the read-only env-file bind, the existing `gateway-key` secret; **no `depends_on`** (started with `--no-deps`, so nothing else starts or restarts) |
| ✎ | `.env.example` | the two token names + `QUOTE_AI`, `QUOTE_ENV_FILE` |
| ✎ | `README.md` | "Quote agents (Signatory demo)" section: start, flags, endpoints |
| ✎ | `test-console/desk.ps1`, `scripts/test/desk.test.ts` | **BUILT+** (project rule 8, one command): `-Quote start\|stop\|check [-QuoteAi off\|nearai\|bedrock] [-QuoteEnvFile]`, only this container; its suite added to `-Test/-All/-Ship`; guard test |
| — | gateway, attest, paywall, analyst, up.ps1 | **no change** |

### 3.3 Tenant registry `config/quote-tenants.json`
```json
{
  "jupiter-knitting": {
    "lei": "3358004DXAMRWRUIYJ05", "dataDir": "jupiter-knitting", "tokenEnv": "QUOTE_TOKEN_JUPITER", "rigTenant": "t01",
    "agents": {
      "JupiterInventoryAgent": ["agents/inventory"], "JupiterLogisticsAgent": ["agents/logistics"],
      "JupiterTreasuryAgent": ["agents/treasury"], "jupiterSellerAgent": ["seller/synthesize"], "jupiterCeoAgent": ["seller/synthesize"]
    }
  },
  "tommy-hilfiger-europe": {
    "lei": "54930012QJWZMYHNJW95", "dataDir": "tommy-hilfiger-europe", "tokenEnv": "QUOTE_TOKEN_TOMMY",
    "agents": { "TommyTreasuryAgent": ["agents/treasury"], "tommyBuyerAgent": ["agents/procurement", "buyer/synthesize"] }
  }
}
```
LEIs and agent aliases are V-READ from Signatory's `config/accounts.json` and vLEI evidence. A token for one tenant gets **403** on the other tenant's paths.

## 4. Shared API contract (identical in both design files)

All requests: `Content-Type: application/json`, `Authorization: Bearer <tenant token>`, `X-Agent-Alias: <vLEI alias>`, `X-Agent-LEI: <tenant LEI>`, body field `requestId`.
Errors: `{error:{code, message}}` with 400 (bad body), 401 (token), 403 (alias/path/LEI), 404 (tenant/path), 422 (data cannot answer), 502/504 (model/attest).

| Method · Path | Request | Response |
|---|---|---|
| `GET /healthz` | — | `{ok, asOf, ai, model, gateway:{ok}, attest:{ok}, tenants:[ids]}` |
| `POST /v1/tenants/{t}/agents/inventory` | `{requestId, sku, qty, shipBy}` | `{sources:[{lot, kind:"FREE"\|"WIP"\|"PRODUCTION", units, readyDate, warehouse}], reallocatable:[{lot, units, tier:"TIER1"\|"TIER2", requiredAuthority:"SALES_OFFICER"\|"CEO", premiumPct, replacementOk}], gradeAlternatives:[{sku, grade}], shortfall}` |
| `POST /v1/tenants/{t}/agents/logistics` | `{requestId, sku, lots:[{lot, units, readyDate, warehouse}], deadline, allowAir}` | `{legs:[{lot, units, mode:"SEA_STD"\|"SEA_EXP"\|"AIR", carrier, etd, delivered, freightCents}], freightCents, meetsDeadline, lateUnits, airOption:{deliveredBy, centsPerUnit, maxUnits}\|null}` |
| `POST /v1/tenants/{t}/agents/treasury` | `{requestId, sku, qty, freightCents, reallocUnits:{TIER1, TIER2}, termsDays, advancePct, margins:[0.15,0.135,0.12,0.11,0.10,0.09,0.08]}` | `{landedCents, pricesAtMargin:{"0.15":n,…}, reallocPremiumCents, liquidity:{net30Usd, status:"SURPLUS"\|"DEFICIT"}, advanceLever:{minAdvancePct, marginRelief, applies}, credit:{headroomUsd, ok}}` |
| `POST /v1/tenants/{t}/seller/synthesize` | `{requestId, mode:"round"\|"ceo-brief", inquiry, round, history, answers:{inventory, logistics, treasury}, authority:{level, floorCents, maxRounds, allowed}}` | `{proposal:{decision:"ACCEPT"\|"COUNTER"\|"ESCALATE", counter:{sku, qty, priceCents, deadline, shipments}}, messageToBuyer, reasoning, source:"ai"\|"rules", model, attest:{chatId, servedModel, verdict}\|null, ms}` |
| later: `/v1/tenants/tommy-hilfiger-europe/agents/treasury`, `/agents/procurement`, `/buyer/synthesize` | buyer mirror | — |

Data rules on the wire: prices in **US cents per unit** (integers); totals in **USD**; ISO dates. Never send cent totals, LEIs or account numbers to the model (residual guard, §2).

**BUILT+ (additive; copy to the companion's §4):**
- Every 200 answer echoes `requestId`. A body without `requestId` is 400.
- Unknown tenant 404; a token that belongs to **another** tenant 403 `wrong_tenant`; a token matching no tenant 401. A tenant without data (Tommy today) answers 404 after the caller check.
- `freightCents` (each leg and the total) is the order's **total in US cents** (integer), the input to treasury's landed cost; the one exception to "cents per unit". It never goes to the model.
- inventory `reallocatable[]` also carries `readyDate`, `warehouse` (logistics needs them to ship a reallocated lot).
- logistics `legs[]` also carries `late` (true = this leg misses the deadline).
- treasury takes an optional `customer` (default: `business-policy.json` `defaultCustomer` = `tommy-hilfiger-europe`). `reallocPremiumCents` is **per unit, on top of** a price at margin. `credit.ok` = `termsDays` 0, or the financed invoice (qty × price at 15% × (1 − advancePct)) ≤ headroom.
- synthesize also returns `reasonAiSkipped` when `source:"rules"` was used with `--ai` on; `model` is `null` for rules; `attest.verdict` = ca-attest's status, `pending`, `no-evidence` (reply without the headers) or `error: ...`.

## 5. Computation rules (DESIGN; the same maths as the generator that produced the CALC oracle)
- **Inventory:** stock available to promise = on hand − reserved − QC hold. Source order: FREE → WIP_FREE → new production (ready = as-of + lead days + 2 days QC, up to the capacity per cycle) → TIER2 reallocation (Sales Officer) → TIER1 reallocation (CEO).
- **Logistics:** at port = ready date + inland days (MADRAS 1, TIRUPUR 2). Take the first sailing whose cutoff (ETD − 2) is ≥ the at-port date. Delivered = ETA + 4 (customs) + 1 (drayage). Choose the cheapest mode that meets the deadline; air only when allowed. Containers = ceil(units ÷ units per 40HC).
- **Treasury:**
  - landed = (qty × unit cost + freight + $300 overhead) ÷ qty;
  - price at margin m = ceil(landed ÷ (1 − m));
  - 30-day net = cash + credit headroom + current AR due ≤ 30d − AP due ≤ 30d;
  - DEFICIT + advance ≥ 30% → one margin point of relief;
  - credit OK if invoice ≤ limit − open receivable.
- **Rules proposal:** round 1 ask = 15%, round 2 = 13.5%, round 3 = the floor sent by Signatory. Accept if the buyer's price ≥ the current ask.
- **BUILT, where §5 left a choice open:** sources include only what is ready on or before `shipBy`; TIER2/TIER1 lots are listed in `reallocatable`, never counted as sources (the caller's authority decides). Logistics takes the first mode that meets the deadline in the order SEA_STD → SEA_EXP → AIR; containers are counted per leg. Status is **DEFICIT when net30 − this order's cost (qty × unit cost + freight + overhead) < `safetyThresholdUsd`** ($3,000, from the treasury CSV). Prices use integer maths from the exact order cost (`landedCents` is shown rounded up). Rules: never above the seller's previous counter, never below the floor; ESCALATE when the buyer is below the ask and `round ≥ maxRounds`; `ceo-brief` asks floor + reallocation premium and never escalates. Policy numbers live in `business-policy.json`, not in code.

## 6. AI synthesis (Q5, DESIGN)
1. Load `config/quote-prompts/seller-round.md` (or `ceo-brief.md`). The user content is a compact JSON context (numbers as fields).
2. `POST {gateway}/v1/chat/completions` with `Authorization: Bearer ${CHAINAIM_GATEWAY_KEY}`, model per `--model`, `temperature 0.2`.
3. Read the 4 `x-chainaim-*` headers. Fire `POST {attest}/verify` **without waiting**; the result lands in the response field `attest.verdict` when it is ready within `--timeout-ms`, otherwise `"pending"`.
4. Strict JSON parse. On 422 (residual), timeout, or bad JSON → the rules proposal with `source:"rules"` and `reasonAiSkipped`.
5. `reasoning` is returned to Signatory (Jupiter-internal record only; Signatory never forwards it to Tommy).
- **BUILT guards** (a failure → rules + `reasonAiSkipped`): price ≥ floor; ACCEPT only at the buyer's price; a COUNTER above the buyer's price and not above the previous seller counter; a CEO brief never ESCALATEs; `messageToBuyer` names no cost/margin/floor/landed and contains no internal price figure (floor, landed, other prices at margin).
- OPEN (O6, narrower): `gateway/src/chat.ts` `toSse` builds the stream delta from the non-stream `message` (L437 copies `message.reasoning`), so the non-stream reply carries `reasoning` when the provider returns it; the service reads `choices[0].message.reasoning` and joins it to the JSON `reasoning`. Whether deepseek-v4.1-flash fills it: OA-7.
- OPEN: Presidio masks locations by default (Chennai, Los Angeles); the gateway restores placeholders in the answer. Confirm in the first live call.

## 7. Tests (`services/quote-agents/test/`)
| Test | Asserts |
|---|---|
| `tenants.test.ts` | wrong token 401; alias not allowed for the path 403; LEI mismatch 403; Jupiter token on the Tommy tenant 403 |
| `inventory.test.ts` | T01–T08 sources and shortfall match the CALC oracle |
| `logistics.test.ts` | legs, delivered dates and freight match the oracle (incl. T03 std + express split) |
| `treasury.test.ts` | landed cents, prices at 15/12/10/8 match the oracle; unit cost absent from every response |
| `synthesize.test.ts` | rules proposals per round; AI branch with a stubbed gateway: valid → `source:"ai"`; 422/timeout/bad JSON → `source:"rules"`; attest headers forwarded |
| `http.test.ts` | `/healthz`, 404/400 paths, JSON error shape |

Run: `node --test "services/quote-agents/test/*.test.ts"` (no extra flags: Node 24 strips the types, as the root `npm test` does; O8 closed). **2026-11-14: 39/39 pass**; also run by `desk.ps1 -Test/-All/-Ship`. The AI branch is tested against real local HTTP servers in the gateway's and ca-attest's place (no network, no key). Oracle: the per-agent values are this session's own worked figures on the synthetic data (O11); the treasury tests pin the companion's T01/T08 (415 at 15 %, 384 at 8 %), T02 (411 at 13.5 %) and T03 (413 at 12 %).

## 8. Iteration plan (OutcomeAI part)
| # | Item | Pri | Punchline | Tracks | Status/work | Files | Time | Who |
|---|---|---|---|---|---|---|---|---|
| OA-0 | Confirm port **8785** free | MVP | No clash | Ops | **done** 2026-11-14 (8780 = ca-control-signer) | — | 2m | AI |
| OA-1 | Data JSON + tenant registry | MVP | Jupiter's private data in one place | Private AI | **done** (synthetic, O11) | `sample-data/quote/jupiter-knitting/*.json`, `config/quote-tenants.json` | 15m | AI |
| OA-2 | quote-agents service, rules only | MVP | Three sub-agents + rules synthesis answer | Private AI | **done** | `services/quote-agents/src/*`, `package.json` | 45m | AI |
| OA-3 | Tests | MVP | Matches the oracle; tenants isolated | QA | **done** 39/39 | `services/quote-agents/test/*` | 25m | AI |
| OA-4 | Compose service + `.env.example` names + `desk.ps1 -Quote` | MVP | One command start | Demo | **done**; image built, `-Quote start/check/stop` run live, other containers untouched | `docker-compose.yml`, `.env.example`, `services/quote-agents/Dockerfile`, `test-console/desk.ps1` | 20m | AI |
| OA-5 | README section | MVP | Judges can start it | Demo | **done** | `README.md` | 10m | AI |
| OA-6 | AI synthesis via gateway + async attest | High | NEAR TEE reasoning, attested | NEAR AI / TEE | **done** (tested against local HTTP servers; from inside the container the gateway and ca-attest answer `/healthz` 200) | `src/synthesize.ts`, `config/quote-prompts/*` | 45m | AI |
| OA-7 | Live NEAR AI run | High | Real attested answer | Demo | **done 2026-11-14**: direct seller/synthesize (source ai, COUNTER 415, attest verified); Signatory T02 `--ai on`: both rounds AI, guard kept, final source ai, attest verified. Needed Signatory fixes (synthesize body to §4; guard accepts legs). Model calls 13-55 s | — | 15m | MANUAL (key in `.env` only; never in chat) |
| OA-8 | Tommy tenant endpoints | Later | Buyer reasons privately too | Private AI | after hackathon | tenant data + `agents/procurement`, `buyer/synthesize` | 60m | AI |

MVP for OutcomeAI: OA-0 → OA-5 ≈ **2h**. Exit: `curl` each endpoint for T01–T08 → values equal the oracle; `docker compose --profile quote up -d quote-agents` → `/healthz` ok; existing repo tests unchanged.

## 9. Run commands (BUILT; project rule 8: one `desk.ps1` command, no raw docker/curl sequences)
```powershell
.\test-console\desk.ps1 -Quote start                    # rules only (ca-quote-agents, only this container)
.\test-console\desk.ps1 -Quote start -QuoteAi nearai    # NEAR AI TEE via ca-gateway, attested by ca-attest (desk running, -Attest)
.\test-console\desk.ps1 -Quote check                    # /healthz, incl. gateway / ca-attest seen from inside the container
.\test-console\desk.ps1 -Quote stop
# without Docker (development): node services/quote-agents/src/main.ts --ai off
```

## 10. Open items
| ID | Item | Close by |
|---|---|---|
| O1 | Port 8785 free | **closed** 2026-11-14 (`netstat`; ca-quote-agents listens there) |
| O6 | non-stream `reasoning` field via the gateway | **closed 2026-11-14 (OA-7):** the live reply carried `reasoning` |
| O7 | Presidio location masking + restore on quote prompts | OA-7 live call. The context sent has no place names today (sku, units, dates, cents), so masking only touches `messageToBuyer` if the model adds a place. 2026-11-14 OA-7: no place name in the context or the three live replies, so masking was not exercised; still open |
| O8 | exact Node test flags used by the repo | **closed**: none (`node --test "<glob>"`) |
| O9 | Is the gateway's current mode one that routes `nearai/*`? | **closed** 2026-11-14: `config/generated/catalog.local.json` (the running gateway's catalog) has `nearai/deepseek-v4.1-flash` → `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `attest: nearai` (V-READ). After another `switch-models.ps1` mode, read it again |
| O10 | next free `privateAI-design-NN` number | **closed**: 44 |
| O11 | The "pack" (CALC source data) is not in either repository | owner: if it exists, put it in `sample-data/quote/jupiter-knitting/` (same JSON shapes, `src/data.ts` checks them at start) and re-pin the tests; until then the data is synthetic and T04-T07 are pinned only by Signatory's flow tests |
| O12 | `--llm-via direct` (§3.1) not built | owner: only if a path around the gateway's masking is ever wanted; it would put `NEARAI_API_KEY` in this service |

## 11. Requirement IDs (BUILT 2026-11-14)
| ARCH-ID | Requirement | Tests |
|---|---|---|
| ARCH-730 | tenant registry + caller check (token, alias → path, LEI; other tenant's token 403) | `tenants.test.ts` (5) |
| ARCH-731 | inventory agent (§5 Inventory) | `inventory.test.ts` (6) |
| ARCH-732 | logistics agent (§5 Logistics) | `logistics.test.ts` (6) |
| ARCH-733 | treasury agent (§5 Treasury), never the unit cost | `treasury.test.ts` (7) |
| ARCH-734 | rules proposal (§5 Rules) | `synthesize.test.ts` (4) |
| ARCH-735 | AI synthesis via the gateway, guards, fallback, attest verdict (§6) | `synthesize.test.ts` (6) |
| ARCH-736 | HTTP API, flags and defaults, `/healthz`, error shape (§4) | `http.test.ts` (5) |
| ARCH-737 | compose service (profile `quote`) + `desk.ps1 -Quote` | `scripts/test/desk.test.ts` (1); live run 2026-11-14 |

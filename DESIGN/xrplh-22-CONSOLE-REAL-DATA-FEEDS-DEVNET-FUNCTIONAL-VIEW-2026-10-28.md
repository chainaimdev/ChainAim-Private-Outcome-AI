# xrplh-22 — Console from demo to real: feeds (Streams + Webhooks), Devnet monitoring, explorer links, functional view

Breadcrumb: xrplh-19 (backend) · xrplh-20 (UI) · xrplh-21 (build plan) · `creditseal-live-ops-demo.html` (look) · **xrplh-22** (this: owner review of the demo, 9 points).
Status: **DESIGN ONLY — no code written or changed.** 2026-10-28 (IST). Awaiting owner approval of §8 (files) and §9 (decisions).
Tags: **[READ]** read in the named repo file today · **[WEB]** read on the named official page today · **[LIVE]** queried live 2026-10-28 · **[ASSUME]** not verified — check named.

---

## 0. The owner's 9 points → what changes

| # | Owner point (2026-10-28) | Answer in one line | § |
|---|---|---|---|
| 1 | The DEMO strip must go in the real page | Removed. Real page has no simulated data; each panel says whether a figure is *measured* (ledger) or *reported* (paywall/rig) | 2 |
| 2 | Control deck: use **Streams and Webhooks**; WebSocket "QuickNode has but does not recommend" | Testnet feeds become QuickNode **Streams** (primary) + **Webhooks** (second road) + `account_tx` poll (safety net). WSS stays as an *optional, off-by-default* road. Sliders and inject buttons leave the page | 3 |
| 3, 7 | Ledger view needs a link to the actual tx on the blockchain | Every hash and address links to the explorer for *its* network (Testnet / Devnet), templates set by flags | 5 |
| 4 | "What happens to Devnet?" | Lending is on Devnet because the Lending amendments are enabled **only** there. QuickNode has no Devnet. Devnet gets its own feed set | 4 |
| 5 | Options for Devnet monitoring; QuickNode listed but disabled | A per-network **feed selector**: QuickNode shown *unavailable* on Devnet; public Devnet node, community node, own xrpld/Clio, Bithomp REST as options | 4 |
| 6 | Live Ops = technical view; Reconcile only covers part | Live Ops stays technical. Reconcile grows from "x402 claims vs ledger" to **every ChainAim charge**: x402 calls, lending service fees, LoanSet attestations | 6 |
| 8 | Lending = only loan health | Lending tab reads real state (vault, broker, loans, ACTUS status) and adds the lifecycle trail with links | 6 |
| 9 | Missing a **functional** view: who asked ChainAim for what, which request, where it paid | New first tab **Engagements**: one row per request (e.g. Harbor Credit → underwriting for Orion Ceramics → request `uw-…` → fee tx → verdict → LoanSet), built by joining data that already exists | 7 |

---

## 1. Facts this design rests on

| Fact | Source |
|---|---|
| Lending runs on **XRPL Devnet** only: "LendingProtocol, LendingProtocolV1_1, SingleAssetVault and fixCleanup3_4_0 are enabled there and not on Testnet or Mainnet (checked 2026-10-24 with the `feature` RPC)". Default `wss://s.devnet.rippletest.net:51233/`, overridable by `XRPL_WS_URL_DEVNET` | [READ] `services/lending/src/env.ts` |
| Still true today: LendingProtocol / SingleAssetVault / LendingProtocolV1_1 `enabled:false` on Mainnet and Testnet, `enabled:true` on Devnet | [LIVE] `feature` against public servers listed on xrpl.org (research agent, 2026-10-28) |
| A separate **Lending-Devnet** exists: `wss://lend.devnet.rippletest.net:51233/` — "Preview of XLS-66d Lending Protocol"; "Devnets may be reset without warning." | [WEB] https://xrpl.org/resources/dev-tools/xrp-faucets |
| QuickNode XRPL networks: Mainnet + Testnet only (no Devnet) | [WEB] https://www.quicknode.com/docs/xrpl/api-overview |
| QuickNode **Streams** on XRPL: "XRP Ledger \| Testnet \| ✅ (Ledger) \| ❌ …" — **only the Ledger dataset** (whole validated ledger with `transactions[]` + `metaData`); filters in JS/Go; destinations Webhook, S3, PostgreSQL, Azure Blob, Kafka; "exactly-once delivery … in finality order"; sequential — waits for the destination's confirmation; pauses after max retries | [WEB] https://www.quicknode.com/docs/streams/supported-chains , …/streams/data-sources/xrpl , …/streams/faq , …/streams/destinations , …/streams/destinations/webhooks |
| QuickNode **Webhooks** XRPL: template `xrplWalletFilter` (`wallets:[r…]`), networks `xrp-mainnet`, `xrp-testnet`; 30 credits per payload; retries on non-200. XRPL payload shape **not documented** | [WEB] https://www.quicknode.com/docs/webhooks , …/webhooks/rest-api/getting-started |
| Signing for both: headers `X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature` (HMAC-SHA256) | [WEB] https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages |
| Plans: Free = 1 stream (webhook destination only, no reorg option) + 1 webhook; Build $49/mo = 10 + 10 | [WEB] https://www.quicknode.com/pricing |
| **"WebSocket not recommended" — no such statement found** in QuickNode docs. Their comparison guide says WebSocket is "Best-effort delivery. Data can be missed if the connection drops" and Streams give "Guaranteed delivery with exactly-once semantics". The XRPL endpoint page still lists WSS for "Transaction monitoring" | [WEB] https://www.quicknode.com/guides/quicknode-products/streams/websocket-vs-streams , https://www.quicknode.com/docs/xrpl/endpoints |
| Ripple public servers: "not for sustained or business use, and they may become unavailable at any time" | [WEB] https://xrpl.org/docs/tutorials/public-servers |
| ledger-watch today: networks `testnet`, `devnet`; Testnet roads `wss` (QuickNode subscribe), `backfill`, `poll`; webhook planned; Devnet via `XRPL_WS_URL_DEVNET` or `--fallback-public on`; `Row.type` is the raw TransactionType; x402 detection only | [READ] `services/ledger-watch/src/config.ts`, `decode.ts`, `README.md` |
| ChainAim service fees on Devnet are plain Payments with memo `chainaim:uw:<requestId>` (type `chainaim/underwriting-fee`) or `chainaim:<service>:<id>` (type `chainaim/<service>`); services seen: `underwrite`, `verify`, `monitoring`, `risk-view` | [READ] `services/lending/src/fee.ts`, `scripts/cockpit.ts action()` |
| Desk parties (demo, hard-coded): Orion Ceramics = borrower, Kestrel Foods = pilot borrower, **Harbor Credit = broker (lender & vault operator)**, Northbay Savings Fund = depositor, TUSD issuer; addresses come from the seed file | [READ] `services/lending/scripts/cockpit.ts PARTIES` |
| `LoanSet.Data` carries `sha256(pack)`, verdict, policy and request id; broker counter-signs only after re-hashing | [READ] `services/lending/README.md` |
| Run state: `data/lending/devnet-run.json` = asset, vault/broker ids, `loans{name:{loanId,borrower,requestId,packFile,createdTx,terms}}`, `fees`, `txs[{step,hash,result,at}]` (real Devnet hashes from 2026-10-26) | [READ] `services/lending/src/state.ts`, `data/lending/devnet-run.json` |
| Packs folder `data/lending/packs/` is **not present on this PC** (only `books/` and `devnet-run.json`) | [READ] directory listing |
| Paywall services: `POST /v1/privacy/scan`, `/v1/privacy/mask`, `/v1/chat/completions`; `payment_settled` line carries route, amount, payer, tx, invoiceId (with the sink on) — never text | [READ] `services/paywall/src/routes.ts`, `sink.ts`, ledger-watch README |
| `config/` is on the leave-alone list (ARCH-002) | handoff / xrplh-21 §1.4 |

---

## 2. Point 1 — no demo content on the real page

- Remove the DEMO strip, all simulated buyers (`t04+ sim`), the "Lending figures are illustrative" note and every in-browser generator.
- Each figure is labelled **measured** (validated ledger) or **reported** (paywall claim / rig trace). Nothing else may appear.
- **Rehearsal mode** (failover drills, fault injection) exists only when ledger-watch runs with `--rehearsal on`; the page then shows a fixed amber bar "REHEARSAL — synthetic rows are marked" and every synthetic row carries a tag. Off by default, never on a hosted deployment.
- Empty states say what is missing ("No Testnet feed configured", "Lending state file not found: <path>") instead of showing zeros.

## 3. Point 2 — control deck and Testnet feeds

### 3.1 What leaves the deck
| Demo control | Real page |
|---|---|
| Pause loop · Buyers · Calls/min · Price | **Removed.** The rig is started from the terminal (xrplh-21 §3). The deck shows *what is running*: buyers seen in the last 5 min, observed calls/min, price read from the paywall (`PRICE_*`) |
| + unclaimed payment · + lost claim · Reset | **Removed** (rehearsal mode only, §2) |
| QuickNode socket / Webhook toggles | Become **read-only feed status chips** (§3.3). No switch on the page changes a feed |
| Optional local Start/Stop (xrplh-21 decision 5) | Still local-only behind `RIG_CONTROL=on`; out of scope here |

### 3.2 Testnet roads — Streams first
| Road | Mechanism | Role | Default |
|---|---|---|---|
| `stream` | QuickNode **Streams**, dataset *Ledger*, Testnet, destination **Webhook** → `POST /feeds/qn-stream` on ledger-watch; a JS filter (kept in the repo, pasted into QuickNode) keeps only transactions touching watched addresses plus the ledger header | **Primary** push; exactly-once, in order | on |
| `webhook` | QuickNode **Webhook** `xrplWalletFilter`, `wallets=[payTo, buyers…]` → `POST /feeds/qn-webhook` | **Second, independent road** | on |
| `poll` | `account_tx` over QuickNode HTTPS every `--poll-sec` | Safety net, also backfill after any gap | on |
| `wss` | QuickNode WebSocket `subscribe` (exists today) | Optional low-latency road; best-effort | **off** (`--road-wss on` to enable) |

Why this order: Streams is the only road with a stated delivery guarantee ("exactly-once … in finality order"); the webhook gives independence from one stream pausing; poll closes any gap. WebSocket is *not* forbidden by QuickNode (no such statement found), but it is best-effort, so it is demoted to optional — this matches the owner's choice.

Consequences to accept:
- **Public HTTPS needed** for both QuickNode roads (cloudflared tunnel locally; load balancer on AWS). Every other route stays loopback/private (existing forwarded-header rule).
- **Free plan** = 1 stream + 1 webhook, enough for local Testnet. Streams' "Restream on reorg" needs a paid plan (XRPL validated ledgers are final, so this is low risk **[ASSUME]**).
- **Credits:** the stream processes every Testnet ledger even when filtered; "filters do not reduce credits". The XRPL per-ledger credit multiplier could not be read (rendered by JS) — **[ASSUME]** check in the QuickNode dashboard before leaving it running.
- **Stream payload shape** is documented (array of `ledger` objects); the **webhook** XRPL payload is not, so its parser is built from the first real delivery (bounded preview log, 200 on unparseable — as designed in xrplh-21 §2.4).
- **Sequential delivery** means a slow or failing ledger-watch pauses the stream after 3 failed attempts → ledger-watch must answer 200 fast (store first, process after) and raise an alert `stream_paused` when deliveries stop while ledgers keep closing (poll sees them).

### 3.3 Feed chips (header)
One chip per network × road: name, provider, last ledger, age, verified signature ✓, state `live / lagging / paused / off / unavailable`. Example: `TESTNET · stream (QuickNode) · ledger 12,480,311 · 2 s · HMAC ✓ · live`.

## 4. Points 4, 5 — Devnet and the choice of monitoring technology

### 4.1 What happens to Devnet
Lending stays on Devnet (only network with the Lending amendments today [LIVE]). QuickNode cannot watch it. So the console treats **monitoring technology as a per-network setting**, not a fixed product.

### 4.2 Options (shown in a "Feeds" settings panel, read-only in the UI, set by flags/env)
| Option | Testnet | Devnet | Push? | Status in our design | Note |
|---|---|---|---|---|---|
| QuickNode Streams | ✅ | ❌ | yes, exactly-once | Testnet primary | Devnet row shows **"unavailable — QuickNode does not serve XRPL Devnet"** (disabled, as the owner asked) |
| QuickNode Webhooks | ✅ | ❌ | yes | Testnet second road | Devnet: unavailable |
| QuickNode WSS | ✅ | ❌ | best-effort | optional | Devnet: unavailable |
| Ripple public node `s.devnet.rippletest.net` (WSS subscribe + JSON-RPC poll) | ✅ | ✅ | best-effort | **Devnet default** | "not for sustained or business use" |
| Ripple **Lending-Devnet** `lend.devnet.rippletest.net` | — | ✅ (lending preview net) | best-effort | option | only if lending moves there — **today's code uses `s.devnet`** |
| Community node (e.g. Honeycluster Devnet, listed on xrpl.org) | ✅ | ✅ | best-effort | Devnet fallback | third-party, no SLA |
| Own **xrpld / Clio** node joined to Devnet | ✅ | ✅ | yes (own subscribe) | **production-grade option** | infra cost; we control uptime and history |
| Bithomp REST API (`dev.bithomp.com/api/v2`) | ✅ | ✅ | no (poll) | poll-only option | "FREE on the test networks"; REST only |
| XRPSCAN, Chainstack, GetBlock, Tatum, Ankr, NOWNodes | some Testnet | ❌ | — | not used for Devnet | no Devnet support found |

Recommendation: **Devnet default = public Ripple node (WSS subscribe + JSON-RPC poll) with Honeycluster as failover**, both through the same adapter interface; **own xrpld/Clio** before anything customer-facing. Devnet resets "without warning", so ledger-watch must detect a reset (ledger index or genesis hash goes backwards / accounts vanish) and raise `network_reset` instead of reporting gaps.

### 4.3 How it is built (one interface, many adapters)
`FeedAdapter { name; network; kind: 'push'|'poll'; available(network): boolean; start(sink); stop(); health() }`
Adapters: `qn-stream`, `qn-webhook`, `qn-wss`, `xrpl-wss` (any rippled/xrpld/Clio URL), `jsonrpc-poll` (any URL), `bithomp-poll`. All feed the existing one-gate `insertIfNew()` with their road name, so de-dup, road timing and reconcile stay unchanged.
Selection by flags, e.g. `--feeds testnet=qn-stream,qn-webhook,jsonrpc-poll --feeds devnet=xrpl-wss,jsonrpc-poll` and URL env names per adapter (`--devnet-wss-env XRPL_WS_URL_DEVNET`, `--devnet-fallback-wss-env XRPL_WS_URL_DEVNET_FALLBACK`). An adapter that is not `available()` for a network is refused at start with a clear message (e.g. `qn-stream` on devnet).

## 5. Points 3, 7 — links to the blockchain

| Network | Transaction | Account | Status |
|---|---|---|---|
| Testnet | `https://testnet.xrpl.org/transactions/<hash>` | `https://testnet.xrpl.org/accounts/<address>` | route verified in ripple/explorer source |
| Devnet | `https://devnet.xrpl.org/transactions/<hash>` | `https://devnet.xrpl.org/accounts/<address>` | route verified (also the existing `DEVNET_EXPLORER` in lending `env.ts`, marked `[CHECK]` there) |
| Alternatives | `testnet.xrpscan.com/tx/<hash>`; `test.bithomp.com/tx/<hash>`, `dev.bithomp.com/tx/<hash>` | — | host verified; page rendering **not** confirmed |

- Flags: `--explorer testnet=https://testnet.xrpl.org --explorer devnet=https://devnet.xrpl.org` with path templates `--explorer-tx-path /transactions/{hash} --explorer-account-path /accounts/{address}`; ledger-watch sends ready-made links in each row (`txUrl`, `fromUrl`, `toUrl`) so the browser never builds URLs.
- Every hash and address on every tab is a link (opens a new tab). Ledger tab gets a `network` column.
- Because the xrpl.org explorer is a single-page app, a link that opens is not proof the tx exists; the row's own `validated · tesSUCCESS` is the proof, the link is for humans.

## 6. Points 6, 8 — Reconcile and Lending become complete

### 6.1 Reconcile: every ChainAim charge, not only x402
| Charge | Reported (what our side says) | Measured (ledger) | Join |
|---|---|---|---|
| x402 call (scan / mask / chat), Testnet RLUSD | paywall `payment_settled` | Payment to payTo, SourceTag 804681468, invoice memo↔InvoiceID | tx hash + invoice (exists, Phase 2) |
| Lending service fee (underwrite / verify / monitoring / risk-view), Devnet TUSD | fee record written by `lending.ts fee` (`verifyFee` ledger file + `devnet-run.json fees`) | Payment to ChainAim wallet with memo `chainaim:<svc>:<id>` | tx hash + memo request id |
| Underwriting attestation | pack `sha256(pack)` + verdict | `LoanSet.Data` | request id |
| Loan repayment / impair / default | `devnet-run.json txs` | LoanPay / LoanManage results | tx hash |
States stay `matched / pending / only_in_log / only_on_ledger / mismatch`, per network. **[ASSUME]** the exact path of the fee ledger file `verifyFee` writes — read `lending.ts fee` before building.

### 6.2 Lending tab: real data
- Read-only from Devnet: vault (assets, available, shares), broker (cover vs minimum), each loan (principal outstanding, next due, ACTUS status PF/DL/DQ/DF/MA). The ACTUS mapping already exists in `cockpit.ts actus()`; **reuse it, don't copy it** (§8 decision D-3).
- Lifecycle trail per loan: fee → LoanSet (attestation ✓/✗) → payments → impair/default, each with explorer links.
- Banner if Devnet reset was detected or `devnet-run.json` points at objects that no longer exist.

## 7. Point 9 — the functional view: **Engagements** (new first tab)

### 7.1 What it answers
"Who asked ChainAim for which service, for whom, which request, what was decided, where it was paid, and what happened on-chain because of it." Example rows (illustrative: names from the Desk's demo parties, prices are the Desk defaults `--price-underwrite 25`, `--price-verify 5`; not read from a run):

> **Harbor Credit** (broker/lender) · **Underwriting** for **Orion Ceramics** · request `uw-9b8485ee7e` · verdict **APPROVE** (policy …) · fee **25 TUSD** paid by Orion (tx ↗) · verify **5 TUSD** paid by Harbor (tx ↗) · **LoanSet** loanA (Data = sha256(pack) ✓, tx ↗) · instalment 1 paid (tx ↗) · status **PF**

and for the privacy services:

> **t02 – <tenant name>** (agent) · **Private chat** · invoice `9F3A…` · 0.01 RLUSD (tx ↗) · settled 4.1 s · answer released

### 7.2 Data model
`Engagement { id (requestId | invoiceId), network, service, requester{address,name,role}, subject{name,role}?, steps[{at, kind, label, txHash?, txUrl?, amount?, state}], verdict?, attestation?{packHash, onLedger:boolean}, charges[{payer, amount, asset, txHash}], status }`

### 7.3 Where each field comes from (all exists today)
| Field | Source |
|---|---|
| service + request id | fee memo `chainaim:<svc>:<id>` (Devnet); x402 route + invoice (Testnet) |
| payer / requester address | fee or x402 Payment `Account` |
| names and roles | **party registry** (§7.4) |
| subject (borrower) | `devnet-run.json loans[].borrower` / pack identity |
| verdict, policy, pack hash | pack file `data/lending/packs/<rid>.pack.json` (+ `LoanSet.Data` on-chain) |
| loan lifecycle | `devnet-run.json` + ledger-watch Devnet rows |
| privacy-service steps | rig traces 1,2,3,5 + claim (Phase 2) |

### 7.4 Gaps found in the code (need a decision)
1. **"Requested by" is not recorded.** The code records *who paid* (`--payer borrower|broker|driller|depositor`) and the request id, not who *asked*. In the Desk, Orion's CFO runs underwriting and either Orion or Harbor pays. Proposal: treat the **first payer of `underwrite` for a request id as the requester**, labelled "requested (by payment)"; if the owner wants an explicit request event, add an optional `--requester <role>` to `underwrite.ts` that writes it into the pack — a lending change (D-4).
2. **Names are hard-coded** in `cockpit.ts PARTIES` and the tenant folders. Proposal: a party registry file `data/parties.json` (gitignored, `parties.example.json` committed): `[{network, address, name, role, kind}]`, path set by `--parties <file>`. Not in `config/` (leave-alone list). Unknown addresses show as the short address.
3. **Packs are not on this PC** (`data/lending/packs/` missing). Without them the verdict comes only from `LoanSet.Data` (verdict + request id, ≤256 B). Engagement rows mark verdict source "ledger" vs "pack".
4. Privacy-service engagements carry **no business context** by design (no text, no decision ids leave the gateway). The view shows service, payer, money and timing only. This is the existing privacy boundary; not changed.

### 7.5 Tabs after this change
**Engagements** (functional, default) · **Live Ops** (technical: feeds, flow, buyers) · **Reconcile** (all charges) · **Ledger** (all rows, both networks, links) · **Lending** (vault, broker, loans, lifecycle) · **Feeds** (adapters per network, health, QuickNode shown unavailable on Devnet).

---

## 8. Files to create / change (for approval — nothing changed yet)

### ledger-watch (`services/ledger-watch/`)
| File | Change |
|---|---|
| `src/config.ts` | `--feeds <network>=<adapter,…>`, per-adapter URL env names, `--road-wss on|off` (default off), `--explorer`, `--explorer-tx-path`, `--explorer-account-path`, `--parties`, `--lending-state`, `--lending-packs`, `--rehearsal` |
| `src/feeds/adapter.ts` (new) | `FeedAdapter` interface + registry + `available(network)` |
| `src/feeds/qn-stream.ts` (new) | `POST /feeds/qn-stream`: HMAC (`X-QN-*`), gzip, fast 200, parse array of ledger objects, extract watched txs, `insertIfNew(via:'stream')`, `stream_paused` detection |
| `src/feeds/qn-webhook.ts` (new) | `POST /feeds/qn-webhook`: same verification; payload parser from first real delivery |
| `quicknode/stream-filter.js` (new) | The JS filter pasted into QuickNode (watched addresses passed as filter variables) + README how to deploy it (manual step) |
| `src/subscribe.ts`, `src/poll.ts` | Wrapped as adapters `xrpl-wss` / `qn-wss` and `jsonrpc-poll`; behaviour unchanged |
| `src/decode.ts` | Decode `chainaim:<svc>:<id>` memos (service, id) and lending types (LoanSet incl. `Data`, LoanPay, LoanManage, Vault*, LoanBroker*) — fields only, no logic change for x402 |
| `src/engagements.ts` (new) | Pure join → `Engagement[]` (§7) |
| `src/lending-state.ts` (new) | Read-only reader of `devnet-run.json` + packs; Devnet reset detection |
| `src/parties.ts` (new) | Party registry loader |
| `src/reconcile.ts` | Add lending fee + attestation + lifecycle sources (§6.1) |
| `src/links.ts` (new) | Explorer URL builder from flags |
| `src/server.ts` | `/api/engagements`, `/api/feeds`, `/api/lending`; rows carry `txUrl/fromUrl/toUrl`; SSE events `engagement`, `feed` |
| `src/store.ts` | Schema 3: `roads.via` accepts `stream`; `engagement_steps` table (or computed view — decided while building, tested either way) |
| `test/*` | Stream payload fixture (from the documented shape), HMAC test vector, adapter availability (qn-* refused on devnet), memo decode, engagements join, lending reader, links, reset detection |

### Console (`apps/admin-console/`, new — xrplh-21 §1.2) with these differences
Tabs per §7.5; no simulation code; deck read-only (§3.1); every hash/address a link; Feeds tab; rehearsal bar.

### Lending (owner OK needed — currently "leave alone")
| File | Change | Why |
|---|---|---|
| `services/lending/src/status.ts` (new) | Move `actus()` + loan/vault status out of `scripts/cockpit.ts` | One copy shared by the Desk and ledger-watch (D-3) |
| `services/lending/scripts/underwrite.ts` | Optional `--requester <role>` written into the pack | Only if D-4 = explicit requester |

### Unchanged
gateway, presidio, route-engine, `config/`, `services/web/src/balance.ts`, paywall (beyond xrplh-21).

---

## 9. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Testnet roads: Streams (primary) + Webhook + poll, **WSS off by default** | Yes |
| D-2 | Devnet default feed: public Ripple node + Honeycluster failover now; own xrpld/Clio before customers | Yes |
| D-3 | Allow a small lending refactor (`status.ts`) so ACTUS status is not duplicated | Yes |
| D-4 | "Requested by" = first `underwrite` payer (no lending change) **or** explicit `--requester` in the pack | Start with first payer; add explicit field later |
| D-5 | Party names in `data/parties.json` (gitignored) | Yes |
| D-6 | Stay on `s.devnet` for lending, or move to **Lending-Devnet** `lend.devnet` | Stay (that is where the 2026-10-26 run lives) |
| D-7 | Where are the packs? (`data/lending/packs/` missing here) | Owner to say: other PC, or regenerate |

## 10. AI vs manual

| Work | Who |
|---|---|
| All code and tests in §8 | AI can do this |
| Create QuickNode Stream (Testnet, dataset Ledger, webhook destination, paste filter) and Webhook (`xrplWalletFilter`); copy security tokens into the private env file; run cloudflared tunnel | **Manual — you**, one step at a time when we reach it |
| Check the XRPL per-ledger credit multiplier in the QuickNode dashboard | **Manual — you** |
| Locate or regenerate the underwriting packs | **Manual — you** (D-7) |

---

Sources (read 2026-10-28): quicknode.com/docs/streams/supported-chains · /docs/streams/data-sources/xrpl · /docs/streams · /docs/streams/faq · /docs/streams/destinations · /docs/streams/destinations/webhooks · /docs/streams/filters · /docs/streams/billing · /docs/webhooks · /docs/webhooks/rest-api/getting-started · /docs/xrpl/api-overview · /docs/xrpl/endpoints · /guides/quicknode-products/streams/websocket-vs-streams · /guides/quicknode-products/streams/validating-incoming-streams-webhook-messages · /pricing · xrpl.org/docs/tutorials/public-servers · xrpl.org/resources/dev-tools/xrp-faucets · github.com/ripple/explorer (routes.ts) · docs.bithomp.com · docs.xrpscan.com.

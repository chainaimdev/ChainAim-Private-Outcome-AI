# xrplh-21 — Build plan: files to create/modify, and how the Live Ops UI becomes a working system

Breadcrumb: xrplh-19 (backend design) · xrplh-20 (UI design) · `creditseal-live-ops-demo.html` (approved look) · **xrplh-21** (this: build plan).
Status: **PLAN ONLY — awaiting approval. No code written or changed.** 2026-10-27 (IST).
Tags: **[READ]** checked in code today · **[WEB]** QuickNode docs read 2026-10-27 · **[ASSUME]** not verified — check named.

> Recovered 2026-10-27 ~22:40 IST from the transcript of chat "CreditSeal admin UI design plan-nisha"
> (https://claude.ai/chat/b611fd31-a3d5-409a-90c6-a1156c0edccc), turn 9, where it was written but never saved to the PC.
> Content is the original Write call verbatim; only HTML entities from the transcript were decoded back to < > &.

---

## 0. Facts this plan rests on (checked today)

| Fact | Source |
|---|---|
| Every x402 Payment carries the paywall's **invoice id twice: `InvoiceID` field and a memo**. The paying scripts (`pay.ts`, `rig.ts`) use the same builder as the browser. | [READ] `services/web/src/xrpl-payment.ts preparePayment()`; `services/paywall/scripts/xrpl.ts` imports it (line 26) |
| x402 Payments carry `SourceTag 804681468` | [READ] `services/paywall/src/config.ts DEFAULT_SOURCE_TAG` |
| The paywall logs one `payment_settled` JSON line to stdout per settlement (route, amount, asset, network, payer, transaction) — **no invoice id in it today** | [READ] `services/paywall/src/app.ts onAfterSettle` |
| The rig runs tenants **in parallel**, each tenant's calls **in sequence**; flags `--calls 1..1000`, `--interval-ms`, `--max-spend`, `--only`, `--endpoint`. No duration/forever mode. | [READ] `services/paywall/scripts/rig.ts`, `rig-core.ts runTenant()` |
| Tenants are folders `rig/tenants/tNN/tenant.json` `{id, name, seedPrefix}`; only t01–t03 exist | [READ] |
| QuickNode XRPL: Mainnet + Testnet (no Devnet); WSS, JSON-RPC, Streams, Webhooks; webhook template `xrplWalletFilter`; signature headers `X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature` = hex HMAC-SHA256(token, nonce+timestamp+payload) | [WEB] |
| PrivaSpend's relay: subscribe → backfill → push; one `seen` set; `via` per row; SSE fan-out; webhook-only public route; agent posts its own steps to `POST /trace` (fire-and-forget) | [READ] `dispatch/live/relay.mjs`, `live/trace.mjs`, `live/demo-loop.mjs` |
| PrivaSpend's webhook HMAC is **not** the documented scheme (signs body only, guesses header names) — do not copy | [READ] + [WEB] |

---

## 1. Files

### 1.1 Create — `services/ledger-watch/` (new backend service; PrivaSpend `relay.mjs` is the pattern)

| File | Purpose | PrivaSpend reference |
|---|---|---|
| `package.json`, `tsconfig.json`, `Dockerfile`, `railway.json`, `README.md` | Service shell, same shape as `services/paywall`. Deps: `xrpl@4.7.0`, `ripple-address-codec`. Storage `node:sqlite` (built in). | — |
| `src/main.ts` | Parse flags, start providers, server, timers; graceful shutdown | `relay.mjs` bottom (`server.listen` → `connect()` → intervals) |
| `src/config.ts` | All flags + env-var **names** (§4). Validates addresses. | `relay.mjs` config block |
| `src/providers.ts` | Per network: QuickNode URL from env, optional public fallback; `server_info` network-id check; exposes **provider name only**; errors reduced to short codes | `relay.mjs sourceName()`, `pane/pane.mjs getRpc()` chain-id check |
| `src/subscribe.ts` | `subscribe {streams:["ledger"], accounts:[watched]}` **first**, then `account_tx` backfill (marker paging), then live; reconnect with backoff; stale guard (no `ledgerClosed` for N s → `polling`) | `relay.mjs connect()`, `scheduleReconnect()`, `reconcile()` |
| `src/decode.ts` | Pure `(tx, meta) → Row`: validated + `tesSUCCESS`; amount from `delivered_amount`; asset; fee; `InvoiceID`; memo; SourceTag; kind (`x402`, `fee`, `payment`, `trustset`, lending types) | `relay.mjs onVoucherLog()` (shape only) |
| `src/store.ts` | SQLite: `wallets`, `transactions` (PK network+hash), `roads` (hash, via, arrivedAt, lagMs), `claims`, `traces`, `ledgers` (index, closeTime, txCount, ourCount, ourAmount), `balances`, `webhook_nonces`. `insertIfNew()` = the one de-dup gate. JSONL tape per network. | `relay.mjs seen` set + `tape.jsonl` |
| `src/roads.ts` | Records every arrival (push / webhook / poll / backfill) with lag = arrival − ledger-close receipt time; first road wins, later ones only add a road row | `relay.mjs` "three roads, one set" |
| `src/webhook.ts` | `POST /webhook/quicknode`: 4 MB cap, gunzip, **documented HMAC**, timestamp skew, nonce replay store, optional source-IP allow-list, 200 on unparseable + bounded preview log, normalize → fetch `tx` if meta missing → decode → `insertIfNew(via:'webhook')` | `relay.mjs readWebhook()`, `normalizeStreamLog()` (with HMAC fixed) |
| `src/watchlist.ts` | Wallets from `--watch`, `--watch-tenants rig/tenants` (derives addresses from seeds in memory, keeps addresses only), `--watch-from-paywall`, `--watch-from-lending-env`, and `POST /api/watch`; re-subscribe on change; optional QuickNode webhook wallet-list sync | `pane/pane.mjs WATCH_AGENT/WATCH_MERCHANT` |
| `src/balances.ts` | `account_info` + `account_lines peer=issuer` per wallet: on start, after any tx touching it, every `--balances-sec` | `relay.mjs balances()`; CreditSeal `web/src/balance.ts` logic |
| `src/claims.ts` | Reported book: `POST /internal/claims` (bearer key) + optional `--paywall-log-file` tail; accepts only `payment_settled` lines | — |
| `src/traces.ts` | `POST /trace`: `{flow, step 1–5, mark, invoiceId, buyer?, route?, at}`; 4 KB cap; 422 on bad shape; **no text, no decision id** | `relay.mjs readTrace()` |
| `src/reconcile.ts` | Pure join: claim ↔ tx by hash, trace ↔ tx by `InvoiceID`; states `matched / pending / only_in_log / only_on_ledger / mismatch` with grace in ledgers | `pane/pane.mjs` "saved run: yes/no" amber rows |
| `src/metrics.ts` | Calls/min, RLUSD/min, per-ledger totals, settle p50/p95 (trace step 1 → ledger close), road win counts + avg lag, refused count | demo KPIs |
| `src/alerts.ts` | Gaps, buyer low/dry, missing trust line, feed on polling, webhook silent, loan overdue | demo "Needs attention" |
| `src/server.ts` | `node:http`. REST + `GET /api/stream` (SSE). Loopback-only except `/webhook/*` (forwarding-header rule); bearer `ADMIN_API_KEY` on `/api/*` | `relay.mjs` server + `throughProxy()` |
| `test/*.test.ts` | decode (fixtures = real STATE.md tx hashes fetched once and saved), de-dup across roads, subscribe-before-backfill order, HMAC with QuickNode's documented example, gzip, nonce replay, forwarded-header 403, reconcile states, metrics percentiles | — |

### 1.2 Create — `apps/admin-console/` (Next.js; look = approved demo; stack = admin reference)

| File | Purpose |
|---|---|
| `package.json`, `next.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `components.json` | From the reference; drop `@vercel/analytics` |
| `app/globals.css` | Reference tokens + demo's `ink` / `cream` themes and classes (chips, deck, kpis, flow, roads, bcard, tape) |
| `app/layout.tsx`, `app/page.tsx` | Shell, tabs: Live Ops · Reconcile · Ledger · Lending |
| `app/api/live/route.ts` | SSE proxy → ledger-watch `/api/stream`, adds `ADMIN_API_KEY` server-side |
| `app/api/[...path]/route.ts` | REST proxy (allow-listed paths) |
| `app/api/rig/route.ts` | **Optional** (flag `RIG_CONTROL=on`, local only): start/stop the buyer loop by calling a local rig-control process — see §3.4 |
| `middleware.ts` | Loopback-only mode, or session check if hosted |
| `lib/types.ts`, `lib/api.ts`, `lib/format.ts` | Event/row types shared with ledger-watch; money as decimal strings |
| `hooks/use-live.ts` | EventSource + reducer (`hello` replaces state; de-dup by hash; roads append) |
| `components/flow-canvas.tsx` | The animated flow map from the demo, driven by real `trace`/`ledger`/`tx`/`road` events |
| `components/control-deck.tsx`, `kpi-row.tsx`, `feed-race.tsx`, `throughput-chart.tsx`, `attention.tsx`, `buyer-card.tsx`, `ledger-tape.tsx`, `change-log.tsx`, `feed-chips.tsx` | One per demo widget |
| `components/tabs/live-ops.tsx`, `reconcile.tsx`, `ledger.tsx`, `lending.tsx` | Tabs |
| `test/*.test.tsx` | Reducer (reconnect, duplicate roads, polling downgrade), chip rules, money formatting, proxy never forwards upstream URLs |

### 1.3 Modify — existing CreditSeal files (all flag-gated; default = today's behaviour)

| File | Change | Why |
|---|---|---|
| `services/paywall/src/config.ts` | Add `PAYMENT_LOG_URL`, `PAYMENT_LOG_KEY`, `PAYMENT_LOG_FILE` (all optional) | Where the reported book goes |
| `services/paywall/src/app.ts` | In `onAfterSettle`: add `invoiceId` to the existing line; also send it to the file and/or URL **fire-and-forget** (1.5 s timeout, never awaited by the response) | Reported book; invoice joins claim ↔ trace ↔ ledger |
| `services/paywall/test/paywall.test.ts` (+ new `payment-sink.test.ts`) | Line unchanged except `invoiceId`; sink failure never affects the response | — |
| `services/paywall/scripts/rig.ts` | New flags: `--duration-sec`, `--forever`, `--rate-per-min`, `--jitter 0.4`, `--trace-url`, `--trace-key-env` | Continuous multi-buyer loop |
| `services/paywall/scripts/rig-core.ts` | `runTenant` loop condition (calls **or** until duration/stop signal); rate-based spacing with jitter; emit traces 1 (request), 2 (402 + invoice), 3 (signed) and 5 (answer) via fire-and-forget `trace()`; existing `--max-spend` budget still stops a tenant | Buyer steps for the cards and flow map |
| `services/paywall/scripts/trace.ts` (**new, small**) | `trace(step, mark, {invoiceId, tenant, route})` — POST, 1.5 s timeout, never awaited | = PrivaSpend `live/trace.mjs` |
| `services/paywall/test/rig.test.ts` | Duration/forever stop, rate spacing, traces emitted, budget still enforced | — |
| `rig/tenants/t04..t12/tenant.json` (**new folders**) | Only if you choose more than 3 real buyers (§3.4) | — |
| `.env.example` | Names only: `QUICKNODE_XRPL_WSS_TESTNET`, `QUICKNODE_XRPL_HTTP_TESTNET`, `QUICKNODE_WEBHOOK_TOKEN`, `QUICKNODE_API_KEY`, `ADMIN_API_KEY`, `LEDGER_WATCH_INGEST_KEY`, `PAYMENT_LOG_URL`, `PAYMENT_LOG_KEY`, `RIG_TRACE_URL`; **blank the `CHAINAIM_GATEWAY_KEY` value** | Secrets never in git |
| `package.json` (root) | Scripts: `ledger-watch`, `test:ledger-watch`, `admin` | — |
| `test-console/stack.ps1` | Optional: start ledger-watch with the stack | One-command local run |
| `PROJECT_CONTEXT.md`, `STATE.md`, `BUILD_LOG.md`, `MANUAL_SETUP.md` | Components table, run log, owner steps | Repo convention |

### 1.4 Leave alone
`services/gateway`, `services/presidio`, `packages/route-engine`, `config/` (ARCH-002) · `services/web/src/balance.ts` (browser — a QuickNode URL there would publish the token) · `services/lending/*` (Devnet is not on QuickNode; ledger-watch reads its state file read-only).

---

## 2. How the system works end to end

```
 rig.ts (N tenants, loop) ──trace 1,2,3,5 (reported, invoiceId)──────────────┐
        │ x402 HTTP                                                          │
        ▼                                                                    ▼
 paywall (Hono + @x402/xrpl) ──verify/settle──▶ t54 ──submit──▶ XRPL Testnet   ledger-watch ──SSE /api/stream──▶ admin-console ──▶ browser
        └──payment_settled + invoiceId (reported claim) ─────────────────────────▶   ▲   ▲   ▲
                                         QuickNode WSS: ledger + accounts (push) ────┘   │   │
                                         QuickNode webhook xrplWalletFilter (HMAC) ──────┘   │
                                         QuickNode HTTPS account_tx every 10 s (poll) ───────┘
```

### 2.1 One payment, step by step (what lights up in the UI)
| # | Happens | Who reports it | UI |
|---|---|---|---|
| 1 | Tenant t02 POSTs `/v1/privacy/scan` | rig → `POST /trace {step:1, tenant:t02, route}` | t02 card dot 1; grey dot buyer → paywall |
| 2 | Paywall answers 402 with price + invoice `9F3A…` | rig → trace step 2 with `invoiceId` | dot 2 |
| 3 | t02 signs a Payment (InvoiceID = `9F3A…`, SourceTag 804681468) and resends | rig → trace step 3 | dot 3; blue dot paywall → t54 → XRPL; "in flight" +1 |
| 4 | t54 settles; the ledger closes; tx validated | **measured**: QuickNode `ledgerClosed` + account tx (push), webhook (later), poll (safety net) | ledger node pulses "+N tx"; gold dot → payTo; road dots race to ledger-watch; tape row with `via`; feed-race counters |
| 4b | Paywall `onAfterSettle` | paywall → `POST /internal/claims` (with invoiceId + tx hash) | Reconcile row turns `matched` |
| 5 | Answer returned to t02 | rig → trace step 5 | dot 5; card "settled", last settle time |

Joins: **claim ↔ tx by tx hash**, **trace ↔ tx by `InvoiceID`** (the ledger field), so a card's steps 1–3 and 5 (reported) and step 4 (measured) belong to the same payment without trusting either side alone.
**[ASSUME]** the exact encoding of `InvoiceID` on the ledger vs the invoice string (the builder may hash or pad it) — read the rest of `preparePayment()` before writing `decode.ts`.

### 2.2 QuickNode
- **WSS (push):** one connection per network. Subscribe `streams:["ledger"]` (gives ledger index, close time, tx count → ledger pulse, throughput per ledger, road lag reference) and `accounts:[all watched]` (validated txs touching them).
- **HTTPS (reads):** backfill `account_tx` on start and after reconnect; the 10 s reconcile `account_tx` since the last checkpoint (= the **poll** road); balances (`account_info`, `account_lines`).
- **Order:** subscribe → backfill → live (PrivaSpend rule; reversed, a payment can fall in the gap).
- **Honesty:** chip is green only when transport is `wss` and a ledger close arrived within `--stale-sec`; otherwise amber "polling fallback". The browser gets the provider **name** only.

### 2.3 Streaming to the UI (SSE contract, matches the demo)
| Event | Payload | Drives |
|---|---|---|
| `hello` | status per network, watched wallets + balances, last 300 rows (+roads), open traces, KPIs, alerts | full state (also after reconnect / pause) |
| `ledger` | `{network, index, closeTime, txCount, ourCount, ourAmount}` | ledger pulse, throughput bars, "ledger close" |
| `tx` | decoded row + first `via` + `lagMs` | tape, gold dot, buyer card step 4, KPIs |
| `road` | `{hash, via, lagMs}` (a later road for a known tx) | road dot, "duplicate dropped", feed race |
| `trace` | `{tenant, invoiceId, step, mark, route}` | buyer card dots, grey/blue dots |
| `claim` / `reconcile` | claim; state change for a hash | Reconcile tab, "books agree" |
| `balances` | per wallet | cards, payTo figure |
| `alert` | add/clear | Needs attention |
| `status` / `webhook` | transport, last push, last webhook (verified, new count) | chips |
Keepalive every 15 s; the console proxy re-emits unchanged.

### 2.4 Webhooks
- QuickNode **Webhook** with template `xrplWalletFilter`, `wallets = [payTo, t01…tNN]` (paid plan). Destination = public URL of `ledger-watch /webhook/quicknode` (cloudflared tunnel locally, or the Railway public domain).
- Verify exactly as documented; reject stale timestamps and reused nonces; answer 200 to unparseable bodies and log a 400-char preview (the first delivery tells us the real XRPL payload shape — **[ASSUME]** not documented on the pages read).
- Every other route returns 403 to forwarded requests (PrivaSpend rule), so the tunnel exposes the webhook only.
- Optional `--qn-webhook-sync on`: when a wallet is added in the console, update the webhook's wallet list through the QuickNode REST API (**[ASSUME]** exact update call — read the REST reference first; until then the list is kept by hand).

### 2.5 Wallet tracking
Sources: tenant folders (addresses derived from the seeds in memory, seeds dropped), paywall payTo, manual `--watch`, console "+ Watch wallet". For each wallet: XRP, RLUSD (or TUSD on Devnet), trust line, last tx, calls left = balance ÷ cheapest price, spent today, status (paying / settled / low / dry). Adding a wallet re-subscribes the WSS accounts list and (optionally) syncs the webhook.

### 2.6 Demo widget → real data
| Demo widget | Real source | Measured / reported |
|---|---|---|
| Feed chips | `status`, `webhook` | measured (feed health) |
| Control deck: buyers, rate, price | rig flags (§3.4); price = paywall `PRICE_*` (read-only in UI) | — |
| Toggles socket / webhook | **ops switches** in ledger-watch (`POST /api/feeds`) to rehearse failover; in production they show state, not control | — |
| "+ unclaimed / + lost claim" | **removed** in production; kept behind `--rehearsal on` for demos, writing clearly marked synthetic rows | synthetic, labelled |
| KPIs | `metrics.ts` | measured, except settle start time (reported by the rig) |
| Flow map | `trace` + `ledger` + `tx` + `road` | both, colour-coded |
| Feed race | `roads` table | measured |
| Throughput | `ledgers` table | measured |
| Buyer cards | `trace` + `balances` + tx rows | both |
| Tape / Ledger tab | `transactions` + `roads` | measured |
| Reconcile | `reconcile.ts` | both, labelled per column |

---

## 3. Running multiple buyers on a loop (real)

### 3.1 Command (after the rig change)
```
node scripts/rig.ts --url http://127.0.0.1:8080 --forever --rate-per-min 8 --jitter 0.4 \
     --endpoint scan --max-spend 0.5 --trace-url http://127.0.0.1:8790/trace
```
Each tenant loops until stopped (Ctrl-C) or its `--max-spend` budget is reached, which is the hard money guard that already exists.

### 3.2 Cost — real RLUSD
N buyers × rate × price. 3 buyers × 8/min × 0.01 = **0.24 RLUSD/min**; 12 × 8 × 0.01 = **0.96 RLUSD/min**. Each tenant stops at its `--max-spend`.

### 3.3 Ledger limits
One tenant's calls stay sequential (one account sequence at a time), as `rig-core.ts` already does; parallelism comes from more tenants, not more calls per tenant. XRPL closes every ~3–5 s, so a single tenant settles at most ~12–15 calls/min.

### 3.4 Buyer count
- Real buyers today: **t01–t03**. More real buyers need new funded Testnet wallets (faucet + trust line + RLUSD), i.e. new `rig/tenants/tNN` folders — owner work.
- The console's "Buyers" slider only shows how many tenants are configured; starting/stopping the loop from the UI is **optional** (`RIG_CONTROL=on`, local only, never hosted — it would let a web page spend money).

---

## 4. ledger-watch flags (defaults)
```
--network testnet[,devnet]  --quicknode-wss-env QUICKNODE_XRPL_WSS_TESTNET  --quicknode-http-env QUICKNODE_XRPL_HTTP_TESTNET
--devnet-wss-env XRPL_WS_URL_DEVNET  --fallback-public off
--watch label=role=rADDR (repeat)  --watch-tenants rig/tenants  --watch-from-paywall <url>  --watch-from-lending-env <file>
--rlusd-issuer rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV  --x402-source-tag 804681468
--backfill-ledgers 20000  --stale-sec 45  --poll-sec 10  --balances-sec 15  --settle-grace-ledgers 10  --low-calls 6
--ingest-key-env LEDGER_WATCH_INGEST_KEY  --paywall-log-file <path>
--webhook-path /webhook/quicknode  --webhook-secret-env QUICKNODE_WEBHOOK_TOKEN  --webhook-max-skew-sec 300  --webhook-allow-ip (optional)
--qn-webhook-sync off  --qn-webhook-id <id>  --qn-api-key-env QUICKNODE_API_KEY
--store data/ledger-watch/watch.sqlite  --port 8790  --bind 127.0.0.1  --public-api off  --admin-key-env ADMIN_API_KEY  --rehearsal off
```

---

## 5. Build order (after approval)

| # | Phase | AI can do this | Manual — you do this | Done when |
|---|---|---|---|---|
| 1 | ledger-watch core (config, providers, subscribe, decode, store, roads, balances, SSE, tests) | ✓ | — | tests green on recorded fixtures |
| 2 | Claims + traces + reconcile + metrics + alerts; paywall sink; rig loop + traces | ✓ | — | paywall + rig tests green |
| 3 | admin-console wired to ledger-watch (demo look) | ✓ | — | console runs against a recorded SSE fixture (labelled) |
| 4 | First live run | — | QuickNode Testnet endpoint → env file; `npm install`/`npm test` on your PC; start stack + ledger-watch + console; `rig.ts --forever` for 2 min | chips green, rows `via push`, Reconcile 100 % matched |
| 5 | Webhook | ✓ receiver | Create `xrplWalletFilter` webhook, tunnel, paste token | chip "HMAC ✓", rows gain a webhook road |
| 6 | Failover rehearsal | ✓ ops switch | Turn socket off in the console during a run | chip amber, webhook/poll carry rows, no gaps |
| 7 | Lending tab (Devnet, read-only) | ✓ | Start with `--watch-from-lending-env` | loans + fees appear |

Manual steps will be given one at a time when we reach phase 4.

---

## 6. Decisions needed with approval
1. Local only, or hosted (then the console needs login, and `RIG_CONTROL` stays off)?
2. `apps/admin-console` inside CreditSeal — OK?
3. Default theme: **ink**, with cream as a toggle?
4. Buyers: stay with t01–t03, or should I add the folders for more tenants (you fund the wallets)?
5. Rig control from the UI (`RIG_CONTROL=on`, local only): yes or no?
6. Paid QuickNode plan for webhooks: available?
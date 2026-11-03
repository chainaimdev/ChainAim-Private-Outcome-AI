# xrplh-19 — CreditSeal: QuickNode, real-time streaming, webhooks and an admin UI

Breadcrumb: xrplh-14 (Why-Not control room idea) · **xrplh-19** (this, the build design).
Status: **DESIGN ONLY — no code written or changed.** Written 2026-10-27 (IST).
Tags: **[READ]** I read it in the code or docs named · **[WEB]** read on QuickNode's site today · **[ASSUME]** not verified — check named.

> Recovered 2026-10-27 22:10 IST from the transcript of chat "CreditSeal admin UI design plan-nisha"
> (https://claude.ai/chat/b611fd31-a3d5-409a-90c6-a1156c0edccc), where it was written but never saved to the PC.
> Content is the original Write call verbatim; only HTML entities from the transcript (< > &) were decoded.

---

## 0. Bottom line

1. Build **one new service, `services/ledger-watch`**, that holds the QuickNode XRPL connection, subscribes to the wallets we care
   about, receives QuickNode webhook deliveries, stores every transaction once, reconciles it against what the paywall and the
   lending scripts *say* happened, and serves an API + live event feed.
2. Build **one new Next.js app, `apps/admin-console`**, cloned from the look and stack of `chain-aim-router-admin-console`, but fed
   by `ledger-watch` instead of the hard-coded arrays it has today.
3. Make **two small changes to existing code**: the paywall writes its `payment_settled` line somewhere the watcher can read it, and
   the paying scripts get the QuickNode URL through the variable they already read. Nothing in the privacy pipeline changes.
4. Copy PrivaSpend's **ideas** (push first then backfill, three roads into one de-dup set, endpoint never reaches the browser,
   "measured vs reported" labels, webhook-only public route). Do **not** copy its code line for line: it is EVM (ethers, logs,
   topics), CreditSeal is native XRPL (xrpl.js, `subscribe`, `account_tx`), and its webhook signature check is wrong (section 1.4).

---

## 1. What PrivaSpend-Ai actually does (reference 1)

### 1.1 "Mastercard" = the AP4M hackathon service, not a Mastercard API
- **[READ]** No file calls a Mastercard API. The word appears only in docs and in the SDK header
  (`dispatch/ap4m-hackathon-sdk.cjs`: "provided exclusively for the Mastercard XRPL Hackathon").
- The payment rail is **AP4M (Agent Pay for Machines)** at `https://hackathon.ap4m.build`, used through `@ap4m/sdk`:
  - `dispatch/ap4m-x402.mjs` — `loadX402Context()` reads `/public/x402-context`; `buyResource()` answers a merchant's HTTP 402 with
    an **EIP-712 voucher** signed on an open payment channel; `createX402Merchant()` redeems the voucher on-chain and keeps a
    `node:sqlite` store so a retried payment is never redeemed twice.
  - `dispatch/channels.mjs` — signs in to AP4M, lists channels, reads `PaymentLedger` / `PooledEscrowVault` state.
- **Settlement asset:** RLUSD as an ERC-20 on the **XRPL EVM sidechain testnet, chain id 1449000**.

### 1.2 How the XRPL EVM sidechain is used
- **[READ]** Contracts (in `live/relay.mjs` defaults): PaymentLedger `0xcAB4…aE91`, RLUSD token `0x27b5…16f3`, escrow vault `0x83DD…ABC0`.
- In the hot path **no RLUSD moves**: a voucher only advances a "redeemed" watermark (`VoucherRedeemed` event). RLUSD leaves the
  vault at settlement (an ERC-20 `Transfer`). The pane keeps these two tracks separate.
- This is **not the same ledger as CreditSeal**. CreditSeal pays on the native XRP Ledger (Testnet `xrpl:1`, and Devnet for lending).
  Nothing from PrivaSpend's contracts or ABIs carries over.

### 1.3 How QuickNode is used (three roads into one set)
**[READ]** `dispatch/live/relay.mjs`, `live/QUICKNODE.md`, `live/README.md`:

| Road | Code | What it does |
|---|---|---|
| RPC | `channels.mjs`, `open-channel.mjs`, `merchants.mjs`, `audit-manifest.mjs`, `pane/pane.mjs` | Prefer `QUICKNODE_EVM_RPC_URL`, fall back to the public node. `pane.mjs` checks `eth_chainId == 1449000` before trusting it. |
| WebSocket push | `relay.mjs connect()` | `ethers.WebSocketProvider(QUICKNODE_EVM_WSS_URL)`; subscribe `newHeads`, `VoucherRedeemed` logs, RLUSD `Transfer` logs. |
| Stream → webhook | `relay.mjs readWebhook()` | QuickNode Stream (Logs dataset, server-side JS filter) posts to `POST /webhook`. |
| Reconcile poll | `relay.mjs reconcile()` | Every 10 s, re-reads the last 50 blocks; if no push for 45 s, marks the feed "polling" and reconnects. |

Design rules worth keeping:
1. **Order:** subscribe → only then backfill → then sit on the push. Reversed, a payment can land in the gap and never be seen.
2. **One `seen` set** keyed by `txHash:logIndex`; every row records `via: push | stream | poll | backfill`.
3. **The endpoint is a credential** (QuickNode puts the token in the URL path). The browser is told only the provider's name.
4. **Honest status chip:** when the poll is producing rows, the UI says "polling fallback", never "live".
5. **Loopback by default:** any request with a forwarding header (`cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`) gets 403 on
   every route except `/webhook`. `LIVE_PUBLIC=1` lifts this on purpose.
6. **Webhook answers 200 even to unparseable bodies** (a non-200 makes QuickNode retry the same failure), and logs a bounded preview
   so the first delivery shows the real payload shape.
7. **Measured vs reported:** on-chain rows are *measured*; `POST /trace` (from `live/trace.mjs`, fire-and-forget, 4 KB cap, 422 on
   bad input) carries a process's own claims, shown as *reported*.
8. **SSE fan-out:** `GET /stream` sends `hello` (status + replay of the tape) then `head`, `status`, `voucher`, `transfer`,
   `balances`, `trace` events; `pane.html` listens with `EventSource('/stream')`.

### 1.4 What NOT to copy
- **Webhook signature check is wrong.** **[READ]** `relay.mjs` computes `HMAC-SHA256(token, rawBody)` and looks in `x-qn-signature`
  / `x-quicknode-signature` / `authorization`. **[WEB]** QuickNode's guide says the signed string is
  `nonce + timestamp + payload` using headers **`X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature`**, HMAC-SHA256 with the Stream's
  security token, hex output, computed over the **decompressed** JSON (bodies may arrive `Content-Encoding: gzip`). With
  `QUICKNODE_WEBHOOK_TOKEN` set, PrivaSpend's check would reject real deliveries. CreditSeal must implement the documented scheme.
- **Stale doc:** `dispatch/MONITORING.md` still says "webhooks not built" and "no QuickNode URL tested", which `live/QUICKNODE.md`
  later contradicts. Trust `QUICKNODE.md` + `relay.mjs`.
- **EVM-specific pieces:** log windows (`could not coalesce error` over 20,000 blocks), `topics`, `logIndex`, ABI decoding. XRPL has
  none of these; it has `subscribe accounts`, `account_tx` with markers, and `meta.delivered_amount`.

---

## 2. What CreditSeal has today (reference 2)

Read first: `PROJECT_CONTEXT.md` (authoritative), `STATE.md`, `README.md`, `DESIGN/xrplh-14-…`.

### 2.1 Two XRPL networks, two businesses
| Part | Network | Asset | Ledger code **[READ]** |
|---|---|---|---|
| Privacy gateway paywall (x402 via t54) | **Testnet** `xrpl:1` | RLUSD, issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | `services/paywall/src/app.ts` (Hono + `@x402/xrpl`), `scripts/xrpl.ts` (`wsUrl()` reads `XRPL_WS_URL_TESTNET`, default `wss://s.altnet.rippletest.net:51233/`) |
| Browser wallet (Crossmark) | Testnet | RLUSD | `services/web/src/balance.ts` — public WS servers hard-coded, one socket per read |
| CreditSeal lending (XLS-65/66) | **Devnet** (Lending amendments only there) | TUSD (self-issued) | `services/lending/src/ledger.ts` (xrpl 5.3.0 `Client`), `src/env.ts` (`XRPL_WS_URL_DEVNET`, default `wss://s.devnet.rippletest.net:51233/`), `scripts/cockpit.ts` (Desk on :8750) |

### 2.2 Money facts already produced
- **Paywall:** one stdout JSON line per settlement — `{ts, event:"payment_settled", route, amount, asset, network, payer, transaction}`
  (`app.ts` `onAfterSettle`). No file, no API: today it is only visible through `docker logs ca-paywall`.
- **Lending:** `data/lending/devnet-run.json` (`state.ts`: vault/broker/loan IDs, `txs[]` with step/hash/result), and the fee ledger
  written by `fee.ts verifyFee()` (memo `chainaim:uw:<requestId>` or `chainaim:<service>:<id>`).
- **Desk** (`cockpit.ts status()`) polls Devnet on each page refresh: `account_lines`, `account_tx limit 40` on the ChainAim wallet.
- **x402 payments carry `SourceTag 804681468`** (`config.ts DEFAULT_SOURCE_TAG`) — a clean way to tag "this came through our paywall".

### 2.3 Known wallets (public addresses, from STATE.md / xrplh-14)
Testnet: payTo `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`; buyer `rMosbGSCHTWnZmdgyhVETxSDRdPnormKxR`; B01 `racuvQQJSCD2YUxR5qLstLBfbCkxj53dcU`;
tenants t01 `rNyKVsrK82yU4v5WBxfAjq3Nk7Ls9oVF8U`, t02 `rD59tmENJNnHovdi4hKq79DVP4gnDNFGWk`, t03 `rKSZJdBpp1vDpqYWbaDFKWDecwSMmmGA1B`.
Devnet: derived from the lending seed file (issuer, broker, depositor, borrower, chainaim, driller) — the watcher derives **addresses
only** and never holds the seeds.

### 2.4 Nothing for QuickNode exists yet
**[READ]** No QuickNode code in CreditSeal. xrplh-14 already proposed the control room and the flag names; this doc turns it into a
build plan and corrects it where the code says otherwise.

### 2.5 Found while reading (fix regardless of this plan)
- **`.env.example` in the public repo has a real-looking value for `CHAINAIM_GATEWAY_KEY`.** If that value was ever used, rotate it
  and blank the line. **[ASSUME]** that it was used — check.

---

## 3. What QuickNode offers for XRPL (checked today, [WEB])

| Item | Fact |
|---|---|
| Networks | **XRPL Mainnet and Testnet only. Devnet is not listed.** |
| Products | JSON-RPC (HTTPS), WebSocket (rippled API, "for subscriptions and queries"), **Streams**, **Webhooks** |
| Plans | Streams and Webhooks are on paid plans (chain page FAQ) |
| Webhooks | XRPL Mainnet + Testnet supported; ready-made template **`xrplWalletFilter`** with `templateArgs.wallets: [...]`; REST API `https://api.quicknode.com/` with `x-api-key`; delivery IP `141.148.40.227` |
| Signing | `X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature` = hex HMAC-SHA256(token, nonce + timestamp + payload) |

Consequences:
1. **Testnet (paywall revenue, tenant buyers) → QuickNode** for WS subscribe, RPC backfill, and `xrplWalletFilter` webhooks.
2. **Devnet (lending) → public Devnet node**, through the same provider layer, labelled "public Devnet node" in the UI.
   Do not pretend Devnet is on QuickNode.
3. **[ASSUME]** The exact JSON shape of an XRPL webhook delivery is not documented on the pages I read. The receiver must log a
   bounded preview of the first delivery (as PrivaSpend does) and the normalizer is written against that real sample.

Sources: QuickNode XRPL API overview, XRPL chain page, Webhooks REST getting-started, Streams validation guide (links in the chat reply).

---

## 4. Target architecture

```
                       ┌──────────────── QuickNode XRPL Testnet ────────────────┐
                       │  WSS subscribe(accounts)   HTTPS account_tx / lines    │
                       │  Webhook xrplWalletFilter ──POST──┐                     │
                       └────────────┬──────────────────────┼─────────────────────┘
                                    │                      │ (tunnel / public URL, /webhook only)
 public Devnet node ── WSS ─────────┤                      │
                                    ▼                      ▼
                     ┌──────────────── services/ledger-watch ────────────────┐
 paywall ──payment_settled──▶ claims │ providers → subscribe → decode → store │
 (file or HTTP sink)                │ webhook receiver ─┘        │          │
 lending state + fee ledger ──▶     │ reconcile (measured vs reported)       │
 (read-only files)                  │ alerts · balances · SSE /api/stream    │
                     └──────────────────────────┬─────────────────────────────┘
                                                │ REST + SSE (loopback / private net, admin key)
                                                ▼
                     ┌──────────── apps/admin-console (Next.js) ──────────────┐
                     │ route handlers proxy to ledger-watch (key stays server)│
                     │ Overview · Wallets · Transactions · Payments · Lending │
                     └────────────────────────────────────────────────────────┘
```

Boundaries:
- **ledger-watch is the only thing that holds a QuickNode URL.** The admin UI and the browser never see it.
- **The paywall and gateway stay isolated.** The watcher only receives the payment line the paywall already writes; it never sees
  request bodies, prompts, decision IDs or restore maps (keeps PROJECT_CONTEXT constraints and xrplh-14 "zero content").
- **Lending files are read, never written** by the watcher.
- Two road types into one store: **measured** (ledger: push / webhook / backfill / poll) and **reported** (paywall log, lending state).

---

## 5. Files and modules — what to add and what to change

### 5.1 New: `services/ledger-watch/` (Node ≥22.22, TypeScript run by Node like the other services)
Dependency: `xrpl` (pin **4.7.0** to match the paywall; the lending package's 5.3.0 is only needed for lending transaction types,
which the watcher reads as plain JSON). Storage: built-in `node:sqlite` (the same thing PrivaSpend's merchant store uses) — no
extra package.

| File | Job |
|---|---|
| `package.json`, `tsconfig.json`, `Dockerfile`, `railway.json` | Same shape as `services/paywall` |
| `src/config.ts` | Parse flags + env (section 6). Validates addresses with `ripple-address-codec` like `paywall/src/config.ts`. |
| `src/providers.ts` | Per network: choose QuickNode URL from env name, else public fallback (only if `--fallback-public on`). On connect, call `server_info` and check the network id matches (testnet 1, devnet 2 **[ASSUME]** — confirm with one `server_info` call per endpoint). Exposes `providerName` only ("QuickNode", "public Testnet node", "public Devnet node"). Error text is reduced to a short code so a URL never leaks into logs or the UI. |
| `src/watchlist.ts` | Builds the wallet list: `--watch label=role=rADDR` (repeatable), `--watch-from-paywall <url>` (reads payTo, as `balances-core.ts` does), `--watch-from-lending-env <file>` (derives addresses with `Wallet.fromSeed` in memory, keeps only addresses), plus `POST /api/watch`. Persists to the store. |
| `src/subscribe.ts` | One `Client` per network. **Order:** `subscribe {streams:["ledger"], accounts:[…]}` → read `ledger_index` → backfill `account_tx` for each wallet from `current − backfillLedgers` with marker paging → live. Reconnect with backoff (1 s → 30 s). Stale guard: no `ledgerClosed` for `--stale-sec` → status `polling`, reconnect. When the watchlist changes, send `subscribe` / `unsubscribe` for just that address. |
| `src/decode.ts` | **Pure** function `(tx, meta, network) → Row`. Counting rule (from xrplh-14, kept): count money only if `validated`, `TransactionResult = tesSUCCESS`, and use **`meta.delivered_amount`, never `Amount`** (partial payments). Asset = XRP drops or `{currency, issuer}` (RLUSD hex `5241…` / TUSD). Fee = `Fee` drops ÷ 1e6. Kind: `x402_payment` (Payment with SourceTag 804681468 to payTo), `fee_payment` (memo `chainaim:*`), `payment`, `trustset`, and lending kinds by `TransactionType` (`VaultCreate`, `VaultDeposit`, `LoanBrokerSet`, `LoanSet`, `LoanPay`, `LoanManage`, …). Direction per watched wallet (in / out). |
| `src/store.ts` | SQLite (WAL): `wallets`, `transactions` (PK = network + tx hash — XRPL hashes are unique, no log index needed), `rows_via` (first road + all roads that delivered it), `claims` (reported lines), `balances` snapshots, `webhook_nonces`. `insertIfNew()` is the single de-dup gate for all roads. Also appends a JSONL tape per network for replay/audit, like PrivaSpend's `tape.jsonl`. |
| `src/balances.ts` | `account_info` (XRP) + `account_lines` with `peer = issuer` (RLUSD/TUSD, trust line open?) over the same client; on start, after every tx touching a wallet, and every `--balances-sec`. Logic mirrors `web/src/balance.ts` / `lending/src/ledger.ts holding()`. |
| `src/webhook.ts` | `POST <webhookPath>`. Body cap 4 MB. Gunzip if `Content-Encoding: gzip`. Verify `X-QN-Signature == hex(HMAC-SHA256(token, nonce + timestamp + body))` with `timingSafeEqual`; reject if `X-QN-Timestamp` older than `--webhook-max-skew-sec`; reject a reused nonce (stored). Optional `--webhook-allow-ip`. Answer **200** to unparseable bodies and log a 400-char preview. Normalize entries → look up full tx with `tx` if the payload lacks `meta` → `decode` → `store` with `via:"webhook"`. |
| `src/claims.ts` | The "reported" side. Two inputs: (a) `--paywall-log-file` tail (JSONL), (b) `POST /internal/claims` with `--claims-key-env` bearer (for Railway, where services don't share disks). Accepts only `event:"payment_settled"` with the known fields; drops anything else. Lending: reads `devnet-run.json` `txs[]` and the fee ledger file on change. |
| `src/reconcile.ts` | **Pure** join by tx hash: `matched` (claim + ledger agree on amount/asset/payer), `only_in_log` (claimed, not on ledger after `--settle-grace-ledgers`), `only_on_ledger` (money in, no claim — e.g. someone paid payTo directly), `mismatch` (amount/asset differ). Same for lending steps. |
| `src/alerts.ts` | Rules → attention items: buyer RLUSD below the cheapest route price; `only_in_log` past grace; `only_on_ledger`; feed on fallback; webhook silent > N min while txs arrive by push; trust line missing; lending loan past `NextPaymentDueDate` (read via `ledger_entry` for loan IDs in the state file). Thresholds are flags. |
| `src/server.ts` | `node:http` (no framework, like `relay.mjs` / `cockpit.ts`). Routes in 5.1.1. Loopback-only except the webhook path (PrivaSpend rule 5); `--public-api on` to lift deliberately. All `/api/*` need `Authorization: Bearer $ADMIN_API_KEY`. |
| `src/main.ts` | Wire it up; graceful shutdown (unsubscribe, close clients, checkpoint SQLite). |
| `test/*.test.ts` | `node --test`. Decode over recorded tx JSON (use the real Testnet hashes in STATE.md as fixtures), reconcile cases, webhook HMAC with QuickNode's documented example, gzip, replayed nonce, loopback/forwarded-header rule, subscribe-before-backfill order with a stand-in client. |

#### 5.1.1 ledger-watch API
| Method + path | Returns |
|---|---|
| `GET /api/health` | per network: provider name, transport `wss`/`polling`/`connecting`, last ledger, last push age, last webhook age |
| `GET /api/wallets` | watched wallets with label, role, network, XRP, token balance, trust line, last tx, status (funded/low/idle) |
| `GET /api/wallets/:network/:address` | wallet detail + last N txs + daily in/out series |
| `GET /api/transactions?network=&wallet=&kind=&result=&from=&to=&cursor=` | paged rows, each with `via`, explorer link, matched claim |
| `GET /api/reconcile?network=&from=&to=` | counts + rows per bucket (matched / only_in_log / only_on_ledger / mismatch) |
| `GET /api/alerts` | open attention items |
| `GET /api/lending` | vault, broker, loans (from state file + `ledger_entry`) |
| `GET /api/stream` (SSE) | `hello` (status + last 300 rows), then `ledger`, `tx`, `balances`, `claim`, `reconcile`, `alert`, `status`; 15 s keepalive |
| `POST /api/watch` / `DELETE /api/watch/:network/:address` | add/remove a wallet (re-subscribes; optionally syncs the QuickNode webhook's wallet list, see 5.1.2) |
| `POST <webhookPath>` | QuickNode delivery (the only public route) |
| `POST /internal/claims` | paywall payment lines (private network only, own key) |

#### 5.1.2 Keeping the QuickNode webhook's wallet list in step (optional, flag-gated)
`--qn-webhook-sync on` + `QUICKNODE_API_KEY` + `--qn-webhook-id`: when the watchlist changes, update the webhook's
`templateArgs.wallets` through the QuickNode REST API. **[ASSUME]** the exact update endpoint/verb — read the Webhooks REST
reference before building; until then the wallet list is maintained by hand in the dashboard.

### 5.2 Change: `services/paywall` (small, flag-gated, default = today's behaviour)
| File | Change |
|---|---|
| `src/config.ts` | Add `PAYMENT_LOG_FILE` (optional path) and `PAYMENT_LOG_URL` + `PAYMENT_LOG_KEY` (optional). |
| `src/app.ts` | In `onAfterSettle`, keep the stdout line exactly as is; additionally append the same line to `PAYMENT_LOG_FILE` and/or POST it fire-and-forget to `PAYMENT_LOG_URL` (1.5 s timeout, never awaited by the response — the PrivaSpend `trace.mjs` rule: narration must never slow a payment). |
| `test/paywall.test.ts` (+1 new test) | Line content unchanged; file sink written; HTTP sink failure does not affect the response. |
| `scripts/*` | **No code change.** Set `XRPL_WS_URL_TESTNET` to the QuickNode WSS URL and `pay.ts`, `rig.ts`, `trust-line.ts` already use it (`scripts/xrpl.ts wsUrl()`). |

### 5.3 Leave alone (on purpose)
- `services/gateway`, `services/presidio`, `packages/route-engine`, `config/` — protected by ARCH-002.
- `services/web/src/balance.ts` — runs **in the browser**; a QuickNode URL there would publish the token. Keep the public servers.
- `services/lending/*` — no change needed: `XRPL_WS_URL_DEVNET` already exists, and QuickNode has no Devnet. Phase 4 (optional)
  lets the Desk read `/api/lending` from the watcher instead of polling Devnet on every refresh.

### 5.4 Config files
- `.env.example`: add **names only** — `QUICKNODE_XRPL_WSS_TESTNET`, `QUICKNODE_XRPL_HTTP_TESTNET`, `QUICKNODE_STREAM_TOKEN`,
  `QUICKNODE_API_KEY`, `ADMIN_API_KEY`, `LEDGER_WATCH_CLAIMS_KEY`, `PAYMENT_LOG_FILE`, `PAYMENT_LOG_URL`, `PAYMENT_LOG_KEY`.
  (And blank the gateway key value — 2.5.)
- `config/ledger-watch.example.json` (optional): default watchlist with the public addresses from 2.3.

---

## 6. ledger-watch flags (defaults in brackets)

```
node services/ledger-watch/src/main.ts
  --network testnet,devnet                  [testnet]        networks to watch (repeat or comma list)
  --quicknode-wss-env QUICKNODE_XRPL_WSS_TESTNET             env var NAME holding the WSS URL (never the URL)
  --quicknode-http-env QUICKNODE_XRPL_HTTP_TESTNET           env var NAME for HTTPS reads
  --devnet-wss-env XRPL_WS_URL_DEVNET       [public Devnet]  reuses the lending variable
  --fallback-public on|off                  [off]            on = use the public node if QuickNode fails, shown in UI
  --watch label=role=rADDR                  (repeatable)
  --watch-from-paywall http://127.0.0.1:8080
  --watch-from-lending-env C:\PRIV-AI-SECRETS\lending-devnet.env   addresses only, seeds dropped after derivation
  --rlusd-issuer rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV
  --x402-source-tag 804681468
  --backfill-ledgers 20000                  how far back on start
  --stale-sec 45   --reconcile-sec 30   --balances-sec 15   --settle-grace-ledgers 10
  --low-balance-rlusd 0.05                  "low" threshold for buyers
  --paywall-log-file <path>                 reported side, local docker
  --claims-key-env LEDGER_WATCH_CLAIMS_KEY  reported side over HTTP
  --lending-state data/lending/devnet-run.json   --lending-fee-ledger <path>
  --store data/ledger-watch/watch.sqlite
  --port 8790   --bind 127.0.0.1   --public-api off
  --admin-key-env ADMIN_API_KEY
  --webhook-path /webhook/quicknode   --webhook-secret-env QUICKNODE_STREAM_TOKEN
  --webhook-max-skew-sec 300   --webhook-allow-ip 141.148.40.227 (optional)
  --qn-webhook-sync off   --qn-webhook-id <id>   --qn-api-key-env QUICKNODE_API_KEY
```

---

## 7. Admin UI — `apps/admin-console` (reference 3)

### 7.1 What the reference is **[READ]**
`chain-aim-router-admin-console`: Next.js 16.4, React 19, Tailwind 4, shadcn (`base-nova`), lucide icons, `@vercel/analytics`.
One `'use client'` file `app/page.tsx` with **hard-coded arrays** (`requests`, `callers`, payment rows) — no fetches, no API. Styling is
all in `app/globals.css`: cream→orange→brown gradient, IBM Plex Mono / Instrument Sans / Newsreader, square borders, hard shadows.
Patterns: top bar (brand, health dots, treasury, "updated Ns ago", settings menu with network / time range / wallet / pause), tabs,
`SectionHead` (eyebrow + question title), `SummaryStrip` (6 metrics), "Needs attention" rows with Open buttons, filter bar + table
with expandable detail, side panel with bars, "Unsettled only" toggle, advisory box.

### 7.2 How to reuse it
- **Copy** `app/globals.css`, `components.json`, `lib/utils.ts`, `components/ui/button.tsx`, the layout and fonts.
- **Split** the single page into components: `components/topbar.tsx`, `tabs.tsx`, `section-head.tsx`, `summary-strip.tsx`,
  `attention-list.tsx`, `data-table.tsx`, `detail-panel.tsx`, `status-dot.tsx`, `kind-pill.tsx` (was `ClassPill`).
- **Replace mock arrays with data**: `lib/api.ts` (typed fetch), `hooks/use-live.ts` (one `EventSource('/api/stream')`, merges
  `tx`/`balances`/`alert` events into state; "Pause updates" closes it; reconnects with backoff; the "updated Ns ago" label comes
  from the last event).
- **Keep secrets server-side**: `app/api/[...path]/route.ts` proxies to ledger-watch and adds `ADMIN_API_KEY` from the server env;
  SSE is streamed through the same proxy. The browser never sees the watcher key or any QuickNode URL.
- **Remove `@vercel/analytics`** for an internal admin console (it sends page telemetry). Keep only if you want that, by choice.
- **Admin login**: the console itself must be protected (it shows wallet balances and revenue). Minimum: run on loopback; for a hosted
  deployment, put it behind an auth layer (e.g. a session check in `middleware.ts` against an `ADMIN_USERS` list or SSO). Decide in 9.

### 7.3 Tabs mapped from the reference
| Reference tab | CreditSeal tab | Title (keep the "question" style) | Data |
|---|---|---|---|
| Overview | **Overview** | "Does anything need me?" | `/api/alerts` → attention rows; strip: RLUSD in 24h, payments, matched, only-in-log, only-on-ledger, feed (QuickNode push / polling) |
| Callers | **Wallets** | "Who is paying, and can they keep paying?" | `/api/wallets`; columns label, address, network, role, XRP, RLUSD/TUSD, trust line, last tx, status dot (funded/low/idle); side panel = recent txs + spend bars from `/api/wallets/:n/:a` |
| Requests | **Transactions** | "What happened on the ledger?" | `/api/transactions` with filters network / kind / wallet / result + search by hash; expanded row = hash, ledger index, delivered amount, fee, decoded memo, `via` badges (push · webhook · backfill · poll), explorer link, matched paywall claim |
| Payments | **Payments** | "Did we get paid?" | `/api/reconcile`; columns time, payer, route, quoted (claim), delivered (ledger), tx, state; "Unsettled only" = only_in_log + mismatch; label each side **reported** / **measured** |
| Models | **Lending** | "Are the loans healthy?" | `/api/lending`; vault totals, broker cover, loans with ACTUS chip (PF/DL/DQ/DF/MA, colours as in `cockpit.html`), next due date, fee payments received; banner "Devnet — public node (QuickNode has no Devnet)" |
| top-bar health | health dots | — | `ledger-watch`, `quicknode-testnet`, `devnet-public`, `paywall-claims`, `webhook` from `/api/health` |
| settings menu | same | — | Network (Testnet / Devnet / Both), time range, wallet filter, Pause updates — all wired to real state |
| "Treasury" | payTo balance | — | payTo RLUSD from `/api/wallets` |

The "privacy inset" idea from the reference stays: a fixed note that the console holds **money and routes only — no prompts,
answers, or restore maps**.

---

## 8. How the parts connect at runtime (one payment, end to end)

1. A tenant (`rig.ts`) or browser pays a priced route. Paywall verifies + settles through t54 → Payment to payTo on Testnet.
2. **Reported:** `onAfterSettle` prints the line (as today) and sends it to ledger-watch (file or `/internal/claims`) → stored as a claim.
3. **Measured, road 1 (push):** QuickNode WS `accounts` stream delivers the validated tx → `decode` → `insertIfNew` (`via: push`).
4. **Measured, road 2 (webhook):** QuickNode `xrplWalletFilter` posts the same tx → HMAC verified → `insertIfNew` → already seen,
   so it only adds `webhook` to that row's roads.
5. **Measured, road 3 (poll):** every `--reconcile-sec`, `account_tx` since the last checkpoint catches anything both roads missed.
6. `reconcile` joins claim ↔ tx by hash → `matched`; balances refresh for payTo and payer.
7. SSE pushes `tx`, `claim`, `reconcile`, `balances` → the admin console updates the row, the Payments state and the Wallet dial.
8. If step 2 has no matching tx after `--settle-grace-ledgers`, an `only_in_log` alert appears in Overview; if step 3/4 has no claim,
   `only_on_ledger` appears.

Lending runs the same path on Devnet, minus QuickNode: public Devnet WS → decode (lending kinds) → reconcile against
`devnet-run.json` `txs[]` and the fee ledger.

---

## 9. Delivery plan (phases, with AI vs manual split)

Each phase ends with tests passing and a short note in `BUILD_LOG.md` / `STATE.md` (the repo's convention).

| # | Phase | AI can do this | Manual — you do this |
|---|---|---|---|
| 0 | Decisions | — | Answer the open questions in section 10 |
| 1 | QuickNode endpoint | — | Create the XRPL **Testnet** endpoint; put WSS + HTTPS URLs in your private env file (outside git) |
| 2 | ledger-watch core: config, providers, subscribe, decode, store, balances, API, SSE, tests | All of it, against recorded fixtures and a stand-in client | Run `npm install` + `npm test` on your PC; start it against QuickNode; confirm `/api/health` says `wss · QuickNode` |
| 3 | Claims + reconcile + alerts; paywall sink | All code + tests | Restart `ca-paywall` with `PAYMENT_LOG_FILE` or `PAYMENT_LOG_URL`; run `rig.ts --calls 5`; confirm 15 matched |
| 4 | Webhook | Receiver, HMAC, gzip, nonce store, tests with QuickNode's documented example | Create the `xrplWalletFilter` webhook (paid plan), expose `/webhook/quicknode` (tunnel or hosted URL), paste the security token into the env file; send one payment; share the logged preview so the normalizer matches the real shape |
| 5 | Admin console | Scaffold from the reference, split components, API proxy, live hook, five tabs, tests (component + API contract) | `pnpm install`, `pnpm dev`, review the screens |
| 6 | Devnet + lending tab | Devnet profile, lending decode, `/api/lending`, Lending tab | Start with `--watch-from-lending-env`; run one Desk cycle; confirm loans appear |
| 7 | Hardening | Admin auth, rate limits, Dockerfile/railway.json, runbook | Deploy decision; rotate the gateway key (2.5) |

Manual steps will be given **one at a time** when we reach each phase. The first one, whenever you are ready, is below.

**Manual — Step 1 (QuickNode endpoint).** In the QuickNode dashboard, choose *Create endpoint* → chain **XRP Ledger** → network
**Testnet**. Expected result: an endpoint page showing an HTTPS URL and a WSS URL, both containing a token in the path. Do **not**
paste them in chat; store them in your private env file (e.g. `C:\PRIV-AI-SECRETS\creditseal-quicknode.env`) as
`QUICKNODE_XRPL_WSS_TESTNET=…` and `QUICKNODE_XRPL_HTTP_TESTNET=…`. Tell me when that's done.

---

## 10. Open questions (need your answer before phase 2/5)

1. **Where does it run?** Local PC only (loopback, tunnel for the webhook), or Railway next to the paywall (then the paywall uses the
   HTTP claim sink over the private network, and the console needs real auth)?
2. **Paid QuickNode plan?** Webhooks/Streams need one. Without it: WS push + poll only (still real-time; phase 4 is skipped).
3. **Which wallets** go in the default watchlist — all of 2.3, or payTo + t01–t03 only?
4. **Include the AP4M / XRPL EVM wallets** from PrivaSpend too? That needs a separate EVM provider path (ethers, logs) — a second
   decoder, not a tweak. Recommendation: no, unless CreditSeal starts paying on AP4M.
5. **Admin console location:** inside the CreditSeal repo (`apps/admin-console`) as proposed, or kept in `PRIVAI2` and pointed at the
   watcher? Recommendation: inside CreditSeal, so API types are shared and versioned together.

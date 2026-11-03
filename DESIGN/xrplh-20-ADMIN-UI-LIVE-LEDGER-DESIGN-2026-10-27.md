# xrplh-20 — CreditSeal Admin Console: live ledger UI (PrivaSpend-style), built on the ChainAim admin look

Breadcrumb: xrplh-14 (control-room idea) · xrplh-19 (backend: `services/ledger-watch`, QuickNode, webhooks) · **xrplh-20** (this: the UI).
Status: **DESIGN ONLY — no code written or changed.** 2026-10-27 (IST).
Tags: **[READ]** read in the named file today · **[WEB]** QuickNode docs read on 2026-10-27 · **[ASSUME]** not verified — check named.

> Recovered 2026-10-27 ~22:15 IST from the transcript of chat "CreditSeal admin UI design plan-nisha"
> (https://claude.ai/chat/b611fd31-a3d5-409a-90c6-a1156c0edccc), where it was written but never saved to the PC.
> Content is the original Write call verbatim; only HTML entities from the transcript were decoded back to < > &.

Inputs read:
- PrivaSpend-Ai `dispatch/live/pane.html`, `dispatch/live/relay.mjs`, `dispatch/pane/wallets.html`, `dispatch/pane/pane.mjs` (GitHub, cloned today).
- Admin reference `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2\chain-aim-router-admin-console\chain-aim-router-admin-console` (`app/page.tsx`, `app/globals.css`, `app/layout.tsx`, `package.json`, `components.json`, `lib/utils.ts`).
- CreditSeal local copy `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2\CreditSeal` (tree checked: **no admin, QuickNode or ledger-watch code exists yet**; same service layout as the GitHub repo analysed in xrplh-19).

---

## 0. Bottom line

- **What we take from PrivaSpend is the *behaviour* of its live UI**, not its look: an honest feed-status chip, a "round trip" strip
  where only the on-ledger step is *measured* and the rest is *reported*, a ledger tape with a **Via** column
  (push · webhook · backfill · poll), an **Ours / All** filter, live balance dials, a change log, and amber rows for money the
  books don't account for.
- **What we take from the ChainAim admin reference is the *look and stack***: Next.js 16 + React 19 + Tailwind 4 + shadcn, the
  cream→orange→brown palette, IBM Plex Mono / Instrument Sans / Newsreader, square borders, question-style section titles,
  summary strips, "Needs attention" rows.
- **New app:** `CreditSeal/apps/admin-console`. It talks only to `services/ledger-watch` (xrplh-19) through its own server-side proxy.
  The browser never sees a QuickNode URL or an API key.

---

## 1. How PrivaSpend's UI shows QuickNode, streaming and webhooks [READ]

### 1.1 The data path behind the page
```
QuickNode WSS (newHeads + VoucherRedeemed + RLUSD Transfer) ─┐
QuickNode Stream → POST /webhook (server-side filter)        ├─▶ relay.mjs: one `seen` set ─▶ GET /stream (SSE) ─▶ pane.html (EventSource)
10 s reconcile poll (eth_getLogs, last 50 blocks)            ─┘        ▲
agent / merchant  ── POST /trace (fire-and-forget) ────────────────────┘ (reported steps)
```
The page never calls the chain. It opens **one** `EventSource('/stream')` and paints from events.

### 1.2 SSE event contract (relay → page)
| Event | Payload | What the page does |
|---|---|---|
| `hello` | status, buyer, seller, cap, contracts, explorer, balances, last 10 traces, whole tape | Rebuild all state (also after a reconnect) |
| `head` | `{transport, source, head, lastPushAgoMs}` | Update chip; counts as "pushed just now" |
| `status` | same + optional `note` | If it drops from `wss` to `polling`, step 4 turns amber: "socket down — rows arrive by poll" |
| `voucher` | decoded `VoucherRedeemed` row with `via`, `mine` | Append to tape, flash row, repaint dials, paint step 4 |
| `transfer` | decoded RLUSD `Transfer` with `settlement`, `mine` | Append; add to "settled to payout" |
| `balances` | buyer / seller / vault | Repaint figures |
| `trace` | `{step 1–5, mark ok/warn/fail, say, evidence:'reported'}` | Paint that step; a fresh step 1 clears the strip |
| `onerror` | — | Chip red "relay unreachable"; step 4 red "no feed" |

### 1.3 UI elements and the rule each one enforces
| Element (pane.html) | Rule |
|---|---|
| **Feed chip**: dot + provider name + `wss` / `polling fallback` + head + "pushed 1.2s ago" (repainted every 250 ms) | Green **only** when transport is `wss` *and* last push < 45 s. Amber = polling. Red = down. The provider **name** ("QuickNode") is shown, never its URL. |
| **Two cards facing each other** (buyer / seller): address, big figure, cap meter (amber > 80 %), counters | Money figures come from chain reads, not from the agents. |
| **x402 round-trip strip** (5 hops, green/amber/red, a small `measured` / `reported` tag) | Only step 4 (on-ledger) is `measured`. Steps 1, 2, 3, 5 come from `/trace` and are tagged `reported`. Strip clears after 30 s idle so a stale run never looks current. |
| **Note under the strip** | Says in words what is measured vs reported and that no RLUSD moves on the hot path. |
| **Ledger tape** table: time, event, buyer, seller, amount, cumulative, block, tx (explorer link), **Via** | Every row is decoded on-chain data. **Via** shows which road delivered it first. Fresh rows slide in. |
| **Ours / All traffic toggle** + "N of M rows are yours" | Shared testnet traffic is kept and labelled, never hidden. |
| **Footer** | "The endpoint never reaches this page." |

`wallets.html` (the older desk) adds: a **provider badge** (`QuickNode` / `public node`), a **live-mode badge** (`polling` → `live: websocket`),
a **change log** (`aria-live`), and a **redemptions table where rows not found in any saved run turn amber** with a warning line —
i.e. "money the books don't explain". It polls `/api/wallets` every 2 s and also listens to `/api/live` SSE, so a dead socket can't blank it.

### 1.4 What not to carry over
- Vanilla HTML + inline script, dark "terminal" theme — CreditSeal uses the ChainAim admin look instead.
- EVM concepts (block, log index, vouchers, cumulative watermark). XRPL has ledgers, tx hashes, `delivered_amount`.
- Webhook HMAC as coded in `relay.mjs` (wrong scheme — see xrplh-19 §1.4). Irrelevant to the UI, but the UI must not show "webhook verified" unless ledger-watch verified it the documented way.

---

## 2. The ChainAim admin reference [READ]

- Single `'use client'` page (`app/page.tsx`) with **hard-coded arrays**; no fetch, no live data.
- Reusable patterns: top bar (brand mark, health dots, treasury, "updated 14s ago", settings menu: network / time range / wallet / pause),
  tabs, `SectionHead` (eyebrow + question title), `SummaryStrip` (6 metrics), attention list with **Open ↗**, filter bar + table with
  expandable detail, caller side panel with bar chart, "Unsettled only" toggle, advisory box, leak banner.
- CSS tokens in `app/globals.css` (`--cream #FEF3E2`, `--pale #F4AE52`, `--light #D4621A`, `--ink #2A1A0E`), mobile breakpoints at 800 / 420 px.
- `@vercel/analytics` is in `layout.tsx` (production only) — remove for an internal console.

---

## 3. Mapping: PrivaSpend behaviour → CreditSeal screens

| PrivaSpend element | CreditSeal equivalent |
|---|---|
| Feed chip (QuickNode · wss · head · pushed Ns ago) | **Top-bar feed chips**, one per network: `TESTNET · QuickNode · wss · ledger 12,345,678 · 1.2s` and `DEVNET · public node · wss · …`. Plus a **webhook chip**: `webhook · last 42s · verified`. |
| Buyer / seller cards with meter | **Live Desk tab**: payTo card (RLUSD collected today/session, last payment) and a buyer strip (t01–t03, B01, buyer) with balance and "calls left at current price" meter. |
| x402 round trip (5 steps) | **x402 settle strip** (CreditSeal's own flow via t54): 1 request priced route · 2 402 + price + invoice · 3 payer signs XRPL Payment · **4 Payment validated on ledger (measured)** · 5 answer released. Difference to note on screen: here RLUSD *does* move at step 4 (direct Payment, no channel). |
| — | **Loan lifecycle strip** (Lending tab): underwrite (reported, off-chain) · fee paid (measured, memo `chainaim:uw:<id>`) · LoanSet co-signed (measured, `Data = sha256(pack)`) · instalment LoanPay (measured) · status PF/DL/DQ/DF/MA. |
| Ledger tape + Via + Ours/All | **Transactions tab** table with **Via** badges, **Ours / All on watched wallets** toggle, fresh-row slide-in, explorer links (testnet.xrpl.org / devnet explorer). |
| "Not in a saved run" amber rows | **Payments tab** reconciliation: `matched` / `only in log` (claimed, not on ledger) / `only on ledger` (money nobody claimed) / `mismatch`, each column labelled *reported* or *measured*. |
| Change log (aria-live) | **Activity rail** on Live Desk: one line per event ("+0.01 RLUSD from t02 · scan · via push"). |
| Honest degradation | Same rules: chip amber when polling; strip step 4 amber "socket down — rows arrive by poll"; banner when SSE to the console is lost. |
| "Endpoint never reaches this page" footer | Fixed **privacy/credentials inset** (reference style): "This console holds money and routes only — no prompts, answers or restore maps. Ledger endpoints stay on the server." |

---

## 4. Screens (in the reference style)

Tabs: **Overview · Live Desk · Wallets · Transactions · Payments · Lending**.

### 4.1 Top bar (every tab)
`CA` brand mark · "CreditSeal · Admin" · feed chips (§3) · payTo RLUSD as "treasury" · "updated Ns ago" (time since last SSE event) ·
settings menu: **Network** (Testnet / Devnet / Both), **Time range** (24h / 7d / 30d), **Wallet** (all / one), **Pause updates**
(closes the EventSource; resume reconnects and replays `hello`).

### 4.2 Overview — "Does anything need me?"
- Attention list from `alerts`: only-in-log payment past grace · only-on-ledger payment · buyer below route price · trust line missing ·
  feed on polling · webhook silent while push is active · loan overdue (NextPaymentDueDate passed) · loan impaired/defaulted.
  Each row: what · detail · severity · **Open ↗** (jumps to the tab with the filter set — same `jump()` idea as the reference).
- Summary strip: RLUSD in (24h) · paid calls · matched · only-in-log · only-on-ledger · feed (`QuickNode push` / `polling`).
- "Recent activity" = last 6 measured rows.

### 4.3 Live Desk — "Is money arriving right now?" (the PrivaSpend pane, re-skinned)
- Left card **payTo** `rn5h…Bej`: big RLUSD figure, today / session counters, last payment (amount, route, via).
- Right card **buyers**: rows for each watched buyer — balance, spent today, calls left = balance ÷ cheapest price, meter (amber < 5 calls, red < 1).
- **x402 settle strip** (§3) with green/amber/red and `measured` / `reported` tags; legend; note explaining which step the ledger proves.
- **Activity rail** (latest 20 lines, `aria-live="polite"`).
- Toggle: **Testnet x402** ↔ **Devnet lending** (Devnet shows the loan lifecycle strip instead).

### 4.4 Wallets — "Who is paying, and can they keep paying?" (reference *Callers*)
Table: label · role · network · address · XRP · RLUSD/TUSD · trust line · last tx · status dot (funded / low / idle / no line).
Row click → side panel: recent txs, in/out bars per day, unsettled count. Header action: **+ Watch wallet** (label, role, network,
address; validated client-side and by ledger-watch) — admin-only.

### 4.5 Transactions — "What happened on the ledger?" (reference *Requests*)
Filters: network · kind (x402 payment, fee, payment, trust line, Vault*, Loan*) · wallet · result · Ours/All · search by hash.
Columns: time · kind pill · from · to · delivered · fee · ledger · tx · **Via** (first road, with the other roads as small dots).
Expanded row: full hash, ledger index, `delivered_amount`, SourceTag, decoded memo, roads + arrival time per road, matched claim,
explorer link. Empty state copy in the reference voice.

### 4.6 Payments — "Did we get paid?" (reference *Payments*)
Columns: time · payer · route · **quoted (reported)** · **delivered (measured)** · tx · state (`matched` / `only in log` / `only on ledger` / `mismatch`).
"Unsettled only" toggle = everything not matched. Summary strip: quoted · delivered · matched · gaps · payTo balance.

### 4.7 Lending — "Are the loans healthy?" (replaces reference *Models*)
Banner: "Devnet · public node — QuickNode has no XRPL Devnet" **[WEB]**. Vault card (assets total/available, loss unrealized),
broker card (debt, cover available vs minimum), loans table with ACTUS chip (PF/DL/DQ/DF/MA — reuse the colour meaning from
`services/lending/scripts/cockpit.html`), next due, outstanding, fees received; loan lifecycle strip for the selected loan.

### 4.8 States every screen must handle
`connecting` (skeleton rows) · `live` · `polling` (amber chip, note) · `console disconnected` (banner, last data greyed, auto-retry) ·
`empty` (reference-style sentence) · `error from ledger-watch` (short code only, never an endpoint).

---

## 5. Front-end architecture

```
browser ──EventSource /api/live──▶ Next route handler (proxy, adds ADMIN key) ──▶ ledger-watch GET /api/stream (SSE)
browser ──fetch /api/*─────────────▶ Next route handler (proxy) ─────────────────▶ ledger-watch REST
```

### 5.1 Files (new app `CreditSeal/apps/admin-console`)
| Path | Holds |
|---|---|
| `package.json`, `next.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `components.json` | Copied from the reference; rename package `@chainaim/admin-console`; drop `@vercel/analytics` |
| `app/globals.css` | Reference CSS + new classes: `.feed-chip`, `.dot.live/.poll/.down` (ping animation from PrivaSpend), `.strip`/`.hop.ok/.warn/.fail`, `.evidence-tag`, `.via-badge`, `.row-fresh` (slide-in), `.unaccounted` (amber row) |
| `app/layout.tsx` | Fonts, metadata "CreditSeal · Admin" |
| `app/page.tsx` | Shell: top bar + tabs + active tab (thin) |
| `app/api/live/route.ts` | SSE proxy: opens ledger-watch `/api/stream` with `Authorization: Bearer ${ADMIN_API_KEY}`, pipes it through, `runtime = 'nodejs'`, no caching |
| `app/api/[...path]/route.ts` | REST proxy, GET + the two admin POST/DELETE (watch list); allow-list of paths |
| `middleware.ts` | Admin session check (see §7 decision); loopback-only mode by flag |
| `lib/types.ts` | `Status`, `TxRow`, `Claim`, `ReconRow`, `Wallet`, `Alert`, `Loan`, `TraceStep`, `Via = 'push' \| 'webhook' \| 'backfill' \| 'poll'` — the same shapes ledger-watch emits |
| `lib/api.ts` | Typed fetchers |
| `lib/format.ts` | RLUSD/TUSD decimals as strings (never floats for money), XRP drops→XRP, short address/hash, ledger-time→local |
| `hooks/use-live.ts` | One EventSource; reducer handling `hello`, `ledger`, `tx`, `balances`, `claim`, `reconcile`, `alert`, `status`, `trace`, `webhook`; backoff reconnect; pause/resume; exposes `lastEventAt` for "updated Ns ago" |
| `hooks/use-ticker.ts` | 250 ms tick for the chip's "pushed Ns ago" (PrivaSpend repaint) |
| `components/topbar.tsx`, `feed-chip.tsx`, `webhook-chip.tsx`, `settings-menu.tsx`, `tabs.tsx` | Top bar |
| `components/section-head.tsx`, `summary-strip.tsx`, `attention-list.tsx`, `status-dot.tsx`, `kind-pill.tsx`, `via-badge.tsx`, `evidence-tag.tsx` | Reference primitives + new badges |
| `components/settle-strip.tsx` | Generic N-step strip (`steps`, `marks`, `evidence`, idle clear 30 s) used for x402 and loan lifecycle |
| `components/ledger-table.tsx` | Table with expand, fresh-row animation, Ours/All |
| `components/wallet-card.tsx`, `buyer-meter.tsx`, `activity-rail.tsx`, `wallet-panel.tsx` | Live Desk + Wallets |
| `components/tabs/overview.tsx`, `live-desk.tsx`, `wallets.tsx`, `transactions.tsx`, `payments.tsx`, `lending.tsx` | One file per tab |
| `test/*.test.tsx` | Reducer tests (event sequences incl. reconnect `hello`, duplicate tx from two roads, polling downgrade), chip colour rules, strip idle clear, format of 15-decimal RLUSD, proxy never forwards upstream URL |

### 5.2 State rules (copied from PrivaSpend, made explicit)
1. **De-dup by `network:txHash`** in the reducer too (ledger-watch already de-dups; a second road for the same tx only adds a road dot).
2. **Chip colour** = green iff `transport==='wss' && now − lastPushAt < staleMs`; amber if `polling`; red if `down` or SSE lost.
3. **Strip step 4** is painted **only** from a measured `tx` event; steps 1, 2, 3, 5 **only** from `trace` events; a fresh step 1 clears the strip; 30 s idle clears it.
4. Backfilled rows go in the table but **never** animate the strip (PrivaSpend: `row.via !== 'backfill'`).
5. `hello` replaces state wholesale (handles reconnect and pause/resume).
6. Money is kept as decimal strings / BigInt; never `Number` sums.

### 5.3 Event additions needed from ledger-watch (on top of xrplh-19 §5.1.1)
| Event | Why the UI needs it |
|---|---|
| `trace` `{flow:'x402'|'loan', step, mark, say, ref}` | Reported steps for the strips. Source: the paywall's fire-and-forget sink (same pattern as PrivaSpend `live/trace.mjs`) — steps 1 (request), 2 (402 quoted + invoice), 3 (payment presented), 5 (released); lending scripts for "underwrite done". Payload carries **no body text, no decision id**. |
| `webhook` `{at, verified, count, fresh}` | Webhook chip ("last 42s · verified · 0 new" — the PrivaSpend "batch of 1, 0 new" line, shown in UI) |
| `status.perNetwork` | One chip per network |

Paywall change for traces (extends xrplh-19 §5.2): `PAYMENT_TRACE_URL` optional; in the request path emit steps 1/2/3/5 fire-and-forget,
never awaited, 1.5 s timeout, only route + amount + invoice id. Default off.

---

## 6. Build order (AI vs manual)

| # | Step | AI can do this | Manual — you do this |
|---|---|---|---|
| 1 | Scaffold `apps/admin-console` from the reference, split components, remove analytics, add tokens/classes | ✓ | — |
| 2 | `lib/types.ts` + `use-live` reducer + tests, run against a **recorded SSE fixture** (labelled as a fixture, not live data) | ✓ | — |
| 3 | Tabs Overview, Transactions, Payments, Wallets wired to the proxy | ✓ | — |
| 4 | Live Desk + settle strip + activity rail; paywall trace sink (flag-gated) + tests | ✓ | — |
| 5 | Lending tab against ledger-watch Devnet profile | ✓ | — |
| 6 | First live run | — | `pnpm install` + `pnpm dev`; ledger-watch running with your QuickNode Testnet URLs (xrplh-19 Manual Step 1); run `rig.ts --calls 5`; check the chip turns green and 15 rows land with Via = push |
| 7 | Webhook chip live | — | Create the QuickNode `xrplWalletFilter` webhook (paid plan), point it at ledger-watch, confirm "verified" on the chip |
| 8 | Auth + deploy | ✓ code | Choose local-only vs hosted (§7) |

Dependency: steps 3–7 need `services/ledger-watch` (xrplh-19). Steps 1–2 can start now against the fixture.

Manual steps will be given **one at a time** when we reach step 6.

---

## 7. Decisions needed from you

1. **Where the console runs:** local PC only (loopback, no login needed beyond the machine) or hosted (needs real login — I'd use
   a session check in `middleware.ts` against an `ADMIN_USERS` list, or your SSO if you have one).
2. **App location:** `CreditSeal/apps/admin-console` (recommended — shares types with ledger-watch) or keep it in `PRIVAI2/chain-aim-router-admin-console` and point it at CreditSeal.
3. **Theme:** keep the reference's cream/orange light theme only, or add a dark mode (PrivaSpend is dark; the reference's `viewport` already declares `light dark`)?
4. **Live Desk on Devnet:** the loan lifecycle strip needs the lending scripts to emit "underwrite done" traces — OK to add that (flag-gated) in `services/lending/scripts/underwrite.ts`?

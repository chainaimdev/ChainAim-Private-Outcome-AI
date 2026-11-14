# Outcome AI from ChainAim: NEAR hackathon demo, one video, 2:58 (v12)

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

| Left half of the screen | Right half of the screen |
|---|---|
| **:8730 · Private AI Desk** (`chainaim-private-ai` v2.3.1, commit `ad90262`) | **:8800 · NEAR Admin Console** (`chainaim-adminUI-NEAR` v1.1.1, commit `782f3f5`) |

The voice-over is the **v11 narrated script, word for word** (`DEMO/outcome-ai-demo-script-v11-narrated.html`), plus two
new 15-second scenes: the agent-to-ChainAim negotiation, and the ERP and dental-office templates. Narrated player for
recording: **`DEMO/outcome-ai-demo-script-v12-narrated.html`** (same player as v11, the scenes below, speed 1.08).
On-screen lines quoted here are the apps' own wording, read from `test-console/console/paid-jobs.html` and
`scripts/agent-ask-core.ts`.

---

## 1. Where the 2:30 script (Nov14-1) deviated from v11, and what v12 does

| Scene | v11 (intended) | Nov14-1 script (deviation) | v12 |
|---|---|---|---|
| Opening | Title card on both halves; "Regulated businesses sit on large volumes of sensitive data… proof for every answer." | No title card (lower-third over the live apps); new words: "Regulated businesses need AI on their sensitive data. Today's AI asks them to hand that data over…" | v11 card and words |
| Two apps | "AI agents, called from the tenant's UI or a terminal, buy private intelligence… a live streamer shows each answer matched to its NEAR payment…" | New words: "the Private AI Desk runs on the company's own PC… reads the chain itself and audits…" | v11 words; agent **t02** (to show the negotiation) |
| Use cases | Not a scene (templates are named inside "Proof you can check") | Added: four use cases (ERPNext, Dental, ChiroTouch, Jane), 15 s | New 15 s scene, **ERP + dental office** only (your choice) |
| Price | "ChainAim prices the job from the file sizes and signs its terms and limits as an AP2 quote, signed with ES256, with domain templates and context caps…" | New words: "The agent asks for the five biggest payments out… two cents…" | v11 words |
| Funded | "…funds the job over x402: a NEP-141 USDC transfer on NEAR, relayed as a NEP-366 meta-transaction. Fair to both sides." | New words: "…and pays first… with no gas of its own" | v11 words |
| Compute | "Compute first, model last…" | Merged with masking: "Now the exact query runs on the PC. Anything personal is masked…" | v11 words |
| Proof (40 s) | Presidio, PII/PHI/PCI tokenization, domain templates (small business, ERP, dental, chiropractic, personal finance), rescan + fail closed, control plane verifies the record, real values return locally, one receipt binds it all | Cut to 18 s; the tokenization, templates, rescan and fail-closed lines were dropped | v11 words, 36 s |
| Money back | "If privacy cannot be proven, the job is refused and the money goes back…" (24 words) | Longer: "Here the attestation service is down. The agent already paid…" | v11 words |
| Running totals + roadmap | "Every payment and every refund is on NEAR… On the roadmap: aggregate views on chain, and ChainAim's ZK-PRET engine… on o1Labs' Mina Protocol…" | Dropped; replaced by a judge-path terminal beat | v11 words (roadmap stays labelled as roadmap) |
| Close | "Private data. Exact numbers. A budget you control. Outcome AI from ChainAim: pay for verified outcomes, not tokens." | New words + a question: "…Which practice system should we support next?" | v11 words |

**New in v12 (not in either script):** the one-round negotiation between the tenant's agent and ChainAim's control plane
(built in v2.3.0), shown live.

### Corrections kept from the code check (v11 visuals that the apps don't show)

| v11 cue | What the code does | v12 cue |
|---|---|---|
| Price scene, right: "Jobs: the new job appears as quoted" | In estimate-first mode nothing reaches 8800 before payment | "no new row yet"; the row appears at payment |
| Running totals, left: "Tab 03 jobs list for the session" | Tab 03 has no session jobs list | Tab 03 "What the chain shows" for this job + its nearblocks link |
| Roadmap: ZK-PRET on Mina, on-chain aggregates | Not in these repos | Kept, said and captioned as **roadmap** (as v11 already does) |

**One wording point to decide (left as v11):** "Two apps" says agents buy intelligence on "operations, health,
finance". Today the AI agent buys crossask datasets (small-business and ERP finance); the dental and chiro packs run
exactly on the PC but are not NEAR-paid jobs. If you want it exact, say "operations, finance, and soon health". The new
template scene is captioned "exact, on your PC" for the same reason.

---

## 2. Before recording

1. Start everything with the negotiation on:
   ```
   .\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified -ReEstimate on -Counter on
   ```
   Expect `OK counter on…` and `ALL OK`.
2. **8730, tab 03 (main flow):** Pay with USDC · NEAR ticked · Who pays? **AI agent, tenant t02** (auto-approve 0.01) ·
   mode **Estimate first** · model `nearai/deepseek-v4.1-flash` · dataset **Small Biz Financials - 1** · template
   **Cash flow vs installment**. This is the combination proven live on 14 Nov (quoted 0.02 → countered → paid 0.01,
   job `0ed4fe96…`), and it is the README's judge sample, so the video and the judge path show the same deal.
3. **8800:** the **Jobs** tab, road chips live; Ledger and Seller wallet one click away.
4. **Pre-record the clips:**
   - **Templates (15 s):** ERPNext set `orion`: Cash flow vs installment, Late payers. Dental set `SET-2/NEG-ALL`: Every leak
     type found: how many and how much, then MODEL: which leaks lose money (the page shows the figures checked).
   - **Refund (9 s):** `.\test-console\desk.ps1 -StopService attest` after "Quoted" and before paying; afterwards
     `-StartService attest`.
5. **Edit for time:** a paid job takes about 49 s from payment to result, and a refund settles about 17 s after the
   refusal; cut the waits.
6. Narration: play `outcome-ai-demo-script-v12-narrated.html` with system audio recorded, speed **1.08** (about 2.75
   words a second; v11 ran at 0.96 for 2:43). If the voice sounds rushed, lower the speed and let the video run long:
   HACKATHON.md sets no length limit.
7. Record at 1080p, browser zoom 110%, both windows snapped side by side. All data is synthetic.

---

## 3. The script (2:58)

| Time | Scene | Length | Words |
|---|---|---|---|
| 0:00 – 0:20 | The problem | 20 s | 58 |
| 0:20 – 0:38 | Two apps | 18 s | 50 |
| 0:38 – 0:53 | **Domain templates: ERP and a dental office (new)** | 15 s | 35 |
| 0:53 – 1:08 | A firm price before any work | 15 s | 42 |
| 1:08 – 1:23 | **Agent and ChainAim negotiate (new)** | 15 s | 38 |
| 1:23 – 1:37 | Funded on NEAR, fair to both sides | 14 s | 39 |
| 1:37 – 1:52 | Compute first, model last | 15 s | 42 |
| 1:52 – 2:28 | Proof you can check | 36 s | 103 |
| 2:28 – 2:37 | Money back if privacy is not proven | 9 s | 24 |
| 2:37 – 2:52 | Running totals, in the open | 15 s | 43 |
| 2:52 – 2:58 | Close | 6 s | 18 |

### 0:00 – 0:20 · The problem
- **Left and right:** title card: *Outcome AI from ChainAim · Pay for verified outcomes, not tokens.*

**"Regulated businesses sit on large volumes of sensitive data and need AI to act on it. Frontier AI asks them to trust
it with their practices, their security and their budget, and to pay for tokens, often incentivizing to spend more
tokens. Outcome AI from ChainAim brings accountable models to local data, cost-effectively, with proof for every
answer."**

*Caption:* Local data · accountable models · proof for every answer

### 0:20 – 0:38 · Two apps
- **Left (8730):** tab 03 with **AI agent t02** chosen; a terminal beside it ready for `-AgentAsk`.
- **Right (8800):** the live job and payment stream (near-watch), block height ticking.

**"On the left, AI agents, called from the tenant's UI or a terminal, buy private intelligence on their own company's
data: operations, health, finance, what-ifs. On the right, a live streamer shows each answer matched to its NEAR
payment, with a receipt anyone can rely on, without seeing the data."**

*Caption:* Tenant UI and terminal agents · a live NEAR payment stream

### 0:38 – 0:53 · Domain templates: ERP and a dental office (new, pre-recorded)
- **Left (8730):** quick cuts, about 7 s each:
  - **Small Biz Financials - 2 (ERPNext)**, set `orion`: *Cash flow vs installment* → the exact table; *Late payers*.
  - **Practice Management - Dental**, set `SET-2/NEG-ALL`: *Every leak type found: how many and how much* → the table;
    then *MODEL: which leaks lose money…* with its figures checked.
- **Right (8800):** Jobs tab, live; no change.

**"Domain templates, on synthetic data. ERP books for a small business: cash flow against loan installments, late
payers, credit exposure. A dental office: every revenue leak between its practice system and the bank, found
exactly."**

*Caption:* ERP: cash flow, payers, credit · Dental: revenue leaks vs the bank · exact, on your PC

### 0:53 – 1:08 · A firm price before any work
- **Left (8730):** Small Biz Financials - 1 · *Cash flow vs installment* · AI agent t02 · Estimate first. Press **Ask**.
  Highlight (zoom): **Quoted 0.02 USDC on near:testnet…** · **Quote signed by ChainAim ✓** · **Signed limits checked ✓**.
- **Right (8800):** no new row yet (a job shows on 8800 once it is paid).

**"ChainAim prices the job from the file sizes and signs its terms and limits as an AP2 quote, signed with ES256, with
domain templates and context caps suited to the data and the question. What the buyer signed is exactly what runs."**

*Caption:* What the buyer signed is exactly what runs

### 1:08 – 1:23 · Agent and ChainAim negotiate (new, live)
- **Left (8730):** highlight in order:
  - **Spending policy: counter → asks ChainAim for a smaller job (nothing paid yet)**
  - **Counter-offer: asked for at most 0.01; ChainAim offered a smaller job at 0.01 (answer rows 20, tokens 1024) ✓ ·
    new id …**
  - **Quoted 0.01 USDC…** · **Quote signed by ChainAim ✓** · **Spending policy: pay ✓**
  - *Optional terminal insert:* `-AgentAsk` for t02 prints `[ChainAim] Counter-offer: … OK · new id …, counter of …`.
- **Right (8800):** still no row: nothing is paid during the negotiation.

**"This company's agent auto-approves only one cent. So it counters, and ChainAim's signer offers a smaller job at that
limit: fewer answer rows, fewer tokens, same fees and margin. The price is never discounted; only the job shrinks."**

*Caption:* Tenant agent ↔ ChainAim control plane · one counter round · 0.02 → 0.01, smaller job

### 1:23 – 1:37 · Funded on NEAR, fair to both sides
- **Left (8730):** highlight: Size re-checked before paying ✓ · **Checkout mandate signed ✓** · **Settled on NEAR ↗** ·
  **Mandate verified by ChainAim's signer ✓**.
- **Right (8800):** Jobs: the row appears, paid 0.01. Ledger: the USDC transfer arrives from the chain.

**"The agent checks the price against its company's rules, signs an AP2 checkout mandate for this one payment, and funds
the job over x402: a NEP-141 USDC transfer on NEAR, relayed as a NEP-366 meta-transaction. Fair to both sides."**

*Caption:* AP2 quote + AP2 mandate · x402 · NEP-141 USDC · NEP-366 relayer

### 1:37 – 1:52 · Compute first, model last
- **Left (8730):** highlight: **Result released** · **AI proof ✓ 1 of 1 NEAR AI call verified** · the answer.
- **Right (8800):** the Jobs row: released, attested ✓. Expand it: TDX, GPU and signature checks.

**"Compute first, model last. An exact query runs over the chosen dataset on the tenant's machine. Then one small call,
inside a NEAR AI enclave attested with Intel TDX and NVIDIA GPU evidence, words or reasons on the result, for a
micropayment."**

*Caption:* Deterministic compute on your PC · 1 TDX + GPU attested NEAR AI call · under $0.0005
(the judge receipt shows NEAR AI cost 0.000322)

### 1:52 – 2:28 · Proof you can check
- **Left (8730):** highlight: Every number checked · **What left your PC: 1 model call** · **Signed receipt ✓**.
- **Right (8800):** Jobs: signed quote ✓, receipt ✓ · Reconcile: matched · Seller wallet: books agree.

**"Every figure is checked. Before anything leaves the machine, enterprise-grade privacy tokenization protects PII, PHI
and PCI: PII and PHI are tokenized with Microsoft Presidio and ChainAim's own detectors. This is ChainAim's domain
expertise, ready in templates for small-business finance, ERP, dental and chiropractic practices, and in
personal-finance datasets. The masked text is rescanned to prevent leaks, and if anything remains, nothing is sent;
ChainAim's control plane then verifies that record before it signs the receipt. Real values return only on the tenant's
machine, and one signed receipt binds the price, both signatures, the payment and the proof. Private by design, and
proven."**

*Caption:* Enterprise-grade privacy tokenization · ChainAim domain templates · re-checked, fail-closed

### 2:28 – 2:37 · Money back if privacy is not proven (pre-recorded clip)
- **Left (8730):** highlight: Settled on NEAR ↗ · **Refused: privacy not proven → refunded ✓** · open the refund
  transaction.
- **Right (8800):** Ledger: the refund leaves the seller wallet; the job row is never released.

**"If privacy cannot be proven, the job is refused and the money goes back to the buyer on NEAR, with a signed refund
record."**

*Caption:* If privacy is not proven, you get your money back

### 2:37 – 2:52 · Running totals, in the open
- **Left (8730):** tab 03 **What the chain shows** for this job (payer, amount, time; the question and data are not on
  chain) and its nearblocks link.
- **Right (8800):** Ledger and Seller wallet · the nearblocks page for `chainaim-payto-seller.testnet` · a roadmap card:
  aggregates on chain, ZK-PRET on Mina.

**"Every payment and every refund is on NEAR, while the questions and the data stay private. On the roadmap: aggregate
views on chain, and ChainAim's ZK-PRET engine, with composed zero-knowledge proofs for business data and processes on
o1Labs' Mina Protocol, for inter-chain integration."**

*Caption:* Live: every payment and refund on NEAR · Roadmap: on-chain aggregates, ZK-PRET on Mina

### 2:52 – 2:58 · Close
- **Left and right:** closing card: *Outcome AI from ChainAim* · tagline · *Verify it yourself, no keys needed* ·
  github.com/chainaimdev/ChainAim-Private-Outcome-AI · github.com/chainaimdev/chainaim-adminUI-NEAR.

**"Private data. Exact numbers. A budget you control. Outcome AI from ChainAim: pay for verified outcomes, not tokens."**

*Caption:* Pay for verified outcomes, not tokens.

---

## 4. Wording rules (unchanged)

- Never say "HIPAA compliant", "a separate server" or "refunded instantly"; never call the payment private (payer,
  amount and time are public on NEAR; the content isn't).
- Say "the price is never discounted, only the job shrinks" for the negotiation; it is one round, not open bargaining.
- Dental and chiro are exact local use cases, not NEAR-paid jobs. ZK-PRET/Mina and on-chain aggregates are roadmap.

## 5. After recording

- Replace `DEMO/outcome-ai-near-demo-2m30.mp4` with the new video (or add it as `outcome-ai-near-demo-2m58.mp4`) and
  update the README demo line; then attach it to the X post (@NEARProtocol, #NEARHackathon).

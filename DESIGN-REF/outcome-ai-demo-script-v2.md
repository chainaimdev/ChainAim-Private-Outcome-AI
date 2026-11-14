# Outcome AI from ChainAim: demo script v2

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

Version history:
- **v2, 2026-11-13 local (2026-11-14 UTC)**, this file (chat near-ai-impl-14), owner's refinements on top of v1:
  - Opening: AI acting on large volumes of sensitive data; frontier AI asks for trust with data and budget and charges per token whatever the result; Outcome AI brings accountable models to local data, at a cost that scales, with proof for every answer.
  - Left/right framing: the agent buys answers about private data (operations, health, finance, what-ifs); the right side matches every answer to its NEAR payment, with a receipt anyone can rely on without seeing the data.
  - Pricing scene names domain templates and context caps; "What the buyer signed is exactly what runs".
  - De-identification spelled out: personal and health data tokenized, card numbers removed, real values restored only on the tenant's machine.
  - Refund: "the money goes back to the buyer".
  - Roadmap line: aggregate views on chain and ChainAim's ZK proof engine (ZK-PRET) for business data and processes.
  - 326 spoken words, about 2:07.
- v1 = `script-nov-13-4.md` (earlier series: script-nov-13-1..3).

Narrated player: `docs/judge/demo-script-player-v2.html` (v1 player: `docs/judge/demo-script-player.html`).

Wording kept accurate to the code: the receipt is signed by ChainAim and checked offline; only the payment and refund are on NEAR (not the receipt, not the content). Card numbers are removed, not tokenized. Admin console labels are carried over from v3 and must be checked on screen before recording (admin repo not connected).

## The script

### 0:00 – 0:22 · The problem
- **Left:** Title card: Outcome AI from ChainAim · Pay for verified outcomes, not tokens.
- **Right:** (same title card)

**"Regulated businesses sit on large volumes of sensitive data and need AI to act on it. Frontier AI asks them to trust it with their data and their budget, and to pay per token, whatever the result. Outcome AI from ChainAim brings accountable models to local data, at a cost that scales, with proof for every answer."**

*Caption:* **Local data · accountable models · proof for every answer**

### 0:22 – 0:38 · Two apps
- **Left:** Tab 03, dataset and agent t01 chosen.
- **Right:** NEAR Admin Console: Jobs tab, each job matched to its NEAR payment; block height ticking.

**"On the left, a company's AI agent buys answers about its private data: operations, health, finance, what-ifs. On the right, every answer is matched to its payment on NEAR, with a receipt anyone can rely on, without seeing the data."**

*Caption:* **The buyer's desk · the auditor's console**

### 0:38 – 0:52 · A firm price before any work
- **Left:** Press Ask. Highlight: Quoted 0.02 USDC · Quote signed by ChainAim ✓ · Signed limits checked ✓ (zoom).
- **Right:** Jobs: the new job appears as quoted.

**"ChainAim prices the job from the file sizes and signs its terms and limits, using domain templates and context caps suited to the data and the answer needed. What the buyer signed is exactly what runs."**

*Caption:* **What the buyer signed is exactly what runs**

### 0:52 – 1:03 · Funded on NEAR, fair to both sides
- **Left:** Highlight: Spending policy ✓ · Checkout mandate signed ✓ · Settled on NEAR ↗ · Mandate verified by ChainAim's signer ✓
- **Right:** Ledger: the USDC transfer arrives from the chain.

**"The agent checks the price against its company's rules, signs a mandate for this one payment, and funds the job in USDC on NEAR. Fair to both sides."**

*Caption:* **Two signatures: ChainAim signs the price, your agent signs the payment**

### 1:03 – 1:19 · Compute first, model last
- **Left:** Highlight: Result released · AI proof ✓ 1 of 1 NEAR AI call verified · the answer.
- **Right:** Jobs row: released, attested ✓. Expand: TDX, GPU and signature checks.

**"Compute first, model last. An exact query runs over the chosen dataset, next to the data, with no model at all. Then one small call, inside a hardware-sealed NEAR AI enclave, words the result, for under a twentieth of a cent."**

*Caption:* **Deterministic compute on your PC · 1 attested NEAR AI call · under $0.0005**

### 1:19 – 1:36 · Proof you can check
- **Left:** Highlight: Every number checked · What left your PC: 1 model call · Signed receipt ✓
- **Right:** Jobs: signed quote ✓, receipt ✓ · Reconcile: matched · Seller wallet: books agree.

**"Every figure is checked. Before anything left the tenant's machine, personal and health data were tokenized and card numbers removed; real values are restored only there. One signed receipt binds the price, both signatures, the payment and the proof. Private by design, and proven."**

*Caption:* **De-identified before it leaves · restored only on your machine**

### 1:36 – 1:45 · Money back if privacy is not proven
- **Left:** Separate clip. Highlight: Settled on NEAR ↗ · Refused: privacy not proven → refunded ✓ · open the refund transaction.
- **Right:** Ledger: the refund leaves the seller wallet.

**"If privacy cannot be proven, the job is refused and the money goes back to the buyer on NEAR, with a signed refund record."**

*Caption:* **If privacy is not proven, you get your money back**

### 1:45 – 2:00 · Running totals, in the open
- **Left:** Tab 03 jobs list for the session.
- **Right:** Ledger and seller wallet totals · nearblocks page for chainaim-payto-seller.testnet.

**"Every job adds up in the open: every payment and every refund is on NEAR, while the questions and the data stay private. Next: aggregate views on chain, and ChainAim's ZK proof engine for business data and processes."**

*Caption:* **Every payment and refund on NEAR · ZK proofs next**

### 2:00 – 2:07 · Close
- **Left:** Closing card: Outcome AI from ChainAim · tagline · Verify it yourself, no keys needed · repo URL.
- **Right:** (same closing card)

**"Private data. Exact numbers. A budget you control. Outcome AI from ChainAim: pay for verified outcomes, not tokens."**

*Caption:* **Pay for verified outcomes, not tokens.**

## Before recording

- Start: `.\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified`, wait for `READY`.
- Space paid jobs 1–2 minutes apart (the public NEAR testnet RPC rate-limits back-to-back payments).
- The refund clip is recorded separately: `-StopService ca-attest`, one paid job, then `-StartService ca-attest`.
- A real run takes about 49 s and a refund about 17 s: cut the waits.

## Wording rules

- "every NEAR AI call attested", never "every AI call"; never "HIPAA compliant".
- Never call the payment private: payer, amount and time are public on NEAR.
- Say "funded" or "pays up front"; avoid "ChainAim never works unpaid".

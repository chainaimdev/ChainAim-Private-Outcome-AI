# Outcome AI from ChainAim: 2-minute demo script (v4)

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

Version history:
- **v4, 2026-11-13 (local; 2026-11-14 UTC)**, this file (chat near-ai-impl-14):
  - Opens with the Org-Chart-vLEI-Bala-2 positioning: regulated businesses need intelligence from large, sensitive data; frontier AI asks them to trust it with their data, their numbers and their budget.
  - Payment framed as fair to both sides ("funded on NEAR", money straight back if not delivered), not as protection for ChainAim.
  - "Private by design" spoken once, where the proof is on screen (1:06).
  - Budget and deterministic compute made explicit (0:46): exact query next to the data, one small attested model call.
  - New beat: running totals in the open (1:36).
  - Close names the modular path: dedicated cloud services, enclave workloads on NEAR or Phala, full ZK-PRET integration.
  - 307 spoken words.
- v3 (`script-nov-13-3.md`): cost highlight, Org-Chart positioning, "Outcome AI from ChainAim".
- v2 (`script-nov-13-2.md`): highlights cut. v1 (`script-nov-13-1.md`): full v2.1.1 script.

Narrated player for rehearsal: `docs/judge/demo-script-player.html` (browser voices; Indian, US or UK English).

Not re-checked in this version (admin repo not connected): the admin console labels "Ledger", "Reconcile: matched" and "Seller wallet: books agree" are carried over from v3. Check them on screen before recording.

Cost line: under a twentieth of a cent per NEAR AI call is from the receipts (0.000445 USD on job b277f065…, 0.000415 USD on job a5bd2720…).

| Left: **127.0.0.1:8730 Private AI Desk** | Right: **127.0.0.1:8800 NEAR Admin Console** |
|---|---|
| A company's AI agent buys answers about its own private data | ChainAim's operator, or an auditor, checks every payment against NEAR |

## The script

### 0:00 – 0:12 · The problem
- **Left:** Title card: Outcome AI from ChainAim · Pay for verified outcomes, not tokens.
- **Right:** (same title card)

**"Regulated businesses sit on large volumes of sensitive data and need intelligence from it. Frontier AI asks them to trust it with their data, their numbers and their budget. Outcome AI from ChainAim replaces that trust with proof."**

*Caption:* **Data. Numbers. Budget. Proof instead of trust.**

### 0:12 – 0:22 · Two apps
- **Left:** Tab 03, dataset and agent t01 chosen.
- **Right:** NEAR Admin Console, Jobs tab, block height ticking.

**"On the left, a company's AI agent buys answers about its own books. On the right, an auditor checks every payment, without ever seeing the data."**

*Caption:* **The buyer's desk · the auditor's console**

### 0:22 – 0:34 · A firm price before any work
- **Left:** Press Ask. Highlight: Quoted 0.02 USDC · Quote signed by ChainAim ✓ · Signed limits checked ✓ (zoom).
- **Right:** Jobs: the new job appears as quoted.

**"Before anything runs, ChainAim prices the job from the file sizes, two cents, and signs its limits. What you signed is exactly what runs."**

*Caption:* **What you signed is exactly what runs**

### 0:34 – 0:46 · Funded on NEAR, fair to both sides
- **Left:** Highlight: Spending policy ✓ · Checkout mandate signed ✓ · Settled on NEAR ↗ · Mandate verified by ChainAim's signer ✓
- **Right:** Ledger: the USDC transfer arrives from the chain.

**"The agent checks the price against its company's rules, signs a mandate for this one payment, and funds the job in USDC on NEAR. If the outcome is not delivered, the money goes straight back. Fair to both sides."**

*Caption:* **Two signatures: ChainAim signs the price, your agent signs the payment**

### 0:46 – 1:06 · Compute first, model last
- **Left:** Highlight: Result released · AI proof ✓ 1 of 1 NEAR AI call verified · the answer.
- **Right:** Jobs row: released, attested ✓. Expand: TDX, GPU and signature checks.

**"Compute first, model last. The heavy lifting is deterministic: an exact query over the whole ledger, next to the data, with no model at all. Then one small call, inside a hardware-sealed NEAR AI enclave, words the result, for under a twentieth of a cent. Intelligence from large data, on a budget you control."**

*Caption:* **Deterministic compute on your PC · 1 attested NEAR AI call · under $0.0005**

### 1:06 – 1:22 · Proof you can check
- **Left:** Highlight: Every number checked · What left your PC: 1 model call · Signed receipt ✓
- **Right:** Jobs: signed quote ✓, receipt ✓ · Reconcile: matched · Seller wallet: books agree.

**"Every figure is checked. Personal data was tokenized before anything left, the desk shows exactly what left, and one signed receipt binds the price, both signatures, the payment and the proof. Private by design, and proven."**

*Caption:* **See exactly what left your PC, without seeing the content**

### 1:22 – 1:36 · Money back if privacy is not proven
- **Left:** Separate clip. Highlight: Settled on NEAR ↗ · Refused: privacy not proven → refunded ✓ · open the refund transaction.
- **Right:** Ledger: the refund leaves the seller wallet.

**"If privacy cannot be proven, the job is refused and the money goes back on NEAR, with a signed refund record. You never pay for an outcome you did not get."**

*Caption:* **If privacy is not proven, you get your money back**

### 1:36 – 1:48 · Running totals, in the open
- **Left:** Tab 03 jobs list for the session.
- **Right:** Ledger and seller wallet totals · nearblocks page for chainaim-payto-seller.testnet.

**"Every job adds up in the open: every payment and every refund is on NEAR, while the questions and the data stay private."**

*Caption:* **Every payment and refund on NEAR · no content on chain**

### 1:48 – 2:00 · Close
- **Left:** Closing card: Outcome AI from ChainAim · tagline · Verify it yourself, no keys needed · repo URL.
- **Right:** (same closing card)

**"Private data. Exact numbers. A budget you control. Built in modules, ready for dedicated cloud services, enclave workloads on NEAR or Phala, and full ZK-PRET integration. Outcome AI from ChainAim: pay for verified outcomes, not tokens."**

*Caption:* **Pay for verified outcomes, not tokens.**

## Before recording

- Start: `.\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified` and wait for `READY`.
- Space paid jobs one to two minutes apart: the public NEAR testnet RPC rate-limits back-to-back payments.
- The refund clip (1:22) is recorded separately: stop ca-attest with `.\test-console\desk.ps1 -StopService ca-attest`, run one paid job, then `-StartService ca-attest`.
- A real run takes about 49 s and a refund about 17 s: cut the waits.

## Wording rules

- "every NEAR AI call attested", never "every AI call"; never "HIPAA compliant".
- Lead with what stays private; never call the payment private (payer, amount and time are public on NEAR).
- Say "funded" or "pays up front"; avoid "ChainAim never works unpaid".

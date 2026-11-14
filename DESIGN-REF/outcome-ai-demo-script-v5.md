# Outcome AI from ChainAim: demo script v5

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

Version history:
- **v5, 2026-11-13 local**, this file: the compute scene says the enclave call "words or reasons on the result, for a micropayment" (owner wording; the measured NEAR AI cost per call is 0.000415–0.000445 USD).
- **v4**: "cost-effectively" (not "at a cost that scales"); "next to the data, with no model at all" removed; de-identification spelled out: PII/PHI tokenized with Microsoft Presidio + ChainAim detectors, PCI card numbers removed (never restored, services/gateway/src/privacy/entities.ts:47), a second scan re-checks the masked text and fails closed (gateway residual check, chat.ts), the signed receipt records it. The re-check runs on the tenant's machine, not the control plane (the control plane never sees text).
  - 365 spoken words, about 2:22.
- v3 (`outcome-ai-demo-script-v3.md`): spec names, roadmap items, ZK-PRET on Mina.
- **v3, 2026-11-13 local (2026-11-14 UTC)**, this file (chat near-ai-impl-14):
  - Opening: frontier AI asks for trust with their practices, their security and their budget.
  - Standards named where they run: AP2 quote signed with ES256; AP2 checkout mandate for one payment; x402 payment settled as a NEP-141 USDC transfer relayed as a NEP-366 meta-transaction; NEAR AI enclave attested with Intel TDX and NVIDIA GPU evidence.
  - Roadmap stated as roadmap: aggregate views on chain; ZK-PRET (composed zero-knowledge proofs for business data and processes on o1Labs' Mina Protocol, for inter-chain integration).
  - 354 spoken words, about 2:17.
- v2 (`outcome-ai-demo-script-v2.md`), v1 (`script-nov-13-4.md`).

Narrated player: `docs/judge/demo-script-player-v5.html`.

Source of each spec claim: ES256 AP2 quotes (up.ps1 start line "AP2 signed quotes on: whole-cent quotes signed ES256"); AP2 checkout mandate (design-36, live 2026-11-13); x402 upfront + NEP-141 ft_transfer to payTo (@x402/near facilitator, design-37); NEP-366 relayer (paywall relayer pays the gas); Intel TDX + NVIDIA GPU checks (ca-attest, -AttestGpuCheck on). Live today: everything except the two roadmap items in the 1:48 scene. Admin console labels carried over from v3 of the earlier series; check them on screen.

## The script

### 0:00 – 0:22 · The problem
- **Left:** Title card: Outcome AI from ChainAim · Pay for verified outcomes, not tokens.
- **Right:** (same title card)

**"Regulated businesses sit on large volumes of sensitive data and need AI to act on it. Frontier AI asks them to trust it with their practices, their security and their budget, and to pay per token, whatever the result. Outcome AI from ChainAim brings accountable models to local data, cost-effectively, with proof for every answer."**

*Caption:* **Local data · accountable models · proof for every answer**

### 0:22 – 0:37 · Two apps
- **Left:** Tab 03, dataset and agent t01 chosen.
- **Right:** NEAR Admin Console: Jobs tab, each job matched to its NEAR payment; block height ticking.

**"On the left, an AI agent buys answers about its company's private data: operations, health, finance, what-ifs. On the right, each answer is matched to its NEAR payment, with a receipt anyone can rely on, without seeing the data."**

*Caption:* **The buyer's desk · the auditor's console**

### 0:37 – 0:53 · A firm price before any work
- **Left:** Press Ask. Highlight: Quoted 0.02 USDC · Quote signed by ChainAim ✓ · Signed limits checked ✓ (zoom).
- **Right:** Jobs: the new job appears as quoted.

**"ChainAim prices the job from the file sizes and signs its terms and limits as an AP2 quote, signed with ES256, with domain templates and context caps suited to the data and the question. What the buyer signed is exactly what runs."**

*Caption:* **What the buyer signed is exactly what runs**

### 0:53 – 1:08 · Funded on NEAR, fair to both sides
- **Left:** Highlight: Spending policy ✓ · Checkout mandate signed ✓ · Settled on NEAR ↗ · Mandate verified by ChainAim's signer ✓
- **Right:** Ledger: the USDC transfer arrives from the chain.

**"The agent checks the price against its company's rules, signs an AP2 checkout mandate for this one payment, and funds the job over x402: a NEP-141 USDC transfer on NEAR, relayed as a NEP-366 meta-transaction. Fair to both sides."**

*Caption:* **AP2 quote + AP2 mandate · x402 · NEP-141 USDC · NEP-366 relayer**

### 1:08 – 1:24 · Compute first, model last
- **Left:** Highlight: Result released · AI proof ✓ 1 of 1 NEAR AI call verified · the answer.
- **Right:** Jobs row: released, attested ✓. Expand: TDX, GPU and signature checks.

**"Compute first, model last. An exact query runs over the chosen dataset on the tenant's machine. Then one small call, inside a NEAR AI enclave attested with Intel TDX and NVIDIA GPU evidence, words or reasons on the result, for a micropayment."**

*Caption:* **Deterministic compute on your PC · 1 TDX + GPU attested NEAR AI call · under $0.0005**

### 1:24 – 1:48 · Proof you can check
- **Left:** Highlight: Every number checked · What left your PC: 1 model call · Signed receipt ✓
- **Right:** Jobs: signed quote ✓, receipt ✓ · Reconcile: matched · Seller wallet: books agree.

**"Every figure is checked. Before anything leaves the machine, PII and PHI are tokenized with Microsoft Presidio and ChainAim's own detectors, and PCI card numbers are removed. A second scan re-checks the masked text, and if anything remains, nothing is sent. The receipt ChainAim signs records that check, and real values return only on the tenant's machine. Private by design, and proven."**

*Caption:* **PII/PHI tokenized · PCI removed · re-scanned before sending, fail-closed**

### 1:48 – 1:57 · Money back if privacy is not proven
- **Left:** Separate clip. Highlight: Settled on NEAR ↗ · Refused: privacy not proven → refunded ✓ · open the refund transaction.
- **Right:** Ledger: the refund leaves the seller wallet.

**"If privacy cannot be proven, the job is refused and the money goes back to the buyer on NEAR, with a signed refund record."**

*Caption:* **If privacy is not proven, you get your money back**

### 1:57 – 2:14 · Running totals, in the open
- **Left:** Tab 03 jobs list for the session.
- **Right:** Ledger and seller wallet · nearblocks page for chainaim-payto-seller.testnet · roadmap card: aggregates on chain, ZK-PRET on Mina.

**"Every payment and every refund is on NEAR, while the questions and the data stay private. On the roadmap: aggregate views on chain, and ChainAim's ZK-PRET engine, with composed zero-knowledge proofs for business data and processes on o1Labs' Mina Protocol, for inter-chain integration."**

*Caption:* **Live: every payment and refund on NEAR · Roadmap: on-chain aggregates, ZK-PRET on Mina**

### 2:14 – 2:21 · Close
- **Left:** Closing card: Outcome AI from ChainAim · tagline · Verify it yourself, no keys needed · repo URL.
- **Right:** (same closing card)

**"Private data. Exact numbers. A budget you control. Outcome AI from ChainAim: pay for verified outcomes, not tokens."**

*Caption:* **Pay for verified outcomes, not tokens.**

## Before recording

- Start: `.\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified`, wait for `READY`.
- Space paid jobs 1–2 minutes apart (public NEAR testnet RPC rate limit).
- Refund clip separately: `-StopService ca-attest`, one paid job, `-StartService ca-attest`.
- Cut the waits: a run takes about 49 s, a refund about 17 s.

## Wording rules

- "every NEAR AI call attested", never "every AI call"; never "HIPAA compliant".
- Never call the payment private: payer, amount and time are public on NEAR.
- Roadmap items are said as roadmap; never present them as live.

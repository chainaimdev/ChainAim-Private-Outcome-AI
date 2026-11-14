# Outcome AI from ChainAim: 2-minute demo script (v3, highlights cut)

**Outcome AI from ChainAim. Pay for verified outcomes, not tokens. Private by design, proven on NEAR. If privacy isn't
proven, you get your money back.**

Version history:
- **v3, 2026-11-13** (this file)
  - Adds the cost highlight: compute first, model last, with the real per-job figures.
  - Adds the Org-Chart-vLEI-Bala-2 positioning and the name "Outcome AI from ChainAim".
  - Positive wording for "pay up front", with protection for both sides.
  - Trimmed to about 300 spoken words.
- v2 (`script-nov-13-2.md`): the highlights cut.
- v1 (`script-nov-13-1.md`): the full v2.1.1 script.

Written against private-ai **v2.1.2** (`b739214`):
- Every quoted on-screen line is the code's own wording (`paid-jobs.html`, `index.html`).
- The cost figures are from `docs/judge/sample-receipt-2026-11-13T1716Z.json`.

| Left: **127.0.0.1:8730 Private AI Desk** | Right: **127.0.0.1:8800 NEAR Admin Console** |
|---|---|
| A company's AI agent buys answers about its own private data | ChainAim's operator, or an auditor, checks every payment against the NEAR chain |

---

## The positioning (from Org-Chart-vLEI-Bala-2), and where each line lands

| Frontier-AI blocker | Outcome AI from ChainAim | Spoken at |
|---|---|---|
| Data leaves your control | Tokenized on your PC (PII and PHI) and card data removed, before any model sees it | 0:44 |
| Hallucinated numbers | Computed exactly next to the data; the model only words them; every figure checked | 0:44, 1:04 |
| Unpredictable cost | **Compute first, model last**: one small attested call, under a twentieth of a cent | 0:44 |
| Paying for effort, not results | A firm, signed price before any work; money back if it can't be delivered | 0:20, 1:20 |
| "Trust me" infrastructure | NEAR AI enclave proof verified before release; every payment matched on NEAR | 0:44, 1:04 |
| Agents can't buy safely | Signed limits plus a Checkout Mandate for exactly one payment | 0:20, 0:32 |

## The six highlights (each one has a spoken punchline)

| # | Punchline | Proof on screen |
|---|---|---|
| 1 | "What you signed is exactly what runs." | "Signed limits checked ✓ · … what you signed is exactly what runs" |
| 2 | "Once the mandate is confirmed, the work begins." | "Settled on NEAR · ↗", then "Mandate verified by ChainAim's signer ✓" |
| 3 | **"Compute first, model last."** (cost) | "Result released: … row(s)"; receipt: 1 model call, NEAR AI cost $0.000445 |
| 4 | Private and proven | "AI proof: ✓ 1 of 1 NEAR AI call(s) verified" |
| 5 | "See exactly what left your PC, without seeing the content." | "What left your PC: 1 model call. Your data files and their rows stay on your PC…" |
| 6 | "Both sides are protected. You never pay for a failed job." | "Refused: privacy not proven (…) → refunded ✓ (record signed by ChainAim, verified by the agent) · ↗" |

---

## Before recording (short)

1. Restart the stack fresh, in upfront mode with only verified inference paid for:
   `.\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified`
2. Do one successful paid job off camera, and run `-VerifyReceipt` on its receipt. This is the first live proof since
   the attest-rule change, so do it before you record.
3. **Left, tab 03:**
   - Dataset: **Small Biz Financials - 2 (ERPNext)**
   - Template: **Biggest payments out**
   - Who pays?: **AI agent, t01**
   - Mode: **Estimate first**
   - Model: an attested NEAR AI model
4. **Right:** the Jobs tab, with the road chips live.
5. Record at 1080p and 110% browser zoom, with a cursor highlight.
6. **Edit, don't play it straight.** Cut the ~49 s run wait and the ~17 s refund wait to fit the voice-over.
7. Record the money-back clip (1:22) separately:
   - After "Quoted" appears, run `-StopService attest`.
   - Let the run finish, then run `-StartService attest`.

---

---

## The script (2:00, about 300 spoken words)

### 0:00 – 0:10 · The problem
- **Both halves:** a title card: *"Outcome AI from ChainAim. Pay for verified outcomes, not tokens."*

**"Frontier AI asks a business to trust it with its data, its numbers and its budget. Outcome AI from ChainAim replaces
that trust with proof."**

### 0:10 – 0:20 · Two apps
- **Left:** tab 03, with the dataset and agent t01 chosen.
- **Right:** the Jobs tab, the road chips live, the block height ticking.

**"On the left, the Private AI Desk: a company's AI agent buys answers about its own private data, operations,
financials, patient records. On the right, the NEAR Admin Console audits every payment without ever seeing that data."**

### 0:20 – 0:32 · A signed price, signed limits
- **Left:** press **Ask**, then highlight:
  - "Quoted 0.02 USDC on near:testnet to …"
  - "Quote signed by ChainAim ✓ · … price, payee and network match"
  - **"Signed limits checked ✓ · … what you signed is exactly what runs"** (zoom in)

**"The agent asks for the biggest payments out. ChainAim's signer prices the job from file sizes, two cents, and signs
its limits. What you signed is exactly what runs."**

*Caption:* **What you signed is exactly what runs**

### 0:32 – 0:44 · The agent pays up front
- **Left:** highlight:
  - "Spending policy: pay ✓ · quote still valid ✓ · attested route ✓ …"
  - "Checkout mandate signed ✓ · … permits exactly this signed quote, for this payment only"
  - **"Settled on NEAR · ↗"**
  - "Mandate verified by ChainAim's signer ✓"
- **Right:** the new USDC transfer arrives from the chain (Ledger tab).

**"The agent checks the price against its company's rules, signs permission for this one payment, and pays up front in
USDC on NEAR. Once the mandate is confirmed, the work begins."**

*Caption:* **Two signatures: ChainAim signs the price, your agent signs the payment**

### 0:44 – 1:04 · Compute first, model last: private, exact, low-cost, proven
- **Left:** highlight:
  - "Result released: … row(s)"
  - **"AI proof: ✓ 1 of 1 NEAR AI call(s) verified"**
  - the answer
- **Right:** the Jobs row shows **released** and **attested ✓**. Expand it to show the TDX / GPU / signature checks.

**"Compute first, model last. The two-megabyte ledger is computed exactly, on this PC, next to the data. Personal and
health data are tokenized by Microsoft Presidio, and card data is removed. Then one small call, inside a hardware-sealed
NEAR AI enclave, words the result, for under a twentieth of a cent. The answer is released only after the enclave's
proof is verified."**

*Caption:* **Compute first, model last · 2 MB computed on your PC · 1 attested NEAR AI call · $0.0004**

### 1:04 – 1:20 · What left your PC, one receipt, books that agree
- **Left:** highlight:
  - "Every number in this answer was checked against the computed result and found there."
  - **"What left your PC: 1 model call. Your data files and their rows stay on your PC…"**
  - "Signed receipt ✓"
- **Right:**
  - Jobs: *signed quote* ✓, *receipt* ✓
  - **Reconcile:** matched
  - **Seller wallet:** Books agree

**"Every figure is checked. The desk shows exactly what left the PC, without showing the content, and one signed receipt
binds the price, both signatures, the payment and the proof. On the right: Jobs, attested. Reconcile, matched to the
NEAR transaction. Seller wallet, the books agree."**

*Caption:* **See exactly what left your PC, without seeing the content**

### 1:20 – 1:38 · Money back if privacy isn't proven (separate clip)
- **Left:** highlight:
  - "Settled on NEAR · ↗"
  - **"Refused: privacy not proven (…) → refunded ✓ (record signed by ChainAim, verified by the agent) · ↗"**
  - open the refund transaction link

**"And if privacy can't be proven? The job is refused, and the money goes back to the customer's agent on NEAR, with a
refund record signed by ChainAim. Both sides are protected. You never pay for a failed job."**

*Caption:* **If privacy isn't proven, you get your money back**

### 1:38 – 2:00 · Close
- **Both halves:** a closing card:
  - *"Outcome AI from ChainAim"*
  - the tagline
  - *"Verify it yourself, no keys needed"*
  - the repo URL

**"Private data. Exact numbers. Two cents an answer, and your money back if privacy isn't proven. Outcome AI from
ChainAim: pay for verified outcomes, not tokens."**

---

## Q&A one-liners (not in the video)

- **"Where does the cost saving come from?"** Compute first, model last.
  - The exact work runs on the PC, next to the data: DuckDB over a 2 MB ledger.
  - The model only words at most 50 result rows, in one call.
  - The judge sample receipt shows a 0.02 USDC price against a total cost of $0.0024: NEAR AI $0.000445, call fees
    $0.001, analyst $0.002, gas $0.002, margin $0.0176, overrun absorbed $0.
  - That job actually ran for $0.01, under its quote.

- **"Is it a real business?"** The receipt carries the money trail: what you paid, what the NEAR AI call cost, gas, and
  ChainAim's margin. Anyone can check it offline with `node scripts/verify-receipt.ts`. *"One receipt shows what you
  paid, what it cost us, and what we earned."*
- **"Does the refund really happen?"** Yes, on testnet:
  - the recorded run on 2026-11-13: refund `EyD53Bnv…7TF`, final about 17 s after the refusal
  - two genuine refusals on the same day, both refunded (jobs `b7441232…` and `01467fe8…`)
  - `desk.ps1 -Refunds` lists them all
- **"Can the agent overspend?"** No. It enforces per-job and per-day limits and an attested route only, and the tenant's
  own key signs a Checkout Mandate for exactly one payment.
- **"Who sees the data?"** Only the company's PC sees it unmasked. 8800 and the chain see ids, amounts and hashes, never
  the question, a file or the answer.

## Wording rules (keep these exact)

- Say "unmasked only on your own machine". A hosted gateway in a TEE is roadmap.
- Say "this job's NEAR AI call was attested", never "every AI call".
- Say "refunded on NEAR", never "refunded instantly".
- Say "a separate signer service", not "a separate server".
- Never call the payment private: the payer, amount and time are public on NEAR. The **content** stays private.
- Never say "HIPAA compliant". The books are synthetic demo data.
- Say "**Outcome AI from ChainAim**" for the product.
- The NEAR AI models run in NEAR AI Cloud enclaves (TDX + GPU), **not** on the PC. The PC does the masking and the exact
  computation, and the model is private and attested remotely. Never say "local NEAR models".
- Cost: say "compute first, model last", "under a twentieth of a cent" for the NEAR AI call, and "two cents an answer".
  Don't claim a percentage saving against frontier AI. No comparison has been measured.
- Say "every AI call attested, every payment matched on NEAR", not "every step proven on NEAR". The gateway is not in a
  TEE yet.

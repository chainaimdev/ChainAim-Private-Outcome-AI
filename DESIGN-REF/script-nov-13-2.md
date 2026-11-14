# Outcome AI on NEAR: 2-minute demo script (highlights cut, v2.1.2)

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR. If privacy isn't proven, you get your money back.**

Written on 2026-11-13 against private-ai **v2.1.2** (`b739214`, the v2.1.1 code plus a log update).
- Replaces `script-nov-13-1.md` for recording.
- Every quoted line on screen is the code's own wording (`test-console/console/paid-jobs.html`, `index.html`).
- This cut shows only the highlights. Behind-the-scenes detail and edge cases are in `script-nov-13-1.md` and
  `docs/judge/demo-script-2026-11-13T1730Z.md`.

| Left: **127.0.0.1:8730 Private AI Desk** | Right: **127.0.0.1:8800 NEAR Admin Console** |
|---|---|
| A company's AI agent buys answers about its own books | ChainAim's operator, or an auditor, checks every payment against the NEAR chain |

---

## The five highlights (each one gets a spoken punchline)

| # | Punchline (spoken) | Proof on screen |
|---|---|---|
| 1 | **"What you signed is exactly what runs."** | "Signed limits checked ✓ · … what you signed is exactly what runs" |
| 2 | **"As soon as the payment settles and the checkout mandate is confirmed, the work begins."** | "Settled on NEAR · ↗", then "Mandate verified by ChainAim's signer ✓" |
| 3 | **Private, exact, proven** | "AI proof: ✓ 1 of 1 NEAR AI call(s) verified", then "Every number in this answer was checked…" |
| 4 | **"See exactly what left your PC, without seeing the content."** | "What left your PC: 1 model call. Your data files and their rows stay on your PC…" |
| 5 | **"If privacy isn't proven, you get your money back. You never pay for a failed job."** | "Refused: privacy not proven (…) → refunded ✓ (record signed by ChainAim, verified by the agent) · ↗" |

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

## The script (2:00, about 260 spoken words)

### 0:00 – 0:10 · The problem
- **Both halves:** a title card: *"Pay for verified outcomes, not tokens."*

**"Frontier AI asks a business to trust it with its data, its numbers and its budget. Outcome AI asks for none of that."**

### 0:10 – 0:20 · Two apps
- **Left:** tab 03, with the dataset and agent t01 chosen.
- **Right:** the Jobs tab, the road chips live, the block height ticking.

**"On the left, the Private AI Desk, where a company's AI agent buys answers about its own private data: operations,
financials, patient records, what-ifs. On the right, the NEAR Admin Console, auditing every payment on
the blockchain without ever seeing that data."**

### 0:20 – 0:34 · Highlight 1: a signed price, signed limits
- **Left:** press **Ask**, then highlight:
  - "Quoted 0.02 USDC on near:testnet to …"
  - "Quote signed by ChainAim ✓ · … price, payee and network match"
  - **"Signed limits checked ✓ · … what you signed is exactly what runs"** (zoom in on this one)

**"The company's agent asks a private question of its own books: the biggest payments out. ChainAim's signer prices the job from file sizes, two cents, and signs
its limits: the model, the calls, the tokens. What you signed is exactly what runs."**

*Caption:* **What you signed is exactly what runs**

### 0:34 – 0:48 · Highlight 2: the agent pays up front
- **Left:** highlight:
  - "Spending policy: pay ✓ · quote still valid ✓ · attested route ✓ …"
  - "Checkout mandate signed ✓ · … permits exactly this signed quote, for this payment only"
  - **"Settled on NEAR · ↗"**
- **Right:** the new USDC transfer arrives from the chain (Ledger tab).

**"The agent checks the price against its company's spending rules, signs permission for this one payment, and pays up
front in USDC on NEAR. As soon as the payment settles and ChainAim's signer confirms the checkout mandate, the work
begins."**

*Caption:* **Two signatures: ChainAim signs the price, your agent signs the payment**

### 0:48 – 1:06 · Highlight 3: private, exact, proven
- **Left:** highlight:
  - "Mandate verified by ChainAim's signer ✓"
  - **"AI proof: ✓ 1 of 1 NEAR AI call(s) verified"**
  - "Result released: … row(s)"
  - the answer
  - "Every number in this answer was checked against the computed result and found there."
- **Right:** the Jobs row shows **released** and **attested ✓**. Expand it to show the TDX / GPU / signature checks.

**"Now the job runs. Personal and health data, PII and PHI, is replaced with privacy tokens on this PC by Microsoft
Presidio, and restored only in your answer, on this PC. Card data, PCI, is removed for good. The model sees only tokens,
inside a hardware-sealed NEAR AI enclave, and the answer is released only after that enclave's proof is verified. Every figure is computed exactly,
and checked."**

*Caption:* **Masked on your PC → NEAR AI enclave (Intel TDX + NVIDIA GPU) → proof verified → released**

### 1:06 – 1:22 · Highlight 4: what left your PC, one receipt, books that agree
- **Left:** highlight:
  - **"What left your PC: 1 model call. Your data files and their rows stay on your PC…"**
  - "Signed receipt ✓"
- **Right:**
  - Jobs: *signed quote* ✓, *receipt* ✓
  - **Reconcile:** matched
  - **Seller wallet:** Books agree

**"The desk shows exactly what left the PC, without showing the content. One signed receipt binds the price, both
signatures, the payment and the proof. On the right, the Jobs tab: attested. Reconcile: matched to the NEAR transaction. Seller wallet: the books agree."**

*Caption:* **See exactly what left your PC, without seeing the content**

### 1:22 – 1:40 · Highlight 5: money back if privacy isn't proven (separate clip)
- **Left:** highlight:
  - "Settled on NEAR · ↗"
  - **"Refused: privacy not proven (…) → refunded ✓ (record signed by ChainAim, verified by the agent) · ↗"**
  - open the refund transaction link

**"And if privacy can't be proven? The job is refused, and the money goes back to the agent on NEAR, with a refund
record signed by ChainAim. You never pay for a failed job."**

*Caption:* **If privacy isn't proven, you get your money back**

### 1:40 – 2:00 · Close
- **Both halves:** a closing card with the tagline, *"Verify it yourself, no keys needed"*, and the repo URL.

**"Private data. Exact numbers. A fixed, signed price. Proof before delivery, and your money back if privacy isn't
proven. Outcome AI: pay for verified outcomes, not tokens."**

---

## Q&A one-liners (not in the video)

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

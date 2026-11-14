# Outcome AI on NEAR: 2-minute demo video script (v2.1.1)

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR. If privacy isn't proven, you get your money
back.**

| Left half of the screen | Right half of the screen |
|---|---|
| **http://127.0.0.1:8730 · Private AI Desk** (`chainiam-private-ai`, v2.1.1) | **http://127.0.0.1:8800 · NEAR Admin Console** (`chainaim-adminUI-NEAR`) |
| Where a company's AI agent buys answers about the company's own files | Where ChainAim's operator, or an auditor, checks every payment and paid job against the NEAR chain |

This script describes the code as it stands on 2026-11-14:
- private-ai **v2.1.1**, commit `b45750f` (designs 37–41)
- admin UI commit `123bb3f`, unchanged since 2026-11-11

Everything below is taken from the source. Part F lists where each claim lives in the code.

---

## Part A: What changed since the last script (v2.0.0 → v2.1.1)

| Version | Change | What you see |
|---|---|---|
| v2.1.0 · design-37 | **Pay before work, with automatic refunds on NEAR.** In upfront mode the paywall settles the payment *before* the job runs. If the job can't be delivered, ChainAim's signer refunds it on NEAR and signs a refund record | Left: "Settled on NEAR" appears *before* the job runs. On a refused job: "Refused: privacy not proven (…) → refunded ✓" |
| v2.1.0 · design-38 | **Signed limits in the checkout.** The signed quote now carries the job's limits: the models, the number of model calls, the tokens per call and the number of files | Left: "Signed limits checked ✓ · … · what you signed is exactly what runs" |
| v2.1.0 · design-39 | **Pay only for attested private inference.** In `verified` mode, the result is delivered only after ca-attest has verified every NEAR AI call of the job. Not proven means not delivered | Left: "AI proof: ✓ 1 of 1 NEAR AI call(s) verified" before the answer is shown |
| v2.1.0 · design-40 | **The receipt carries the money trail and the attestation bundle.** Money trail: what was paid, the NEAR AI cost, gas, margin and any overrun absorbed | Checked offline by `verify-receipt`. Not shown as a panel in tab 03 |
| v2.1.1 · design-41 | **Egress receipt.** For each model call: where it went, how many values of each kind were masked, and the hash of the exact bytes sent (on NEAR AI calls, the same hash the enclave signed) | Left: "What left your PC: 1 model call. Your data files and their rows stay on your PC…" |

**On the admin UI (8800):** nothing new since 2026-11-11. Its Jobs tab already shows the signed quote, the receipt and the
NEAR AI attestation for each job.

---

## Part B: The two apps, and how they talk

**8730 Private AI Desk.** Runs on the company's PC, in Docker, reachable on 127.0.0.1 only.

| Part | What it does |
|---|---|
| gateway + Presidio | Masks anything personal **on the PC** before any text goes to a model. Anything still personal is refused (HTTP 422). If the scanner is down, nothing is sent |
| analyst (DuckDB) | Computes the answer with one exact, read-only query on the files. The model only writes the query and words the result, and every figure is checked against the result |
| ca-control-signer | ChainAim's signer, a separate service with its own keys. It prices the job from file sizes and signs the quote and its limits (AP2). It verifies the agent's mandate, signs the receipt and signs any refund. It sees only sizes, ids, hashes and amounts |
| agent | The tenant's AI agent. It checks the quote against the tenant's spending policy, signs a Checkout Mandate for this one payment, and pays in USDC on NEAR. A relayer pays the gas |
| paywall (x402) | Upfront mode: settles the payment first, then runs the job and releases the result. If the job fails, it asks the signer for a refund |
| ca-attest | Verifies that the NEAR AI call ran in an attested enclave (Intel TDX + NVIDIA GPU) |

**8800 NEAR Admin Console.**
- **near-watch**, in Docker on port 8790, reads final NEAR blocks over three independent sources: neardata, QuickNode
  RPC and public RPC.
- It reconciles what the paywall *reports* against what the chain *shows*.
- The admin UI on 8800 has six tabs: Live ops, Ledger, Reconcile, Jobs, Feeds and Seller wallet.

**How the two apps connect.** Only ids, amounts and hashes cross between them. near-watch refuses any field it doesn't
know.

```
 paywall ── POST /ingest/claim (payment_settled, at settlement) ──────────────┐
 console ── POST /ingest/job (job_quoted · job_attested · job_released · job_receipt)
                                                                             ▼
 NEAR testnet ── neardata · QuickNode · RPC ──▶ ca-near-watch :8790 ──▶ 8800 admin UI
```

**What 8800 shows, in order, in upfront mode:**
1. The paid job appears as **paid (no job event)** as soon as the payment settles. Live ops also raises a `job_unknown`
   attention note, because the claim arrives before the job's details.
2. After a successful, verified run, `job_quoted` fills that row in. The row moves to **released** with **attested ✓**,
   then **receipt ✓**.
3. A refused job never sends `job_quoted` or `job_released`, so its row stays **paid (no job event)**.

---

## Part C: Before recording

1. Start everything in upfront mode with only verified inference paid for, using one command:
   `.\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified`
   (one-time setup: the MANUAL_SETUP.md 2026-11-13 "Upfront pay" steps and the signer/mandate keys).
2. **Left, 8730, tab 03** (Private Chat and AI, Across Files):
   - Dataset: **Small Biz Financials - 2 (ERPNext)**
   - Template: **Biggest payments out**
   - Who pays?: **AI agent**, tenant **t01**
   - Mode: **Estimate first**
   - Model: an attested NEAR AI model
3. **Right, 8800:** open the **Jobs** tab. Check that the road chips are live.
4. Snap the windows with Win+← and Win+→. Record at 1080p, browser zoom 110%.
5. **Timing: edit the recording, don't play it straight.** A real job takes about 49 s from payment to result, and a
   refund is final about 17 s after the refusal. Cut or speed up those waits so the narration lines up.
6. **The refund clip (1:25) is recorded separately:**
   - After "Quoted" appears and before paying, run `.\test-console\desk.ps1 -StopService attest`.
   - Let the run finish, then restart it with `-StartService attest`.
   - `.\test-console\desk.ps1 -Refunds` lists the refund afterwards.

The datasets are synthetic demo books ("Orion"). The figures and ids on screen come from the live run.

---

## Part D: The script (2:00, about 280 spoken words, about 140 a minute)

The **bold** lines are the voice-over.

### 0:00 – 0:12 · Opening: the problem
- **Left and right:** a title card over both halves: *"Pay for verified outcomes, not tokens."*

**"Every business wants AI on its own books. Today that means handing over private data, trusting numbers a model may
invent, and an open-ended bill. Outcome AI fixes all three."**

### 0:12 – 0:24 · Two apps, two jobs
- **Left (8730):** tab 03, with the dataset and the AI agent t01 chosen.
- **Right (8800):** the Jobs tab, the road chips live, the block height ticking.

**"On the left, the Private AI Desk, where a company's AI agent buys answers about its own files. On the right, the NEAR
Admin Console, which audits every payment against the blockchain."**

*Behind the scenes:* both run on 127.0.0.1. The desk reports ids and amounts to near-watch, never content.

### 0:24 – 0:37 · Step 1: a firm price, with signed limits
- **Left (8730):** press **Ask**. Show, in order:
  - "Estimated from the job's sizes …: nothing has run yet; it runs only after the payment"
  - "Quoted 0.02 USDC on near:testnet to …"
  - "Quote signed by ChainAim ✓ · key id … · price, payee and network match"
  - "Signed limits checked ✓ · … · at most … model call(s), … tokens each · … file(s): what you signed is exactly what
    runs"
- **Right (8800):** no new row yet.

**"The agent asks for the biggest payments out. Before any work, ChainAim's signer prices the job from file sizes, two
cents, and signs the limits too: which model, how many calls, how many tokens."**

*Behind the scenes:* console → ca-control-signer (sizes and hashes only) → an AP2 signed quote with the job's limits.

### 0:37 – 0:51 · Step 2: the agent pays first
- **Left (8730):** show, in order:
  - "Spending policy: pay ✓ · quote still valid ✓ · attested route ✓ · …"
  - "Checkout mandate signed ✓ · … · permits exactly this signed quote, for this payment only"
  - "Payment signed by … (ChainAim's relayer pays the gas)"
  - "Settled on NEAR · ↗"
- **Right (8800):**
  - The Jobs row appears: **paid (no job event)**.
  - Live ops: the claim (*reported · paywall*) and the chain transfer (*measured*).

**"The agent checks the quote against its company's spending rules, signs permission for this one payment, and pays
first, in USDC on NEAR. The right side records the payment as it settles, reported and measured."**

*Behind the scenes:* upfront x402: settle first → `POST /ingest/claim` → near-watch matches it to the chain transfer.

### 0:51 – 1:09 · Step 3: private work, released only with proof
- **Left (8730):** show "Mandate verified by ChainAim's signer ✓", then:
  - "AI proof: ✓ 1 of 1 NEAR AI call(s) verified…"
  - "Result released: … row(s)"
  - the answer
  - "Every number in this answer was checked against the computed result and found there."
- **Right (8800):** the Jobs row fills in and moves to **released**, with attested **✓**. Expand it to show the TDX / GPU
  / signature / hash checks.

**"Now the job runs, inside those signed limits. Anything personal is masked on this PC. The model sees only masked text,
inside a hardware-sealed NEAR AI enclave, and the result is released only after that enclave's proof is verified. Every
figure is computed exactly and checked."**

*Behind the scenes:* Presidio masks → NEAR AI (TDX + GPU) → ca-attest verifies → DuckDB result released →
`job_quoted`, `job_attested`, `job_released`.

### 1:09 – 1:25 · Step 4: what left the PC, one receipt, books that agree
- **Left (8730):** show, in order:
  - "Signed receipt ✓"
  - "What left your PC: 1 model call. Your data files and their rows stay on your PC…" (where the call went, the masked
    counts, the sha256 of the bytes sent)
  - then press **What the chain shows**
- **Right (8800):**
  - Jobs: *signed quote* ✓, *receipt* ✓
  - **Reconcile:** matched
  - **Seller wallet:** Books agree

**"The desk shows exactly what left the PC, and one signed receipt binds the price, both signatures, the payment and the
proof. On the right: attested, matched, and the books agree. Never the question, never the data."**

*Behind the scenes:* Ed25519 receipt with egress, money trail and attestation bundle (all hashes) → `job_receipt`. The
claim's transaction equals the chain's, so the row is **matched**.

### 1:25 – 1:42 · Step 5: privacy not proven, money back (separate clip)
- **Left (8730):**
  - "Settled on NEAR · ↗"
  - "Refused: privacy not proven (unavailable): refund pending…"
  - "Refused: privacy not proven (unavailable) → refunded ✓ (record signed by ChainAim, verified by the agent) · ↗"
- **Right (8800):** the new row stays **paid (no job event)**. It is never released.

**"And if privacy can't be proven? Here, the attestation service is down. The agent has already paid, so the job is
refused, and the money goes back to the agent on NEAR, with a refund record signed by ChainAim."**

*Behind the scenes:* ca-attest is unreachable, so the run returns 422 and the paywall asks the signer for a refund. The
refund is a NEAR transfer back to the paying account.

### 1:42 – 2:00 · Closing pitch
- **Left and right:** a closing card with the tagline, *"Verify it yourself, no keys needed"*, and the repo.

**"Private data. Exact numbers. A fixed price. Proof before delivery, and your money back if privacy isn't proven.
Outcome AI: pay for verified outcomes, not tokens."**

---

## Part E: Business value (for Q&A)

| Problem | What the solution does |
|---|---|
| Data leaves your control | It's masked on your PC first, and the egress receipt shows exactly what left, per call, with the hash the enclave signed |
| AI invents numbers | DuckDB computes the answer exactly, and every figure in the wording is checked |
| Unpredictable bills | A firm, signed price from file sizes (0.01–0.02 USDC for template questions), with the job's limits signed in |
| Paying for unproven privacy | The result is delivered only after the NEAR AI attestation is verified. Otherwise the payment is refunded on NEAR with a signed refund record |
| Agents spending money | The tenant's policy (per job, per day, auto-approve, attested route only), plus a Checkout Mandate signed by the tenant's own key for one payment |
| Is the revenue real? | 8800 reads the chain over three sources and reconciles every payment |

---

## Part F: Verification record

| Claim | Source |
|---|---|
| Upfront flow: settle before the handler; refund via the signer on failure | `services/paywall/src/upfront.ts`, `routes.ts` (`paymentFlow: "upfront"`) |
| `-PaidFlow upfront`, `-PayOnlyAttested verified`, `-StopService`, `-Refunds` | `test-console/desk.ps1` |
| Verified mode: a call not proven returns 422, so nothing is delivered | `test-console/console/server.ts` `runOffer` (`attestation_not_proven`) |
| Step wording: estimated, quoted, quote signed, signed limits, spending policy, mandate, payment signed, settled, released, refund pending, refunded | `test-console/console/paid-jobs.html` (agent stream handler) |
| Egress panel wording: "What left your PC …" | `paid-jobs.html` `EGRESS_LINE`, `egressPanel` |
| Money trail and attestation bundle in the receipt | README judge path; `scripts/verify-receipt.ts` |
| Claim sent at settlement; `job_quoted` only after a successful run | paywall settle hook + `server.ts` (`JOB_FEED.quoted` after the attestation check) |
| "paid (no job event)" and the `job_unknown` alert | admin UI `components/tabs/jobs.tsx`; near-watch `src/jobs.ts` |
| Jobs / Reconcile / Seller wallet labels | admin UI `components/tabs/*.tsx`, `components/seller-wallet.tsx` |
| About 49 s from paid to result; refund about 17 s after the refusal | `docs/judge/demo-script-2026-11-13T1730Z.md` (recorded run) |

## Part G: Wording rules

- Say **"unmasked only on your own machine"**. A hosted gateway in a TEE is roadmap.
- Say **"this job's NEAR AI call was attested"**, never "every AI call".
- Say **"a separate signer service"**, not "a separate server".
- Say **"refunded on NEAR"**, not "refunded instantly".
- Never call the payment private: payer, amount and time are public on NEAR.
- Never say "HIPAA compliant".
- The money trail is in the receipt and is checked by `verify-receipt`. Don't show it as a tab 03 panel; there isn't one.

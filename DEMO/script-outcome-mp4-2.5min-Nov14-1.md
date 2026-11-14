# Outcome AI from ChainAim: NEAR hackathon demo script (2:30)

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

| Left half of the screen | Right half of the screen |
|---|---|
| **:8730 · Private AI Desk** (`chainiam-private-ai` v2.1.1, commit `b45750f`) | **:8800 · NEAR Admin Console** (`chainaim-adminUI-NEAR`, commit `123bb3f`) |

This script was checked against both codebases on 2026-11-14 and against the v11 narrated draft
(`Outcome AI from ChainAim_ demo script v11, narrated.md/.html`). Nothing in either codebase was changed.

---

## 1. Official NEAR HACKATHON requirements, and how this script meets them

Source: the official **https://nearhackathon.com/HACKATHON.md**, read on 2026-11-14. That page is authoritative, and its
rules can change, so check it again before submitting.

### 1.1 Official requirements (from HACKATHON.md)

| Requirement | What the official page says | How this submission meets it |
|---|---|---|
| **Deadline** | Development ends and submissions close **2026-11-14 23:59 UTC**. The repository must be public by then | ⚠️ **Today.** Record, post and submit before 23:59 UTC |
| **Demo post** | The human publishes a public **X post** saying it was built at NEAR HACKATHON, tagging **@NEARProtocol** and **#NEARHackathon**, with the demo video (or screenshots) attached | A draft post is in section 8. You publish it yourself |
| **Video length** | **No length limit** is set | 2:30 is this script's choice, not a rule |
| **Local-only demo** | Acceptable if the repo is public with a reproducible README **and** the post has a video. Screenshots alone are not enough when judges can't open the demo | Both apps run on 127.0.0.1, so **the video is required**. The README has a judge path that runs without keys |
| **AI screening** | Claude Code and Codex screen for **reproducibility and feature verification** and give a preliminary score. Humans decide | The video shows only behaviour that runs. Section 6 lists commands a judge can reproduce |
| **README** | Written for a machine reader too: what it is, the problem, and "do X - see Y" steps, with no marketing | The admin UI README has a "Do X → see Y" table, and the private-ai README has a no-keys judge path. ⚠️ Check that private-ai also states the problem and "do X - see Y" steps plainly |
| **NEAR integration** | No specific integration is mandatory. **Testnet-only projects are eligible** for every track | NEAR testnet: USDC (NEP-141) via x402 with a NEP-366 relayer, NEAR AI attested inference, and near-watch reading the chain |
| **Pre-existing work** | Old projects as they stand aren't eligible. New features built in the window are. **Disclose pre-existing work** (other chains included) in the README; only the NEAR work built in the window is judged | `HACKATHON-DISCLOSURE.md` (admin UI) separates the XRPL liveops baseline from the NEAR code. ⚠️ private-ai's README should carry an equivalent section (tags or branch + diff link) |
| **AI-generated code, libraries** | Allowed, if listed in the README | ⚠️ Confirm both READMEs list them |
| **License** | Any license; keep the repo public through judging | Both repos have a `LICENSE` file |
| **Submission form** | Submit once (API or web form), after the human confirms the payload: tracks, a **mainnet** NEAR payout account, the repo URL, the demo post URL, and a 20–2000 character description | Done by you, after the X post |

### 1.2 Tracks (the official hints are "wishes, not requirements")

| Track (id) | Official one-liner | Fit, and the evidence in this demo |
|---|---|---|
| **Privacy & Private AI** (`privacy`) | "Build intelligence without exposure" · hints: private AI, TEE, NEAR AI Cloud | **Strongest fit:** masking on the PC, attested NEAR AI calls (TDX + GPU), the egress receipt, "not proven, not delivered", and a refund |
| **Agent Economy** (`agents`) | Agents that earn, spend and negotiate; pay for APIs, compute or data | A tenant agent buys compute and data answers under a spending policy, with an AP2 quote and mandate |
| **Real-World Money** (`realworld`) | "A normal company could use tomorrow" · hints: stablecoins, meta transactions | USDC payments with a NEP-366 relayer, small-business and clinic use cases, and reconciliation |

*Recommendation, not an official rule:* enter **privacy** first, plus **agents** and/or **realworld**. A project can
fit several tracks but is still one submission.

### 1.3 The official demo guidance, applied to this video

| Official guidance | Where the script does it |
|---|---|
| Lead with the user problem, understandable from the first line | 0:00: the problem is the first spoken line, over the live apps rather than a long title card |
| Show one complete moment, from a real user action to a visible result. **Skip long intros, architecture slides and setup** | 0:42–1:52: **Ask** → price → pay → attested result → receipt → matched. There's no architecture slide. The data flow is told in short captions |
| Explain NEAR's role concretely, not a vague "powered by NEAR" | NEAR moves the USDC (NEP-141, NEP-366 relayer), is the public record that 8800 reconciles against, and runs the attested model (NEAR AI) |
| Give a next step: link the demo and the repo, ask a genuine question or invite specific feedback | 2:18 closing card: both repo links, the no-keys judge path, and one question to viewers |

### 1.4 Repository facts used (verifiable)

- **Judge path:** the README's `verify-receipt`, `observe-receipt` and test suite (534 tests on v2.1.1), all runnable
  without keys.
- **Disclosure:** `HACKATHON-DISCLOSURE.md` separates ported code from code built during the window, and names what was
  not built (`services/custody` / OutLayer TEE; `qn-wss`).

---

## 2. What is implemented, partly implemented, or not implemented

| Status | Feature | Where in the code |
|---|---|---|
| ✅ Implemented | Masking on the PC with Presidio + ChainAim patterns (names, accounts, IDs, health data, cards). A residual rescan returns 422, and nothing is sent if the scanner is down | gateway, presidio |
| ✅ Implemented | Exact answers from DuckDB on local files; every figure in the wording is checked | analyst, `answer-checks.json` |
| ✅ Implemented | Estimate-first: a firm price from file sizes, an AP2 quote (ES256) signed by `ca-control-signer`, and **signed limits** (models, model calls, tokens, files) | design-34/38 |
| ✅ Implemented | The agent's spending policy plus an AP2 **Checkout Mandate** signed by the tenant's key, verified by the signer before the run | design-36 |
| ✅ Implemented | x402 payment: NEP-141 USDC on NEAR testnet, relayed as a NEP-366 meta-transaction (the relayer pays the gas) | paywall; near-watch fixture `H3ZFsVY1…` |
| ✅ Implemented (flag) | **Pay before work, with refunds on NEAR**: the payment settles first, and a job that can't be delivered is refunded with a refund record signed by ChainAim | design-37, `-PaidFlow upfront` |
| ✅ Implemented (flag) | **Pay only for attested inference**: the result is released only after ca-attest verifies every NEAR AI call (TDX + GPU evidence) | design-39, `-PayOnlyAttested verified` |
| ✅ Implemented | An Ed25519 receipt (hashes only) carrying the quote, mandate, settlement, money trail, attestation bundle and **egress** (what left the PC per call), checked by the signer and by `verify-receipt` | design-32/40/41 |
| ✅ Implemented | 8800: near-watch reads NEAR over neardata, QuickNode and RPC, takes claims and job events, and reconciles them. Tabs: Live ops, Ledger, Reconcile, Jobs, Feeds, Seller wallet | adminUI near-watch, admin-console |
| ⚠️ Partly implemented | **Dental and Chiro (ChiroTouch, Jane) use cases** run on tab 03 with exact answers from their domain query banks and an optional masked "Explained" answer. They are **not** wired to the NEAR paid flow: the Pay box and the AI agent work only for crossask datasets (`-AgentAsk` refuses domain-pack datasets) | `paid-jobs.html` (paid only for `/crossask`); `agent-ask.test.ts` |
| ⚠️ Partly implemented | Separation of the signer is **by design, not by hardware**: on one PC it is a separate service with its own keys | README |
| ❌ Not implemented (roadmap) | A hosted gateway in a TEE, the signer in a TEE (Shade Agents), the spending mandate on a NEAR contract, unlinkable credits, on-chain aggregates, ZK-PRET on Mina (named in v11) | README roadmap; ZK-PRET/Mina isn't in these repositories |

### Corrections to the v11 draft

These lines don't match the code:
- **"Jobs: the new job appears as quoted"** at the price step: in estimate-first mode nothing reaches 8800 before
  payment. In upfront mode the row first appears as **"paid (no job event)"** when the payment settles.
- **"templates for … dental and chiropractic"** inside the paid flow: those packs run, but not as NEAR-paid jobs.
- **"Tab 03 jobs list for the session"**: no such list exists in tab 03.
- **Roadmap items** must be labelled as roadmap.

---

## 3. How the two apps communicate

```
 8730 (customer PC, 127.0.0.1)                                  8800 (operator)
 paywall ── POST /ingest/claim  (payment_settled: tx hash, amount, payer) ──┐
 console ── POST /ingest/job    (job_quoted · job_attested · job_released · job_receipt)
                                                                           ▼
 NEAR testnet ── neardata · QuickNode RPC · public RPC ──▶ ca-near-watch :8790 (SQLite) ──▶ admin UI :8800
```

- **Only ids, amounts, model ids, counts and hashes cross.** near-watch refuses any field it doesn't know, so a question,
  file or answer can't get through.
- **Two separate keys:** an *ingest* key that can only add records, and an *admin* key that only the 8800 server holds.
- **What NEAR is used for:**
  1. moving the money (USDC, NEP-141)
  2. an independent public record that 8800 reads itself and reconciles against the paywall's claim
  3. NEAR AI's attested enclave for the one model call

---

## 4. Before recording

1. Start everything with one command:
   `.\test-console\desk.ps1 -All -AllSkipTests -PaidFlow upfront -PayOnlyAttested verified`
   One-time setup first: signer and mandate keys, and the MANUAL_SETUP.md "Upfront pay" steps.
2. **8730, tab 03:** Pay with USDC · NEAR ticked, Who pays? **AI agent** (tenant **t01**), mode **Estimate first**,
   with an attested NEAR AI model.
3. **8800:** open the **Jobs** tab, with the road chips live.
4. **Pre-record the clips** (the four use-case cuts take 15 s in total):
   - the four use-case runs: the paid ERPNext job, plus free runs of the three practice packs on their NEG-ALL sets
   - the refund clip: `desk.ps1 -StopService attest` after "Quoted" and before paying; afterwards `-StartService
     attest`
5. **Edit for time.** A real paid job takes about 49 s from payment to result, and a refund is final about 17 s after
   the refusal.
6. Record at 1080p, browser zoom 110%, with the two windows snapped side by side.

All datasets are **synthetic**: the ERPNext demo borrowers ("Orion"), and generated Curve Dental, ChiroTouch and Jane
exports with planted leaks.

---

## 5. The script (2:30, about 350 spoken words, about 140 a minute)

The **bold** lines are the voice-over. *Caption* is a short on-screen line for viewers who aren't technical.

| Time | Beat | Length |
|---|---|---|
| 0:00 – 0:15 | Opening: the problem | 15 s |
| 0:15 – 0:27 | Two apps, one NEAR record | 12 s |
| 0:27 – 0:42 | **The four use cases (15 s for all four)** | 15 s |
| 0:42 – 0:58 | NEAR flow 1: a firm, signed price | 16 s |
| 0:58 – 1:14 | NEAR flow 2: the agent pays first | 16 s |
| 1:14 – 1:34 | NEAR flow 3: private work, released only with proof | 20 s |
| 1:34 – 1:52 | NEAR flow 4: receipt, egress, matched books | 18 s |
| 1:52 – 2:08 | NEAR flow 5: privacy not proven, money back | 16 s |
| 2:08 – 2:18 | Verify it yourself, no keys (judge path) | 10 s |
| 2:18 – 2:30 | Closing pitch and next step | 12 s |

### 0:00 – 0:15 · Opening: the problem
- **Left and right:** both live apps are already on screen, with a short lower-third title (no separate intro card):
  *Outcome AI from ChainAim · Pay for verified outcomes, not tokens.*

**"Regulated businesses need AI on their sensitive data. Today's AI asks them to hand that data over, trust numbers it
may invent, and pay for tokens with no limit. Outcome AI asks for none of that, and proves it."**

*Caption:* local data · exact answers · proof for every paid answer

### 0:15 – 0:27 · Two apps, one NEAR record
- **Left (8730):** the tab 03 header, "Private Chat and AI (Across Files)".
- **Right (8800):** the road chips (neardata · qn-rpc · rpc), the block height ticking.

**"On the left, the Private AI Desk runs on the company's own PC. On the right, the NEAR Admin Console reads the chain
itself and audits every payment the desk reports."**

*Caption:* left does the work · right checks the money

### 0:27 – 0:42 · The four use cases (15 s in total)
Use quick cuts on the **left (8730)**, about 3.5 s each: open the dataset and show one exact answer. The **right (8800)**
stays on the Jobs tab.

| Cut | Dataset | Shown on the left |
|---|---|---|
| 0:27 – 0:31 | **Small Biz Financials - 2 (ERPNext)** | The template list (Cash flow vs installment, Biggest payments out, Late payers, Credit limit exposure) |
| 0:31 – 0:35 | **Practice Management - Dental** · set NEG-ALL | "Every leak type found: how many and how much" |
| 0:35 – 0:38 | **Practice Management - Chiro (ChiroTouch)** · NEG-ALL | "Insurance paid by payer in the statement period: 835 payments…" |
| 0:38 – 0:42 | **Practice Management - Chiro (Jane)** · NEG-ALL | "Care plans: unearned total (collected - earned)…" |

**"Four use cases, on synthetic data: ERPNext books for small-business cash flow and credit, paid per answer on NEAR,
plus Dental, ChiroTouch and Jane packs that find revenue leaks against the bank, exactly and locally."**

*Caption:* ERPNext: paid on NEAR · Dental · ChiroTouch · Jane: exact, on your PC

*Accuracy note:* only the ERPNext use case runs the NEAR-paid flow. The three practice packs give exact local answers
and aren't paid on NEAR yet (see section 2).

### 0:42 – 0:58 · NEAR flow 1: a firm, signed price
- **Left (8730):** ERPNext · **Biggest payments out** · Who pays? **AI agent t01** · Estimate first. Press **Ask**.
  Show:
  - "Estimated from the job's sizes …: nothing has run yet"
  - "Quoted 0.02 USDC on near:testnet…"
  - "Quote signed by ChainAim ✓"
  - "Signed limits checked ✓ … what you signed is exactly what runs"
- **Right (8800):** no new row yet.

**"The agent asks for the five biggest payments out. Before any work, ChainAim's separate signer prices the job from the
file sizes, two cents, and signs its limits: which model, how many calls, how many tokens."**

*Caption:* AP2 quote (ES256) · signed limits · no work yet

### 0:58 – 1:14 · NEAR flow 2: the agent pays first
- **Left (8730):** show:
  - "Spending policy: pay ✓ · quote still valid ✓ · attested route ✓ …"
  - "Checkout mandate signed ✓ … for this payment only"
  - "Payment signed by … (ChainAim's relayer pays the gas)"
  - "Settled on NEAR · ↗"
- **Right (8800):**
  - The Jobs row appears: **paid (no job event)**.
  - Ledger: the USDC transfer, measured on the chain.

**"The agent checks the quote against its company's spending rules, signs permission for this one payment, and pays
first, in USDC on NEAR, with no gas of its own. The right side sees the transfer on chain."**

*Caption:* AP2 mandate · x402 · NEP-141 USDC · NEP-366 relayer pays the gas

### 1:14 – 1:34 · NEAR flow 3: private work, released only with proof
- **Left (8730):** show:
  - "Mandate verified by ChainAim's signer ✓"
  - "AI proof: ✓ 1 of 1 NEAR AI call(s) verified"
  - "Result released"
  - the answer, with "Every number in this answer was checked against the computed result and found there."
- **Right (8800):** the row moves to **released**, **attested ✓**. Expand it: TDX ✓ · GPU ✓ · signature ✓ · hashes ✓.

**"Now the exact query runs on the PC. Anything personal is masked before it leaves. One small model call, on masked
text, runs in a NEAR AI enclave with Intel and NVIDIA hardware proof. The result is released only after that proof is
verified, and every number is checked."**

*Caption:* compute on your PC · 1 attested NEAR AI call · not proven = not delivered

### 1:34 – 1:52 · NEAR flow 4: receipt, egress, matched books
- **Left (8730):** show "Signed receipt ✓" and "What left your PC: 1 model call…" (where it went, the masked counts, the
  hash of the bytes sent), then press **What the chain shows**.
- **Right (8800):** Jobs: signed quote ✓, receipt ✓ · **Reconcile: matched** · **Seller wallet: Books agree**.

**"One signed receipt binds the price, both signatures, the payment, the proof, and exactly what left the PC. On the
right, what the paywall reported matches what the chain shows. On chain: only the payment, never the data."**

*Caption:* Ed25519 receipt · hashes only · claim tx = chain tx → matched

### 1:52 – 2:08 · NEAR flow 5: privacy not proven, money back (pre-recorded clip)
- **Left (8730):** show:
  - "Settled on NEAR · ↗"
  - "Refused: privacy not proven (unavailable): refund pending…"
  - "… → refunded ✓ (record signed by ChainAim, verified by the agent) · ↗"
- **Right (8800):**
  - The row stays **paid (no job event)**. It is never released.
  - Ledger: the refund transfer from the pay-to account.

**"And if privacy can't be proven? Here the attestation service is down. The agent already paid, so the job is refused,
and the money goes back on NEAR, with a refund record signed by ChainAim."**

*Caption:* not proven → not delivered → refunded on NEAR

### 2:08 – 2:18 · Verify it yourself, no keys
- **Left (8730 side):** a terminal in the repo root runs
  `node scripts/verify-receipt.ts --file docs/judge/sample-receipt-2026-11-13T1716Z.json --result none`. Show the three
  `OK` lines: receipt valid · money trail · attestation bundle.
- **Right (8800 side):** a terminal runs
  `node scripts/observe-receipt.ts --file docs/judge/sample-receipt-2026-11-13T1716Z.json`. Show
  `OK the chain shows this receipt's payment`.

**"Anyone can check this without keys: one command verifies the receipt, money trail and attestation; another reads the
payment straight from NEAR."**

*Caption:* reproducible judge path · Node.js only · no account, no key

*Why this beat:* the official guidance says to skip architecture slides, and AI screening checks reproducibility. This
replaces the diagram with a real action and a visible result.

### 2:18 – 2:30 · Closing pitch and next step
- **Left and right:** a closing card:
  - *Outcome AI from ChainAim · Pay for verified outcomes, not tokens*
  - github.com/chainaimdev/ChainAim-Private-Outcome-AI · github.com/chainaimdev/chainaim-adminUI-NEAR
  - *Built at NEAR HACKATHON · testnet · Verify it yourself, no keys needed*
  - The question: *"Which practice system should we support next?"*

**"Private data, exact numbers, a firm price, and your money back if privacy isn't proven. Pay for verified outcomes,
not tokens. Which practice system should we support next?"**

*Caption:* repos linked · judge path in the README · reply with your practice system

---

## 6. Judge evidence to show or link (all runnable without keys)

```powershell
node scripts/verify-receipt.ts --file docs/judge/sample-receipt-2026-11-13T1716Z.json --result none
node scripts/observe-receipt.ts --file docs/judge/sample-receipt-2026-11-13T1716Z.json
```

| Check | Expected result |
|---|---|
| Receipt | `OK receipt valid: signed by the pinned key d27d1e9f…, settlement signed too, signed quote matches, checkout mandate matches, signed limits match` |
| Money trail | `OK money trail: paid 0.020000 USDC … NEAR AI cost 0.000445 · gas 0.002000 · … margin 0.017555` |
| Attestation | `OK attestation bundle matches evidenceBundleSha256 (1/1 NEAR AI calls verified)` |
| Chain read | `OK the chain shows this receipt's payment (0.02, …)` |
| near-watch fixture | A real testnet x402 payment (`H3ZFsVY1…`, 0.01 USDC, a NEP-366 delegate `ft_transfer`) |

## 7. Wording rules

- Say **"unmasked only on your own machine"**, **"this job's NEAR AI call was attested"**, **"a separate signer
  service"** and **"refunded on NEAR"**. Never say "every AI call is attested", "a separate server", "refunded
  instantly" or "HIPAA compliant".
- Don't call the payment private. The payer, amount and time are public on NEAR; the content isn't.
- Present Dental and Chiro as **implemented local use cases**, not as NEAR-paid jobs.
- Present TEE hosting, on-chain mandates, aggregates and ZK-PRET/Mina **only as roadmap**, or leave them out.

---

## 8. Draft X post and submission checklist (official requirements; you publish and submit)

**Draft X post.** Edit it as you like; the official rules only require the three items marked ✔.

> Regulated businesses want AI on their own books without handing over the data. We built Outcome AI at **NEAR
> HACKATHON** ✔: an AI agent buys an exact answer for 0.02 USDC on NEAR. The data is masked on its own PC, the model
> runs in an attested NEAR AI enclave, the result is released only with proof, and the money is refunded on NEAR if
> privacy isn't proven. A live console reconciles every payment with the chain.
> Repos: github.com/chainaimdev/ChainAim-Private-Outcome-AI · github.com/chainaimdev/chainaim-adminUI-NEAR (judge path, no keys)
> Which practice system should we support next?
> **@NEARProtocol** ✔ **#NEARHackathon** ✔ (optional: @NearLegion @NearBuilders)
> [attach the 2:30 video] ✔

**Checklist before 2026-11-14 23:59 UTC:**
- [ ] Both repositories are public, with a LICENSE file (present in both).
- [ ] Each README states the problem, has "do X - see Y" steps, and lists the AI-generated code and libraries used.
- [ ] Pre-existing work is disclosed (admin UI: `HACKATHON-DISCLOSURE.md`; private-ai: add an equivalent section, with
      a tag or branch and a diff link).
- [ ] The video is recorded and edited to 2:30, and the X post is published with it attached.
- [ ] Submit once, after confirming the payload: project name, lead, email, team size, tracks (suggested: `privacy`,
      `agents`, `realworld`), a **mainnet** NEAR payout account, the repo URL, the post URL, a 20–2000 character
      description, and contact consent.

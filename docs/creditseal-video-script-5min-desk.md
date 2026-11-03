# ChainAim CreditSeal: 5-minute Desk walkthrough (video script for brag)

**Tagline:** Private books, private models, public proof.

**What this video is:** one continuous screen recording of the **CreditSeal Desk** at `http://127.0.0.1:8750/`,
walking through every part of the page and all 17 steps, with a voiceover. No slides are needed; brag can add a title
card at the start and an end card at the end (Scenes 1 and 12).

**Length:** 5:00. Voiceover about 740 words, at roughly 150 words a minute.

**Where the page comes from:** `services/lending/scripts/cockpit.ts` (server, Devnet reads, the commands behind each
button) and `services/lending/scripts/cockpit.html` (the page, the 17 steps and their texts). Every button runs the
same `scripts/lending.ts` / `scripts/underwrite.ts` command you would run in a terminal; the Desk shows its real output.

**Desk colours (brag can reuse them):** background `#0e1317`, accent teal `#3fb6a8`, gold `#e3b341` (payments and the
ChainAim wallet), red `#f0605d` (declines and refusals). Borrower steps are blue, Harbor's are purple, Kestrel's amber,
Northbay's and the bank's green.

---

## The page, part by part (what to point at)

| Area on screen | What it is | What to say about it |
|---|---|---|
| Header "ChainAim CreditSeal Desk" · *private books, private models, public proof* | The product and its promise | The three promises of the product |
| Links "Maya's private-AI console ↗" and "ChainAim wallet on explorer ↗" | The borrower's private chat (`:8730`) and ChainAim's wallet on the Devnet explorer | Everything on this page can be checked on the public ledger |
| "XRPL Devnet · ledger time …" | The time of the last validated ledger, read live | The Desk is reading the real ledger, not a database |
| Grey banner "Two-sided confidentiality …" | The privacy rule of the product | The borrower shares computed facts, never raw books; the lender's model stays with the lender |
| Gold box **CHAINAIM SERVICE WALLET** (e.g. `75.00 TUSD`, "last: +25.00 from Harbor Credit · underwrite · tx ↗") | ChainAim's balance in the test dollar, and the last fee received, with its transaction | This is the business model: each party pays ChainAim on-chain for the service it uses |
| Four party cards: **Orion Ceramics** (borrower), **Kestrel Foods** (pilot borrower), **Harbor Credit** (broker = lender), **Northbay Savings Fund** (depositor) | Each party's address, TUSD balance and "paid ChainAim" total | Who is in the room, and what each has paid |
| Left column: steps 1–17 | The story, coloured by who acts | Click any step to jump to it |
| Stage card (right) | The current step: who acts, title, why, **Initiated by**, **CreditSeal service** | Every step says who started it and which paid service it uses |
| Button **Run** / **Pay** (gold) / **Continue** | Runs the real command for this step | Gold "Pay" = a fee to ChainAim on-chain |
| Result box (green / red / amber) | The verdict line and the command's real output, with transaction links | Green = done on XRPL, red = refused before signing, amber = stopped before sending |
| **Loans · ACTUS contract performance** table | Harbor's vault (assets, lent out, unrealised loss, first-loss cover) and every loan: borrower, ACTUS status, principal out, payments left, next due, "If it defaulted now", loan link | One table that a lender, a depositor and a bank all read the same way |
| Status chips **PF / DL / DQ / DF / MA** | ACTUS performance: performing, delayed (in grace), delinquent (past grace), default, matured | The language banks already use for loan status |

## The 17 steps (as they appear on the Desk)

| # | Who acts | Step | Button | Fee to ChainAim | Expected result |
|---|---|---|---|---|---|
| 1 | Harbor Credit | Background: Harbor's short pilot loan to Kestrel Foods | Run | — | **Pilot loan live on XRPL** (`LoanSet … tesSUCCESS`) |
| 2 | Maya Chen, Orion (CFO) | Maya checks her cash privately, then applies to Harbor | Continue | per question in her console (x402) | **Application sent to Harbor** |
| 3 | Harbor Credit | Harbor engages CreditSeal to underwrite the applicants | Pay | 25 TUSD underwriting | payment `tesSUCCESS`, gold wallet +25 |
| 4 | CreditSeal on Raj Patel's PC (Mercury Textiles) | Underwrites the stressed applicant | Run | (covered by step 3) | **VERDICT DECLINE** |
| 5 | CreditSeal on Ana Ruiz's PC (Jupiter Knitting) | Underwrites Jupiter Knitting (LEI verified) | Run | (covered by step 3) | **✓ LEI VERIFIED** badge, **VERDICT APPROVE**, ACTUS check |
| 6 | CreditSeal on Maya Chen's PC (Orion Ceramics) | Underwrites Orion | Run | (covered by step 3) | **VERDICT APPROVE**, ACTUS schedule vs XRPL schedule |
| 7 | Harbor Credit | A forged request: a bigger loan than approved | Run | — | **REFUSED: no signature, no loan, nothing sent** |
| 8 | Harbor Credit | The real loan: verified, then co-signed | Run | — | **Loan created on XRPL with the proof inside** |
| 9 | Maya Chen, Orion | Orion pays its first instalment | Run | — | **Instalment paid** (`LoanPay … tesSUCCESS`) |
| 10 | Harbor Credit | Harbor pays CreditSeal to monitor its loans | Pay | 3 TUSD monitoring | payment `tesSUCCESS`, gold wallet +3 |
| 11 | CreditSeal monitoring | Ledger vs ChainAim: does Orion's loan match? | Run | (covered by step 10) | **All fields match ✓** (`attestation = sha256(pack) ✓`) |
| 12 | Kestrel Foods | Kestrel missed its due date and tries to pay as if on time | Run | — | **Stopped before sending: payment is late (tecEXPIRED)** |
| 13 | Harbor Credit | Harbor marks Kestrel's loan impaired | Run | — | **Impaired: depositors see the loss coming** |
| 14 | Harbor Credit | Harbor defaults the loan | Run | — | **Defaulted: cover paid its slice** |
| 15 | Northbay Savings Fund | The depositor pays CreditSeal for a risk view | Pay | 2 TUSD risk view | payment `tesSUCCESS`, gold wallet +2 |
| 16 | Northbay Savings Fund | What would each loan cost depositors if it defaulted now? | Run | (covered by step 15) | **Depositor exposure** table |
| 17 | Any bank or supervisor | The same loan, as a bank sees it (ACTUS) | Run | roadmap: metered | **ACTUS ANN contract for the XRPL loan**, events linked to XRPL transactions |

Fees are the Desk's defaults (`--price-underwrite 25 --price-monitoring 3 --price-risk-view 2`); if you start the
Desk with other prices, say the prices you set.

---

## Scene overview (for brag)

| # | Time | Length | Scene | On screen |
|---|---|---|---|---|
| 1 | 0:00–0:20 | 20 s | Hook: lending without collateral | Title card, then the Desk header |
| 2 | 0:20–0:50 | 30 s | Tour: header, wallet, party cards | Desk top half |
| 3 | 0:50–1:10 | 20 s | Tour: steps, stage card, Loans table | Desk left column, stage card, table |
| 4 | 1:10–1:30 | 20 s | Step 1: the pilot loan | Step 1 → Run |
| 5 | 1:30–1:55 | 25 s | Step 2: Maya asks her own books | Step 2 (+ optional console cut) |
| 6 | 1:55–2:15 | 20 s | Step 3: Harbor pays for underwriting | Step 3 → Pay, gold wallet ticks up |
| 7 | 2:15–3:00 | 45 s | Steps 4–6: underwriting that says no | Three Runs: DECLINE, LEI + APPROVE, APPROVE + ACTUS |
| 8 | 3:00–3:35 | 35 s | Steps 7–8: proof inside the loan | REFUSED, then loan created; explorer `Data` |
| 9 | 3:35–3:55 | 20 s | Steps 9–11: pay, monitor, reconcile | Instalment, Pay +3, All fields match ✓ |
| 10 | 3:55–4:25 | 30 s | Steps 12–14: when a borrower slips | tecEXPIRED, impaired, defaulted; ACTUS chips |
| 11 | 4:25–4:50 | 25 s | Steps 15–17: savers and banks | Pay +2, depositor table, bank view |
| 12 | 4:50–5:00 | 10 s | Close | End card |

---

## Scene 1 · 0:00–0:20 · The hook

**Screen:** a dark title card, three lines one per beat: "No collateral." · "Underwriting off-chain." ·
"Who checks the borrower?" Then cut to the Desk at `http://127.0.0.1:8750/`, header in view.

**Chip:** `XRPL lending vaults · XLS-65 / XLS-66 · Devnet`

> XRPL lending vaults can now lend without collateral. The XLS-66 spec leaves underwriting off-chain, on purpose. So
> who checks the borrower? This is the ChainAim CreditSeal Desk, and in the next five minutes it answers that,
> step by step, on the live XRPL Devnet.

## Scene 2 · 0:20–0:50 · Tour: the top of the page

**Screen:** slow pan across the header. Hover the tagline, the two links, the "XRPL Devnet · ledger time" line, the grey
two-sided confidentiality banner, then the gold **ChainAim service wallet** box, then each of the four party cards.

**Chips:** `Live ledger time` · `Two-sided confidentiality` · `Fees paid on-chain, in TUSD`

> At the top: private books, private models, public proof. The ledger time is read live from Devnet. The banner is the
> rule the whole product follows: the borrower shares computed facts, never its books, and the lender's model and
> cut-offs are never shown to the borrower. The gold box is ChainAim's own wallet. Every service on this page is paid
> into it on-chain, and it shows the last fee and its transaction. Below it, the parties: Orion Ceramics, the borrower;
> Kestrel Foods, a pilot borrower; Harbor Credit, the broker that runs the vault and lends; and Northbay Savings Fund,
> which deposits savings into Harbor's vault. Each card shows the balance in our test dollar and what that party has
> paid ChainAim.

## Scene 3 · 0:50–1:10 · Tour: how the Desk works

**Screen:** highlight the step list (colours by who acts), then the stage card's **Initiated by** and
**CreditSeal service** lines and the Run button, then scroll to the **Loans · ACTUS contract performance** table and
its legend.

**Chip:** `PF performing · DL delayed · DQ delinquent · DF default · MA matured`

> On the left, seventeen steps, coloured by who acts. The card on the right says who started each step and which
> CreditSeal service it uses. Every button runs the real command and shows its real output. Gold buttons are payments.
> At the bottom, Harbor's vault and every loan, with its status in ACTUS terms, the open standard banks already use,
> and what depositors would lose if it defaulted now.

## Scene 4 · 1:10–1:30 · Step 1: the pilot loan

**Screen:** click step 1 → **Run**. Green result **Pilot loan live on XRPL**; the new loan appears in the Loans table as
`PF`.

> Step one sets up the background. Harbor gives Kestrel Foods a small pilot loan with very short payment intervals.
> It's created on XRPL now, so that later we can see what CreditSeal monitoring catches when a borrower misses a
> payment.

## Scene 5 · 1:30–1:55 · Step 2: Maya asks her own books

**Screen:** step 2 → **Continue** → **Application sent to Harbor**. Optional quick cut: click "Maya's private-AI
console ↗" and show her question "Can our monthly cash flow cover the instalment?" answered from her files.

**Chips:** `Books stay on Maya's PC` · `Paid per question (x402)`

> Maya Chen is the CFO of Orion Ceramics. Before applying, she asks her own books, in her private console, whether her
> monthly cash flow can cover the instalment. The answer is computed from her files on her PC, and she pays per
> question. Then she applies to Harbor for a working-capital loan, sharing computed facts, not her books.

## Scene 6 · 1:55–2:15 · Step 3: Harbor pays for underwriting

**Screen:** step 3 → gold **Pay**. Zoom on the gold wallet: it goes up by 25.00, "last: +25.00 from Harbor Credit ·
underwrite · tx ↗". Harbor's "paid ChainAim" rises too.

**Chip:** `Payment memo = the underwriting request id`

> Harbor engages CreditSeal to underwrite the applicants and pays ChainAim on-chain. The memo carries the request id,
> so the fee is tied to this exact job. Watch the gold wallet: plus twenty-five. Harbor will not originate a loan
> without this paid, matching decision.

## Scene 7 · 2:15–3:00 · Steps 4–6: underwriting that says no

**Screen:** step 4 → **Run** → red **VERDICT DECLINE** (Mercury Textiles). Step 5 → **Run** → the green
**✓ LEI VERIFIED** badge, the GLEIF line "entity ACTIVE · registration ISSUED", the check list, then
**VERDICT APPROVE**. Step 6 → **Run** → **VERDICT APPROVE** (Orion), scroll to the ACTUS panel: "Contract sent",
"ACTUS response events", and the table "XRPL / XLS-66 schedule vs ACTUS" with a zero difference column.

**Chips:** `DECLINE: burns ~27k/month, 90 % of collections from one late payer` ·
`GLEIF: live public record` · `APPROVE: lowest cash 154.6k, 2.38× coverage` · `5 stress scenarios`

> Now CreditSeal underwrites three applicants, each on the applicant's own PC. It computes the facts and five stress
> scenarios; the books never leave, and Harbor's private model applies its cut-offs. The applicant sees only the
> outcome. Mercury Textiles burns about twenty-seven thousand a month, and ninety percent of its collections come from
> one late payer: declined. Jupiter Knitting declares its legal entity identifier, and CreditSeal checks it live
> against the public GLEIF registry: entity active, registration issued, check digits valid. Approved. Orion passes
> every stress, with two point three eight times coverage: approved. And the repayment schedule is checked live on an
> ACTUS server. The XRPL schedule and the ACTUS schedule match, instalment by instalment.

## Scene 8 · 3:00–3:35 · Steps 7–8: proof inside the loan

**Screen:** step 7 → **Run** → red **REFUSED: no signature, no loan, nothing sent**. Step 8 → **Run** → green
**Loan created on XRPL with the proof inside**; click the transaction link and highlight the `Data` field on the Devnet
explorer.

**Chip:** `LoanSet.Data = sha256(underwriting pack)`

> Now a forged request arrives: someone signs a much bigger loan and attaches the approval. Harbor's software re-hashes
> the pack, the terms don't match, and it refuses to counter-sign. No signature, no loan, nothing sent. Then the real
> loan: Maya signs, Harbor re-hashes and checks, then co-signs. The fingerprint of the analysis is written into the
> loan itself, in the Data field, on the public ledger. ChainAim never signs a loan.

## Scene 9 · 3:35–3:55 · Steps 9–11: pay, monitor, reconcile

**Screen:** step 9 → **Run** → **Instalment paid**. Step 10 → gold **Pay** → wallet +3.00. Step 11 → **Run** →
**All fields match ✓**, with the line `attestation = sha256(pack) ✓`.

**Chip:** `Ledger vs ChainAim: every field ✓`

> Orion pays its first instalment, on-chain. Harbor pays CreditSeal three dollars to monitor its loans. Monitoring
> compares every field the ledger stores with ChainAim's own numbers, plus the fingerprint in the loan. All fields
> match.

## Scene 10 · 3:55–4:25 · Steps 12–14: when a borrower slips

**Screen:** step 12 → **Run** → amber **Stopped before sending: payment is late (tecEXPIRED)**. Step 13 → **Run** →
**Impaired: depositors see the loss coming**. Step 14 → **Run** → **Defaulted: cover paid its slice**. Scroll to the
Loans table: Kestrel's chip moves to `DQ`, then `DF`; the vault line's "unrealised loss" changes.

**Chip:** `Pre-flight checks the spec's failure rules: no failed transactions`

> Meanwhile Kestrel Foods missed its due date and tries to pay as if it were on time. XRPL requires a late payment to
> carry the late flag and late interest, and CreditSeal's pre-flight catches it before anything is sent. Harbor,
> alerted by monitoring, marks the loan impaired. That's only allowed once it's overdue, so the command waits for the
> exact ledger time. After the grace period, Harbor defaults it. First-loss cover pays its slice, and in ACTUS terms
> the loan is now in default.

## Scene 11 · 4:25–4:50 · Steps 15–17: savers and banks see the same truth

**Screen:** step 15 → gold **Pay** → wallet +2.00. Step 16 → **Run** → **Depositor exposure** table. Step 17 →
**Run** → **ACTUS ANN contract for the XRPL loan**: the side-by-side "XRPL loan (XLS-66 fields)" and "ACTUS contract
terms", then the event schedule with each event's **XRPL ↗** link.

**Chip:** `ACTUS event ↔ XRPL transaction`

> Northbay's savings sit in Harbor's vault, so it pays for its own risk view: what each loan would cost depositors if
> it defaulted now. And any bank or supervisor can read Orion's loan as an ACTUS contract, with each scheduled event
> linked to the XRPL transaction that settled it. Any system that reads ACTUS can take this loan in.

## Scene 12 · 4:50–5:00 · Close

**Screen:** zoom out to the full Desk, the gold wallet showing every fee collected, then end card: "Private books."
"Private models." "Public proof." · ChainAim CreditSeal · Live on XRPL Devnet · XLS-65 / XLS-66.

> Borrower, lender and depositor each pay for what they use. ChainAim CreditSeal: private books, private models,
> public proof.

---

## Before you record

- **Start from a fresh vault** so the Loans table is clean (the current Desk shows many old `drill…` loans in `DQ`):
  `powershell -ExecutionPolicy Bypass -File .\demo\start-demo.ps1 -FreshVault`.
- **Run step 1 first and record Scene 10 last.** Impair (step 13) is only allowed once Kestrel's loan is overdue and
  default (step 14) only after the grace period; the commands wait up to 120 s for the ledger time. Run steps 12–14
  after the due date has passed, or cut the wait out of the recording.
- **Step 8 must run before 9 and 11**, and step 1 before 12–14: otherwise the Desk answers "needs a loan that does not
  exist in this vault yet".
- **ACTUS and AI are optional flags.** The ACTUS panels in steps 5, 6 and 17 need the Desk started with
  `--actus-url`; without it they say "no call was made". Maya's console (step 2 cut) needs the private-AI stack on
  `http://127.0.0.1:8730`; if it isn't running, show step 2 on the Desk only and drop the "pays per question" line.
- **Say "Devnet" and "test dollar".** It runs on XRPL Devnet with a self-issued TUSD, not RLUSD and not MainNet.
- **Jupiter's identity is real; the financials are synthetic.** Keep the Desk note "Identity: real public GLEIF record.
  Financials: synthetic demo books." visible or as a lower-third. Blur the LEI number if you don't want it in the video.
- **Check spoken numbers against your run.** 27k/month, 90 %, 154.6k and 2.38× come from the recorded runs in
  `README.md`; if your run prints different figures, change the voiceover, not the screen. The "If it defaulted now"
  figures (cover vs depositors) come from XLS-66's own default formula on the vault's total debt, so they change with
  how much the vault has lent; read them off the screen rather than quoting a fixed percentage.
- **Both sides run on one machine in this demo.** Say "Harbor's private model", as the Desk does; don't claim the
  lender's model runs on a separate server.
- **If you run long:** shorten Scene 3 (the Loans table is shown again in Scene 10) and fold step 9 into Scene 8.

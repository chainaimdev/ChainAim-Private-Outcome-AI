# ChainAim CreditSeal: 3-minute video script

**Tagline:** Private books, private models, public proof.

**Audience:** XRPL Lending & Borrowing judges, lenders/vault operators, depositors, banks and supervisors.

**Story in one line:** XRPL vaults now lend *without collateral* (XLS-66) and leave underwriting off-chain on purpose.
So the savers' real protection is one decision: *should this loan be made at all?* CreditSeal makes that decision
privately, writes the proof into the loan, and keeps watching the loan until it is repaid or defaulted.

**Format:** 4 slides (presentation) + a screen recording of the **CreditSeal Desk** (`http://127.0.0.1:8750`) and
Maya's private-AI console (`http://127.0.0.1:8730`), cut together. The voiceover is about 450 words, roughly 3:00 at
150 words a minute. Every number spoken comes from the Devnet runs recorded in `README.md` and `BUILD_LOG.md`.

**Cast (the same names appear on the Desk; all companies are fictional demo parties):**

| Who | Role | Colour on the Desk |
|---|---|---|
| Maya Chen, CFO of Orion Ceramics | healthy borrower | blue |
| Raj Patel, Mercury Textiles | stressed borrower | blue |
| Ana Ruiz, Jupiter Knitting | borrower with a real, LEI-verified identity | blue |
| Harbor Credit | broker = lender and vault operator | purple |
| Northbay Savings Fund | depositor | green |
| Kestrel Foods | pilot borrower who misses a payment | amber |
| Any bank or supervisor | reads the loan as an ACTUS contract | green |

---

## Scene overview (for brag)

| # | Time | Length | Scene | Shown with |
|---|---|---|---|---|
| 1 | 0:00–0:15 | 15 s | Hook: lending without collateral | Slide 1 |
| 2 | 0:15–0:35 | 20 s | What CreditSeal is, and who's in the room | Slide 2 |
| 3 | 0:35–0:55 | 20 s | Maya asks her own books, privately | Console + Desk step 2 |
| 4 | 0:55–1:25 | 30 s | Underwriting that says no | Desk steps 3–6 |
| 5 | 1:25–1:50 | 25 s | Proof inside the loan | Desk steps 7–8, 11 |
| 6 | 1:50–2:15 | 25 s | When a borrower slips | Desk steps 1, 12–14 |
| 7 | 2:15–2:35 | 20 s | Savers and banks see the same truth | Desk steps 15–17 |
| 8 | 2:35–2:50 | 15 s | Why it's different | Slide 3 |
| 9 | 2:50–3:00 | 10 s | Close | Slide 4 |

---

## Scene 1 · 0:00–0:15 · The hook (SLIDE 1)

**Screen:** dark title card "ChainAim CreditSeal", then three lines appear one per beat:
"No collateral." · "Underwriting off-chain." · "First-loss cover ≈ 5 % of a default."
Final beat: a gold question, "Who checks the borrower?"

**On-screen chip:** `XRPL lending vaults · XLS-65 / XLS-66`

> XRPL lending vaults can now lend without collateral. The spec leaves underwriting off-chain, on purpose. And
> first-loss cover pays only about five percent of a default. So who checks the borrower?

## Scene 2 · 0:15–0:35 · The answer (SLIDE 2)

**Screen:** a left-to-right diagram: Borrower's PC (books) → **CreditSeal** → Harbor's private model →
`LoanSet.Data` on XRPL. Below it, the cast row with each party's colour. Three badges light up in turn:
🔒 Private books · 🧠 Private model · ✅ Public proof.

> CreditSeal is the orchestration layer between everyone on a vault. The borrower keeps its books. The lender keeps
> its model. The ledger keeps the proof. Meet Harbor Credit, which runs the vault; its borrowers; Northbay, which
> deposits savings into it; and the banks that will read these loans. ChainAim never signs a loan. The borrower and
> the broker do.

## Scene 3 · 0:35–0:55 · A private question first (DEMO, console + Desk step 2)

**Screen:** Maya's private-AI console. She types "Can our monthly cash flow cover the instalment?" The answer appears,
computed from her own files. Cut to the Desk, step 2 → **Application sent to Harbor**.

**Callout chips:** `Masked before any model sees it` · `Paid per question (x402 on XRPL)`

> It starts with Maya, the CFO of Orion Ceramics. Before she applies, she asks her own books whether her cash flow
> covers the instalment. The question is masked before any model sees it, and she pays per question, on-chain. Then
> she applies to Harbor, sharing computed facts, never her books.

## Scene 4 · 0:55–1:25 · Underwriting that says no (DEMO, Desk steps 3–6)

**Screen:** step 3: Harbor pays the underwriting fee; the gold **ChainAim service wallet** balance ticks up.
Step 4 → Run → red **VERDICT DECLINE** (Mercury). Step 5 → zoom on the **LEI verified** badge and the live GLEIF line
(Jupiter). Step 6 → green **APPROVE** (Orion) and the ACTUS schedule check.

**Callout chips:** `DECLINE: burns ~27k/month, 90 % of collections from one late payer` ·
`GLEIF: entity ACTIVE, registration ISSUED` · `APPROVE: lowest cash 154.6k, 2.38× coverage` ·
`5 stress scenarios`

> Harbor pays CreditSeal to underwrite three applicants. Everything runs on each applicant's own PC: a cash projection
> and five stress scenarios. The books never leave, and no customer names enter the pack. Harbor's private model
> applies its cut-offs. Mercury Textiles burns twenty-seven thousand a month: declined. Jupiter Knitting's identity is
> checked live against the public GLEIF registry, then approved. Orion passes every stress: approved. Every number is
> computed from the spec's formulas, not generated by AI.

## Scene 5 · 1:25–1:50 · Proof inside the loan (DEMO, Desk steps 7–8, 11)

**Screen:** step 7 → red **REFUSED: no signature, no loan, nothing sent** (short shake). Step 8 → green
**Loan created on XRPL with the proof inside** → open the transaction on the Devnet explorer and highlight `Data`.
Step 11 → **All fields match ✓**.

**Callout chips:** `LoanSet.Data = sha256(underwriting pack)` · `Ledger vs engine: 6 / 6 ✓`

> Now someone forges a bigger loan and attaches the approval. Harbor's software re-hashes the pack, the terms don't
> match, and it refuses to sign. Nothing is sent. The real loan goes through: Maya signs, Harbor checks and co-signs,
> and the fingerprint of the analysis is written into the loan itself. Orion pays its first instalment, and
> monitoring checks every ledger field against our engine. Six of six match.

## Scene 6 · 1:50–2:15 · When a borrower slips (DEMO, Desk steps 12–14)

**Screen:** step 12 → amber **Stopped before sending: payment is late (tecEXPIRED)**. Steps 13–14 → impaired, then
defaulted; the Loans table's ACTUS chip moves `PF → DL → DQ → DF`; "cover paid its slice".

**Callout chip:** `Pre-flight checks every spec failure condition: no failed transactions`

> Meanwhile Kestrel Foods, on a short pilot loan, misses its due date and tries to pay as if on time. Pre-flight
> catches it before anything reaches the ledger, and names the rule. Harbor impairs the loan, then defaults it, each
> at the exact ledger time the spec allows. First-loss cover pays its slice.

## Scene 7 · 2:15–2:35 · Savers and banks see the same truth (DEMO, Desk steps 15–17)

**Screen:** step 15–16 → Northbay pays for a risk view; the depositor exposure table ("If it defaulted now").
Step 17 → the bank view: ACTUS terms + live event schedule, each event linked to the XRPL transaction that settled it.

**Callout chip:** `ACTUS ANN schedule = XLS-66 schedule, to the cent`

> Northbay, the depositor, pays for its own view: what each loan would cost savers if it defaulted now. And any bank
> or supervisor can read the same loan as an ACTUS contract, the open standard, with every instalment matching the
> ledger to the cent.

## Scene 8 · 2:35–2:50 · Why it's different (SLIDE 3)

**Screen:** six tiles that appear one per beat:
"Says no" · "Books stay home" · "Computed, not generated" · "Proof on-chain" · "No failed transactions" ·
"Bank-readable (ACTUS)". Underneath: "Every party pays for what it uses: borrower, lender, depositor."

> So CreditSeal fills the gap XLS-66 leaves on purpose. It says no. It keeps books private. It proves every decision
> on-chain. And every party pays only for what it uses.

## Scene 9 · 2:50–3:00 · Close (SLIDE 4)

**Screen:** end card: "Private books." "Private models." "Public proof." Logo: ChainAim CreditSeal ·
Live on XRPL Devnet · XLS-65 / XLS-66.

> ChainAim CreditSeal. Private books, private models, public proof.

---

## What makes it unique (use as on-screen callouts or a pinned comment)

1. **Fills the gap XLS-66 leaves on purpose:** underwriting for uncollateralised vault loans.
2. **It says no:** declines the stressed borrower, approves the healthy ones, on the lender's own policy.
3. **Two-sided privacy:** the borrower's books stay on its PC (the pack carries IDs, never names); the lender's model
   and cut-offs are never shown to the borrower.
4. **Computed, not generated:** XLS-66 formulas copied from the spec; AI only explains, and any number it states that
   was not computed is flagged.
5. **Proof on-chain:** `sha256(pack)` in `LoanSet.Data`; a forged loan is refused before signing.
6. **Real identity:** live GLEIF LEI check (ISO 17442 check digits, entity active, registration issued).
7. **Bank-readable:** the ACTUS ANN contract reconciles with the XRPL loan to the cent.
8. **No failed transactions:** pre-flight evaluates the spec's failure conditions and names the clause.
9. **Savers see the downside:** depositor view of the loss if a loan defaulted now.
10. **A business model that matches XLS-66:** borrower, lender and depositor each pay ChainAim on-chain for the service
    they use; ChainAim never signs a loan.

## Before you record

- **Pre-run the slow parts.** Start the Desk with `demo\start-demo.ps1 -FreshVault`, run step 1 (Kestrel's pilot loan)
  first, and record Scene 6 last so the impair/default timings have passed. Steps 9 and 10 (Orion's instalment and the
  monitoring fee) can be shown as quick cuts inside Scene 5.
- **Maya's console needs the private-AI stack running** (`http://127.0.0.1:8730`). If it isn't up when you record,
  replace Scene 3's console shot with Desk step 2 alone and drop the "masked" and "pays per question" lines.
- **Say "Devnet" and "test dollar".** It runs on XRPL Devnet with a self-issued TUSD, not RLUSD and not MainNet.
- **Jupiter's identity is real; the financials are synthetic.** Keep the Desk's own note "Identity: real public GLEIF
  record. Financials: synthetic demo books." visible, or add it as a lower-third. Don't show the LEI number if you
  don't want it in the video.
- **Check the spoken numbers against your run.** 27k/month, 90 %, 154.6k, 2.38×, "six of six" and "about five
  percent" (10 % cover × 50 % = 5 %) come from the recorded runs; if your run prints different figures, change the
  voiceover, not the screen.
- **In this demo both sides run on one machine.** Say "Harbor's private model", as the Desk does; don't claim the
  lender's model runs on a separate server.
- **Timing tip:** if you run long, shorten Scene 2's cast introduction or merge Scene 8 into the close.

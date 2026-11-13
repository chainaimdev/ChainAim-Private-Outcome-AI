# NEAR Hackathon strategy session — 2026-11-12 (record)

Written 2026-11-12 18:06 UTC-5 (23:06 UTC). This is a structured record of the chat session, reconstructed by
Claude from the conversation, not a verbatim transcript. Facts are tagged with where they came from; inferences
are marked. No keys, secrets or key material are included.

Hackathon deadline: 14 Nov 2026, 23:59 UTC. Directory size at the end of the session: 777 projects.

---

## 1. Starting point (handoff from the previous chat)

- vLEI codebase `enh2-final\legentvLEI` (4C/4D: GEDA→QVI→LE→OOR→agent→sub-agent on KERIA). Hard rule: no change to
  4D until "PROCEED TO CHANGE". A new codebase is to be made for the hackathon; 4D is never touched.
- Designed earlier: 2-level OOR officer model (L1 CEO, L2 CSO seller / CPO buyer), escalation ladder
  (agent $100k → L2 $250k → CEO agent $500k → CEO), company files in W3C ORG + PROV-O JSON-LD, NEAR = enforcement,
  agents/UI = routing.

## 2. Agent Escalation Console (mock UI) — analysis

File: `Agent_Escalation_Console.html` (863 lines, read in full). Single-file mock, no backend; tabs Live trade /
Tommy reports / Jupiter reports; engine `approveSide`; limits hardcoded; L2 timeout 45 s (= 8 h), CEO 60 s (= 24 h).

Scenario trace: 1 ✅; 2 ⚠️ CSO involved only if the CPO counters; 3 ✅; 4 ✅; 5 ⚠️ CEO agent only if the CPO lets it time out.

Logic bugs found:
1. A human counter is not re-checked against the counterer's limit (L2 can close above $250k on a counter).
2. `deal.by.jupiter` stays "-" when the deal closes on Jupiter's counter (Jupiter KPIs undercount).
3. Buyer exception rules (`new_supplier`) checked only on the opening offer.
4. Jupiter never approves the early-pay discount it gives.
5. Agents issue/admit invoices above their mandate's transactionLimit after a higher approval (no approval reference).
6. Tommy "budget" always equals the asked total; treasury text ignores the "Tommy cash tight" switch.

Mismatches with config/4D: UI claims KEL + full OOR chain verification (4C agent verify is format-only; verifier
never checks OOR); CEO agents and second OOR officer not built; rule names differ from company files; limits
hardcoded; invoice says Algorand.

## 3. Codebases checked (read-only)

Reachable on the linked PC during the session: `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIMDEV\` →
chainaim-adminUI-NEAR, chainaim-blockchain-liveops, chainaim-creditseal, chainaim-private-ai, DD5-final-, enh2-final.
The `C:\SATHYA\CHAINAIM3003\mcp-servers\CHAINAIM-DEV\...` repos (this computer) were not read in this session;
confirm they match.

Built and verified in files:
- private-ai: x402 on NEAR (USDC, NEP-366 relayed delegate, relayer pays gas) and RLUSD on XRPL as a separate
  same-chain rail; masking (Presidio + custom + residual guard, fail closed); DuckDB analyst; paid jobs; Strands agent
  pays from a tenant NEAR account; packages/ap2 (UCP checkout + AP2 merchant authorization, ES256 JWS over JCS);
  packages/offer (estimate-first firm quote); tenant policy (rig/tenants/t01/tenant.json).
- adminUI-NEAR: near-watch (NEP-141 transfers, 3 roads, reconcile matched/pending/...), NEAR AI attestation per job,
  recorded real TestNet x402 tx `H3ZFsVY1…` (0.01 USDC). services/custody (OutLayer TEE) deferred, no code.
- DD5-final: seller/buyer/treasury/credit/inventory/logistics agents (Gemini), live GLEIF check, signify-ts,
  live agent cards (jupiterSellerAgent, tommyBuyerAgent, JupiterTreasuryAgent).
- enh2-final invoice credential (`schemas/invoice-credential-schema.json`): sellerLEI, buyerLEI, paymentChainID,
  paymentWalletAddress inside the credential; edge `oor` with operator I2I (issued by an OOR holder);
  invoiceConfig issuer Jupiter_Chief_Sales_Officer, holder tommyBuyerAgent; paymentChainID "algorand".

## 4. NEAR Hackathon tracks (nearhackathon.com)

13 tracks; multiple tracks per project; up to 2 projects per person (each README names the other).
Directory counts (snapshot 766–777 projects): security 355, agents 328, realworld 177, open 161, privacy 153,
business 141, defi 131, swarms 81, social 78, nfts 65, games 65, memecoins 56, thesis 51.
~92 project names are agent spending guards; 6+ use "Mandate"; none name vLEI/GLEIF/LEI/officer/Signatory/
Countersign/Outcome.

Competitors checked (X posts / README): Sealed Ledger (bank CSVs audited in NEAR AI TEEs), Clean Ledger (AML
investigator, TEE, no payments), RedactGate (PII stripping + audit hash on NEAR), Ledgerly (private on-chain
commerce), LinguaLedger (translation company, Intents + TEE), NEAR PayMandate (owner-approved payment terms in a
contract). None mention AP2/UCP/signed checkout (posts only; descriptions not available in the directory API).

## 5. NEAR Intents and 1Click (official docs)

- Intent = outcome, solvers compete, Verifier `intents.near` settles atomically. **No testnet** (MainNet only).
- Intent types: transfer, token_diff, ft/nft/mt/native_withdraw, add/remove_public_key. Signing: nep413, erc191,
  tip191, raw_ed25519, webauthn, ton_connect, sep53; payload has deadline + nonce.
- 1Click API (`1click.chaindefuser.com`): `/v0/tokens`, `/v0/quote` (dry, swapType EXACT_INPUT/EXACT_OUTPUT/
  FLEX_INPUT/ANY_INPUT, depositType ORIGIN_CHAIN/INTENTS/CONFIDENTIAL_INTENTS, confidentiality public/basic/advanced),
  deposit to depositAddress, `/v0/deposit/submit`, `/v0/status` (PENDING_DEPOSIT … SUCCESS/REFUNDED/FAILED).
  Bearer JWT; +0.25% without a key. Operator not named in docs (not a ChainAim service).
- Tokens: USDC on NEAR, USDC/ETH on Ethereum, SOL/USDC on Solana supported; **RLUSD not supported**; XRP supported
  (destination tags not supported for 1Click). 39 blockchains listed.
- Other: Earn (third-party yield, receipt tokens, no principal guarantee), Limit Orders (confidential, default 7-day
  expiry), Agent Skills (`npx skills add near/agent-skills --skill near-intents`), x402-1CS gateway (third party,
  Base USDC only, pilot) — dropped in favour of ChainAim's own rails.
- Card/bank: not part of Intents/1Click (needs a separate on-ramp).

## 6. Payment rails compared

| | private-ai x402 (built) | x402-1CS gateway (3rd party) | xpay (design-36, design only) |
|---|---|---|---|
| Payer | USDC on NEAR; RLUSD on XRPL (separate rail) | USDC on Base | USDC on Base/Solana (wave 1), more EVM (wave 2) |
| Receiver | same chain, same token | any 1Click chain | USDC on NEAR |
| Cross-chain | no | yes | yes (TestNet float relay; MainNet via 1Click EXACT_OUTPUT) |
| Who fronts USDC | n/a | solvers | ChainAim float (TestNet) |
| Decision | keep | drop | don't build before deadline; MainNet path = 1Click |

xpay refund rules (from design-36 summary): buyer is the only party ever refunded, on the chain paid from; price/
address tampering refused before signing; float short → only NEAR option shown; NEAR leg fails → automatic refund;
crash → chain decides; unclear → needs_review (owner). Two cases unspecified: wrong amount arrived; release fails.

Licensing (not legal advice): FinCEN treats CVC payment processors as money transmitters (no payment-processor
exemption); every state but Montana regulates money transmission; agent-of-the-payee exemption in ~half the states,
goods/services only, written agreement. Case A (xpay for ChainAim's own service) lower risk; case B (xpay moving
Tommy→Jupiter money) high; case C (mandate contract + 1Click, non-custodial) lowest. Get a payments-counsel memo.

Pricing/profitability: gas is already priced in (`NEAR_GAS_FEE_USD 0.002`, `FEE_PER_MODEL_CALL_USD 0.001`,
`FEE_ANALYST_USD 0.002`, `MARGIN_PCT 20`, `MIN_PRICE_USD 0.01`). Stripe US: cards 2.9% + 30¢, ACH 0.8% capped $5,
stablecoin 1.5%. Cards/bank only as credit top-ups, never per call; one USD credit ledger, many top-up rails.

## 7. Quote vs agent policy (ERPNext flow)

Screen: t01 policy maxPerJobUsd 0.05, quote 0.09 → not paid. Cause (from packages/offer + crossask/cost.ts):
estimate-first worst case = answer-model call at full maxTokens + analyst $0.0140/MB × 1.47 safety + gateway + fees
+20% margin, rounded up to cents. Fix options: smaller maxTokens/answerMaxRows, phrase none, or raise the cap;
keep one deliberate refusal scene.

## 8. Entries decided

### Entry A — ChainAim Outcome AI (was "Countersign"; the Private AI entry)

- Positioning: an antidote to frontier-AI adoption blockers in regulated industries.
  Data leaves control → de-identification / reversible pseudonymization, fail closed.
  Hallucinated numbers → deterministic compute, grounded and verified answers.
  Unpredictable cost → compute first, model last; model routing.
  Pay for effort → outcome-based pricing (firm quote, failed job never charged).
  Trust-me infra → confidential computing / verifiable inference (NEAR AI attestation) + on-chain reconcile.
  Agents can't buy safely → UCP checkout + AP2 merchant signature + agent spending mandate.
- AP2 (Google, Sept 2025) and UCP (Google with Shopify and retailers, Jan 2026) verified as Google-led open standards.
- NEAR value: each job = a NEAR AI Cloud attested inference + a USDC settlement on NEAR + an agent account paying.
- Tracks: Privacy & Private AI (lead), Real-World Money, Agent Economy.
- Missing: quote/cap fix; user-side AP2 Checkout Mandate (Phase 2, outline only); policy enforced off-chain;
  counter-offers (ARCH-623); full-pipeline TEE (only model calls attested); judge-mode README; disclosure check.
- NEAR Intents not required (tracks don't need it; micro-amounts; MainNet only). Optional: credit top-up from any chain.
- Wording rules: "every AI call attested", "merchant-signed AP2 quote", never "HIPAA compliant".

### Entry B — Signatory (vLEI + NEAR mandate)

- Signatory 1 (full: two companies, 8 nodes, Intents, ~20–28 h) → too much.
- Signatory 2 (lite: one officer, one agent, one contract, ~10–12 h).
- **Signatory 1.5 (chosen direction):** 6 nodes — Jupiter CSO (OOR, signs invoice) → jupiterSellerAgent →
  InventoryAgent + TreasuryAgent (masked, attested NEAR AI advice on ERPNext jupiter-knitting books, no payment key);
  Tommy CPO (OOR, approves above limit, revokes) → tommyBuyerAgent (function-call key on pay_invoice).
- Contract: register_invoice (attestor), pay_invoice, approve (CPO), revoke. Invoice SAID binds payee and amount.
- Scenes: routine paid · over limit → CPO approves · tampered invoice refused (SAID mismatch) · revoked · any chain
  (1Click EXACT_OUTPUT dry quotes; one real MainNet payment if time allows).
- Penny-test scale 1 : 1,000,000 (1¢ = $10,000): agent $0.10, CPO $0.25, orders $0.084 / $0.1575 / $0.40.
- Punchline: "Private AI decides. Signed credentials prove. NEAR enforces." Tracks: Autonomous Business (lead),
  Real-World Money, Security as a tag.
- Legal angle (worded carefully): "a verifiable evidence trail auditors and courts can check", not "legally binding".
- vLEI risks: test root of trust; format-only agent verify / OOR unchecked; bridge as trust point; revocation lag;
  judges can't run KERIA (recorded output, no key files); AIDs change per run; placeholders; custom invoice schema
  (algorand chain, float amount, required ref_uri); never claim GLEIF endorsement.
- Effort: ~16 h core + ~5 h stretch. Do Entry A's fixes and video first.
- UI mockup: design canvas "Signatory 1.5 — Console" (https://claude.ai/artifact/Kz2nYjAC86urFrEqKSJFas),
  interactive, 5 scenes, sample data.

## 9. Open items / next steps

1. Entry A: fix the ERPNext quote vs t01 cap; README judge mode; disclosure; rewrite the 1-min video around
   "Outcome AI"; record.
2. Entry B: "PROCEED TO CHANGE" for a new repo (name e.g. chainaim-signatory); contract + tests first.
3. Read the 1Click Quickstart/API-keys/swap-limits pages before the Intents scene; get a 1Click key (manual).
4. Confirm whether this computer's CHAINAIM3003\...\CHAINAIM-DEV repos match the CHAINIAM3003 copies read earlier.
5. Payments-counsel memo before taking third-party money (xpay case B, credits).

## Sources

- https://nearhackathon.com/ and its /api/projects listing (names and tracks)
- https://docs.near.org/chain-abstraction/intents/overview
- https://docs.near-intents.org (what-are-intents, verifier-contract, intent-types-and-execution, signing-intents,
  1click-api about / making-a-request / swap-types / confidential-swaps / earn / orders, devkit/skills,
  resources/chain-support, llms.txt)
- https://1click.chaindefuser.com/v0/tokens
- https://github.com/IkerAlus/x402_1CS_gateway
- https://github.com/mitran27/clean-ledger
- https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol/
- https://infoq.com/news/2026/01/google-agentic-commerce-ucp
- https://www.fincen.gov/sites/default/files/2019-05/FinCEN%20CVC%20Guidance%20FINAL.pdf
- https://stripe.com/pricing
- Local files: private-ai README, PROJECT_CONTEXT, config/paid-jobs-prices.conf, config/cost-model.json,
  packages/crossask/src/cost.ts, packages/offer/src/index.ts, rig/tenants/t01/tenant.json,
  DESIGN/privateAI-design-33; adminUI README, HACKATHON-DISCLOSURE.md; DD5 PROJECT_CONTEXT; enh2-final
  invoiceConfig.json, invoice-credential-schema.json

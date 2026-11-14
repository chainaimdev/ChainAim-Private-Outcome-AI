# NEAR HACKATHON disclosure: what came before, and what was built in the window

Window: NEAR HACKATHON, 1 Nov 2026 00:00 UTC to 14 Nov 2026 23:59 UTC. Every date below is a commit or tag date in this
repository (`git log`, `git tag`). The companion repository
[chainaim-adminUI-NEAR](https://github.com/chainaimdev/chainaim-adminUI-NEAR) has its own `HACKATHON-DISCLOSURE.md`.

## How this repository started

This repository was created during the window. Its first commit, `58e36245` (3 Nov 2026, "Seperation done"), split it
out of ChainAim's earlier private-AI and lending codebase (CreditSeal, which grew from `chainaim-router`). That first
commit therefore carries code written **before** the window. It has no commits dated before 1 Nov; the earlier history
lives in the predecessor repositories.

## Baseline: written before 1 Nov 2026 (arrived with the first commit)

- **Masking gateway** (`services/gateway`) with **Presidio** (`services/presidio`) and ChainAim's own patterns: find and
  mask personal, account, health and card data before any model sees it; restore on the user's side; fail closed.
- **Model routing**: catalogs for local, OpenRouter and Amazon Bedrock models; the decision ledger (no text).
- **x402 paywall on the XRP Ledger** (RLUSD) and its scripts (`services/paywall`, `services/web` Crossmark wallet):
  the XRPL rail is still in the code and still tested; NEAR is the rail this entry demonstrates.
- **Multi-tenant test rig** and **buyer agents** on Strands + Bedrock (paying on XRPL).
- **The analyst** (`services/analyst`): DuckDB relations and read-only SQL across a folder of files; the dental
  practice reconciliation pack; "ask across files" (`packages/crossask`).
- The pre-hackathon design notes, session records and build log: removed from the tree on 14 Nov, kept in git history.

## Built during the window (1 to 14 Nov 2026), by release

| Release | Date (UTC) | What was built |
|---|---|---|
| (first commit and before) | 1-3 Nov | Done in the predecessor repo inside the window, arrived with `58e36245`: domain packs for dental and chiropractic practice data, the ACTUS package split, multi-chain chain-query design |
| v1.1.0 | 3 Nov | Read-only chain queries (XRPL + NEAR) and the Blockchain queries panel |
| v1.2.0 to v1.2.2 | 4 Nov | Datasets in tab 03; chiropractic ERA X12 835 parser and adapter |
| **v1.3.0** | 4 Nov | **NEAR USDC x402 payment rail**: paywall rail, relayer (NEP-366 delegate), NEAR web wallet, NEAR scripts, NEAR-GATES |
| v1.3.1 to v1.3.9 | 5-6 Nov | Chiro data generator; pay-as-you-go paid jobs on NEAR; Docker stack; programmatic tenant wallets; **tab 03 AI agent pays on NEAR**; `desk.ps1` one-command desk |
| **v1.4.0 to v1.4.9** | 6-8 Nov | **NEAR AI model**; **NEAR AI attestation**: verify-first gate, `ca-attest` (official verifier), every paid job checked; results to the admin UI; template smoke check; exact-query banks |
| v1.5.0 to v1.5.7 | 10-11 Nov | **Signed job receipts** (Ed25519) and their offline verifier; **agent spending policy**; the agent verifies the receipt; headless `-AgentAsk`; AP2 groundwork; ERPNext templates |
| **v1.6.0** | 12 Nov | **AP2 signed quotes** (UCP checkout, merchant authorization), checked by the agent with a pinned key |
| v1.7.0 | 12 Nov | ERPNext JSON bundles read directly by DuckDB |
| **v1.8.0 to v1.9.2** | 12-13 Nov | **Estimate-first firm quotes** (price from sizes, no work before payment); observer view ("What the chain shows"); judge path |
| **v2.0.0** | 13 Nov | **ChainAim's signer as its own control-plane service** (`ca-control-signer`) and the tenant's **AP2 checkout mandate** |
| **v2.1.0** | 13 Nov | **Pay before work with automatic NEAR refunds**; **signed job limits**; **pay only for attested private inference**; **money trail** in the receipt |
| v2.1.1 to v2.1.3 | 13-14 Nov | **Egress receipt** ("what left your PC" = the attested request hash); fixes; judge and demo pages |
| v2.2.0 | 14 Nov | The deal on the admin Jobs tab (tenant mandate in the job feed); **re-check the folder size before paying** |
| **v2.3.0** | 14 Nov | **One-round counter-offer**: the agent asks for a smaller job at its auto-approve limit; ChainAim's signer prices it; the price is never discounted, only the job shrinks |

Requirement ids in test names: ARCH-0xx are the pre-hackathon paywall requirements, defined in
`architecture-xrpl-migration.md` (removed from the tree on 14 Nov; in git history, commit `58e36245`); ARCH-1xx are in
`architecture.md`, ARCH-3xx in `architecture-tab03-agent-mode.md`, ARCH-4xx in `PLAN-private-ai-nearai-attestation.md`,
ARCH-2xx in the admin repo, and ARCH-6xx to 7xx in `DESIGN/privateAI-design-32` to `-43`.

Design records for the window: `DESIGN/privateAI-design-30` to `-43`, and `DESIGN/xrplh-24` to `-29` (1-3 Nov).
The record of what ran: [BUILD_LOG.md](BUILD_LOG.md) and [STATE.md](STATE.md) (both from 1 Nov).

## Not built (roadmap)

Hosted gateway in a TDX VM, signer in a TEE (NEAR Shade Agents), settle remotely, spending mandate on NEAR, model proxy,
unlinkable credits: see the README's Roadmap.

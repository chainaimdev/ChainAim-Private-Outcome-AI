# xrplh-21 — Session record: key cleanup (v1.1.1), isolation proof + reapply policy + XRPL anchors + split layout (v1.2.0), E2E encryption and key-storage design

**Session:** 2026-10-27 12:03 → 21:23 (UTC-5)
**Repo:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\CreditSeal\CreditSeal` (origin `github.com/chainaim-sathya/CreditSeal`, branch `main`)
**Previous record:** `DESIGN/xrplh-20-SESSION-SPLIT-REVIEW-PORT-V1.1.0-2026-10-27T1157.md`
**Companion design:** `DESIGN/xrplh-22-E2E-ENCRYPTION-AND-KEY-STORAGE-DESIGN-2026-10-27T2123.md`

**Outcome:** `main` = `e8626e8`, tagged **`v1.2.0`** (pushed). `v1.1.1` = `4da7d91`. Tests 58/58 (AI's shell, Node 22.23); `prove-isolation` 12/12 PASS on the owner's PC (Windows, Node 24.22).

This is a summary record (questions, findings, decisions, commands, results), not a verbatim transcript.
Statements marked *(unverified)* were not checked against a file or a run.

---

## 1. Recap at session start

- Read `xrplh-20` and `.git`: `e7a9578` (the xrplh-20 doc) was already committed and pushed (`refs/remotes/origin/main` = `e7a9578`), closing the open item from the handoff.

## 2. Exposed gateway key in `.env.example` → v1.1.1

- **Finding (verified by SHA-256 fingerprint comparison, keys not printed):** the value in `.env.example` (`CHAINAIM_GATEWAY_KEY`) was **not** the live local key (`test-console/local-gateway-key.txt`). Consumers of the live key: `ca-gateway` (via `switch-models.ps1`), `ca-paywall` (`stack.ps1 -Recreate paywall`), console (`test-console/console/server.ts`), analyst (`ask.ts`, `contract-cashflows.ts`).
- The value had been in git history since the first commit `5fd0dee`, so it is burned regardless.
- **Decision:** blank it, do not rotate (nothing live used it). *(unverified: whether it was ever set on a Railway or other deployment; owner judged no.)*
- Committed `4da7d91` "Security: blank exposed CHAINAIM_GATEWAY_KEY value in .env.example", tag **v1.1.1**, pushed.

## 3. Item 1 — Isolation proof (built, verified)

**Files:** `services/lending/scripts/prove-isolation.ts`, `services/lending/src/isolation.ts`, `services/lending/test/isolation.test.ts` (6 tests).

- Per borrower, two folders under a work folder: **borrower-pc** (copy of the books + questions) and **lender-pc** (rulebook + questions). Only the facts pack is copied across.
- **Enforcement:** Node's permission model. `facts.ts` and `decide.ts` run with `--permission --allow-fs-read=<code>,<own folder> --allow-fs-write=<own output>`. A **probe** with the same flags then tries to read the other side's secret and must get `ERR_ACCESS_DENIED`.
- **Acts:**
  1. `facts.ts` runs without the rulebook (policy absent and unreadable).
  2. Nothing in the borrower's outbox contains a value from `customers.csv:Customer Name` or `invoices.csv:Invoice No` (`--secret-columns`; a missing column makes the act FAIL rather than pass vacuously).
  3. The books copy is deleted; `decide.ts` runs without it (books unreadable).
  4. The borrower's questions and outcome contain none of the lender's keys (`rules`, `broker` and every key under them, read from `--lender-policy`) and no "(limit" text.
- **Flags:** `--books <dir>...` `--lender-policy` `--questions` `--out` `--json` `--sandbox node-permission|none` `--secret-columns` `--allow-read` `--keep` `--timeout-sec`. Exit 0 all PASS, 1 any FAIL, 2 bad flags.
- **Output:** PASS/FAIL table (row per borrower) + who-sees-what matrix (each cell tied to the act that proves it; a failed act shows NOT PROVEN).
- **Desk:** Isolation card (POST `/api/isolation` runs the script with `--json`; GET returns the last report); cockpit flag `--isolation-sandbox`.
- **Results:** AI's shell (Node 22.23) 3 borrowers × 4 acts PASS; **owner's PC (Windows, Node 24.22) 12/12 PASS**, every probe `ERR_ACCESS_DENIED`; Orion `factsHash 350c5321f348be7c…` unchanged.
- **Limits stated in the output:** one machine, one OS user; the sandbox proves the software cannot cross, not that the owner cannot look. Network is **not** restricted by this sandbox (the proof runs `--no-gleif`, no ACTUS).

## 4. Item 2 — Reapply policy, applications log, XRPL anchors, split layout (built, offline-verified)

**Files:** `src/reapply.ts`, `src/anchor.ts`, `src/layout.ts`, `scripts/layout.ts`; changes to `scripts/decide.ts`, `scripts/underwrite.ts`, `scripts/facts.ts`, `scripts/lending.ts`, `src/stages.ts`, `src/stage-io.ts`, `scripts/cockpit.ts/.html`, `start-desk.ps1`; tests `test/reapply.test.ts` (9), `test/anchor.test.ts` (3).

- **Reapply policy** (lender side, only when `--applications-log` is given; otherwise behaviour unchanged):
  - Applicant key: LEI (GLEIF record or declared), else the facts pack's `borrowerRef`. `--require-lei` returns packs without one.
  - **RETURNED** (exit 3): paperwork problems (other questions, a document not matching its terms, no LEI when required) — no credit decision, no cooldown; at most `--max-clerical 3` per `--clerical-window-days 30`, then NOT CONSIDERED until the window has room.
  - **NOT CONSIDERED** (exit 4): within `--cooldown-days 90` of a DECLINE, unless the new books run at least `--material-change-months 1` further.
  - `--max-offers-returned 2`: the borrower's outcome lists only the best counter-offers (largest approvable amount, then shorter term, then ANN). The lender's pack is unchanged.
  - `--now <ISO>` for audits and tests. Undecided attempts are saved as `<rid>.attempt-<n>.json` (an earlier outcome is never overwritten).
- **Applications log:** `applications.jsonl`, hash-chained (each entry: `prevHash`, `entryHash = sha256(canonical entry)`); a broken chain is refused.
- **XRPL anchors:** `lending.ts anchor` sends an AccountSet from the broker with memo `chainaim/decision-log` `{v, head, n, p}`; `anchors.jsonl` next to the log. `lending.ts verify-anchors` recomputes the chain and checks each anchor on the ledger (validated, tesSUCCESS, sent by the lender, head matches entry n). Only hashes and a count go on-chain.
- **Split layout:** `data/borrowers/<id>/{books,outbox}`, `data/lenders/<id>/{policy,decisions}`, `data/exchange/`. `layout.ts init` copies (never moves). `facts.ts --exchange`, `decide.ts --exchange`; `decide.ts` keeps the facts it decided on next to the pack.
- **LEI in facts:** when GLEIF is skipped, the declared LEI is now kept in the facts pack (`identity.lei`), so the reapply key cannot be dodged with `--no-gleif`. Changes Jupiter's `--no-gleif` facts hash (`77602dc8…` → `fd554d33…`); Orion unchanged (no LEI).
- **Desk:** Applications card (GET `/api/applications`, actions `lender-anchor`, `lender-verify-anchors`); cockpit `--applications-log`; `start-desk.ps1 -ApplicationsLog <file> -IsolationSandbox node-permission|none`. Step 4 (Mercury) accepts DECLINE or NOT CONSIDERED.
- **Fix:** `--json` output of facts/decide/underwrite was cut at 64 KB when piped (`process.exit` before stdout drained); now written with a flush callback / `exitCode`.
- **Verified:** reapply 9/9, anchor 3/3 (AccountSet passes xrpl.js `validate` + `encode`; audit catches a rewritten log, a foreign sender, a failed tx), split-layout flow by hand (DECLINE exit 0 → NOT CONSIDERED exit 4), Desk with throwaway seeds (Isolation 12/12; Mercury twice → DECLINE then NOT CONSIDERED; chain intact). **Not yet verified:** an anchor sent on Devnet (AI's shell cannot reach Devnet).

## 5. Commit and tag v1.2.0

- First attempt ran from `services\lending` with root-relative paths: `git add` failed, nothing committed, but `v1.2.0` was created on `4da7d91` and pushed. Fixed: `git tag -d v1.2.0`, `git push origin :refs/tags/v1.2.0`, commit from the root, re-tag, push.
- **Result:** `e8626e8` "Lending: isolation proof, reapply policy with hash-chained applications log and XRPL anchors, split data layout (LEND-4)", 20 files, +1277/−49; tag `v1.2.0` → `e8626e8`, pushed.

## 6. Incidents and open observations

- **AI test wrote into real data:** a Desk test run in the AI's shell (Desk underwrite steps write to `data/lending/packs` by default) overwrote Mercury `uw-1876489c04.*`. Outcome restored; the attempt file moved to `data/lending/packs/_to_delete/` (AI cannot delete on the owner's PC). Mercury's ACTUS evidence files now record "not reachable" (AI's shell cannot reach ACTUS) — **re-run Desk step 4 once** to regenerate them.
- **Mercury `factsHash` differs by Node version:** `8223b357…` (owner, Node 24.22) vs `fe4932b0…` (AI, Node 22.23) from the same books and code; Orion and Jupiter match. Cause *(unverified)*: last-digit float differences between V8 versions. Protocol unaffected (the lender hashes the received file), but "identical hash" holds only per Node version.
- AI's shell: `import("xrpl")` over the mounted folder takes ~58 s, so the Desk starts in ~45 s there.
- UI test sequence started: Applications card showed the log path, 0 entries; Anchor correctly said "nothing to anchor". Steps 4 → 4 → 6 → Anchor → Verify not yet reported.

## 7. Design discussions (no code)

### 7.1 Is prove-isolation working, and what is Item 3 for?
- Yes, working (12/12 on Windows). Item 3 (Docker) strengthens it: network isolation of the facts step, separate filesystems, `docker inspect` as proof, image digest in packs (format v3 — the riskiest part: changes the pack hash for new loans; v2 loans must stay verifiable).

### 7.2 Hardening tiers deprioritised
- Separate Windows accounts + ACLs, encrypted relay, separate cloud accounts with audit logs, Docker: **not built**; lowered in priority. Business use cases on separate directories rely on what exists (split layout + Node sandbox proof). Describe as "separate directories per party, software proven to respect them", not "separate machines".

### 7.3 E2E encryption (detailed in xrplh-22)
- Fits the current code without the relay or Docker; those plug in later (relay carries ciphertext; Docker mounts each party's key folder only).
- Keys: lender in AWS KMS (P-256 `KEY_AGREEMENT` + Ed25519 `SIGN_VERIFY`); borrower on its own PC; ChainAim holds no decryption key. KMS ECDH supports NIST curves only → envelope uses **P-256**, not X25519.
- Best practice: follow **HPKE (RFC 9180)** with test vectors rather than a home-made envelope; add rotation/revocation.

### 7.4 Who inspects, if ChainAim cannot read? (two flows)
- **Lender flow** (party → trusted party): E2E; each secret can only leak through its owner's software, so the check runs **at the source before sealing** and again at the receiver; ChainAim authors and signs the checker. Optional later: enclave inspection (Nitro) so ChainAim's code checks but its staff cannot see.
- **AI flow** (party → outside model): ChainAim must see the text (ideally pre-masked by the client) to mask and check it; the gateway already re-detects even client-masked text and the **residual check refuses with HTTP 422** (read: `services/gateway/src/chat.ts`, `privacy/residual.ts`). Effective control = gateway is the **only** path to Bedrock (IAM), plus measured masking recall. **Gap from `DESIGN/xplh-3-DESIGN-PLAN-reconciled.md`:** the Strands agent's typed prompt reached Bedrock unmasked, bypassing the gateway *(unverified whether fixed since)*.
- XRPL: fingerprints only, a third rule.

### 7.5 Vendor neutrality of key storage
- `KeyProvider` needs three calls (`publicKey`, `deriveSharedSecret`, `sign`); suite ids in the envelope header (crypto agility); keys named by fingerprint, not vendor ID; moving vendors = rotation. AWS KMS fits fully; PKCS#11 HSMs fit with a raw-secret caveat; Google Cloud KMS and Azure Key Vault ECDH not confirmed.

## 8. State and next steps

**Done:** v1.1.1 (key blanked), v1.2.0 (Items 1 and 2), Item 1 verified on Windows.

**Pending, in order:**
1. UI test: Desk step 4 → 4 → 6 → Anchor → Verify (first anchor on Devnet).
2. Desk split-layout switch (`--layout split` on cockpit, `-Layout split` on `start-desk.ps1`) — top priority for business use cases.
3. E2E encryption step 1 (xrplh-22): HPKE envelope, FileKeyProvider, content checker, `keys.ts`, `open.ts`, prove-isolation act 5. Owner to choose: own HPKE implementation + RFC test vectors, or `hpke-js`.
4. Polish: disable Anchor when the log is empty; clean message when Devnet is unreachable; Desk cheat sheet; delete `data/lending/packs/_to_delete/`.
5. Mercury hash by Node version: diff the two facts files.
6. Verify/close the Strands → Bedrock bypass (AI codebase).
7. E2E step 2: AWS KMS provider (manual: KMS keys + IAM role in `ap-southeast-2`; free-plan support *(unverified)*).
8. Later: Item 3 Docker; rebuild `ca-*` containers from CreditSeal; relay; enclave; ZK-PRET; MPC.

# xrplh-22 — End-to-end encryption and key storage for the borrower ↔ lender exchange (design, not built)

**Date:** 2026-10-27 (UTC-5) · **Status:** design approved for discussion; no code yet
**Repo:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\CreditSeal\CreditSeal`
**Builds on:** `v1.2.0` (`e8626e8`): split layout (`data/borrowers`, `data/lenders`, `data/exchange`), `facts.ts --exchange`, `decide.ts --exchange`, `prove-isolation.ts`, reapply log + XRPL anchors.
**Session record:** `DESIGN/xrplh-21-SESSION-ISOLATION-REAPPLY-ANCHORS-V1.2.0-2026-10-27T2123.md`

Marks: **[AWS-DOC]** read on docs.aws.amazon.com on 2026-10-27; **[VENDOR-DOC]** read on the vendor's docs on 2026-10-27; **[CODE]** read in this repo; **[NODE]** run in Node 22.23; *(unverified)* not checked.

---

## 1. Goal and scope

- **Goal:** what crosses between borrower and lender (facts pack out, outcome back) is readable only by the intended party. The exchange folder today — and the ChainAim relay later — sees only ciphertext and a routing label.
- **In scope:** the **lender flow** (party → trusted party).
- **Out of scope here:** the **AI flow** (party → outside model through the ChainAim gateway). There ChainAim must see (masked) text to mask and check it; see §9.
- **Later, plugs in without changing this design:** the ChainAim relay (moves the same sealed files), Docker isolation (each container mounts only its own key folder), enclave inspection.

## 2. Plain-language model

- **Padlock (encryption key):** the lender hands out open padlocks (public key); only it holds the key that opens them, kept in a vault (AWS KMS) that never lets the key out.
- **Box:** the borrower puts the facts pack in a box and locks it with the lender's padlock.
- **Wax seal (signing key):** the borrower stamps the box; the lender checks the seal *before* opening and throws away fakes unopened.
- **Post office (ChainAim / `data/exchange`):** carries the box, can read the label (from, to, when), never the inside.
- **Notice board (XRPL):** the lender's padlock fingerprint is pinned there so borrowers can tell a real padlock from an impostor's.
- **Visitor log (CloudTrail):** every use of the lender's key in KMS is recorded.

## 3. Concrete example (Orion → Harbor)

Values marked *(example)* are illustrative.

1. **Orion's PC.** Books hold e.g. customer "Atlas Build Supply (demo)" and invoices `INV-60001…`. `facts.ts` produces the facts pack `uw-9b8485ee7e`: numbers only (lowest base-case cash 41,200 *(example)*, coverage 1.6 *(example)*, largest customer share 0.31 *(example)*). The **content checker** runs on Orion's PC: no customer name, no invoice id, fixed shape → pass. Orion seals to Harbor's public key and signs.
2. **Exchange.** Sees `{from: orion-fpr…, to: harbor-fpr…, kind: facts, sent: …}` + ciphertext.
3. **Harbor.** Verifies Orion's signature, opens with its KMS key, **re-runs the checker**, decides with its private rule `minCoverageBase 1.25` → APPROVE. The outcome ("APPROVE, 50,000 USD, 3 months, 12 %") is checked for cut-off keys, then sealed to Orion and signed.
4. **Orion** verifies, opens, re-checks: no limits leaked.
5. **XRPL:** pack hash in `LoanSet.Data`, applications-log head in an anchor, Harbor's key fingerprint. Nothing secret.

Harbor never learns "Atlas Build Supply"; Orion never learns "1.25"; ChainAim learns neither, nor any number.

## 4. Why ChainAim does not need to inspect the lender flow

- Each secret can only be leaked by its **owner's** software: the borrower's names only when building the facts; the lender's cut-offs only when writing the outcome. Protection therefore sits **at the source, before sealing**.
- Four layers:
  1. **Fixed shapes:** the facts pack has no field for names; the outcome has none for limits; `facts.ts` computes only the fixed fact list whatever the questions say.
  2. **Sender's checker** (ChainAim-authored, open, versioned) runs before sealing and refuses to seal a failing pack.
  3. **Receiver re-checks** after opening; a failing facts pack is RETURNED (paperwork) by the reapply policy.
  4. **`prove-isolation`** shows the commands keep each secret on its side (12/12 PASS, Windows, Node 24.22).
- ChainAim's role: **author and signer of the checker**; each envelope records the checker's version hash.
- **Optional later — enclave inspection:** ChainAim's checker runs in an AWS Nitro Enclave; the lender's KMS key policy may allow `DeriveSharedSecret` only from an attested enclave. **[AWS-DOC]** `DeriveSharedSecret` has a `Recipient` / attestation option that returns the secret encrypted to the enclave. Tying the policy to a specific enclave image is *(unverified)*.
- **Not by default:** decrypt-and-re-encrypt at ChainAim (ChainAim reads everything; would need written consent, own KMS keys, data-processor duties). If ever offered: an explicit labelled mode (e.g. `--relay-mode inspect`).

## 5. Cryptography

- **Envelope = HPKE (RFC 9180), base mode, one suite:** DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
  - **P-256, not X25519:** **[AWS-DOC]** KMS `DeriveSharedSecret` requires a NIST-standard ECC (or SM2, China Regions) key with `KeyUsage KEY_AGREEMENT`; both parties' keys must be on the same curve.
  - Header bound as AAD (any header change fails decryption).
- **Signature:** Ed25519 over header + encapsulated key + ciphertext; verified **before** decrypting, against a pinned sender fingerprint. **[AWS-DOC]** KMS supports `ECC_NIST_EDWARDS25519` with `ED25519_SHA_512`. Fallback suite for vaults without Ed25519: ECDSA P-256.
- **Header (visible, routing only):** `{v:1, suite:"hpke:P256-SHA256-AES256GCM", sig:"Ed25519", kind:"facts"|"outcome", from:<sender fpr>, to:<recipient fpr>, envelopeId, createdAt, checker:<checker version hash>}`. `requestId`, LEI, verdict and all numbers are inside the ciphertext.
- **Implementation choice (owner to decide):**
  - (a) own HPKE implementation over Node built-ins, proven against the **official RFC 9180 test vectors** — keeps the single ECDH step pluggable for KMS (recommended); or
  - (b) the `hpke-js` library — less own code, but the KMS ECDH step needs a custom KEM.
- **[NODE]** verified in Node 22.23: X25519/ECDH, `hkdfSync('sha256')`, `aes-256-gcm` with AAD, Ed25519 sign/verify. P-256 ECDH is a Node built-in *(not separately run today)*.
- **Hashes unchanged:** `factsHash` and the pack hash stay over plaintext → pack format and `LoanSet.Data` unchanged (no format v3 needed for encryption).

## 6. Key storage

| Key | Demo (now) | Production |
|---|---|---|
| Borrower private keys (P-256 enc + Ed25519 sig) | `--keys-dir`, default `data/borrowers/<id>/keys/`; recommended `C:\PRIV-AI-SECRETS\creditseal-keys\<party>\` (outside the repo); files encrypted at rest with a passphrase (scrypt) | On the borrower's PC outside any repo, or Windows DPAPI; hardware key later |
| Lender private keys | `data/lenders/<id>/keys/` (passphrase-encrypted file) | **AWS KMS** in the **lender's own AWS account**: one `KEY_AGREEMENT` P-256 key, one `SIGN_VERIFY` Ed25519 key. No key file exists; config holds only the key ARN (not a secret). IAM: only the lender's decide role may call `kms:DeriveSharedSecret` / `kms:Sign`; CloudTrail logs each use |
| Sender's one-time key | generated per envelope, discarded | same |
| ChainAim | **no decryption key** | its own KMS Ed25519 key only for anchors/attestations |
| Public keys | `data/exchange/directory/<party>.pub.json` | same + lender fingerprint anchored on XRPL (AccountSet memo, reusing `src/anchor.ts`) |
| Passphrases | environment variable **named** by `--passphrase-env` (pattern of `--ai-key-env`); never on the command line, never printed | secrets file outside the repo (as `C:\PRIV-AI-SECRETS\lending-devnet.env`) |

- **Not Secrets Manager** for private keys: it stores retrievable key material; KMS only allows use.
- **Demo caveat:** one AWS account (`897258608518`, free plan, limited to `ap-southeast-2` per `BUILD_LOG.md`) separated by IAM is acceptable for a demo; describe it as "one account, separated by IAM". KMS asymmetric key availability/pricing on the free plan *(unverified)*.
- **Rule:** whoever holds a decryption key can read. The lender's KMS key must not sit in ChainAim's account in production.

## 7. Keeping keys out of git

1. `data/` is already in `.gitignore` [CODE] → `data/**/keys/` ignored today.
2. Add explicit patterns: `**/keys/`, `*.key.json`, `*.pk8`.
3. Private key files are passphrase-encrypted → useless if leaked; the passphrase is never in the repo.
4. `test/keys.test.ts` lists git-tracked files and **fails** if any contains a private-key marker (`"kind":"chainaim.private-key"`, `-----BEGIN PRIVATE KEY-----`).
5. Optional: pre-commit hook running the same scan.

## 8. Vendor neutrality

- **`KeyProvider` interface** (three calls): `publicKey()`, `deriveSharedSecret(peerPublicKey)`, `sign(message)`. Selected by `--key-provider file|aws-kms|pkcs11 --kms-key-id <arn> --kms-region <region>`. One adapter file per vendor.
- **Crypto agility:** suite ids in the header; new suites (ECDSA P-256 signatures; RSA-OAEP key wrap for vaults without ECDH) can be added while old envelopes still open.
- **Keys named by fingerprint**, never by vendor key ID, in the envelope.
- **Moving vendor = key rotation** (vault keys are non-exportable): create a new key, publish/anchor its fingerprint, keep the old key until old envelopes are retired.

| Vendor | ECDH | Signing | Fit |
|---|---|---|---|
| AWS KMS | P-256 `DeriveSharedSecret` [AWS-DOC] | Ed25519 [AWS-DOC] | full |
| HSMs via PKCS#11 (AWS CloudHSM, Thales, Azure Cloud HSM, YubiHSM) | `CKM_ECDH1_DERIVE` [VENDOR-DOC: Thales; Azure Cloud HSM algorithm list] | EdDSA / ECDSA | fits; caveat: ECDH result often stays inside the HSM as a key object — HPKE needs the raw secret (extractable attribute; check per model) |
| Google Cloud KMS | not confirmed | ECDSA P-256 *(unverified)* | unknown |
| Azure Key Vault (standard) | not confirmed | ECDSA P-256 *(unverified)* | unknown |

## 9. The AI flow (for contrast)

- Final reader is an outside model (Bedrock, others) → ChainAim's gateway must see the text to mask and check it; not end-to-end by necessity.
- **[CODE]** gateway: re-detects even client-masked text ("client masking never loosens the data policy", `services/gateway/src/chat.ts`); masks; classifies data class for model zones; **residual check** refuses with **HTTP 422** before anything leaves, recording kinds and counts only (`services/gateway/src/privacy/residual.ts`).
- Make it effective: gateway = **only** path to Bedrock (only its IAM role has `bedrock:InvokeModel`); clients send **pre-masked** text so ChainAim never sees raw values; measure masking recall on a test set with a release threshold and canaries; PHI only to local/private-cloud zones; later, gateway checking in an enclave.
- **Gap:** `DESIGN/xplh-3-DESIGN-PLAN-reconciled.md` records the Strands agent's typed prompt reaching Bedrock unmasked, bypassing the gateway *(unverified whether fixed)*.
- In CreditSeal both flows occur in one loan: facts/outcome = lender flow (sealed); `decide.ts --ai-url` explanation via the gateway = AI flow (masked); XRPL = fingerprints only.

## 10. Threat model summary

**Protects:** content against the exchange/relay and ChainAim; forged or altered envelopes; wrong-sender envelopes; replay (`envelopeId` + applications log); leaks of the other party's secrets through buggy code (checker at both ends).

**Does not protect:** endpoint compromise (whoever holds a party's key folder or KMS permission); metadata (sizes, timing, fingerprints); the same-machine owner in the demo (Docker / accounts later); forward secrecy against later theft of the lender's static key (mitigated by KMS; short-lived keys later).

**Best-practice status:** conforms on KMS non-exportable keys, least privilege, audit logs, key separation (encryption ≠ signing ≠ XRPL wallet), AEAD with AAD, verify-before-decrypt, per-message ephemeral keys, keys held only by their owners. **Gaps to close before production:** use HPKE exactly with RFC test vectors (planned), key rotation and revocation (fingerprint + revocation on XRPL), passphrase strength / DPAPI for borrowers, separate AWS account for the lender, external security review.

## 11. Build plan

**Step 1 — AI, offline, test-first (~one session):**

New:
- `services/lending/src/envelope.ts` — HPKE seal/open (suite above), header AAD, Ed25519 sign/verify-before-open, suite ids.
- `services/lending/src/keys.ts` — `KeyProvider`; `FileKeyProvider` (scrypt-encrypted PKCS#8 files, `--passphrase-env`).
- `services/lending/src/content-check.ts` — shared checker (names/ids, cut-off keys, fixed shape) moved from `src/isolation.ts`, with a version hash.
- `services/lending/scripts/keys.ts` — `init --party borrower:<id>|lender:<id>`, `show`, `export-public`; `--keys-dir`, `--data-root`.
- `services/lending/scripts/open.ts` — the borrower opens and checks the sealed outcome.
- `test/envelope.test.ts` (RFC 9180 vectors, tamper, wrong key, wrong sender), `test/keys.test.ts` (incl. git-tracked key scan), `test/e2e-exchange.test.ts` (round trip, replay).

Changed:
- `scripts/facts.ts` — `--seal-to <lender .pub.json>`, `--keys-dir`, `--passphrase-env`; check, then seal into `exchange`.
- `scripts/decide.ts` — `--keys-dir`, `--expect-sender <fpr>`, `--seal-outcome-to`, `--encryption off|required`; open, re-check, decide, check outcome, seal.
- `src/stage-io.ts` — read/write `.sealed.json`.
- `src/reapply.ts` — sender key fingerprint per log entry.
- `src/isolation.ts`, `scripts/prove-isolation.ts` — **act 5**: exchange holds only ciphertext; wrong key, flipped byte, wrong sender, replay all fail.
- `src/layout.ts` — key folders, public-key directory.
- `.gitignore`, `services/lending/README.md`, `BUILD_LOG.md`.

Unchanged: `packages/underwrite`, `packages/xls66`, `scripts/lending.ts`, pack and on-chain format. Defaults: with no flags, behaviour is as in v1.2.0.

**Step 2 — AWS KMS provider:** `src/keys-kms-aws.ts` (`@aws-sdk/client-kms`: `GetPublicKey`, `DeriveSharedSecret`, `Sign`). **Manual:** create the two KMS keys and the lender's IAM role in `ap-southeast-2` (walked one step at a time).

**Step 3:** anchor the lender's key fingerprint on XRPL; rotation and revocation.

**Later:** relay (S3 or HTTP, ciphertext only; SSE-KMS is defence in depth, not E2E); Docker per party; enclave inspection; other vendors (one adapter each, after confirming ECDH support).

**Order relative to other work:** Desk split-layout switch first (needed for business use cases), then Step 1.

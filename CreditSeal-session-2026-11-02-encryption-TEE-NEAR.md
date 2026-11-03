# CreditSeal — Session notes: encryption paths, gateway data-blindness, NEAR TEE and NEAR Intents

**Date:** 2026-11-02 / 03 (IST)
**Project root:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2\CreditSeal`
**Mode:** analysis only — no code was changed.

Marks: **[CODE]** = read in the repo this session · **[DOC]** = official/vendor docs read this session · **[API]** = live API queried · **[ASSUMED]** = inference, not verified.

---

## 1. Files examined

| File | What it gave us |
|---|---|
| `PROJECT_CONTEXT.md` | Components (paywall public, gateway private, Presidio), privacy constraints, residual check, ledger never stores text |
| `CLAUDE.md` | Build rules (no mocks, ARCH-IDs, flags, no git) |
| `services/lending/src/envelope.ts` | HPKE seal/open + Ed25519 signing |
| `services/lending/src/keys.ts` | `FileKeyProvider`, key file at-rest encryption, `ReplayGuard` |
| `services/lending/src/exchange.ts` | Sealed file naming, `loadParty`, `writeSealed`, `readSealed`, `findSealed` |
| `services/lending/scripts/facts.ts` | Borrower side: seals facts |
| `services/lending/scripts/decide.ts` | Lender side: opens facts, seals outcome |
| `services/lending/scripts/open.ts` | Borrower side: opens outcome |
| `DESIGN/xrplh-22-E2E-ENCRYPTION-AND-KEY-STORAGE-DESIGN-2026-10-27T2123.md` | Design of the envelope + KMS plan (header says "design, not built" — out of date; Step 1 is built) |
| `services/gateway/src/chat.ts` | Server-side chat pipeline: detect → mask → residual → model → restore |
| `services/gateway/src/privacy/restore.ts` | Restore of server placeholders; skips client `<C_...>` |
| `services/paywall/scripts/client-mask.ts` | Client-side masker (pattern-only) |
| `services/paywall/scripts/private-ask-core.ts` | Client flow: mask → self-check → send; map never leaves |
| `services/web/src/mask.ts` | Serves the same `client-mask.ts` to the browser |

---

## 2. Encryption / decryption in the lending exchange [CODE]

All encryption lives in `services/lending`. One pair of functions, `seal()` / `open()` in `src/envelope.ts`, used in **two paths** (two directions).

### Path 1 — facts, borrower → lender
| Step | Where | Trigger |
|---|---|---|
| ENCRYPT `seal({payload:"facts"})` | `scripts/facts.ts` | only with `--seal-to <lender .pub.json>` (+ `--exchange`, `--party`, `--keys-dir`) |
| stored | `<exchange>/<envelopeId>.facts.sealed.json` | ciphertext + visible routing header |
| DECRYPT `open({expectPayload:"facts"})` | `scripts/decide.ts` | only with `--sealed <file>` |

Order in `facts.ts`: unlock key file first (fail fast) → compute facts → content check (`checkFacts` vs `--secret-columns`) → seal. A failing pack is never sealed.

### Path 2 — outcome, lender → borrower
| Step | Where | Trigger |
|---|---|---|
| ENCRYPT `seal({payload:"outcome"})` | `scripts/decide.ts` → `deliver()` | only if the facts arrived sealed (`sealedCtx`); outcome checked by `checkOutcome` (no cut-off keys) first |
| stored | `<exchange>/<envelopeId>.outcome.sealed.json` | |
| DECRYPT `open({expectPayload:"outcome"})` | `scripts/open.ts` | `--sealed <file>` or `--exchange <dir>` (all unopened envelopes addressed to this borrower) |

### Diagram

```
            Borrower PC                 data/exchange                  Lender
  Path 1:  [1 ENCRYPT seal()]  ──►  .facts.sealed.json   ──►  [2 DECRYPT open()]
            facts.ts --seal-to       (ciphertext only)          decide.ts --sealed

  Path 2:  [4 DECRYPT open()]  ◄──  .outcome.sealed.json ◄──  [3 ENCRYPT seal()]
            open.ts                  (ciphertext only)          decide.ts deliver()

  Before every seal/open: each party unlocks its own key file
  (keys.ts FileKeyProvider.fromFile: scrypt(passphrase) → AES-256-GCM decrypt)
```

### Inside `seal()` (encrypt)
1. `checkIdentity(recipient)` — valid P-256 point, fingerprint matches keys.
2. Header (plaintext, routing only): kind, suite, payload, from/to fingerprints, envelopeId, createdAt, checker version.
3. `encap()` — ECDH with a fresh one-time P-256 key against the recipient's public key.
4. `keySchedule()` — HKDF-SHA256 → AES key + nonce (HPKE RFC 9180 base mode, suite DHKEM(P-256)/HKDF-SHA256/AES-256-GCM).
5. `aeadSeal()` — AES-256-GCM, header as AAD.
6. Ed25519 signature over (header, enc, ciphertext).

### Inside `open()` (decrypt) — checks before decrypting
shape/suite → payload kind → addressed to me → sender pinned (`--expect-sender`) → **signature verifies** → replay (`ReplayGuard`) → then `decap()` via `KeyProvider.deriveSharedSecret` → `aeadOpen()`.

### Second layer — key files at rest (`keys.ts`)
- Encrypt: `FileKeyProvider.generate()` — scrypt(passphrase) → AES-256-GCM over {encSk, sigSk}, AAD = kind|party|fingerprint.
- Decrypt: `FileKeyProvider.fromFile()` — called by `loadParty()` in every script before seal/open.
- Passphrase only from the env var named by `--passphrase-env` (default `CREDITSEAL_KEY_PASSPHRASE`).

### Notes
- Encryption is **opt-in**. No flags = plain JSON. `decide.ts --encryption required` refuses plain `--facts`.
- Only `FileKeyProvider` exists. AWS KMS provider (`keys-kms-aws.ts`, design Step 2) is **not** in the codebase.
- Not checked for other `seal()`/`open()` callers: `scripts/cockpit.ts`, `scripts/lending.ts`, `scripts/prove-isolation.ts`, demo `.ps1` scripts.

---

## 3. Is the ChainAim gateway data-blind? [CODE]

### Client side (corrected after user pointed it out)
`private-ask-core.ts` → `prepareAsk()`:
- masks question + document on the user's machine (`maskText`) → `<C_TYPE_n>`, cards → `[CARD REMOVED]`;
- **self-check**: `detect(masked)` must find nothing, else refused, nothing sent or paid;
- restore map stays on the client; only `bodyText` is sent; answer restored locally.
- Browser uses the same source (`web/src/mask.ts`).

Client masker is **pattern-only** (no language model). Catches: cards (Luhn), Aadhaar, PAN, IFSC, e-mail, Indian mobile, bank account / MRN near a label word, names after a label (`Patient:`, `Name:` at line start, `Mr`, `Dr`, `S/O`...). **Misses:** unlabelled names, street addresses, dates of birth, locations, company names, non-Indian phone formats. The self-check uses the same `detect()`, so it can't catch its own blind spots.

### Server side when the client missed a value (`chat.ts` → `prepare()` / `runChat()`)
1. Value arrives in plaintext next to `<C_...>` placeholders.
2. `presidio.analyzeAll()` scans all text → gateway + Presidio hold it in memory.
3. `Masker` → `<PERSON_1>`; real value goes into `masker.map` (memory only, never ledger).
4. Residual check → HTTP 422 if anything still visible; nothing sent.
5. Model sees only placeholders.
6. Gateway restores its own placeholders in the answer (unless `chainaim_restore: false`).
7. Ledger: counts/kinds only.
Gap: if both Presidio and the residual check miss a value, it reaches the model in plaintext.

### Verdict — partly data-blind
| Data | Server sees it? |
|---|---|
| Values the client masked (`<C_...>`) | No (map stays on client) |
| Values the client masker missed | Yes, plaintext in gateway + Presidio memory |
| Callers that skip client masking (gateway doesn't require it) | Yes, all of it |

Not checked: whether the web chat flow can skip masking (`web/src/app.ts`, `relay.ts` not read).

---

## 4. NEAR TEE / confidential compute [DOC]

- **Confidential compute** = goal (protect data while in use). **TEE** = hardware that achieves it (Intel TDX + NVIDIA GPU TEE in NEAR's case). NEAR uses both terms for the same offering.
- **Data-blind** = code never receives the value. **Operator-blind** = code sees it, but no human (ChainAim staff, cloud host) can. **Provable** = hardware-signed attestation shows the exact code running.
- A TEE does **not** make the gateway data-blind (it must read text to mask it); it makes it **operator-blind and provable**.

### Two NEAR options
| | NEAR AI Cloud (private inference) | Shade Agents (dstack on Phala / own TDX hardware) |
|---|---|---|
| What runs in the TEE | NEAR's models + NEAR's gateway | Your container (ChainAim gateway + Presidio) |
| Use for CreditSeal | Replace OpenRouter as model provider | Host the gateway |
| API | OpenAI-compatible, `https://cloud-api.near.ai/v1` | Docker Compose deployed to dstack |

NEAR AI Cloud docs do not show hosting arbitrary customer containers [unverified]; dstack is NEAR's documented route for that.

### Advantages of gateway + Presidio in a TEE
| Concern | Today (local / AWS EC2) | In a TEE |
|---|---|---|
| Who can read missed values in memory | Staff, host, root | Nobody outside the enclave |
| `masker.map` | Readable | Sealed |
| "We never log text" | Trust us | Provable via attestation code hash |
| Where TLS ends | Load balancer / edge → plaintext there | Can be bound inside the enclave |
| API keys | On host | Sealed |

If models also run on NEAR AI Cloud private inference: values missed by every masker are still protected at the model hop.

### TLS termination explained
TLS protects data only until the point where it is unlocked. Today (cloud edge, e.g. Railway [ASSUMED from `docs/deploy/railway.md`, not read]) the edge unlocks it → plaintext from there on. In a TEE the TLS key is created inside the enclave; NEAR offers `include_tls_fingerprint=true` on attestation to prove the HTTPS connection ends inside the TEE. Paywall caveat: x402 headers must be readable by the paywall → run paywall in the same TEE, or seal only the request body to the enclave key.

### Caveats
- Presidio must run in the same TEE (gateway sends raw text to it).
- New trust root: Intel TDX, NVIDIA, dstack image.
- Self-hosted TLS-in-enclave on dstack/Phala not verified.
- AWS Nitro Enclaves is an alternative (already noted in `xrplh-22` design).

### Layers together
Client masking (server never sees most values) + server masking & residual check (model never sees what client missed) + TEE (operator never sees what client missed; code provable) + NEAR private models (values every masker missed stay protected at the model).

---

## 5. Why not encrypt before masking on the server?

- Presidio and the model need readable text → server must decrypt before masking → plaintext still in server memory → same blindness question. TLS already covers transit.
- Encryption doesn't replace masking: the model can't work on ciphertext.
- **Where it does help:** sealing the body to the gateway hides it from the paywall and hosting edge; sealing to an **enclave key** (published with attestation) means plaintext exists only inside the TEE.
- Rejected: value-level / format-preserving encryption instead of placeholders (no privacy gain, worse answers); homomorphic encryption (not practical for LLMs).

### Proposed design (not built)
- Client `private-ask`: `--seal-to-gateway off|attested` — verify attestation, HPKE-seal masked body to the enclave key (same suite as `envelope.ts`).
- Paywall: handles x402, forwards sealed body unopened.
- Gateway: `--request-encryption off|optional|required` — decrypt inside the TEE, run existing pipeline unchanged, seal the response back.
- Order: **client masks → encrypts → server decrypts in TEE → server masks leftovers.**

---

## 6. NEAR Intents [DOC] [API]

- Multichain transaction protocol: user states the outcome, solvers (market makers) compete, a **Verifier** contract on NEAR (`intents.near`) settles.
- Parts: Message Bus (optional WebSocket relay), solvers, Verifier contract, Chain Signatures (threshold signing by NEAR validators — third-party source), **1Click API** (`https://1click.chaindefuser.com`, deposit-address flow, poll status to SUCCESS / REFUNDED / FAILED).
- **No testnet** (official 1Click quickstart).
- 0.2% platform fee without a partner key from partners.near-intents.org (third-party source).
- Not a privacy tool — settlements are public.

### Codebase check [CODE]
No NEAR Intents code in CreditSeal. Only name matches: `packages/route-engine/tool-intent.ts` / `.test.ts` (route-engine tool intent, unrelated; not opened).

### Live token list [API] — `GET /v0/tokens`, prices updated 2026-11-01
- XRPL: exactly one entry — native **XRP**, `nep141:xrp.omft.near`, decimals 6.
- **RLUSD: not listed on any chain.**
- Stablecoins available: USDC (ETH, Base, Arbitrum, Solana, Stellar, Polygon, others), USDT, etc.

### Scope for CreditSeal
1. **Pay-from-any-chain for the paywall** (strong fit) — buyer pays USDC on Base/Solana etc., settles to the XRPL seller wallet **as XRP**, not RLUSD.
2. **Loan repayments / application fee (`decide.ts --fee-tx`) from other chains** — later, mainnet only.
3. **Not a fit** for envelopes, masking, TEE privacy.

Constraints: deposit-address + polling vs x402's instant signed payment; mainnet only (CreditSeal is on XRPL Testnet/Devnet); RLUSD unsupported → either XRPL DEX swap XRP→RLUSD after arrival, or accept XRP (ledger-watch / Live Ops currently count RLUSD only). Reference pattern: MPP has a NEAR Intents payment method (`mpp.dev/payment-methods/nearintents`); no x402 equivalent found.

### Proposed plug-in (not built; paywall code not read)
- Paywall flag `--settlement xrpl-x402|near-intents|both`.
- 402 response offers x402 + a 1Click quote (recipient = XRPL seller wallet, deposit address).
- Paywall polls 1Click status, forwards to gateway only on SUCCESS.
- ledger-watch sees the XRP arrive; Live Ops must learn to count XRP.

---

## 7. Open items / next steps
1. Read `services/paywall/src/routes.ts` and `invoices.ts` to see where a second settlement option fits.
2. Read `services/web/src/app.ts` and `relay.ts` — can the web chat skip client masking?
3. Check `scripts/cockpit.ts`, `lending.ts`, `prove-isolation.ts` for other `seal()`/`open()` callers.
4. Decide XRP-vs-RLUSD settlement policy if adopting NEAR Intents.
5. Verify TLS-inside-enclave setup on dstack/Phala before relying on it.

## Sources
- NEAR AI Cloud — https://cloud.near.ai/
- Private Inference — https://docs.near.ai/cloud/private-inference
- Verification — https://docs.near.ai/cloud/verification
- Gateway verification — https://docs.near.ai/cloud/verification/gateway.md
- Shade Agents terminology — https://docs.near.org/ai/shade-agents/concepts/terminology
- dstack — https://github.com/dstack-TEE/dstack
- NEAR Intents overview — https://docs.near.org/chain-abstraction/intents/overview
- Market makers — https://docs.near-intents.org/near-intents/market-makers
- Chain support — https://docs.near-intents.org/resources/chain-support
- Chain address support — https://docs.near-intents.org/near-intents/chain-address-support
- 1Click quickstart — https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction.md
- 1Click tokens — https://1click.chaindefuser.com/v0/tokens
- FastNEAR intents — https://js.fastnear.com/intents
- MPP NEAR Intents — https://mpp.dev/payment-methods/nearintents

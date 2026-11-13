/**
 * ARCH-409 / ARCH-410 decision rules (src/judge.ts), Node built-ins only. The inputs are the shapes the official
 * verifier's checks and NEAR AI's signature endpoint produce; the recorded real report and signature are exercised end to
 * end in official.test.ts (inside the ca-attest image).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { evidenceOf, judgeAttestation, judgeCall, pruneHistory, type AttestationChecks, type CallEvidence, type ReportFetch, type SignatureOutcome } from "../src/judge.ts";

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const SIGNER = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";
const OTHER = "0x1111111111111111111111111111111111111111";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const REQ = h("request bytes");
const RESP = h("response bytes");
const OPTS = { signingAlgo: "ecdsa", attestedModels: [MODEL] };

const passing = (over: Partial<AttestationChecks> = {}): AttestationChecks => ({
  tdxVerified: true, bindsAddress: true, embedsNonce: true, composeMatchesMrConfig: true, modelNameMatches: true,
  gpu: { checked: true, nonceMatches: true, verdict: true }, ...over,
});
const fetchAt = (fetchedAt: string, attest = [judgeAttestation(SIGNER, "ecdsa", passing(), true)], model = MODEL): ReportFetch => ({ model, nonce: "a".repeat(64), fetchedAt, attestations: attest });
const call = (over: Partial<CallEvidence> = {}): CallEvidence => ({ chatId: "chatcmpl-1", servedModel: MODEL, requestSha256: REQ, responseSha256: RESP, calledAt: "2026-11-06T14:00:00.000Z", ...over });
const sig = (over: Partial<Extract<SignatureOutcome, { available: true }>> = {}): SignatureOutcome => ({
  available: true, text: `${MODEL}:${REQ}:${RESP}`, signature: "0xsig", signingAddress: SIGNER, signingAlgo: "ecdsa", signatureKind: "provider_tee", ...over,
});
const BEFORE = "2026-11-06T13:50:00.000Z";
const AFTER = "2026-11-06T14:05:00.000Z";

describe("ARCH-409 judgeAttestation", () => {
  it("ARCH-409: every check passing is verified, signer and algo lower-cased", () => {
    const r = judgeAttestation(SIGNER.toUpperCase().replace("0X", "0x"), "ECDSA", passing(), true);
    assert.equal(r.verified, true);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.signingAddress, SIGNER);
    assert.equal(r.signingAlgo, "ecdsa");
  });

  it("ARCH-409: each failed check is a reason and the attestation is not verified", () => {
    const cases: [Partial<AttestationChecks>, RegExp][] = [
      [{ tdxVerified: false, tdxError: "collateral fetch failed" }, /TDX quote not verified: collateral fetch failed/],
      [{ tdxVerified: false, tdxStatus: "Revoked" }, /TDX quote not verified \(status Revoked\)/],
      [{ bindsAddress: false }, /does not bind the signing address/],
      [{ embedsNonce: false }, /does not hold the request nonce/],
      [{ composeMatchesMrConfig: false }, /app_compose\) is not in mr_config/],
      [{ composeMatchesMrConfig: null }, /no app_compose/],
      [{ modelNameMatches: false }, /names another model/],
      [{ gpu: { checked: true, nonceMatches: false, verdict: true } }, /GPU evidence nonce differs/],
      [{ gpu: { checked: true, nonceMatches: true, verdict: false } }, /NVIDIA attestation verdict is not true/],
      [{ gpu: { checked: false, reason: "NRAS 503" } }, /GPU not checked: NRAS 503/],
    ];
    for (const [over, re] of cases) {
      const r = judgeAttestation(SIGNER, "ecdsa", passing(over), true);
      assert.equal(r.verified, false, String(re));
      assert.match(r.reasons.join("; "), re);
    }
  });

  it("ARCH-409: with --gpu-check off the GPU is not required, and the checks still say it was not checked", () => {
    const r = judgeAttestation(SIGNER, "ecdsa", passing({ gpu: { checked: false, reason: "--gpu-check off" } }), false);
    assert.equal(r.verified, true);
    assert.deepEqual(r.checks.gpu, { checked: false, reason: "--gpu-check off" });
  });
});

describe("ARCH-410 judgeCall", () => {
  it("ARCH-410: provider_tee, exact text, recovered signer, signer in the report that arrived before the call: verified", () => {
    const r = judgeCall(call(), sig(), SIGNER, [fetchAt(BEFORE)], OPTS);
    assert.equal(r.status, "verified");
    assert.equal(r.reason, null);
    assert.deepEqual([r.signature, r.hashes, r.tdx, r.gpu], [true, true, true, true]);
    assert.equal(r.reportFetchedAt, BEFORE);
    assert.equal(r.signatureKind, "provider_tee");
    assert.equal(r.signingAddress, SIGNER);
  });

  it("ARCH-410: one changed byte in either body -> unverified: hash mismatch", () => {
    for (const changed of [call({ requestSha256: h("request bytes!") }), call({ responseSha256: h("response bytes!") })]) {
      const r = judgeCall(changed, sig(), SIGNER, [fetchAt(BEFORE)], OPTS);
      assert.equal(r.status, "unverified");
      assert.match(r.reason!, /^hash mismatch/);
      assert.equal(r.hashes, false);
    }
  });

  it("ARCH-410: a signed text for another model id -> unverified, hashes equal", () => {
    const r = judgeCall(call(), sig({ text: `other/model:${REQ}:${RESP}` }), SIGNER, [fetchAt(BEFORE)], OPTS);
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /model id differs/);
    assert.equal(r.hashes, true);
  });

  it("ARCH-410: a report that arrived after the call is not used", () => {
    const onlyAfter = judgeCall(call(), sig(), SIGNER, [fetchAt(AFTER)], OPTS);
    assert.equal(onlyAfter.status, "unavailable");
    assert.match(onlyAfter.reason!, /no report for this model arrived before the call/);
    const both = judgeCall(call(), sig(), SIGNER, [fetchAt(AFTER), fetchAt(BEFORE)], OPTS);
    assert.equal(both.status, "verified");
    assert.equal(both.reportFetchedAt, BEFORE);
  });

  it("ARCH-410: the LATEST report before the call decides; a signer only in an older one does not pass", () => {
    const older = fetchAt("2026-11-06T13:00:00.000Z");
    const newer = fetchAt(BEFORE, [judgeAttestation(OTHER, "ecdsa", passing(), true)]);
    const r = judgeCall(call(), sig(), SIGNER, [older, newer], OPTS);
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /signer is not in the report/);
  });

  it("ARCH-410: a failed fetch is never the report used", () => {
    const failed: ReportFetch = { model: MODEL, nonce: "b".repeat(64), fetchedAt: "2026-11-06T13:55:00.000Z", attestations: [], error: "attestation report: HTTP 502" };
    const r = judgeCall(call(), sig(), SIGNER, [fetchAt(BEFORE), failed], OPTS);
    assert.equal(r.status, "verified");
    assert.equal(r.reportFetchedAt, BEFORE);
  });

  // 2026-11-14 attest-rule change (owner decision, option 1): this test said "the signer must match exactly one attestation".
  // NEAR AI's live report (DeepSeek-V4.1-Flash-1017, 2026-11-13 19:10Z) lists the same signer twice, both verified, so the
  // rule is now: every matching attestation verified and naming the model. The three cases below replace it.
  it("ARCH-410: the signer in 2 attestations, both verified (the live report's shape) -> verified, detail says so", () => {
    const twice = fetchAt(BEFORE, [judgeAttestation(SIGNER, "ecdsa", passing(), true), judgeAttestation(SIGNER, "ecdsa", passing(), true), judgeAttestation(OTHER, "ecdsa", passing(), true)]);
    const r = judgeCall(call(), sig(), SIGNER, [twice], OPTS);
    assert.equal(r.status, "verified");
    assert.equal(r.reason, null);
    assert.equal(r.detail, "signer in 2 attestations, all verified");
    assert.deepEqual([r.tdx, r.gpu, r.signature, r.hashes], [true, true, true, true]);
    assert.equal(judgeCall(call(), sig(), SIGNER, [fetchAt(BEFORE)], OPTS).detail, "signer in 1 attestation, verified");
  });

  it("ARCH-410: the signer in 2 attestations, one not verified -> unverified, the reason names it and its failed check", () => {
    const mixed = fetchAt(BEFORE, [judgeAttestation(SIGNER, "ecdsa", passing(), true), judgeAttestation(SIGNER, "ecdsa", passing({ embedsNonce: false }), true)]);
    const r = judgeCall(call(), sig(), SIGNER, [mixed], OPTS);
    assert.equal(r.status, "unverified");
    assert.equal(r.reason, "signer in 2 attestations, 1 not verified: report_data does not hold the request nonce");
    assert.equal(r.detail, "signer in 2 attestations, 1 not verified");
    assert.equal(r.tdx, false);
  });

  it("ARCH-410: the signer in 2 attestations that do not agree on the model -> unverified, naming that", () => {
    const split = fetchAt(BEFORE, [judgeAttestation(SIGNER, "ecdsa", passing(), true), judgeAttestation(SIGNER, "ecdsa", passing({ modelNameMatches: false }), true)]);
    const r = judgeCall(call(), sig(), SIGNER, [split], OPTS);
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /^signer in 2 attestations, 1 naming another model: the attestations do not agree on the model$/);
  });

  it("ARCH-410: the signer in 0 attestations -> unverified (unchanged)", () => {
    const r = judgeCall(call(), sig(), SIGNER, [fetchAt(BEFORE, [judgeAttestation(OTHER, "ecdsa", passing(), true), judgeAttestation(OTHER, "ecdsa", passing(), true)])], OPTS);
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /signer is not in the report that arrived before the call/);
    assert.equal(r.detail, null);
  });

  it("ARCH-410: the signer's attestation failing makes the call unverified with its reasons", () => {
    const bad = fetchAt(BEFORE, [judgeAttestation(SIGNER, "ecdsa", passing({ composeMatchesMrConfig: false }), true)]);
    const r = judgeCall(call(), sig(), SIGNER, [bad], OPTS);
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /attestation failed: sha256\(app_compose\) is not in mr_config/);
    assert.equal(r.tdx, false);
  });

  it("ARCH-410: recovery to another address, or no recovery, is unverified", () => {
    assert.match(judgeCall(call(), sig(), OTHER, [fetchAt(BEFORE)], OPTS).reason!, /does not recover to signing_address/);
    assert.match(judgeCall(call(), sig(), undefined, [fetchAt(BEFORE)], OPTS).reason!, /could not be recovered/);
  });

  it("ARCH-410: a gateway signature is never verified (NEAR's gateway re-signs; the model is not attested)", () => {
    const r = judgeCall(call(), sig({ signatureKind: "gateway", text: `${REQ}:${RESP}` }), SIGNER, [fetchAt(BEFORE)], OPTS);
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /gateway, not by the model's TEE/);
    assert.equal(r.signature, null, "nothing past the kind is reported as checked");
  });

  it("ARCH-410: the kind is never inferred from the text: absent or unknown kind is unverified even with the 3-part text", () => {
    for (const kind of [null, "something_else"]) assert.match(judgeCall(call(), sig({ signatureKind: kind }), SIGNER, [fetchAt(BEFORE)], OPTS).reason!, /unknown signature kind/);
  });

  it("ARCH-410: another signing algorithm is unverified", () => {
    assert.match(judgeCall(call(), sig({ signingAlgo: "ed25519" }), SIGNER, [fetchAt(BEFORE)], OPTS).reason!, /signing algorithm ed25519 is not ecdsa/);
  });

  it("ARCH-410: no signature after the retry window is unavailable, with the fetch's reason", () => {
    const r = judgeCall(call(), { available: false, reason: "signature not available after 30 s (HTTP 404)" }, undefined, [fetchAt(BEFORE)], OPTS);
    assert.deepEqual([r.status, r.reason], ["unavailable", "signature not available after 30 s (HTTP 404)"]);
  });

  it("ARCH-410: no chat id, bad hashes, or a model ca-attest does not attest: unverified before anything is fetched", () => {
    assert.match(judgeCall(call({ chatId: undefined }), sig(), SIGNER, [fetchAt(BEFORE)], OPTS).reason!, /no provider chat id/);
    assert.match(judgeCall(call({ requestSha256: "ABC" }), sig(), SIGNER, [fetchAt(BEFORE)], OPTS).reason!, /not SHA-256 hex/);
    assert.match(judgeCall(call({ servedModel: "other/model" }), sig(), SIGNER, [fetchAt(BEFORE)], OPTS).reason!, /not attested by ca-attest/);
  });

  it("ARCH-410 / ARCH-412 + fix 4: a result carries ids, addresses, booleans, reasons and well-formed signature evidence only", () => {
    const r = judgeCall(call(), sig(), SIGNER, [fetchAt(BEFORE)], OPTS);
    // detail (2026-11-14 attest-rule change): how many attestations the signer matched, in a fixed form built from counts only.
    assert.deepEqual(Object.keys(r).sort(), ["chatId", "detail", "gpu", "hashes", "reason", "reportFetchedAt", "servedModel", "signature", "signatureHex", "signatureKind", "signedText", "signingAddress", "signingAlgo", "status", "tdx"]);
    assert.match(r.detail!, /^signer in \d+ attestations?, (verified|all verified|not verified|\d+ not verified|\d+ naming another model)$/);
    assert.equal(r.signatureHex, null, "a malformed signature (0xsig) is never echoed");
    assert.ok(!JSON.stringify(r).includes("0xsig"));
    assert.equal(r.signedText, `${MODEL}:${REQ}:${RESP}`, "the signed text is a model id and two hashes");
  });

  // The real values NEAR AI returned (services/attest/test/fixtures/nearai-recorded.json, recorded 2026-11-06).
  const REC_TEXT = "deepseek-ai/DeepSeek-V4.1-Flash-1017:8bb07e5acc99523f3d5e08eb788648998976334f860fb952b773ac3598c8e3b0:fa7c7a023fd7b09410bac0fb2fea040f35305391c645a950a4ee1967dd9f2fa0";
  const REC_SIG = "0x44082da011ba9919ba0c291710d642187720563cc005d523c9bbffe149a9582f3bf7c9c9e9260cc1ce7dabdfeefac9e9bf79342efc1c4c705ceaa74ab22b5cb21b";

  it("fix 4: the recorded real NEAR AI text and ecdsa signature are kept as evidence", () => {
    assert.deepEqual(evidenceOf(REC_TEXT, REC_SIG, "ecdsa"), { signedText: REC_TEXT, signatureHex: REC_SIG });
    const r = judgeCall(call(), sig({ signature: REC_SIG }), SIGNER, [fetchAt(BEFORE)], OPTS);
    assert.equal(r.status, "verified");
    assert.deepEqual([r.signedText, r.signatureHex], [`${MODEL}:${REQ}:${RESP}`, REC_SIG]);
  });

  it("fix 4: evidence of any other shape is null (free text, wrong length, wrong algo, uppercase hashes)", () => {
    const cases: [string, string, string, { signedText: string | null; signatureHex: string | null }][] = [
      ["the revenue was 42", REC_SIG, "ecdsa", { signedText: null, signatureHex: REC_SIG }],
      [REC_TEXT.toUpperCase(), REC_SIG, "ecdsa", { signedText: null, signatureHex: REC_SIG }],
      [`a b:${REQ}:${RESP}`, REC_SIG, "ecdsa", { signedText: null, signatureHex: REC_SIG }],
      [REC_TEXT, REC_SIG.slice(0, -2), "ecdsa", { signedText: REC_TEXT, signatureHex: null }],
      [REC_TEXT, "ab".repeat(64), "ecdsa", { signedText: REC_TEXT, signatureHex: null }],
      [REC_TEXT, "ab".repeat(64), "ed25519", { signedText: REC_TEXT, signatureHex: "ab".repeat(64) }],
      [REC_TEXT, REC_SIG, "rsa", { signedText: REC_TEXT, signatureHex: null }],
      [`${REQ}:${RESP}`, REC_SIG, "ecdsa", { signedText: `${REQ}:${RESP}`, signatureHex: REC_SIG }],
    ];
    for (const [text, s, algo, want] of cases) assert.deepEqual(evidenceOf(text, s, algo), want, `${text.slice(0, 20)} / ${algo}`);
  });

  it("fix 4: a failed check still carries the evidence (so the failure can be re-checked); none when no signature came back", () => {
    const mismatch = judgeCall(call({ responseSha256: h("response bytes!") }), sig({ signature: REC_SIG }), SIGNER, [fetchAt(BEFORE)], OPTS);
    assert.equal(mismatch.status, "unverified");
    assert.deepEqual([mismatch.signedText, mismatch.signatureHex], [`${MODEL}:${REQ}:${RESP}`, REC_SIG]);
    const none = judgeCall(call(), { available: false, reason: "signature not available after 30 s (HTTP 404)" }, undefined, [fetchAt(BEFORE)], OPTS);
    assert.deepEqual([none.signedText, none.signatureHex], [null, null]);
  });
});

describe("ARCH-409 report history", () => {
  it("ARCH-409: pruneHistory keeps the newest N fetches per model", () => {
    const list = ["01", "02", "03", "04"].map((m) => fetchAt(`2026-11-06T${m}:00:00.000Z`));
    const other = fetchAt("2026-11-06T00:30:00.000Z", undefined, "x/other");
    const kept = pruneHistory([...list, other], 2);
    assert.deepEqual(kept.filter((r) => r.model === MODEL).map((r) => r.fetchedAt), ["2026-11-06T04:00:00.000Z", "2026-11-06T03:00:00.000Z"]);
    assert.equal(kept.filter((r) => r.model === "x/other").length, 1);
  });
});

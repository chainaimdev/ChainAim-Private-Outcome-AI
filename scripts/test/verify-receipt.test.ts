/**
 * scripts/verify-receipt.ts, privateAI-design-40: the money trail (ARCH-693), the attestation bundle hash (ARCH-692) and
 * refund records (ARCH-694). Runs the real script as a child process against receipts signed with a key generated per
 * run and pinned through --public-key; the judge sample (signed before v2.1.0) must still verify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addSettlement, canonicalJson, economicsOf, filesRoot, sha256Hex, signReceipt, signRefund, signerFromKey, type ReceiptBody,
} from "../../packages/receipt/src/index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VERIFY = join(ROOT, "scripts/verify-receipt.ts");
// The judge sample before v2.1.0, kept in docs/judge/older (the v2.1.0 one is JUDGE below).
const SAMPLE = join(ROOT, "docs/judge/older/sample-receipt-2026-11-13T0547Z.json");
const JUDGE = join(ROOT, "docs/judge/sample-receipt-2026-11-13T1716Z.json");
const TX = "4vv6QJSaL1V9dDeqWeVGhX5vaeQ3EhXheJSnYSmGWAAc";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [VERIFY, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "verify-receipt-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ATTESTATION = { jobId: "0123456789abcdef0123456789abcdef", summary: "verified", at: "2026-11-13T10:00:05.000Z", calls: [{ index: 0, status: "verified", signedText: `near/x:${"d".repeat(64)}:${"e".repeat(64)}` }] };

function signed(dir: string, economicsOver: Record<string, string> = {}) {
  const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  const keyFile = join(dir, "pub.pem");
  writeFileSync(keyFile, signer.publicKeyPem);
  const files = [{ name: "gl.csv", bytes: 1200, sha256: "a".repeat(64) }];
  const body: ReceiptBody = {
    v: 1, receiptId: "f".repeat(32), jobId: ATTESTATION.jobId, quoteId: ATTESTATION.jobId, route: "nearai/x", datasetId: "smb-erp-fin", files, filesRoot: filesRoot(files),
    sqlSha256: "b".repeat(64), resultSha256: "c".repeat(64), calls: [{ servedModel: "near/x", attestStatus: "verified", reqSha256: "d".repeat(64), respSha256: "e".repeat(64) }],
    evidenceBundleSha256: sha256Hex(canonicalJson(ATTESTATION)),
    price: {
      amountUnits: "20000", usdcDecimals: 6, priceUsd: "0.020000", quoteBasis: { pricing: "estimate-first", calls: 1 }, actualUsd: "0.010000",
      economics: { ...economicsOf("0.020000", "0.010000", { modelUsd: "0.004210", callFeesUsd: "0.002000", analystUsd: "0.001000", nearGasUsd: "0.001000" }), ...economicsOver },
    },
    createdAt: "2026-11-13T10:01:00.000Z",
  };
  return { signer, keyFile, body };
}

test("ARCH-693 a receipt with a money trail verifies and prints paid, cost, gas, margin, overrun and the flow", () =>
  withDir((dir) => {
    const { signer, keyFile, body } = signed(dir);
    const r = addSettlement(signReceipt(body, signer), { network: "near:testnet", transaction: TX, invoiceId: "INV1", payer: "t01.testnet", settledAt: "2026-11-13T10:01:01.000Z", flow: "upfront" }, signer);
    const file = join(dir, "receipt.json");
    writeFileSync(file, JSON.stringify({ receipt: r, publicKeyPem: signer.publicKeyPem, attestation: ATTESTATION }));
    const v = run(["--file", file, "--public-key", keyFile, "--result", "none"]);
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, /OK +money trail: paid 0\.020000 USDC \(upfront, tx 4vv6…\) · NEAR AI cost 0\.004210 · gas 0\.001000 · cost 0\.005210 · margin 0\.014790 · overrun absorbed 0\.000000/);
    assert.match(v.out, /OK +attestation bundle matches evidenceBundleSha256 \(1\/1 NEAR AI calls verified\)/);
    assert.match(v.out, /flow upfront/);
  }));

test("ARCH-693 a tampered margin fails, and a bundle that does not match the signed hash fails", () =>
  withDir((dir) => {
    const { signer, keyFile, body } = signed(dir);
    const r = signReceipt(body, signer);
    const tampered = { ...r, body: { ...r.body, price: { ...r.body.price, economics: { ...r.body.price.economics!, marginUsd: "0.019000" } } } };
    const file = join(dir, "tampered.json");
    writeFileSync(file, JSON.stringify(tampered));
    const v = run(["--file", file, "--public-key", keyFile, "--result", "none"]);
    assert.equal(v.status, 1, v.out);
    assert.match(v.out, /FAIL +receipt NOT valid: receipt price\.economics\.marginUsd must be priceUsd - costUsd/);
    const other = join(dir, "other-bundle.json");
    writeFileSync(other, JSON.stringify({ receipt: r, attestation: { ...ATTESTATION, summary: "partly" } }));
    const w = run(["--file", other, "--public-key", keyFile, "--result", "none"]);
    assert.equal(w.status, 1, w.out);
    assert.match(w.out, /FAIL +attestation bundle does NOT match evidenceBundleSha256/);
  }));

test("ARCH-693 the judge sample (before v2.1.0) still verifies and says it has no money trail", () =>
  withDir((dir) => {
    // The sample's own key is used as the pinned key here: this checks that the older receipt shape still verifies.
    const keyFile = join(dir, "sample.pem");
    writeFileSync(keyFile, (JSON.parse(readFileSync(SAMPLE, "utf8")) as { publicKeyPem: string }).publicKeyPem);
    const v = run(["--file", SAMPLE, "--public-key", keyFile, "--result", "none"]);
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, /OK +receipt valid/);
    assert.match(v.out, /OK +no money trail \(before v2\.1\.0\)/);
  }));

test("ARCH-692 ARCH-693 the v2.1.0 judge sample verifies with the PINNED key as README says: money trail and attestation bundle checked offline", () => {
  const v = run(["--file", JUDGE, "--result", "none"]);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /OK +receipt valid: signed by the pinned key d27d1e9f17a0104e34c46cf3e5233f23, settlement signed too, signed quote matches, checkout mandate matches, signed limits match/);
  assert.match(v.out, /OK +money trail: paid 0\.020000 USDC .* margin 0\.017555 · overrun absorbed 0\.000000/);
  assert.match(v.out, /OK +attestation bundle matches evidenceBundleSha256 \(1\/1 NEAR AI calls verified\)/);
});

test("ARCH-694 --refund verifies a signed refund record and prints paid -> refunded; a tampered one fails", () =>
  withDir((dir) => {
    const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
    const keyFile = join(dir, "pub.pem");
    writeFileSync(keyFile, signer.publicKeyPem);
    const rec = signRefund({
      status: "refunded", invoiceId: "INV1", jobId: ATTESTATION.jobId, paidTx: TX, refundTx: "9xRfndTxHash2222ABCDEFGHJK", payer: "t01.testnet",
      amountUnits: "20000", network: "near:testnet", reason: "over_estimate", at: "2026-11-13T10:02:00.000Z",
    }, signer);
    const file = join(dir, "refund.json");
    writeFileSync(file, JSON.stringify(rec));
    const v = run(["--refund", file, "--public-key", keyFile]);
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, new RegExp(`OK +refund valid: invoice INV1 \\(job ${ATTESTATION.jobId}\\) paid ${TX} -> refunded 9xRfndTxHash2222ABCDEFGHJK to t01\\.testnet, 20000 units on near:testnet, reason over_estimate`));
    writeFileSync(file, JSON.stringify({ ...rec, payer: "someone.testnet" }));
    const w = run(["--refund", file, "--public-key", keyFile]);
    assert.equal(w.status, 1, w.out);
    assert.match(w.out, /FAIL +refund NOT valid: the refund signature does not verify/);
  }));

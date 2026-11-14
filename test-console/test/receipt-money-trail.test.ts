/**
 * privateAI-design-40 on the console: the money trail goes from the hold into the signed receipt (ARCH-690), the
 * attestation bundle is hashed into it once final and kept beside it for the download (ARCH-692), and the release
 * notice's settlement flow is read and signed (ARCH-691). Real Ed25519 key, real files in a temporary folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, economicsOf, sha256Hex, verifyReceipt } from "../../packages/receipt/src/index.ts";
import { datasetFiles, evidenceBundleOf, parseSettlement, receiptConfig, receiptOnRelease, ReceiptStore } from "../console/receipt.ts";
import type { HeldJob } from "../console/jobs.ts";
import type { JobAttestation } from "../console/attest.ts";

const H = "a".repeat(64), G = "b".repeat(64);
const TX = "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH";
const NOTICE = { transaction: TX, network: "near:testnet", payer: "t02.testnet", invoiceId: "ABCDEF0123456789ABCDEF0123456789" };
const pem = (): string => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function attestation(summary: JobAttestation["summary"]): JobAttestation {
  return {
    jobId: "0123456789abcdef0123456789abcdef", summary, at: "2026-11-13T10:00:05.000Z",
    calls: [{
      index: 0, model: "nearai/x", status: summary === "pending" ? "unavailable" : "verified", reason: null, servedModel: "near/x", chatId: "chat-1",
      signatureKind: "ecdsa", signingAlgo: "ecdsa", signingAddress: "0xabc", reportFetchedAt: "2026-11-13T10:00:04.000Z", tdx: true, gpu: true,
      signature: true, hashes: true, signedText: `near/x:${H}:${G}`, signatureHex: "0x1234",
    }],
  };
}

async function setup(dir: string) {
  const data = join(dir, "data");
  mkdirSync(data);
  writeFileSync(join(data, "orders.csv"), "order_id,amount\n1,10\n");
  const cfg = receiptConfig({ receipts: "on", "receipt-dir": join(dir, "receipts") }, { RECEIPT_SIGNING_KEY: pem() }, true)!;
  const files = await datasetFiles(data, 10);
  const served = [{ text: "", model: "nearai/x", zone: "private-cloud", attest: { servedModel: "near/x", requestSha256: H, responseSha256: G, calledAt: "2026-11-13T10:00:00Z" } }];
  const result = { sql: "SELECT 1", result: { columns: ["n"], rows: [{ n: 1 }], truncated: false }, served };
  const economics = economicsOf("0.020000", "0.010000", { modelUsd: "0.004210", callFeesUsd: "0.002000", analystUsd: "0.001000", nearGasUsd: "0.001000" });
  const held = (jobId: string): HeldJob => ({
    jobId, result: result as never, amount: "20000", breakdown: {} as never, expiresAt: Date.now() + 60_000,
    receipt: { network: "near:testnet", quoteId: jobId, route: "nearai/x", datasetId: "demo", files, sql: "SELECT 1", priceUsd: "0.020000", actualUsd: "0.010000", economics, quoteBasis: { pricing: "estimate-first", calls: 1 } },
  });
  return { cfg, store: new ReceiptStore(cfg), held, economics };
}

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "receipt-trail-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("ARCH-692 the bundle hash is the SHA-256 of the canonical JSON of the final attestation; none while pending or off", () => {
  const a = attestation("verified");
  assert.deepEqual(evidenceBundleOf(a), { bundle: a, sha256: sha256Hex(canonicalJson(a)) });
  assert.equal(evidenceBundleOf(attestation("pending")), undefined);
  assert.equal(evidenceBundleOf(undefined), undefined);
  assert.ok(evidenceBundleOf(attestation("not_applicable")), "a job with no attested call has a final verdict too");
});

test("ARCH-690 ARCH-692 a released job's receipt carries the held money trail and the bundle hash; the bundle is kept for the download", () =>
  withDir(async (dir) => {
    const { cfg, store, held, economics } = await setup(dir);
    const jobId = "0123456789abcdef0123456789abcdef";
    const a = attestation("verified");
    const r = await receiptOnRelease({ store, cfg, attestation: () => a, now: () => Date.parse("2026-11-13T10:01:00Z") }, jobId, held(jobId), NOTICE);
    assert.ok(r);
    assert.deepEqual(r.body.price.economics, economics);
    assert.equal(r.body.evidenceBundleSha256, sha256Hex(canonicalJson(a)));
    assert.deepEqual(verifyReceipt(r, cfg.signer.publicKeyPem), { ok: true, settled: true });
    // Kept beside the receipt, read back after a restart, and it re-hashes to the signed value.
    const again = new ReceiptStore(cfg).getAttestation(jobId);
    assert.deepEqual(again, a);
    assert.equal(sha256Hex(canonicalJson(again)), r.body.evidenceBundleSha256);
  }));

test("ARCH-692 a receipt released while the attestation is pending is signed without the bundle hash, and keeps no bundle", () =>
  withDir(async (dir) => {
    const { cfg, store, held } = await setup(dir);
    const jobId = "fedcba9876543210fedcba9876543210";
    const r = await receiptOnRelease({ store, cfg, attestation: () => attestation("pending") }, jobId, held(jobId), NOTICE);
    assert.ok(r);
    assert.equal(r.body.evidenceBundleSha256, undefined);
    assert.equal(store.getAttestation(jobId), undefined);
    assert.deepEqual(verifyReceipt(r, cfg.signer.publicKeyPem), { ok: true, settled: true });
  }));

test("ARCH-691 the release notice's flow is read and signed with the settlement; another value makes the notice malformed", () =>
  withDir(async (dir) => {
    const now = () => Date.parse("2026-11-13T10:01:00Z");
    assert.equal(parseSettlement({ ...NOTICE, flow: "upfront" }, now)?.flow, "upfront");
    assert.equal(parseSettlement(NOTICE, now)?.flow, undefined);
    assert.equal(parseSettlement({ ...NOTICE, flow: "later" }, now), undefined);
    const { cfg, store, held } = await setup(dir);
    const jobId = "00112233445566778899aabbccddeeff";
    const r = await receiptOnRelease({ store, cfg }, jobId, held(jobId), { ...NOTICE, flow: "upfront" });
    assert.equal(r?.settlement?.flow, "upfront");
    assert.deepEqual(verifyReceipt(r!, cfg.signer.publicKeyPem), { ok: true, settled: true });
  }));

test("privateAI-design-43 ARCH-722 a counter-offer's receipt names the offer it countered and what was reduced; ChainAim's signer's allowlist takes them; a first offer's has neither", () =>
  withDir(async (dir) => {
    const { parseReceiptBody } = await import("../../packages/signer/src/index.ts");
    const { cfg, store, held } = await setup(dir);
    const first = "11112222333344445555666677778888";
    const jobId = "99990000aaaabbbbccccddddeeeeffff";
    const h = held(jobId);
    h.receipt = { ...h.receipt!, counterOf: first, reduced: ["answerMaxRows", "maxTokens"] };
    const r = await receiptOnRelease({ store, cfg }, jobId, h, NOTICE);
    assert.ok(r);
    assert.deepEqual([r.body.quoteId, r.body.counterOf, r.body.reduced], [jobId, first, ["answerMaxRows", "maxTokens"]]);
    assert.deepEqual(verifyReceipt(r, cfg.signer.publicKeyPem), { ok: true, settled: true });
    assert.doesNotThrow(() => parseReceiptBody(JSON.parse(JSON.stringify(r.body))), "ca-control-signer signs the same body");
    const plain = await receiptOnRelease({ store, cfg }, first, held(first), NOTICE);
    assert.equal("counterOf" in plain!.body || "reduced" in plain!.body, false);
  }));

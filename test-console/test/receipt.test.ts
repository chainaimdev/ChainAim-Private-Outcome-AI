import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReceipt } from "../../packages/receipt/src/index.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildReceipt, datasetFiles, parseSettlement, receiptCalls, receiptConfig, ReceiptStore, type ReceiptInput } from "../console/receipt.ts";
import { internalHandler, JobStore, type HeldJob } from "../console/jobs.ts";

const H = "a".repeat(64), G = "b".repeat(64);
const pem = (): string => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("ARCH-614 --receipts is off by default; on needs paid jobs and the key variable, whose value never appears", () => {
  assert.equal(receiptConfig({}, {}, true), undefined);
  assert.throws(() => receiptConfig({ receipts: "yes" }, {}, true), /--receipts must be on or off/);
  assert.throws(() => receiptConfig({ receipts: "on" }, { RECEIPT_SIGNING_KEY: pem() }, false), /needs --paid-jobs on/);
  assert.throws(() => receiptConfig({ receipts: "on" }, {}, true), /RECEIPT_SIGNING_KEY is not set/);
  assert.throws(() => receiptConfig({ receipts: "on", "receipt-key-env": "bad-name" }, {}, true), /environment variable name/);
  assert.throws(() => receiptConfig({ receipts: "on" }, { RECEIPT_SIGNING_KEY: "secret-value-123" }, true), (e: Error) => !e.message.includes("secret-value-123"));
  const cfg = receiptConfig({ receipts: "on", "receipt-dir": "x" }, { RECEIPT_SIGNING_KEY: pem() }, true)!;
  assert.equal(cfg.dir, "x");
  assert.equal(cfg.maxFiles, 500);
});

test("ARCH-613 dataset files: every file under the folder, relative names with /, sizes and hashes; too many is refused", () =>
  withDir(async (dir) => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "b.csv"), "x,y\n1,2\n");
    writeFileSync(join(dir, "sub", "a.csv"), "z\n");
    const files = await datasetFiles(dir, 10);
    assert.deepEqual(files.map((f) => [f.name, f.bytes]), [["b.csv", 8], ["sub/a.csv", 2]]);
    assert.match(files[0].sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(datasetFiles(dir, 1), /more than 1 files/);
  }));

test("ARCH-613 receipt calls: attested calls carry hashes and the verdict; others are none with no hashes", () => {
  const calls = receiptCalls(
    [
      { text: "", model: "nearai/x", zone: "private-cloud", attest: { chatId: "chat-1", servedModel: "near/x", requestSha256: H, responseSha256: G, calledAt: "2026-11-10T00:00:00Z" } },
      { text: "", model: "bedrock/y", zone: "public-api" },
    ],
    () => "verified",
  );
  assert.deepEqual(calls[0], { servedModel: "near/x", zone: "private-cloud", chatId: "chat-1", reqSha256: H, respSha256: G, attestStatus: "verified" });
  assert.deepEqual(calls[1], { servedModel: "bedrock/y", zone: "public-api", attestStatus: "none" });
});

test("ARCH-613 ARCH-615 ARCH-616 a built receipt verifies against the result, is stored, survives a restart, and takes one settlement", () =>
  withDir(async (dir) => {
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "orders.csv"), "order_id,amount\n1,10\n");
    const cfg = receiptConfig({ receipts: "on", "receipt-dir": join(dir, "receipts") }, { RECEIPT_SIGNING_KEY: pem() }, true)!;
    const result = { columns: ["n"], rows: [[1]] };
    const input: ReceiptInput = {
      jobId: "0123456789abcdef0123456789abcdef", quoteId: "q-1", route: "nearai", datasetId: "demo", folder: data, sql: "SELECT count(*) AS n FROM orders",
      result, served: [], attestStatusOf: () => "pending", amountUnits: "10000", usdcDecimals: 6, priceUsd: "0.01", quoteBasis: { answerMaxRows: 50 },
      createdAt: "2026-11-10T12:00:00.000Z",
    };
    const r = await buildReceipt(input, cfg);
    assert.deepEqual(verifyReceipt(r, cfg.signer.publicKeyPem, result), { ok: true, settled: false });
    const store = new ReceiptStore(cfg);
    store.put(r);
    assert.throws(() => store.put(r), /already exists/);
    const again = new ReceiptStore(cfg);
    assert.equal(again.get(input.jobId)?.sig.value, r.sig.value);
    const settled = again.settle(input.jobId, { network: "near:testnet", transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", invoiceId: "inv-1", payer: "t02.testnet", settledAt: "2026-11-10T12:01:00.000Z" });
    assert.deepEqual(verifyReceipt(settled, cfg.signer.publicKeyPem, result), { ok: true, settled: true });
    assert.throws(() => again.settle(input.jobId, settled.settlement!), /already carries a settlement/);
    assert.throws(() => again.get("../escape"), /32 lowercase hex/);
  }));

test("ARCH-616 the release notice reaches the hook with the held job; no body or an oversized one still releases", async () => {
  const KEY = "k".repeat(32);
  const store = new JobStore(10, 60_000);
  const seen: { jobId: string; job: HeldJob; notice: unknown }[] = [];
  const server = createServer(internalHandler(store, KEY, (jobId, job, notice) => seen.push({ jobId, job, notice })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hold = (jobId: string): void => store.hold({ jobId, result: { rows: [] } as never, amount: "10000", breakdown: {} as never, expiresAt: store.expiryFromNow() });
  const post = (jobId: string, body?: string) => fetch(`${base}/internal/jobs/${jobId}/released`, { method: "POST", headers: { "x-jobs-key": KEY, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
  try {
    const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
    hold(a); hold(b); hold(c);
    const notice = { transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", network: "near:testnet", payer: "t02.testnet", invoiceId: "ABCDEF0123456789ABCDEF0123456789" };
    assert.equal((await post(a, JSON.stringify(notice))).status, 200);
    assert.equal((await post(b)).status, 200);
    assert.equal((await post(c, JSON.stringify({ pad: "x".repeat(5000) }))).status, 200);
    assert.equal((await post(a, JSON.stringify(notice))).status, 404, "a released job is gone");
    assert.deepEqual(seen.map((s) => [s.jobId, s.job.amount]), [[a, "10000"], [b, "10000"], [c, "10000"]]);
    assert.deepEqual(seen[0].notice, notice);
    assert.equal(seen[1].notice, undefined);
    assert.equal(seen[2].notice, undefined, "over RELEASE_NOTICE_MAX_BYTES is ignored, not parsed");
    assert.equal((await fetch(`${base}/internal/jobs/${a}/released`, { method: "POST" })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("ARCH-616 the paywall's settlement notice is read field by field; anything malformed is ignored", () => {
  const now = () => Date.parse("2026-11-10T12:00:00Z");
  const ok = parseSettlement({ transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", network: "near:testnet", invoiceId: "inv_1", payer: "chainaim-t02-seller.testnet" }, now);
  assert.deepEqual(ok, { network: "near:testnet", transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", invoiceId: "inv_1", payer: "chainaim-t02-seller.testnet", settledAt: "2026-11-10T12:00:00.000Z" });
  assert.equal(parseSettlement(undefined, now), undefined);
  assert.equal(parseSettlement({ transaction: "0OIl", network: "near:testnet", invoiceId: "i" }, now), undefined);
  assert.equal(parseSettlement({ transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", network: "xrpl:1", invoiceId: "i" }, now), undefined);
  assert.equal(parseSettlement({ transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", network: "near:testnet", invoiceId: "i", payer: "Bad Payer" }, now), undefined);
});

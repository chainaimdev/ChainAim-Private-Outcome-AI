import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReceipt } from "../../packages/receipt/src/index.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  attestStatusFrom, buildReceipt, datasetFiles, datasetIdOf, parseSettlement, receiptCalls, receiptConfig, receiptOnRelease, ReceiptStore, releasedResult,
  routeOf, templateLabelOf, type ReceiptInput,
} from "../console/receipt.ts";
import { internalHandler, JobStore, type HeldJob } from "../console/jobs.ts";
import { JobFeed, jobFeedConfig, receiptEvent } from "../console/job-feed.ts";
import type { JobAttestation } from "../console/attest.ts";

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

const TX = "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH";
const NOTICE = { transaction: TX, network: "near:testnet", payer: "t02.testnet", invoiceId: "ABCDEF0123456789ABCDEF0123456789" };

test("ARCH-613 dataset files leave hidden sub-folders (the analyst's work folder) out", () =>
  withDir(async (dir) => {
    mkdirSync(join(dir, "_analyst"));
    writeFileSync(join(dir, "_analyst", "work.duckdb"), "changes every run");
    writeFileSync(join(dir, "a.csv"), "x\n1\n");
    const files = await datasetFiles(dir, 10, (n) => /^_/.test(n));
    assert.deepEqual(files.map((f) => f.name), ["a.csv"]);
  }));

test("ARCH-613 receipt fields from the request: dataset id or a folder hash (never a path), template label, route, released result", () => {
  assert.equal(datasetIdOf("chiro-demo", "C:\\data\\x"), "chiro-demo");
  const hashed = datasetIdOf("../etc", "C:\\Users\\someone\\clinic");
  assert.match(hashed, /^folder-[0-9a-f]{16}$/);
  assert.ok(!hashed.includes("clinic"));
  assert.equal(templateLabelOf("  Overdue invoices "), "Overdue invoices");
  assert.equal(templateLabelOf("line\nbreak"), undefined);
  assert.equal(templateLabelOf("x".repeat(121)), undefined);
  assert.equal(routeOf("nearai/a", undefined), "nearai/a");
  assert.equal(routeOf("nearai/a", "nearai/a"), "nearai/a");
  assert.equal(routeOf("nearai/a", "local/b"), "nearai/a+local/b");
  assert.deepEqual(releasedResult({ a: 1, b: undefined, c: [{ d: undefined }] }), { a: 1, c: [{}] });
});

test("ARCH-613 attest verdicts map to the receipt: verified, unverified -> failed, anything unjudged -> pending", () => {
  const a = { calls: [{ status: "verified" }, { status: "unverified" }, { status: "unavailable" }, { status: "not_applicable" }] } as unknown as JobAttestation;
  const of = attestStatusFrom(a);
  assert.deepEqual([0, 1, 2, 3, 4].map(of), ["verified", "failed", "pending", "pending", "pending"]);
  assert.equal(attestStatusFrom(undefined)(0), "pending");
});

test("ARCH-615 ARCH-616 a released job's receipt is built from what was held, verifies against the released body, and carries the settlement", () =>
  withDir(async (dir) => {
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "orders.csv"), "order_id,amount\n1,10\n");
    const cfg = receiptConfig({ receipts: "on", "receipt-dir": join(dir, "receipts") }, { RECEIPT_SIGNING_KEY: pem() }, true)!;
    const store = new ReceiptStore(cfg);
    const files = await datasetFiles(data, 10);
    const served = [{ text: "", model: "nearai/x", zone: "private-cloud", attest: { servedModel: "near/x", requestSha256: H, responseSha256: G, calledAt: "2026-11-10T00:00:00Z" } }];
    const result = { sql: "SELECT 1", result: { columns: ["n"], rows: [{ n: 1 }], truncated: false }, answer: undefined, served };
    const attestation = { jobId: "x", summary: "verified", at: "", calls: [{ status: "verified" }] } as unknown as JobAttestation;
    const jobId = "0123456789abcdef0123456789abcdef";
    const held: HeldJob = {
      jobId, result: result as never, amount: "12001", breakdown: {} as never, expiresAt: Date.now() + 60_000,
      receipt: { network: "near:testnet", quoteId: jobId, route: "nearai/x", datasetId: "demo", templateLabel: "Orders", files, sql: "SELECT 1", priceUsd: "0.012001", actualUsd: "0.012001", quoteBasis: { pricing: "after", calls: 1 } },
    };
    const deps = { store, cfg, attestation: () => attestation, now: () => Date.parse("2026-11-10T12:00:00Z") };
    const r = await receiptOnRelease(deps, jobId, held, NOTICE);
    assert.ok(r);
    const body = releasedResult(result);
    assert.deepEqual(verifyReceipt(r, cfg.signer.publicKeyPem, body), { ok: true, settled: true });
    assert.equal(verifyReceipt(r, cfg.signer.publicKeyPem, { ...(body as object), answer: "changed" }).ok, false);
    assert.equal(r.settlement?.transaction, TX);
    assert.deepEqual(r.body.calls, [{ servedModel: "near/x", zone: "private-cloud", reqSha256: H, respSha256: G, attestStatus: "verified" }]);
    assert.equal(r.body.price.usdcDecimals, 6);
    assert.equal(r.body.templateLabel, "Orders");
    assert.equal(store.get(jobId)?.settlementSig?.value, r.settlementSig?.value, "stored as settled");
    const text = JSON.stringify(r);
    assert.ok(!text.includes("SELECT 1") && !text.includes(data), "no SQL text or folder path in the receipt");
    // Without a settlement in the notice: stored unsettled. Held without a receipt: none made.
    const other = "fedcba9876543210fedcba9876543210";
    const unsettled = await receiptOnRelease(deps, other, { ...held, jobId: other, receipt: { ...held.receipt!, quoteId: other } }, undefined);
    assert.deepEqual(verifyReceipt(unsettled!, cfg.signer.publicKeyPem, body), { ok: true, settled: false });
    const { receipt: _r, ...bare } = held;
    assert.equal(await receiptOnRelease(deps, "a".repeat(32), { ...bare, jobId: "a".repeat(32) }, NOTICE), undefined);
    await assert.rejects(receiptOnRelease(deps, jobId, held, NOTICE), /already exists/, "one receipt per job");
  }));

test("ARCH-615 job_receipt goes to near-watch only with --job-feed-receipts on, as ids and hashes", async () => {
  const KEY = "i".repeat(32);
  assert.equal(jobFeedConfig({ "job-feed-url": "http://127.0.0.1:1/ingest/job" }, { NEAR_WATCH_INGEST_KEY: KEY }, true)?.receipts, false);
  assert.throws(() => jobFeedConfig({ "job-feed-receipts": "on" }, {}, true), /needs --job-feed-url/);
  assert.throws(() => jobFeedConfig({ "job-feed-url": "http://127.0.0.1:1/x", "job-feed-receipts": "yes" }, { NEAR_WATCH_INGEST_KEY: KEY }, true), /on or off/);
  const signer = receiptConfig({ receipts: "on" }, { RECEIPT_SIGNING_KEY: pem() }, true)!;
  await withDir(async (dir) => {
    writeFileSync(join(dir, "a.csv"), "x\n");
    const r = await buildReceipt({ jobId: "0123456789abcdef0123456789abcdef", quoteId: "q", route: "m", datasetId: "d", folder: dir, sql: "S", result: {}, served: [], attestStatusOf: () => "pending", amountUnits: "1", usdcDecimals: 6, priceUsd: "0.000001", quoteBasis: {}, createdAt: "2026-11-10T00:00:00Z" }, signer);
    assert.deepEqual(receiptEvent(r, "near:testnet", 0), {
      v: 1, event: "job_receipt", ts: "1970-01-01T00:00:00.000Z", jobId: r.body.jobId, network: "near:testnet", receiptId: r.body.receiptId,
      keyId: r.sig.keyId, resultSha256: r.body.resultSha256, filesRoot: r.body.filesRoot, settled: false, transaction: null,
    });
    const got: unknown[] = [];
    const server = createServer((req, res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { got.push(JSON.parse(s)); res.writeHead(202).end(); }); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest/job`;
    try {
      const off = new JobFeed(jobFeedConfig({ "job-feed-url": url }, { NEAR_WATCH_INGEST_KEY: KEY }, true)!, () => {});
      off.receipt(r, "near:testnet");
      await off.idle();
      assert.equal(got.length, 0);
      const on = new JobFeed(jobFeedConfig({ "job-feed-url": url, "job-feed-receipts": "on" }, { NEAR_WATCH_INGEST_KEY: KEY }, true)!, () => {});
      on.receipt(r, "near:testnet");
      await on.idle();
      assert.equal(got.length, 1);
      assert.equal((got[0] as { event: string }).event, "job_receipt");
      assert.equal(on.counters.sent, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});

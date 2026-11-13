/**
 * privateAI-design-37 ARCH-677: the buyer agent believes a refund only when ChainAim's record verifies with the PINNED
 * receipt key and names this payment, amount and payer; a pending refund is asked again; a verified refund gives the
 * amount back to today's spending cap. Real Ed25519 keys and the real packages/receipt and packages/agent-policy code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signerFromKey, signRefund } from "../../../packages/receipt/src/index.ts";
import { SpendLedger } from "../../../packages/agent-policy/src/index.ts";
import { awaitRefund, checkRefund } from "../scripts/agent-refund.ts";

const chainaim = signerFromKey(generateKeyPairSync("ed25519").privateKey);
const stranger = signerFromKey(generateKeyPairSync("ed25519").privateKey);
const PAID = "4vv6QJSaL1V9dDeqWeVGhX5vaeQ3EhXheJSnYSmGWAAc";
const expect = { paidTx: PAID, amountUnits: "20000", payer: "chainaim-buyer-seller.testnet" };
const base = { status: "refunded", invoiceId: "C702E26D9A1B4C5D8E7F60718293A4B5", jobId: "8314afbf65b672d657a9a43bc45c8c2d", paidTx: PAID, refundTx: "9RefundTxAbCdEfGhJkLmNpQrStUvWxYz12345678abc", payer: expect.payer, amountUnits: "20000", network: "near:testnet", reason: "over_estimate", at: "2026-11-13T12:00:00.000Z" };
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

test("ARCH-677 a refund record signed by ChainAim and naming this payment, amount and payer is refunded", () => {
  const o = checkRefund(json(signRefund(base, chainaim)), expect, chainaim.publicKeyPem);
  assert.deepEqual(o, { kind: "refunded", refundTx: base.refundTx, invoiceId: base.invoiceId });
});

test("ARCH-677 never refunded without a verified signature: another key, a changed member, another payer/amount/payment", () => {
  const cases: [unknown, RegExp][] = [
    [json(signRefund(base, stranger)), /signed by another key/],
    [{ ...json(signRefund(base, chainaim)), refundTx: "9OtherTx" }, /does not verify/],
    [json(signRefund({ ...base, payer: "someone.testnet" }, chainaim)), /another payer/],
    [json(signRefund({ ...base, amountUnits: "10000" }, chainaim)), /another amount/],
    [json(signRefund({ ...base, paidTx: "5vv6QJSaL1V9dDeqWeVGhX5vaeQ3EhXheJSnYSmGWAAc" }, chainaim)), /another payment/],
    [{ ...base, sig: "not a signature" }, /does not verify|sig/],
    [{ status: "refund_refused", invoiceId: base.invoiceId, paidTx: PAID, reason: "a receipt was delivered for this job; no refund" }, /did not refund automatically: a receipt was delivered/],
    [null, /no refund record/],
  ];
  for (const [raw, re] of cases) {
    const o = checkRefund(raw, expect, chainaim.publicKeyPem);
    assert.equal(o.kind, "invalid", re.source);
    assert.match((o as { reason: string }).reason, re);
  }
  // No pinned key: reported refunded, but the agent cannot confirm it, so it stays pending.
  assert.equal(checkRefund(json(signRefund(base, chainaim)), expect, undefined).kind, "pending");
});

test("ARCH-677 a pending refund is asked again until the signed record arrives", async () => {
  let asks = 0;
  const server = createServer((req, res) => {
    asks++;
    const pending = (invoiceId: string) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(signRefund({ ...base, invoiceId, status: "refund_pending" }, chainaim))); };
    if (req.url !== `/v1/refunds/${base.invoiceId}`) return pending(String(req.url).split("/").pop());
    if (asks < 3) return pending(base.invoiceId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(signRefund(base, chainaim)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = checkRefund({ status: "refund_pending", invoiceId: base.invoiceId, paidTx: PAID, reason: "over_estimate" }, expect, chainaim.publicKeyPem);
    assert.deepEqual(first, { kind: "pending", invoiceId: base.invoiceId, reason: "over_estimate" });
    const o = await awaitRefund(url, base.invoiceId, expect, chainaim.publicKeyPem, { pollMs: 10, pollMax: 10, fetchTimeoutMs: 2000 });
    assert.deepEqual(o, { kind: "refunded", refundTx: base.refundTx, invoiceId: base.invoiceId });
    assert.equal(asks, 3);
    const gaveUp = await awaitRefund(url, "D802E26D9A1B4C5D8E7F60718293A4B5", expect, chainaim.publicKeyPem, { pollMs: 5, pollMax: 3, fetchTimeoutMs: 2000 });
    assert.deepEqual([gaveUp.kind, (gaveUp as { invoiceId?: string }).invoiceId], ["pending", "D802E26D9A1B4C5D8E7F60718293A4B5"]);
  } finally {
    // Windows: --test-force-exit while the client's keep-alive sockets are still closing trips a libuv assertion
    // (src/win/async.c: !(handle->flags & UV_HANDLE_CLOSING); seen here in about half the runs). Close, then let the
    // sockets finish closing before the test ends.
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await new Promise((r) => setTimeout(r, 200));
  }
});

test("ARCH-677 spend ledger: the upfront payment counts, a verified refund gives it back; old lines read as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  try {
    const ledger = new SpendLedger(dir, () => Date.parse("2026-11-13T12:00:00Z"));
    ledger.record("t01", "a".repeat(32), "0.03", "tx1");
    ledger.record("t01", "b".repeat(32), "0.02", PAID);
    assert.equal(ledger.spentToday("t01"), 50_000n);
    ledger.refund("t01", "b".repeat(32), "0.02", base.refundTx);
    assert.equal(ledger.spentToday("t01"), 30_000n);
    const lines = readFileSync(join(dir, "t01", "spend-2026-11-13.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.kind ?? "payment", l.amountMicro]), [["payment", "30000"], ["payment", "20000"], ["refund", "20000"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ARCH-689 a refund because NEAR AI attestation was not proven is named, with ca-attest's summary", async () => {
  const { privacyNotProven } = await import("../scripts/agent-jobs-core.ts");
  const why = "privacy was not proven for this job (NEAR AI attestation: unavailable); your payment X was refunded in R";
  assert.equal(privacyNotProven({ ...base, reason: "attestation_not_proven" }, why), "unavailable");
  assert.equal(privacyNotProven({ ...base, reason: "attestation_not_proven" }, "HTTP 422"), "not verified", "named by the refund, no summary in the message");
  assert.equal(privacyNotProven(undefined, "privacy was not proven for this job (NEAR AI attestation: partly)"), "partly");
  assert.equal(privacyNotProven({ ...base, reason: "over_estimate" }, "the folder has grown since the estimate"), undefined);
});

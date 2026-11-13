/**
 * privateAI-design-35 ARCH-650/652: scripts/observe-receipt.ts, the judges' no-key chain read of a receipt's settlement.
 * Run as a child process against a local JSON-RPC server (real HTTP) answering with the recorded x402 NEAR payment
 * (packages/observer/test/fixtures/x402-near-payment.json: payer chainaim-buyer-seller.testnet, 10000 base units).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const fx = JSON.parse(readFileSync(join(ROOT, "packages/observer/test/fixtures/x402-near-payment.json"), "utf8")) as { tx: string; txStatus: unknown };

async function withRpc(fn: (url: string) => Promise<void> | void): Promise<void> {
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const m = JSON.parse(b) as { method: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(m.method === "tx" ? { jsonrpc: "2.0", id: 1, result: fx.txStatus } : { jsonrpc: "2.0", id: 1, result: { header: { height: 7, timestamp_nanosec: "1762264350000000000" } } }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); } finally { srv.close(); }
}

/** Async spawn: spawnSync would block the local RPC server running in this process. */
function run(file: string, rpc: string): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => {
    const c = spawn(process.execPath, [join(ROOT, "scripts/observe-receipt.ts"), "--file", file, "--rpc-testnet", rpc, "--rpc-fallback-testnet", "none"], { cwd: ROOT });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => ok({ code, out }));
  });
}

const dir = mkdtempSync(join(tmpdir(), "observe-receipt-"));
const receipt = (units: string) => ({ receipt: { body: { jobId: "a".repeat(32), price: { amountUnits: units } }, sig: {}, settlement: { network: "near:testnet", transaction: fx.tx, invoiceId: "X", payer: "chainaim-buyer-seller.testnet", settledAt: "2026-11-04T13:44:30Z" } }, publicKeyPem: "" });

test("observe-receipt: prints the public fields and what is not on chain, and OK when the transfer matches the receipt's price", async () => {
  const f = join(dir, "ok.json"); writeFileSync(f, JSON.stringify(receipt("10000")));
  await withRpc(async (url) => {
    const r = await run(f, url);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PUBLIC  paid by     chainaim-buyer-seller\.testnet/);
    assert.match(r.out, /PUBLIC  sent by     chainaim-relayer-seller\.testnet/);
    assert.match(r.out, /PUBLIC  paid to     chainaim-payto-seller\.testnet/);
    assert.match(r.out, /PUBLIC  amount      0\.01 \(base units 10000/);
    assert.match(r.out, /PRIVATE not on the chain: the question; the data files and their rows/);
    assert.match(r.out, /OK      the chain shows this receipt's payment \(0\.01, as the receipt's price for job a{32}\)/);
  });
});

test("observe-receipt: exit 1 when the transfer's amount is not the receipt's price, or the receipt has no settlement; exit 2 without --file", async () => {
  const f = join(dir, "bad.json"); writeFileSync(f, JSON.stringify(receipt("20000")));
  await withRpc(async (url) => {
    const r = await run(f, url);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /NO      the receipt's price is 20000 base units, the transfer moved 10000/);
  });
  const u = join(dir, "unsettled.json"); writeFileSync(u, JSON.stringify({ body: { jobId: "b".repeat(32) }, sig: {} }));
  assert.equal(spawnSync(process.execPath, [join(ROOT, "scripts/observe-receipt.ts"), "--file", u], { cwd: ROOT }).status, 1);
  assert.equal(spawnSync(process.execPath, [join(ROOT, "scripts/observe-receipt.ts")], { cwd: ROOT }).status, 2);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

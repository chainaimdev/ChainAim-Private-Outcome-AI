/**
 * Tab 04 Payment "Try scan / mask / chat" (ARCH-013 quote display; NEAR-AC3 two rails): the console's GET-free relay
 * /paywall/<route> against a loopback paywall answering a two-rail 402 (RLUSD on XRPL and USDC on NEAR, one invoice), as
 * services/paywall routes.ts writes it. The real console process; no payment is made.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../console/server.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "paywall-try-"));
const REQUIRED = {
  x402Version: 2,
  accepts: [
    { scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "524C555344000000000000000000000000000000", payTo: "rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej", maxTimeoutSeconds: 60, extra: { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", invoiceId: "INV1" } },
    { scheme: "exact", network: "near:testnet", amount: "10000", asset: "usdc.chainaim-test.testnet", payTo: "merchant.chainaim-test.testnet", maxTimeoutSeconds: 60, extra: { invoiceId: "INV1" } },
  ],
};
const paywall = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(REQUIRED)).toString("base64"), "content-type": "application/json" }); res.end("{}"); }); });
after(() => { paywall.close(); rmSync(dir, { recursive: true, force: true }); });

test("ARCH-013 NEAR-AC3: Try scan shows one offer per rail: RLUSD on XRPL as a decimal, USDC on NEAR as a decimal with its exact base units", async () => {
  const pw = await new Promise<string>((ok) => paywall.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(paywall.address() as AddressInfo).port}`)));
  writeFileSync(join(dir, "gk.txt"), "test-gateway-key");
  writeFileSync(join(dir, "ds.json"), JSON.stringify({ allowedRoots: [dir], defaultFolder: dir, defaultMode: "whole", extensions: [".csv"], maxBytes: { "*": 1000 }, exclude: [], maxFiles: 2, hideFolders: [] }));
  const port = await new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--paywall", pw, "--gateway-key-file", join(dir, "gk.txt"), "--data-config", join(dir, "ds.json"), "--ledger-source", "off", "--run-log", "off"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d)); child.stderr!.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !out.includes(`http://127.0.0.1:${port}`); i++) await new Promise((ok) => setTimeout(ok, 100));
    const r = await fetch(`http://127.0.0.1:${port}/paywall/scan`, { headers: { host: `127.0.0.1:${port}` } });
    const j = (await r.json()) as { status: number; accepts: Record<string, unknown>[] };
    assert.equal(j.status, 402, out);
    assert.deepEqual(j.accepts.map((a) => [a.rail, a.price, a.amountUnits ?? null, a.network]), [["xrpl", 0.01, null, "xrpl:1"], ["near", 0.01, "10000", "near:testnet"]]);
    assert.deepEqual(j.accepts.map((a) => a.invoiceId), ["INV1", "INV1"]);
  } finally { child.kill(); }
});

test("ARCH-013 NEAR-AC3: the Payment tab labels each offer by its own rail (USDC and nearblocks for NEAR, RLUSD, issuer and the XRPL explorer for XRPL)", () => {
  const page = readFileSync(new URL("../console/index.html", import.meta.url), "utf8");
  const h = page.slice(page.indexOf('for (const b of document.querySelectorAll("[data-route]"))'), page.indexOf('if (r.body) out.append(block(el("span", { className: "blabel", textContent: "Response body" })'));
  assert.match(h, /const unit = \(q\) => \(q\.rail === "near" \? "USDC" : "RLUSD"\);/);
  assert.match(h, /if \(q\.rail === "near"\) \{[\s\S]*nearblocks\.io[\s\S]*q\.amountUnits[\s\S]*\} else \{[\s\S]*row\("Issuer"/);
  assert.match(h, /cell\("Price", offers\.length \? offers\.map\(\(q\) => `\$\{q\.price \?\? "\?"\} \$\{unit\(q\)\}`\)\.join\(" · "\)/);
});

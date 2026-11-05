/**
 * The test console's Docker split (DOCKERIZE-PLAN 4.1, C1-C7 and --dataset-root), with real console processes:
 * an api process and a ui process in front of it, a recording paywall on loopback, and temporary files for the data
 * config, the key file and a gateway ledger folder. The default (--mode all) is covered by every other console test.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = join(ROOT, "test-console/console/server.ts");
const PAGE = join(ROOT, "test-console/console/index.html");
const FRAGMENT = join(ROOT, "test-console/console/paid-jobs.html");
const WALLET = join(ROOT, "services/web/public/wallet.js");
const dir = mkdtempSync(join(tmpdir(), "console-docker-"));
const data = join(dir, "data");
mkdirSync(join(data, "private-set"), { recursive: true });
writeFileSync(join(data, "private-set", "a.csv"), "x\n1\n");
const dataConfig = join(dir, "data-sources.json");
writeFileSync(dataConfig, JSON.stringify({ allowedRoots: [data], defaultFolder: data, defaultMode: "whole", extensions: [".csv"] }));
const KEY = "docker-split-test-key-0123456789";
const keyFile = join(dir, "gateway-key.txt");
writeFileSync(keyFile, KEY + "\n");
const ledger = join(dir, "ledger");
mkdirSync(ledger);
const ROW = (i: number) => JSON.stringify({ ts: `2026-11-06T00:00:0${i}Z`, decision: `d${i}` });
writeFileSync(join(ledger, "2026-11-05.jsonl"), [1, 2, 3, 4, 5, 6, 7].map(ROW).join("\n") + "\n");
writeFileSync(join(ledger, "2026-11-06.jsonl"), [8, 9].map(ROW).join("\n") + "\n");

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
type Proc = { child: ChildProcess; out: () => string };
function start(args: string[], readyText: string): Promise<Proc> {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the console did not start: ${out}`)), 20_000);
    child.stdout!.on("data", () => { if (out.includes(readyText)) { clearTimeout(t); resolve({ child, out: () => out }); } });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`the console exited ${code}: ${out}`)); });
  });
}
const stop = (p?: Proc) => new Promise<void>((ok) => { if (!p || p.child.exitCode !== null) return ok(); p.child.once("exit", () => ok()); p.child.kill(); });
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host, ...headers } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (d) => (text += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// A recording paywall and gateway on loopback: what reached them, and a fixed answer.
const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
const upstream: Server = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ path: req.url!, headers: req.headers, body });
    if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "local/x", context_length: 8192 }] })); return; }
    res.writeHead(200, { "content-type": "application/json", "payment-response": "cmVjZWlwdA==", "x-chainaim-model": "local/x" });
    res.end(JSON.stringify({ choices: [{ message: { content: "answered" } }] }));
  });
});
let upUrl = "";
let apiPort = 0, uiPort = 0;
let apiProc: Proc, uiProc: Proc;

before(async () => {
  upUrl = await new Promise<string>((ok) => upstream.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)));
  apiPort = await freePort();
  uiPort = await freePort();
  apiProc = await start(["--mode", "api", "--port", String(apiPort), "--gateway", upUrl, "--paywall", upUrl, "--data-config", dataConfig, "--gateway-key-file", keyFile,
    "--ledger-source", `dir:${ledger}`, "--dataset-root", `private=${data}`, "--run-log", "off"], `http://127.0.0.1:${apiPort}`);
  uiProc = await start(["--mode", "ui", "--port", String(uiPort), "--api", `http://127.0.0.1:${apiPort}`, "--gateway-key-file", join(dir, "no-such-key.txt")], "ui mode");
});
after(async () => {
  await stop(uiProc); await stop(apiProc);
  await new Promise<void>((ok) => upstream.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

describe("C1/C3 ui mode forwards to the api", () => {
  test("C1: the page and the wallet bundle come from the ui itself, unchanged", async () => {
    const page = await call(uiPort, "GET", "/");
    assert.equal(page.status, 200);
    assert.equal(page.text, readFileSync(PAGE, "utf8"));
    const w = await call(uiPort, "GET", "/wallet.js");
    assert.equal(w.text, readFileSync(WALLET, "utf8"));
    assert.equal(seen.length, 0, "nothing reached the backends");
  });

  test("C3: a data route answers the same through the ui as from the api", async () => {
    const direct = await call(apiPort, "GET", "/data/config");
    const via = await call(uiPort, "GET", "/data/config");
    assert.equal(via.status, 200);
    assert.equal(via.text, direct.text);
    assert.deepEqual(JSON.parse(via.text).allowedRoots, [data]);
    assert.equal(via.headers["cache-control"], "no-store");
    assert.equal(via.headers["x-content-type-options"], "nosniff");
  });

  test("C3: a stored page keeps its sandbox CSP through the ui", async () => {
    const stored = await call(uiPort, "POST", "/view", { "content-type": "application/json" }, JSON.stringify({ html: "<p>hi</p>" }));
    assert.equal(stored.status, 200);
    const page = await call(uiPort, "GET", JSON.parse(stored.text).url);
    assert.equal(page.status, 200);
    assert.equal(page.text, "<p>hi</p>");
    assert.match(String(page.headers["content-security-policy"]), /^sandbox allow-scripts; default-src 'none'.*connect-src 'none'/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
  });

  test("C3: a paid chat goes ui -> api -> paywall with the payment header byte for byte, never the gateway key", async () => {
    seen.length = 0;
    const sig = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signedDelegateAction: "c2lnbmVk" } })).toString("base64");
    const body = JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: "private words" }] });
    const r = await call(uiPort, "POST", "/paid/chat", { "content-type": "application/json", "payment-signature": sig }, body);
    assert.equal(r.status, 200);
    assert.equal(r.headers["payment-response"], "cmVjZWlwdA==");
    assert.equal(r.headers["x-chainaim-model"], "local/x");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/v1/chat/completions");
    assert.equal(seen[0].headers["payment-signature"], sig);
    assert.equal(seen[0].body, body);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(JSON.stringify(seen[0].headers).includes(KEY), false);
    await new Promise((ok) => setTimeout(ok, 100));
    for (const leak of [sig, "private words"]) { assert.equal(uiProc.out().includes(leak), false); assert.equal(apiProc.out().includes(leak), false); }
  });

  test("C6: the api uses the key file it was given; the ui holds none (its key file does not even exist)", async () => {
    seen.length = 0;
    const r = await call(uiPort, "GET", "/gateway/models");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).models, ["local/x"]);
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  });

  test("C4: the ui refuses a foreign Host before anything is forwarded", async () => {
    seen.length = 0;
    for (const path of ["/data/config", "/gateway/models", "/view"]) {
      const r = await call(uiPort, "GET", path, {}, undefined, `evil.example:${uiPort}`);
      assert.equal(r.status, 403, path);
    }
    assert.equal(seen.length, 0);
  });

  test("C3: an api that does not answer gives one plain sentence; with a payment it never says not charged", async () => {
    const port = await freePort();
    const ui = await start(["--mode", "ui", "--port", String(port), "--api", "http://127.0.0.1:9"], "ui mode");
    try {
      const plain = await call(port, "GET", "/data/config");
      assert.equal(plain.status, 502);
      assert.match(JSON.parse(plain.text).error.message, /console API is not answering at http:\/\/127\.0\.0\.1:9/);
      const paid = await call(port, "POST", "/paid/chat", { "content-type": "application/json", "payment-signature": "eA==" }, "{}");
      assert.match(JSON.parse(paid.text).error.message, /after your payment was sent/);
    } finally { await stop(ui); }
  });

  test("C7: --paid-jobs-page on adds the tab 03 pay box in the ui; --paid-jobs itself is refused there", async () => {
    const port = await freePort();
    const ui = await start(["--mode", "ui", "--port", String(port), "--api", `http://127.0.0.1:${apiPort}`, "--paid-jobs-page", "on", "--near-wallet", "intear-wallet"], "ui mode");
    try {
      const page = (await call(port, "GET", "/")).text;
      assert.equal(page.replace(readFileSync(FRAGMENT, "utf8"), ""), readFileSync(PAGE, "utf8"));
      assert.ok(page.includes("xpayNear"));
    } finally { await stop(ui); }
    const API = ["--api", "http://127.0.0.1:9"];
    for (const [args, re] of [
      [[...API, "--paid-jobs", "on"], /--paid-jobs belongs to the api process/],
      [[], /--mode ui needs --api URL/],
      [[...API, "--paid-jobs-page", "on"], /--paid-jobs-page on needs --near-wallet/],
    ] as const) {
      const r = spawnSync(process.execPath, [SERVER, "--mode", "ui", "--port", "1", ...args], { encoding: "utf8", timeout: 20_000 });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, re);
    }
    const all = spawnSync(process.execPath, [SERVER, "--port", "1", "--api", "http://x"], { encoding: "utf8", timeout: 20_000 });
    assert.match(all.stderr, /--api is for --mode ui only/);
  });
});

describe("C4/C5 and --dataset-root on the api", () => {
  test("C4: by default the guard is today's two hosts; --allowed-hosts replaces them exactly", async () => {
    assert.equal((await call(apiPort, "GET", "/data/config", {}, undefined, `localhost:${apiPort}`)).status, 200);
    assert.equal((await call(apiPort, "GET", "/data/config", {}, undefined, `console-api:${apiPort}`)).status, 403);
    const port = await freePort();
    const c = await start(["--mode", "api", "--bind", "0.0.0.0", "--port", String(port), "--allowed-hosts", `console-api:${port}`, "--data-config", dataConfig, "--gateway-key-file", keyFile, "--run-log", "off"], "api mode");
    try {
      assert.equal((await call(port, "GET", "/data/config", {}, undefined, `console-api:${port}`)).status, 200);
      assert.equal((await call(port, "GET", "/data/config", {}, undefined, `127.0.0.1:${port}`)).status, 403);
      assert.match(c.out(), new RegExp(`api mode: listening on 0\\.0\\.0\\.0:${port}; hosts console-api:${port}`));
    } finally { await stop(c); }
  });

  test("C5: --ledger-source dir: gives what tail -n 6 <dir>/*.jsonl gives; off gives nothing", async () => {
    const r = JSON.parse((await call(apiPort, "GET", "/ledger")).text).lines;
    assert.deepEqual(r, [
      `==> ${join(ledger, "2026-11-05.jsonl")} <==`, ...[2, 3, 4, 5, 6, 7].map((i) => JSON.parse(ROW(i))),
      `==> ${join(ledger, "2026-11-06.jsonl")} <==`, ...[8, 9].map((i) => JSON.parse(ROW(i))),
    ]);
    const port = await freePort();
    const c = await start(["--mode", "api", "--port", String(port), "--ledger-source", "off", "--data-config", dataConfig, "--gateway-key-file", keyFile, "--run-log", "off"], "api mode");
    try { assert.deepEqual(JSON.parse((await call(port, "GET", "/ledger")).text), { lines: [] }); } finally { await stop(c); }
    const bad = spawnSync(process.execPath, [SERVER, "--port", "1", "--ledger-source", "file:/x"], { encoding: "utf8", timeout: 20_000 });
    assert.match(bad.stderr, /--ledger-source must be docker-exec, dir:<path> or off/);
  });

  test("--dataset-root replaces one root of config/datasets.json", async () => {
    const r = JSON.parse((await call(apiPort, "GET", "/datasets?root=private")).text);
    assert.equal(r.rootPath, data);
    assert.equal(r.rootAllowed, true);
    const bad = spawnSync(process.execPath, [SERVER, "--port", "1", "--dataset-root", "private"], { encoding: "utf8", timeout: 20_000 });
    assert.match(bad.stderr, /--dataset-root must be NAME=PATH/);
  });
});

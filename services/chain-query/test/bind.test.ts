/**
 * DOCKERIZE-PLAN 4.3: chain-query in a container. By default --host stays loopback-only and there is no Host check, as
 * before; --allow-non-loopback lets it listen on 0.0.0.0, and --allowed-hosts (optional) accepts only the listed Hosts.
 * The real process is run; only /healthz is called, so no chain is contacted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
function start(args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`chain-query did not start: ${out}`)), 20_000);
    child.stdout!.on("data", () => { if (out.includes("chain-query on http://")) { clearTimeout(t); resolve(child); } });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`chain-query exited ${code}: ${out}`)); });
  });
}
const stop = (c: ChildProcess) => new Promise<void>((ok) => { if (c.exitCode !== null) return ok(); c.once("exit", () => ok()); c.kill(); });
const health = (port: number, host: string) => new Promise<number>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: "/healthz", agent: false, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
  req.on("error", reject);
  req.end();
});

test("DOCKERIZE 4.3: without the new flags, a non-loopback --host is refused and any Host is answered, as before", async () => {
  const r = spawnSync(process.execPath, [MAIN, "--host", "0.0.0.0", "--port", "1"], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--host must be a loopback address: chain-query is for this PC only/);
  const port = await freePort();
  const c = await start(["--port", String(port)]);
  try {
    assert.equal(await health(port, `127.0.0.1:${port}`), 200);
    assert.equal(await health(port, `anything:${port}`), 200, "no Host check by default");
  } finally { await stop(c); }
});

test("DOCKERIZE 4.3: --allow-non-loopback --host 0.0.0.0 --allowed-hosts answers only the listed Hosts", async () => {
  const port = await freePort();
  const c = await start(["--host", "0.0.0.0", "--port", String(port), "--allow-non-loopback", "--allowed-hosts", `chain-query:${port},127.0.0.1:${port}`]);
  try {
    assert.equal(await health(port, `chain-query:${port}`), 200);
    assert.equal(await health(port, `127.0.0.1:${port}`), 200);
    assert.equal(await health(port, `evil.example:${port}`), 403);
  } finally { await stop(c); }
});

test("DOCKERIZE 4.3: bad values stop start-up", () => {
  for (const [args, re] of [[["--allow-non-loopback", "--host", "my-host"], /--host must be an IP address/], [["--allowed-hosts", "chain-query"], /host:port/]] as const) {
    const r = spawnSync(process.execPath, [MAIN, "--port", "1", ...args], { encoding: "utf8", timeout: 20_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, re);
  }
});

const getJson = (port: number, path: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    let t = ""; res.setEncoding("utf8"); res.on("data", (d) => (t += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(t) }));
  });
  req.on("error", reject);
  req.end();
});

test("privateAI-design-43 A6: --chains near lists only NEAR in GET /chains and refuses a query for another chain (404) without contacting it; default all lists both", async () => {
  const port = await freePort();
  const c = await start(["--port", String(port), "--chains", "near"]);
  try {
    const chains = await getJson(port, "/chains");
    assert.equal(chains.status, 200);
    assert.deepEqual((chains.body.chains as { id: string }[]).map((x) => x.id), ["near"]);
    const xrpl = await getJson(port, "/vaults?chain=xrpl&env=devnet");
    assert.equal(xrpl.status, 404);
    assert.match(String(xrpl.body.error), /chain xrpl is not offered here \(--chains near\)/);
  } finally { await stop(c); }
  const p2 = await freePort();
  const all = await start(["--port", String(p2)]);
  try { assert.deepEqual(((await getJson(p2, "/chains")).body.chains as { id: string }[]).map((x) => x.id).sort(), ["near", "xrpl"]); }
  finally { await stop(all); }
  const bad = spawnSync(process.execPath, [MAIN, "--port", "1", "--chains", "solana"], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--chains: solana is not in the registry/);
});

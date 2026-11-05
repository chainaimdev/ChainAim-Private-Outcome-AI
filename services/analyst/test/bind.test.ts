/**
 * DOCKERIZE-PLAN A1/A2: --bind and --allowed-hosts. The analyst runs as a real process; the defaults keep today's
 * behaviour (127.0.0.1 only, Host 127.0.0.1:<port> or localhost:<port>), and in a container it can listen on 0.0.0.0 and
 * accept the console's Host (analyst:8740) while still refusing every other one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });

function start(args: string[]): Promise<{ child: ChildProcess; out: () => string }> {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the analyst did not start: ${out}`)), 20_000);
    child.stdout!.on("data", () => { if (out.includes("[analyst] http://")) { clearTimeout(t); resolve({ child, out: () => out }); } });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`the analyst exited ${code}: ${out}`)); });
  });
}
const stop = (c: ChildProcess) => new Promise<void>((ok) => { if (c.exitCode !== null) return ok(); c.once("exit", () => ok()); c.kill(); });
/** GET /healthz with a chosen Host header, connecting to 127.0.0.1. */
const health = (port: number, host: string) => new Promise<number>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: "/healthz", agent: false, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
  req.on("error", reject);
  req.end();
});

test("A1/A2: the defaults are today's: 127.0.0.1 and localhost on its port only", async () => {
  const port = await freePort();
  const a = await start(["--port", String(port)]);
  try {
    assert.equal(await health(port, `127.0.0.1:${port}`), 200);
    assert.equal(await health(port, `localhost:${port}`), 200);
    assert.equal(await health(port, `analyst:${port}`), 403);
    assert.equal(await health(port, `evil.example:${port}`), 403);
    assert.match(a.out(), new RegExp(`\\[analyst\\] http://127\\.0\\.0\\.1:${port} `));
    assert.doesNotMatch(a.out(), /listening on/);
  } finally { await stop(a.child); }
});

test("A1/A2: --bind 0.0.0.0 --allowed-hosts accepts exactly the listed hosts", async () => {
  const port = await freePort();
  const a = await start(["--port", String(port), "--bind", "0.0.0.0", "--allowed-hosts", `analyst:${port},127.0.0.1:${port}`]);
  try {
    assert.equal(await health(port, `analyst:${port}`), 200);
    assert.equal(await health(port, `ANALYST:${port}`), 200, "Host is compared case-insensitively");
    assert.equal(await health(port, `127.0.0.1:${port}`), 200);
    assert.equal(await health(port, `localhost:${port}`), 403, "only the listed hosts");
    assert.equal(await health(port, `analyst:${port + 1}`), 403);
    assert.match(a.out(), new RegExp(`listening on 0\\.0\\.0\\.0; hosts analyst:${port},127\\.0\\.0\\.1:${port}`));
  } finally { await stop(a.child); }
});

test("A1/A2: bad values stop start-up with what to fix", () => {
  for (const [args, re] of [[["--bind", "any"], /--bind must be an IP address/], [["--allowed-hosts", "analyst"], /--allowed-hosts entries must be host:port/], [["--allowed-hosts", " , "], /at least one host:port/]] as const) {
    const r = spawnSync(process.execPath, [MAIN, "--port", "1", ...args], { encoding: "utf8", timeout: 20_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, re);
  }
});

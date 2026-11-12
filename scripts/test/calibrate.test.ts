/**
 * scripts/calibrate.ts (privateAI-design-34 ARCH-635, desk.ps1 -Calibrate) against a loopback console double that answers
 * like test-console/console/server.ts (/datasets, /data/files, /crossask with timings: true, /gateway/scan|mask). The CLI
 * runs as a child process, so flags, exit codes, the request bodies and the files it writes are what the owner gets.
 * No model, no Docker; the sample text is files written here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { parseCostModel } from "../../packages/offer/src/index.ts";
import { sampleText } from "../calibrate.ts";

const SCRIPT = fileURLToPath(new URL("../calibrate.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "calibrate-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const sampleRoot = join(dir, "sample-data");
mkdirSync(join(sampleRoot, "smb", "statements"), { recursive: true });
mkdirSync(join(sampleRoot, "pers"), { recursive: true });
writeFileSync(join(sampleRoot, "smb", "statements", "st.csv"), "date,amount,memo\n" + "2026-01-02,10.50,Coffee Zqxmarker\n".repeat(1500));
writeFileSync(join(sampleRoot, "pers", "p.csv"), "a,b\n1,2\n");
const datasetsConfig = join(dir, "datasets.json");
writeFileSync(datasetsConfig, JSON.stringify({ datasets: [{ id: "smb", folder: "smb/statements" }, { id: "pers", folder: "pers" }] }));
const QUESTION = "By month, how much came in Zqxmarker?";

const DATASETS = { root: "samples", rootAllowed: true, datasets: [
  { id: "smb", engine: "crossask", templates: [{ label: "Cash", q: QUESTION, sql: "SELECT 1" }], defaultSubfolder: null, folder: "/app/sample-data/smb/statements", exists: true, allowed: true, files: ["st.csv"], sets: [] },
  { id: "pers", engine: "crossask", templates: [{ label: "P", q: "Q2?" }], defaultSubfolder: null, folder: "/app/sample-data/pers", exists: true, allowed: true, files: ["p.csv"], sets: [] },
  { id: "dent", engine: "domain-pack", templates: [], defaultSubfolder: null, folder: "/app/sample-data/dent", exists: true, allowed: true, files: [], sets: [] },
] };
type Seen = { method: string; path: string; body: any };
type Mode = { noTimings?: boolean; failRun?: number; rateLimited?: number; noUsage?: boolean };

async function double(mode: Mode): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let runs = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "", path: url.pathname + url.search, body });
    const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.method === "GET" && url.pathname === "/datasets") return send(200, DATASETS);
    if (req.method === "GET" && url.pathname === "/data/files") {
      const p = url.searchParams.get("path");
      return send(200, { path: p, files: p?.endsWith("smb/statements") ? [{ name: "st.csv", size: 1024 * 1024 }, { name: "ar.csv", size: 1024 * 1024 }] : [{ name: "p.csv", size: 512 * 1024 }], truncated: false, maxFiles: 20 });
    }
    if (req.method === "POST" && url.pathname === "/crossask") {
      if (mode.rateLimited && mode.rateLimited-- > 0) return send(200, { error: "the model that writes the query (m/x) failed: 429 rate_limited", result: null, served: [], sentToModel: [] });
      runs++;
      if (mode.failRun === runs) return send(200, { error: "the model did not reply with a query", result: null, served: [], sentToModel: [] });
      const llm = body.phrase === "llm";
      const served = [{ text: "q", usage: mode.noUsage ? undefined : { promptTokens: 300, completionTokens: 20 } }, ...(llm ? [{ text: "a", usage: mode.noUsage ? undefined : { promptTokens: 120, completionTokens: 30 } }] : [])];
      return send(200, {
        question: body.question, result: { columns: ["n"], rows: [{ n: 1 }], truncated: false }, answer: llm ? "One." : null, served,
        sentToModel: [{ step: "query", chars: 1000, bytes: 1100, hasData: false }, ...(llm ? [{ step: "answer", chars: 400, bytes: 400, hasData: true }] : [])],
        ...(body.timings === true && !mode.noTimings ? { timings: { relationsMs: 40 + runs, queryMs: 900, sqlMs: 10, ...(llm ? { answerMs: 500 } : {}), callsMs: [800 + 10 * runs, ...(llm ? [500] : [])], files: 2 } } : {}),
      });
    }
    if (req.method === "POST" && (url.pathname === "/gateway/scan" || url.pathname === "/gateway/mask")) return send(200, { status: 200, headers: {}, body: { entities: [] } });
    send(404, { error: "no route" });
  });
  const url = await new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { server, url, seen };
}
function cli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code: code ?? -1, out }));
  });
}
const base = (url: string, outFile: string, reportDir: string, extra: string[] = []) =>
  ["--api", url, "--compute-usd-per-hour", "3.6", "--runs", "2", "--presidio-kb", "1,4", "--sample-root", sampleRoot, "--datasets-config", datasetsConfig, "--out", outFile, "--report-dir", reportDir, "--machine", "test-pc", "--rate-limit-wait-sec", "0", ...extra];

test("ARCH-635: a clean run writes config/cost-model.json that packages/offer reads; free questions with timings: true; no data in the report", async () => {
  const d = await double({});
  const outFile = join(dir, "ok", "cost-model.json"), rep = join(dir, "ok-runs");
  try {
    const r = await cli(base(d.url, outFile, rep));
    assert.equal(r.code, 0, r.out);
    const file = JSON.parse(readFileSync(outFile, "utf8"));
    const cm = parseCostModel(file);
    assert.equal(cm.machine, "test-pc");
    assert.match(cm.source, /sample datasets smb, pers; model bedrock\/nemotron-nano-3-30b, answer bedrock\/nemotron-nano-3-30b; 2 runs; compute 3\.6 USD\/h/);
    // analyst worst: (40+run + 10) ms over 0.5 MB (pers runs 3-4: 54 ms) = 108 ms/MB -> 0.000108 USD/MB at 3.6 USD/h
    assert.equal(cm.units.analystPerMbUsd, "0.000108000000");
    // gateway worst: the answer call, 500 ms over 400 B = 1280 ms/KB (beats the query call's 840 ms over 1100 B = 782 ms/KB)
    assert.equal(cm.units.gatewayPerKbPromptUsd, "0.001280000000");
    assert.deepEqual([cm.tokensPerByte, cm.bytesPerChar], ["1", "1.1000"]);
    assert.deepEqual(file.observed.samples, { presidio: 8, analyst: 4, call: 8 }, "2 sizes x scan, mask x 2 runs; 2 datasets x 2 runs, 2 calls each");
    const asks = d.seen.filter((s) => s.path === "/crossask");
    assert.equal(asks.length, 4);
    for (const a of asks) { assert.equal(a.body.timings, true); assert.equal("sql" in a.body, false, "the template's sql is not sent: a model must write the query"); assert.equal(a.body.phrase, "llm"); }
    assert.deepEqual(d.seen.filter((s) => s.path.startsWith("/data/files")).map((s) => s.path), ["/data/files?path=%2Fapp%2Fsample-data%2Fsmb%2Fstatements", "/data/files?path=%2Fapp%2Fsample-data%2Fpers"]);
    const scans = d.seen.filter((s) => s.path === "/gateway/scan");
    assert.deepEqual(scans.map((s) => Buffer.byteLength(s.body.text)), [1024, 1024, 4096, 4096], "the start of the local sample files, at each size");
    assert.ok(scans[0].body.text.startsWith("date,amount,memo"));
    assert.equal(d.seen.some((s) => s.path.includes("dent")), false, "domain packs are not calibrated");
    const report = readFileSync(join(rep, readdirSync(rep)[0]), "utf8");
    for (const leak of ["Zqxmarker", QUESTION, "Coffee"]) assert.equal(report.includes(leak), false, leak);
    assert.match(r.out, /written .*cost-model\.json/);
  } finally { d.server.close(); }
});

test("ARCH-635: a console older than ARCH-635 (no timings), a failed run or no token usage writes nothing", async () => {
  for (const [mode, re] of [[{ noTimings: true }, /older than ARCH-635\. Rebuild it \(\.\\test-console\\desk\.ps1 -All -AllSkipTests\)/], [{ failRun: 2 }, /1 problem\(s\); nothing written[\s\S]*smb\|t1 run 2: the model did not reply with a query/], [{ noUsage: true }, /no model call reported its token usage[\s\S]*nothing written/]] as const) {
    const d = await double(mode);
    const outFile = join(dir, "bad", "cost-model.json");
    try {
      const r = await cli(base(d.url, outFile, join(dir, "bad-runs")));
      assert.equal(r.code, 1, r.out); assert.match(r.out, re); assert.equal(existsSync(outFile), false);
    } finally { d.server.close(); }
  }
});

test("ARCH-635: a rate-limited call is waited out and sent again", async () => {
  const d = await double({ rateLimited: 1 });
  try {
    const r = await cli(base(d.url, join(dir, "rl", "cost-model.json"), join(dir, "rl-runs")));
    assert.equal(r.code, 0, r.out); assert.match(r.out, /gateway rate limit: waiting 0 s, then retry 1\/3/); assert.match(r.out, /1 rate-limit wait/);
  } finally { d.server.close(); }
});

test("ARCH-635: usage: compute price required, at least 2 runs, Presidio sizes under the gateway's limit, sample root only; dry run sends nothing", async () => {
  for (const [args, re] of [
    [["--runs", "3"], /--compute-usd-per-hour is required/], [["--compute-usd-per-hour", "0"], /must be a decimal above 0/], [["--compute-usd-per-hour", "1", "--runs", "1"], /--runs must be a whole number 2-20/],
    [["--compute-usd-per-hour", "1", "--presidio-kb", "20"], /--presidio-kb must be whole KB sizes 1-19/], [["--compute-usd-per-hour", "1", "--root", "private"], /--root must be samples/],
    [["--compute-usd-per-hour", "1", "--tokens-per-byte", "guess"], /bound or observed/], [["--compute-usd-per-hour", "1", "--answer-model", "x"], /same, none or provider\/name/],
  ] as const) {
    const r = await cli([...args, "--api", "http://127.0.0.1:9"]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`); assert.match(r.out, re);
  }
  const d = await double({});
  try {
    const r = await cli(["--api", d.url, "--dry-run", "--datasets", "smb"]);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /plan: 1 template question\(s\) in smb x 3 runs; 3 size\(s\) x scan, mask x 3 runs/);
    assert.deepEqual(d.seen.map((s) => s.method), ["GET"], "only /datasets");
    const u = await cli(["--api", d.url, "--compute-usd-per-hour", "1", "--datasets", "dent"]);
    assert.equal(u.code, 2); assert.match(u.out, /dent is not a crossask dataset \(crossask: smb, pers\)/);
  } finally { d.server.close(); }
});

test("ARCH-635: sampleText takes the start of the text files in order, cut on a character boundary", () => {
  const sd = join(dir, "st"); mkdirSync(sd);
  writeFileSync(join(sd, "a.csv"), "ab€"); writeFileSync(join(sd, "b.txt"), "xyz"); writeFileSync(join(sd, "_answer.json"), "SECRET"); writeFileSync(join(sd, "c.xlsx"), "bin");
  assert.equal(sampleText([sd], 4), "ab", "the euro sign (3 bytes) does not fit in 4: no broken character");
  assert.equal(sampleText([sd], 100), "ab€xyz", "underscore files and non-text files are left out");
  assert.equal(sampleText([join(dir, "none"), sd], 6), "ab€x");
  assert.equal(sampleText([sd], 20, true), "ab€xyz\nab€xyz\nab", "fill: the files' own text repeated up to the size, cut on a character boundary");
  assert.equal(sampleText([sd], 21, true), "ab€xyz\nab€xyz\nab", "the third euro sign would cross 21 bytes: dropped, never broken (20 bytes)");
  assert.equal(sampleText([join(dir, "none")], 20, true), "", "no text file: nothing to repeat");
});

test("ARCH-635: sample files smaller than a Presidio size are repeated up to it (owner run 2026-11-12: 2,600 bytes of text); a run still writes the model", async () => {
  const d = await double({});
  const outFile = join(dir, "small", "cost-model.json"), rep = join(dir, "small-runs");
  try {
    // pers: one 8-byte CSV, so every size is its text repeated
    const r = await cli(base(d.url, outFile, rep, ["--presidio-kb", "1,16,19", "--datasets", "pers"]));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /NOTE presidio 19 KB: the sample files hold 8 bytes of text, repeated to 19456 bytes/);
    assert.ok(existsSync(outFile));
    const scans = d.seen.filter((s) => s.path === "/gateway/scan").map((s) => Buffer.byteLength(s.body.text));
    assert.deepEqual(scans, [1024, 1024, 16384, 16384, 19456, 19456]);
    assert.deepEqual(JSON.parse(readFileSync(join(rep, readdirSync(rep)[0]), "utf8")).presidioKbRepeatedText, [1, 16, 19]);
    assert.ok(d.seen.find((s) => s.path === "/gateway/mask")!.body.text.startsWith("a,b\n1,2\n\na,b\n1,2\n"), "the file's own text, copy after copy");
  } finally { d.server.close(); }
});

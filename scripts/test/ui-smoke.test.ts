/**
 * scripts/ui-smoke.ts (tab 03 template smoke check, 2026-11-06) against a loopback console double that answers like
 * test-console/console/server.ts: the CLI runs as a child process, so flags, exit codes, the request bodies it sends and the
 * report it writes are what an owner gets. No model, no Docker, no data folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const SCRIPT = fileURLToPath(new URL("../ui-smoke.ts", import.meta.url));
const DEFAULT_MODEL = "bedrock/nemotron-nano-3-30b";

const DATASETS = {
  root: "samples", rootPath: "/app/sample-data", rootAllowed: true, roots: ["samples", "private"],
  datasets: [
    { id: "smb", engine: "crossask", pack: null, templates: [{ label: "Cash flow", q: "Q1?" }], templatesFrom: null, defaultSubfolder: null,
      folder: "/app/sample-data/smb", exists: true, allowed: true, files: ["st.csv"], sets: [] },
    { id: "chiro", engine: "crossask", pack: null, templates: [{ label: "Payers", q: "Q2?" }], templatesFrom: null, defaultSubfolder: "SET-1/POS",
      folder: "/app/sample-data/chiro", exists: true, allowed: true, files: [], sets: [{ name: "SET-1/NEG-A", files: ["x.csv"] }, { name: "SET-1/POS", files: ["x.csv"] }] },
    { id: "dent", engine: "domain-pack", pack: "finance/rcm/dental", templates: [], templatesFrom: "pack", defaultSubfolder: "SET-2/NEG-ALL",
      folder: "/app/sample-data/dent", exists: true, allowed: true, files: [], sets: [{ name: "SET-2/NEG-ALL", files: ["b.csv"] }, { name: "SET-2/POS", files: ["b.csv"] }] },
    { id: "pers", engine: "crossask", pack: null, templates: [], templatesFrom: null, defaultSubfolder: null,
      folder: "/app/sample-data/pers", exists: false, allowed: true, files: [], sets: [] },
  ],
};
const BANK = { pack: "finance/rcm/dental", topics: [{ id: "leaks", label: "Leaks" }], queries: [
  { id: "leak-summary", title: "Every leak", kind: "sql", topic: "leaks", pair: null },
  { id: "financing", title: "Financing", kind: "sql", topic: "leaks", pair: null },
  { id: "ask-priorities", title: "MODEL: priorities", kind: "model", topic: "leaks", pair: "leak-summary", question: "What first?", facts: ["T"] },
] };

type Seen = { method: string; path: string; body: any };
type Mode = { crossFail?: boolean; zeroRows?: boolean; checkOk?: boolean; warnings?: boolean; rateLimited?: number; datasets?: unknown;
  /** answer checks: the rows a pack query id returns, and the rows every crossask result returns */
  packRows?: Record<string, Record<string, unknown>[]>; crossRows?: Record<string, unknown>[] };

async function double(mode: Mode): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "", path: url.pathname + url.search, body });
    const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.method === "GET" && url.pathname === "/datasets") return url.searchParams.get("root") === "samples" ? send(200, mode.datasets ?? DATASETS) : send(400, { error: "unknown root" });
    if (req.method === "POST" && url.pathname === "/analyst/pack-queries") return send(200, BANK);
    if (req.method === "POST" && url.pathname === "/analyst/pack-run") {
      const id = body.ids[0];
      return send(200, { runId: "r1", pack: body.pack, files: [], exceptions: 0, questions: [],
        results: [id === "financing" ? { id, title: "Financing", skipped: "no financing file in this folder" }
          : { id, title: "Every leak", columns: mode.packRows?.[id] ? Object.keys(mode.packRows[id][0] ?? {}) : ["code"], rows: mode.packRows?.[id] ?? [], truncated: false }] });
    }
    if (req.method === "POST" && url.pathname === "/packask") {
      const ok = mode.checkOk !== false;
      return send(200, { id: body.id, check: { ok, checked: 3, problems: ok ? [] : ["$12.00 not in the facts"] }, served: { model: "nvidia.nemotron-nano-3-30b", zone: "private-cloud", seconds: 2.5 } });
    }
    if (req.method === "POST" && url.pathname === "/crossask") {
      // The gateway's free-rpm refusal, as the console returns it (200 with error, no attempt).
      if (mode.rateLimited && mode.rateLimited-- > 0) return send(200, { attempts: [], sql: null, result: null, answer: null, unverified: [], served: [], sentToModel: [], warnings: [],
        error: "the model that writes the query (bedrock/nemotron-nano-3-30b) failed: gateway: free-model capacity is used up right now (rate_limited); you were not charged" });
      if (mode.crossFail && body.question === "Q2?") return send(200, { attempts: [{ sql: "SELECT nope", error: "Binder Error: column nope" }], sql: null, result: null, answer: null, unverified: [], served: [], sentToModel: [], warnings: [], error: "the query failed after 2 tries" });
      return send(200, { attempts: [{ sql: "SELECT 1 AS n" }], sql: "SELECT 1 AS n", result: { columns: ["n"], rows: mode.zeroRows ? [] : mode.crossRows ?? [{ n: 1 }], truncated: false },
        answer: null, unverified: [], served: [{ model: "m" }], sentToModel: [], warnings: mode.warnings ? ["a many-to-many join"] : [] });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Runs the CLI as a child (async: the double answers on this process's event loop). */
function cli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out }));
  });
}

async function withDouble(mode: Mode, args: string[], check: (r: { code: number | null; out: string; seen: Seen[]; dir: string }) => void) {
  const { server, url, seen } = await double(mode);
  const dir = mkdtempSync(join(tmpdir(), "ui-smoke-"));
  try { check({ ...(await cli(["--api", url, "--report-dir", dir, ...args])), seen, dir }); }
  finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}
const posts = (seen: Seen[], path: string) => seen.filter((s) => s.method === "POST" && s.path === path).map((s) => s.body);

test("every template runs with exactly the page's request bodies; default sets only; exit 0 and a report without rows or answers", async () => {
  await withDouble({}, [], ({ code, out, seen, dir }) => {
    assert.equal(code, 0, out);
    assert.deepEqual(posts(seen, "/crossask"), [
      { folder: "/app/sample-data/smb", question: "Q1?", model: DEFAULT_MODEL, phrase: "none" },
      { folder: "/app/sample-data/chiro/SET-1/POS", question: "Q2?", model: DEFAULT_MODEL, phrase: "none" },
    ]);
    assert.deepEqual(posts(seen, "/analyst/pack-queries"), [{ pack: "finance/rcm/dental" }]);
    assert.deepEqual(posts(seen, "/analyst/pack-run"), [
      { folder: "/app/sample-data/dent/SET-2/NEG-ALL", pack: "finance/rcm/dental", ids: ["leak-summary"] },
      { folder: "/app/sample-data/dent/SET-2/NEG-ALL", pack: "finance/rcm/dental", ids: ["financing"] },
    ]);
    assert.deepEqual(posts(seen, "/packask"), [{ folder: "/app/sample-data/dent/SET-2/NEG-ALL", pack: "finance/rcm/dental", id: "ask-priorities", model: DEFAULT_MODEL }]);
    const files = readdirSync(dir).filter((f) => /^ui-smoke-.*\.json$/.test(f));
    assert.equal(files.length, 1);
    const rep = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.deepEqual(rep.counts, { pass: 4, warn: 0, skip: 2, fail: 0 }); // 2 crossask + leak-summary + packask; financing + pers skipped
    assert.equal(rep.items.find((i: any) => i.dataset === "smb").sql, "SELECT 1 AS n");
    assert.ok(!JSON.stringify(rep).includes('"rows":[') && !JSON.stringify(rep).includes('"answer"'), "no result rows or answers in the report");
    assert.match(out, /PASS 4 {2}WARN 0 {2}SKIP 2 {2}FAIL 0/);
  });
});

test("a failed crossask template is FAIL, names the error, and exits 1", async () => {
  await withDouble({ crossFail: true }, ["--datasets", "chiro"], ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /chiro .*crossask +FAIL .*the query failed after 2 tries/);
  });
});

test("0 rows: FAIL with --require-rows on (default), WARN with off; join warnings are WARN", async () => {
  await withDouble({ zeroRows: true }, ["--datasets", "smb"], ({ code, out }) => { assert.equal(code, 1, out); assert.match(out, /FAIL .*0 rows/); });
  await withDouble({ zeroRows: true }, ["--datasets", "smb", "--require-rows", "off"], ({ code, out }) => { assert.equal(code, 0, out); assert.match(out, /WARN .*0 rows/); });
  await withDouble({ warnings: true }, ["--datasets", "smb"], ({ code, out }) => { assert.equal(code, 0, out); assert.match(out, /WARN .*join warning/); });
});

test("pack: a skipped query is SKIP unless --skip-is-fail on; a figure mismatch is WARN unless --strict-check on", async () => {
  await withDouble({}, ["--datasets", "dent", "--skip-is-fail", "on"], ({ code, out }) => { assert.equal(code, 1, out); assert.match(out, /pack-sql +FAIL .*no financing file/); });
  await withDouble({ checkOk: false }, ["--datasets", "dent"], ({ code, out }) => { assert.equal(code, 0, out); assert.match(out, /pack-explained +WARN .*did not match/); });
  await withDouble({ checkOk: false }, ["--datasets", "dent", "--strict-check", "on"], ({ code }) => assert.equal(code, 1));
  await withDouble({}, ["--datasets", "dent", "--pack-explained", "off"], ({ code, seen }) => { assert.equal(code, 0); assert.equal(posts(seen, "/packask").length, 0); });
});

test("--sets all runs every set; --answer-model words the answer (phrase llm), as the page does when one is picked", async () => {
  await withDouble({}, ["--datasets", "chiro", "--sets", "all", "--answer-model", "local/qwen2.5-3b"], ({ code, seen }) => {
    assert.equal(code, 0);
    assert.deepEqual(posts(seen, "/crossask"), [
      { folder: "/app/sample-data/chiro/SET-1/NEG-A", question: "Q2?", model: DEFAULT_MODEL, answerModel: "local/qwen2.5-3b", phrase: "llm" },
      { folder: "/app/sample-data/chiro/SET-1/POS", question: "Q2?", model: DEFAULT_MODEL, answerModel: "local/qwen2.5-3b", phrase: "llm" },
    ]);
  });
});

test("a template with sql (smb-fin-1, owner 2026-11-07) is sent with it, as the page does, and listed as crossask-sql; one without sql is unchanged", async () => {
  const SQL = "SELECT 1 AS receivables_open";
  const datasets = { ...DATASETS, datasets: [{ ...DATASETS.datasets[0], templates: [{ label: "AR vs AP", q: "Owed?", sql: SQL }, { label: "Free", q: "Q1?" }] }] };
  await withDouble({ datasets }, ["--datasets", "smb", "--answer-model", "nearai/deepseek-v4.1-flash"], ({ code, out, seen, dir }) => {
    assert.equal(code, 0, out);
    assert.deepEqual(posts(seen, "/crossask"), [
      { folder: "/app/sample-data/smb", question: "Owed?", model: DEFAULT_MODEL, answerModel: "nearai/deepseek-v4.1-flash", phrase: "llm", sql: SQL },
      { folder: "/app/sample-data/smb", question: "Q1?", model: DEFAULT_MODEL, answerModel: "nearai/deepseek-v4.1-flash", phrase: "llm" },
    ]);
    assert.match(out, /AR vs AP +crossask-sql +PASS/);
    assert.match(out, /Free +crossask +PASS/);
    const r = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("ui-smoke-"))!), "utf8"));
    assert.deepEqual(r.items.map((i: { kind: string }) => i.kind), ["crossask-sql", "crossask"]);
  });
  await withDouble({ datasets }, ["--datasets", "smb", "--dry-run"], ({ code, out }) => { assert.equal(code, 0, out); assert.match(out, /AR vs AP +crossask-sql +PLAN/); });
});

test("a gateway rate_limited refusal is waited out and sent again (--rate-limit-retries); with 0 retries it is FAIL", async () => {
  await withDouble({ rateLimited: 2 }, ["--datasets", "smb", "--rate-limit-wait-sec", "0"], ({ code, out, seen }) => {
    assert.equal(code, 0, out);
    assert.equal(posts(seen, "/crossask").length, 3, "two refusals, then the run");
    assert.match(out, /retry 2\/3/);
    assert.match(out, /2 rate-limit wait\(s\) included/);
  });
  await withDouble({ rateLimited: 1 }, ["--datasets", "smb", "--rate-limit-retries", "0"], ({ code, out }) => { assert.equal(code, 1); assert.match(out, /FAIL .*rate_limited/); });
  await withDouble({}, ["--rate-limit-wait-sec", "-1"], ({ code }) => assert.equal(code, 2));
});

test("--dry-run reads the datasets and query banks only: no model call, no report", async () => {
  await withDouble({}, ["--dry-run"], ({ code, out, seen, dir }) => {
    assert.equal(code, 0, out);
    assert.equal(posts(seen, "/crossask").length + posts(seen, "/packask").length + posts(seen, "/analyst/pack-run").length, 0);
    assert.match(out, /5 template run\(s\) planned/); // smb 1 + chiro 1 + dent 3; pers (no folder) is SKIP, not planned
    assert.equal(readdirSync(dir).length, 0);
  });
});

test("usage errors exit 2: non-sample root without --allow-root, bad model, unknown dataset, bad on/off, API down", async () => {
  await withDouble({}, ["--root", "private"], ({ code, out }) => { assert.equal(code, 2); assert.match(out, /--allow-root private/); });
  await withDouble({}, ["--model", "nemotron"], ({ code }) => assert.equal(code, 2));
  await withDouble({}, ["--datasets", "nope"], ({ code, out }) => { assert.equal(code, 2); assert.match(out, /unknown dataset nope/); });
  await withDouble({}, ["--strict-check", "yes"], ({ code }) => assert.equal(code, 2));
  await withDouble({}, ["--bogus"], ({ code }) => assert.equal(code, 2));
  const r = await cli(["--api", "http://127.0.0.1:9", "--report-dir", tmpdir()]);
  assert.equal(r.code, 2); assert.match(r.out, /not answering/);
});

// ---------------------------------------------------------------- --check-answers (answer keys, config/answer-checks.json)
/** A rules file, a datasets config and an answer root with keys for dent SET-2/NEG-ALL and chiro SET-1/POS (none for smb). */
function answerFixture(): { dir: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ui-smoke-keys-"));
  const put = (rel: string, j: unknown) => { const p = join(dir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(j)); };
  put("rules.json", { version: 1, rules: [
    { datasets: ["dent"], item: "leak-summary", key: "truth.json", unit: "dollars", compare: [
      { type: "rowsByKey", keyColumn: "code", valueColumn: "amount", path: "by_code" }, { type: "columnSum", column: "items", path: "counts.items", kind: "count" }] },
    { datasets: ["chiro"], item: "Payers", key: "k.json", unit: "cents", compare: [{ type: "figuresPresent", paths: ["paid.total"] }] },
    { datasets: ["smb"], item: "Cash flow", key: "none.json", unit: "cents", compare: [{ type: "figuresPresent", paths: ["x"] }] }] });
  put("datasets.json", { datasets: [{ id: "dent", folder: "dent" }, { id: "chiro", folder: "chiro" }, { id: "smb", folder: "smb" }] });
  put("root/dent/SET-2/NEG-ALL/_answer-key/truth.json", { by_code: { CASH_SHORT: "12.50", EFT_MISSING: "300.00" }, counts: { items: 3 } });
  put("root/chiro/SET-1/POS/_answer-key/k.json", { paid: { total: 2357210 } });
  return { dir, args: ["--answer-checks", join(dir, "rules.json"), "--datasets-config", join(dir, "datasets.json"), "--answer-root", join(dir, "root")] };
}
const ROWS_OK = [{ code: "EFT_MISSING", items: 1, amount: 300 }, { code: "CASH_SHORT", items: 2, amount: 12.5 }];
const report = (dir: string) => JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("ui-smoke-"))!), "utf8"));

test("--check-answers (default on): results equal to the key are PASS 'answer checked'; no key file is 'not checked'; the report counts them, without rows", async () => {
  const fx = answerFixture();
  try {
    await withDouble({ packRows: { "leak-summary": ROWS_OK }, crossRows: [{ payer: "MARKER-ROW-TEXT", paid: -23572.1 }] }, ["--pack-explained", "off", ...fx.args], ({ code, out, dir }) => {
      assert.equal(code, 0, out);
      assert.match(out, /answers checked/);
      const r = report(dir);
      const by = (item: string) => r.items.find((i: { item: string; id?: string }) => i.item === item || i.id === item);
      assert.equal(by("leak-summary").status, "PASS"); assert.equal(by("leak-summary").check, "ok"); assert.match(by("leak-summary").note, /answer checked against truth\.json/);
      assert.equal(by("Payers").check, "ok", "figuresPresent ignores the sign: -23572.10 in the result is the key's 2357210 cents");
      assert.equal(by("Cash flow").check, "none"); assert.match(by("Cash flow").note, /not checked: no answer key none\.json/);
      assert.deepEqual(r.checks, { ok: 2, mismatch: 0, none: 1 }, "leak-summary and Payers ok; Cash flow has no key file; financing (SKIP) and pers (no templates) are never checked");
      assert.equal(r.checkAnswers, true);
      assert.ok(!JSON.stringify(r).includes("MARKER-ROW-TEXT"), "the report never holds result rows");
    });
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("--check-answers: a figure different from the key is FAIL naming it (exit 1); a missing or extra key row too; off turns checks off", async () => {
  const fx = answerFixture();
  try {
    await withDouble({ packRows: { "leak-summary": [{ code: "EFT_MISSING", items: 1, amount: 300 }, { code: "CASH_SHORT", items: 2, amount: 12.49 }, { code: "NEW", items: 0, amount: 1 }] } },
      ["--pack-explained", "off", ...fx.args], ({ code, out, dir }) => {
        assert.equal(code, 1, out);
        const it = report(dir).items.find((i: { id?: string }) => i.id === "leak-summary");
        assert.equal(it.status, "FAIL"); assert.equal(it.check, "mismatch");
        assert.match(it.note, /code CASH_SHORT: 12\.49, key 12\.50/); assert.match(it.note, /code NEW: in the result, not in key by_code/);
      });
    await withDouble({ packRows: { "leak-summary": ROWS_OK }, crossRows: [{ paid: 1 }] }, ["--pack-explained", "off", ...fx.args], ({ code, dir }) => {
      assert.equal(code, 1);
      assert.match(report(dir).items.find((i: { item: string }) => i.item === "Payers").note, /paid\.total 23572\.10 not found in the result/);
    });
    await withDouble({ packRows: { "leak-summary": [{ code: "X", items: 9, amount: 9 }] } }, ["--pack-explained", "off", "--check-answers", "off", ...fx.args], ({ code, out, dir }) => {
      assert.equal(code, 0, out); assert.match(out, /answers not checked/);
      assert.ok(report(dir).items.every((i: { check?: string }) => i.check === undefined));
    });
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("--check-answers: a bad rules file or check-answers value is a usage error (exit 2); checkAnswer compares one-row cells exactly", async () => {
  const fx = answerFixture();
  try {
    writeFileSync(join(fx.dir, "bad.json"), JSON.stringify({ version: 1, rules: [{ datasets: ["dent"], item: "x", key: "truth.json", unit: "euros", compare: [{ type: "cell", column: "a", path: "b" }] }] }));
    const bad = await cli(["--api", "http://127.0.0.1:9", "--answer-checks", join(fx.dir, "bad.json")]);
    assert.equal(bad.code, 2); assert.match(bad.out, /unit must be dollars or cents/);
    const v = await cli(["--check-answers", "maybe"]); assert.equal(v.code, 2); assert.match(v.out, /--check-answers must be on or off/);
    const { checkAnswer } = await import(new URL("../ui-smoke.ts", import.meta.url).href); // a file:// URL: a bare C:\ path fails on Windows
    assert.deepEqual(checkAnswer({ datasets: ["d"], item: "i", key: "k.json", unit: "dollars", compare: [{ type: "cell", column: "net", path: "n" }] }, { n: "1720.00" }, [{ net: 1720 }]), []);
    assert.deepEqual(checkAnswer({ datasets: ["d"], item: "i", key: "k.json", unit: "dollars", compare: [{ type: "cell", column: "net", path: "n" }] }, { n: "1720.00" }, [{ net: 1720 }, { net: 1 }]), ["net: expected one row, got 2"]);
    // rowsByKey with keyColumns joined by "/" and several values (PI by state/coverage, contracted by payer/cpt)
    const multi = { datasets: ["d"], item: "i", key: "k.json", unit: "dollars", compare: [{ type: "rowsByKey", keyColumns: ["state", "coverage"], values: { open_cases: "count", open_balance: "amount" }, path: "pi" }] };
    const key = { pi: { "MA/PIP": { open_cases: 13, open_balance: "2320.00" }, "CT/MedPay": { open_cases: 15, open_balance: "2330.00" } } };
    assert.deepEqual(checkAnswer(multi, key, [{ state: "CT", coverage: "MedPay", open_cases: 15, open_balance: 2330 }, { state: "MA", coverage: "PIP", open_cases: 13, open_balance: 2320 }]), []);
    assert.deepEqual(checkAnswer(multi, key, [{ state: "MA", coverage: "PIP", open_cases: 12, open_balance: 2320 }, { state: "RI", coverage: "PIP", open_cases: 1, open_balance: 1 }]),
      ["MA/PIP open_cases: 12, key 13", "state/coverage CT/MedPay: in key pi, not in the result", "state/coverage RI/PIP: in the result, not in key pi"]);
    writeFileSync(join(fx.dir, "bad2.json"), JSON.stringify({ version: 1, rules: [{ datasets: ["d"], item: "x", key: "truth.json", unit: "dollars", compare: [{ type: "rowsByKey", keyColumns: ["a"], values: { b: "euro" }, path: "p" }] }] }));
    const bad2 = await cli(["--api", "http://127.0.0.1:9", "--answer-checks", join(fx.dir, "bad2.json")]);
    assert.equal(bad2.code, 2); assert.match(bad2.out, /keyColumns \+ values \{column: amount\|count\}/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

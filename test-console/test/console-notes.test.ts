/**
 * privateAI-design-31: (1) the console's NOTE CONTRACT: checks are shown as calm, labelled curation or honesty notes, never as
 * alarming warnings about results that may well be right; .flag is kept for real errors. (2) the run log of "Ask across
 * files" (test-console/console/run-log.ts): meta keeps no data values, full keeps capped rows, off writes nothing, old files go.
 * Change the contract only together with this test. Reads index.html as text (no browser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog, runRecord } from "../console/run-log.ts";

const page = readFileSync(new URL("../console/index.html", import.meta.url), "utf8");

test("note contract: two labelled kinds, styled calmly; the old alarming wording is gone", () => {
  assert.match(page, /\.note\.curation \{ border-left-color: var\(--ok\); \}/);
  assert.match(page, /\.note\.honesty \{ border-left-color: var\(--amber\); \}/);
  assert.match(page, /const note = \(kind, \.\.\.kids\) =>/);
  assert.ok(page.includes(`kind === "honesty" ? "Honesty note" : "Curation note"`), "notes carry their label");
  for (const gone of ["Do not trust these totals", "Numbers or placeholders not in the result", "Why the model's text was not shown"]) assert.ok(!page.includes(gone), `still says: ${gone}`);
});

test("note contract: the answer check, join warnings and the Explained path use notes, and say what IS exact", () => {
  const fig = page.slice(page.indexOf("function figureNote("), page.indexOf("const runLogLine"));
  assert.match(fig, /note\("curation", `Every number in this answer was checked/);
  assert.match(fig, /note\("honesty"/);
  assert.match(fig, /The result table is computed exactly on this PC\./);
  assert.match(fig, /r\.derivations/);
  assert.match(page, /withPlaceholders\(r\.answer\), \.\.\.figureNote\(r\)/);
  assert.match(page, /for \(const w of r\.warnings \?\? \[\]\) out\.append\(block\(note\("honesty"/);
  assert.match(page, /note\("curation", `\$\{r\.check\.problems\.length\} figure\(s\) in the model's wording did not match the reconciled facts/);
  assert.match(page, /out\.append\(runLogLine\(r\.runLog\)\)/);
});

const IN = { folder: "C:/data/chiro/SET-1/NEG-ALL", question: "care plans?", model: "local/m", phrase: "llm", userSql: false };
const OUT = {
  schema: "careplans_set1_pos(Plan ID, Price)", attempts: [{ sql: "SELECT 1" }], sql: "SELECT 1", result: { columns: ["Plan ID", "Price"], rows: Array.from({ length: 80 }, (_, i) => ({ "Plan ID": `PL${i}`, Price: 480 })), truncated: false },
  answer: "They total $2,880.", unverified: ["$2,880"], derivations: { "$2,880": "the total of Price over 6 rows" }, warnings: [],
  served: [{ text: "```sql\nSELECT 1\n```", model: "local/m", zone: "local" }, { text: "They total $2,880.", model: "local/m" }], sentToModel: [{ step: "answer", chars: 10, hasData: true }],
};

test("run log meta: question, SQL, columns and counts, but no rows, no answer text, no model replies", () => {
  const r = runRecord("id1", new Date("2026-11-05T17:00:00Z"), "meta", 50, IN, OUT) as any;
  assert.equal(r.question, "care plans?"); assert.equal(r.sql, "SELECT 1");
  assert.equal(r.schema, "careplans_set1_pos(Plan ID, Price)", "the schema (headers only) is kept, so a wrong column can be traced");
  assert.deepEqual(r.result, { columns: ["Plan ID", "Price"], rowCount: 80, truncated: false });
  assert.deepEqual(r.answer, { chars: 18, figuresNotFound: 1, derived: 1 });
  assert.deepEqual(r.served, [{ model: "local/m", zone: "local" }, { model: "local/m", zone: null }]);
  assert.ok(!JSON.stringify(r).includes("PL1") && !JSON.stringify(r).includes("2,880"), "no data values in meta");
});

test("run log full: rows capped by --run-log-max-rows, answer with what was not found and its derivation, model replies", () => {
  const r = runRecord("id2", new Date("2026-11-05T17:00:00Z"), "full", 5, IN, OUT) as any;
  assert.equal(r.result.rows.length, 5); assert.equal(r.result.rowCount, 80);
  assert.equal(r.answer.text, "They total $2,880."); assert.deepEqual(r.answer.notFound, ["$2,880"]);
  assert.deepEqual(r.answer.derivations, { "$2,880": "the total of Price over 6 rows" });
  assert.equal(r.served[1].text, "They total $2,880.");
});

test("RunLog: off writes nothing; meta appends one line per run to crossask-<day>.jsonl and returns its id; errors are saved too", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  assert.equal(new RunLog({ mode: "off", dir, maxRows: 50, keepDays: 14 }).write(IN, OUT), null);
  assert.deepEqual(readdirSync(dir), []);
  const now = () => new Date("2026-11-05T17:09:30Z");
  const log = new RunLog({ mode: "meta", dir, maxRows: 50, keepDays: 14 }, now);
  const a = log.write(IN, OUT, undefined, 1234) as any, b = log.write(IN, null, "the analyst is not running") as any;
  assert.equal(a.file, "crossask-2026-11-05.jsonl"); assert.match(a.id, /^2026-11-05T170930-[0-9a-f]{4}$/); assert.equal(a.mode, "meta");
  const lines = readFileSync(join(dir, a.file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); assert.equal(lines[0].id, a.id); assert.equal(lines[0].ms, 1234);
  assert.equal(lines[1].id, b.id); assert.equal(lines[1].error, "the analyst is not running");
});

test("RunLog: files older than keep-days are removed at start; other files in the folder are never touched; bad flags refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  for (const n of ["crossask-2026-10-01.jsonl", "crossask-2026-11-01.jsonl", "notes.txt", "crossask-old.jsonl"]) writeFileSync(join(dir, n), "x\n");
  new RunLog({ mode: "meta", dir, maxRows: 50, keepDays: 14 }, () => new Date("2026-11-05T12:00:00Z"));
  assert.deepEqual(readdirSync(dir).sort(), ["crossask-2026-11-01.jsonl", "crossask-old.jsonl", "notes.txt"]);
  assert.throws(() => new RunLog({ mode: "all" as never, dir, maxRows: 50, keepDays: 14 }), /--run-log must be one of off, meta, full/);
  assert.throws(() => new RunLog({ mode: "meta", dir, maxRows: 50, keepDays: 0 }), /--run-log-keep-days/);
});

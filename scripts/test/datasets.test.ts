/** config/datasets.json (DESIGN/xrplh-29): the datasets tab 03 offers. Names and folders only, never data; folders stay inside their root. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reg = JSON.parse(readFileSync(new URL("../../config/datasets.json", import.meta.url), "utf8"));
const sources = JSON.parse(readFileSync(new URL("../../config/data-sources.example.json", import.meta.url), "utf8"));

test("every dataset has an id, a label, a 1-2 sentence description, a relative folder and a known engine", () => {
  assert.equal(reg.version, 1);
  const ids = new Set<string>();
  for (const d of reg.datasets) {
    assert.match(d.id, /^[a-z0-9][a-z0-9-]*$/); assert.ok(!ids.has(d.id), `duplicate ${d.id}`); ids.add(d.id);
    assert.ok(d.label && d.description, `${d.id}: label and description`);
    const sentences = d.description.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.ok(sentences >= 1 && sentences <= 2, `${d.id}: description should be 1-2 sentences, has ${sentences}`);
    assert.ok(!/^([a-z]:|[\\/])/i.test(d.folder) && !d.folder.split(/[\\/]/).includes(".."), `${d.id}: folder must be relative and stay inside its root`);
    assert.ok(["crossask", "domain-pack"].includes(d.engine), `${d.id}: engine`);
    if (d.engine === "domain-pack") { assert.match(d.pack, /^[a-z0-9-]+(\/[a-z0-9-]+)*$/); assert.deepEqual(d.templates, { from: "pack" }); }
    else assert.ok(Array.isArray(d.templates) && d.templates.every((t: { label: string; q: string }) => t.label && t.q));
  }
});

test("a crossask template's sql, when it has one, is a single SELECT (the analyst runs it as is; no model writes it)", () => {
  for (const d of reg.datasets.filter((x: { engine: string }) => x.engine === "crossask")) {
    for (const t of d.templates as { label: string; sql?: unknown }[]) {
      if (t.sql === undefined) continue;
      assert.equal(typeof t.sql, "string", `${d.id} ${t.label}: sql must be text`);
      const s = (t.sql as string).trim();
      assert.match(s, /^SELECT\b/i, `${d.id} ${t.label}: sql must start with SELECT`);
      assert.ok(!s.includes(";"), `${d.id} ${t.label}: one statement, no ';'`);
    }
  }
});

test("smb-fin-1 (owner 2026-11-07): both templates run an exact query, each with an exact answer check (not figuresPresent)", () => {
  const smb = reg.datasets.find((d: { id: string }) => d.id === "smb-fin-1");
  assert.deepEqual(smb.templates.map((t: { label: string }) => t.label), ["Cash flow vs installment", "Receivables vs payables: need a loan?"]);
  for (const t of smb.templates) assert.ok(typeof t.sql === "string" && t.sql.trim(), `${t.label}: sql`);
  const checks = JSON.parse(readFileSync(new URL("../../config/answer-checks.json", import.meta.url), "utf8"));
  for (const t of smb.templates) {
    const rule = checks.rules.find((r: { datasets: string[]; item: string }) => r.datasets.includes("smb-fin-1") && r.item === t.label);
    assert.ok(rule, `${t.label}: a rule in config/answer-checks.json`);
    assert.ok(rule.compare.every((c: { type: string }) => c.type !== "figuresPresent"), `${t.label}: the exact query's columns are known, so compare them exactly`);
    // every column a rule reads is one the template's SELECT names
    for (const c of rule.compare) for (const col of [c.column, ...(c.keyColumns ?? []), ...Object.keys(c.values ?? {})].filter(Boolean)) {
      assert.match(t.sql, new RegExp(`\\bAS ${col}\\b`), `${t.label}: the sql names column ${col}`);
    }
  }
});

test("tab 03 page: a template with sql fills the query box and hides the query model; a free question brings it back", () => {
  const page = readFileSync(new URL("../../test-console/console/index.html", import.meta.url), "utf8");
  assert.match(page, /id="xaskModelWrap"/);
  assert.match(page, /id="xaskExact" hidden/);
  assert.match(page, /xExact\(t\.sql \?\? ""\)/, "the template button passes its sql");
  assert.match(page, /\$\("xaskModelWrap"\)\.hidden = Boolean\(ds\.exactSql\)/);
  assert.match(page, /if \(ds\.exactSql\) \{ xExact\(""\)/, "editing the question undoes the exact query");
  assert.match(page, /<select id="xaskAnswerModel">/, "Words the answer stays");
  // like a pack's first question, the first template starts picked (its exact query, not the page's built-in text)
  assert.match(page, /xExact\(d\.templates\[0\]\.sql \?\? ""\)/, "the first template is picked when the dataset opens");
  // tidy results (owner 2026-11-07): a one-row result is a label/value list; long query text and proof values wrap
  assert.match(page, /if \(rows\.length === 1 && columns\.length > 3\)/);
  assert.match(page, /className: "kv result-kv"/);
  assert.match(page, /#xaskOut pre \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/);
  assert.match(page, /#xattest td \{ overflow-wrap: anywhere;/);
});

test("the two roots: samples inside the repository (git-ignored), private outside it; both are allowed data roots", () => {
  assert.equal(reg.roots.samples, "sample-data");
  assert.match(reg.roots.private, /^[A-Za-z]:\\/);
  for (const r of Object.values(reg.roots)) assert.ok(sources.allowedRoots.includes(r), `${r} is not in data-sources allowedRoots`);
  assert.equal(sources.allowedRoots[0], "sample-data");
});

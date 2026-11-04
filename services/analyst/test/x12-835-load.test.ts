/**
 * privateAI-design-30 §6.3: the remit/x12-835 source adapter loads an 835 into DuckDB (claim table + 4 side tables).
 * Needs the DuckDB native build of this machine (runs on the owner's PC; the Linux sandbox has only the Windows build).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceRegistry } from "../src/core/registry.ts";
import { openDb, rows } from "../src/db.ts";
import { firstLines } from "../src/sources/lines.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { X12_835 } from "../src/sources/remit/x12-835.ts";
import { chiroEra } from "./era-fixture.ts";

test("an 835 file is detected by exactly one built-in adapter (remit/x12-835), and the dental layouts do not claim it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "era-")); const f = join(dir, "ERA-SET1-POS.835"); writeFileSync(f, chiroEra({ newline: true }));
  try {
    const r = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) r.register(a);
    assert.deepEqual(r.detect(await firstLines(f)).map((a) => a.id), ["remit/x12-835"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("load: claims table + payments, lines, adjustments and plb side tables, typed, every check ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "era-")); const f = join(dir, "e.835"); writeFileSync(f, chiroEra());
  const db = await openDb();
  try {
    const l = await X12_835.load(db, "era", f, { patientNameFormat: "last_first" });
    assert.equal(l.rows, 5); assert.deepEqual(l.checks.filter((c) => !c.ok), []);
    assert.deepEqual(l.meta.tables, { claims: "era", payments: "era__payments", lines: "era__lines", adjustments: "era__adjustments", plb: "era__plb" });
    const [p] = await rows<{ n: number; total: number; d: string }>(db, `SELECT CAST(count(*) AS INTEGER) n, CAST(sum(paid_cents) AS INTEGER) total, CAST(min(payment_date) AS VARCHAR) d FROM era__payments`);
    assert.deepEqual(p, { n: 2, total: 9870, d: "2026-09-15" });
    const byGroup = await rows<{ g: string; c: number }>(db, `SELECT "group" || '-' || carc g, CAST(sum(cents) AS INTEGER) c FROM era__adjustments GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(byGroup, [{ g: "CO-253", c: 150 }, { g: "CO-45", c: 3400 }, { g: "CO-97", c: 4500 }, { g: "PR-119", c: 6000 }, { g: "PR-2", c: 30 }, { g: "PR-3", c: 2000 }]);
    const [mcr] = await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM era__lines l JOIN era c USING (claim_seq) WHERE c.filing_indicator = 'MB' AND l.code IN ('98940','98941','98942') AND coalesce(l.modifiers, '') NOT LIKE '%AT%'`);
    assert.equal(mcr.n, 0, "both Medicare CMT lines in the fixture carry AT");
    const [plb] = await rows<{ c: number }>(db, `SELECT CAST(sum(cents) AS INTEGER) c FROM era__plb`);
    assert.equal(plb.c, -250);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

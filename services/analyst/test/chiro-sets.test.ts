/**
 * privateAI-design-30 §11 (CHIRO-1b): the generated chiro sets (tools/chiro-synth, git-ignored) through the existing DuckDB
 * adapters. CHIRO_DATA_ROOT, default <repo>/sample-data/prms; sets at chiro-1-chirotouch/SET-1/POS and chiro-2-jane/SET-1/POS.
 * Skipped, with the reason, when a set is not on this machine (run tools/chiro-synth/gen_chiro_set.py first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceRegistry } from "../src/core/registry.ts";
import { openDb, rows } from "../src/db.ts";
import { firstLines } from "../src/sources/lines.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const env = process.env.CHIRO_DATA_ROOT?.trim();
const ROOT = env ? (isAbsolute(env) ? env : resolve(REPO, env)) : join(REPO, "sample-data", "prms");
const SETS = [["chirotouch", join(ROOT, "chiro-1-chirotouch", "SET-1", "POS")], ["jane", join(ROOT, "chiro-2-jane", "SET-1", "POS")]] as const;
const registry = () => { const r = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) r.register(a); return r; };

for (const [prms, dir] of SETS) {
  const skip = existsSync(dir) ? false : `chiro set not found at ${dir} (python tools/chiro-synth/gen_chiro_set.py --prms ${prms} --out <that folder>)`;

  test(`${prms} SET-1/POS: BANK-ST is bank/bofa, ERA is remit/x12-835, and no PRMS file is claimed by a dental or financing layout`, { skip }, async () => {
    const r = registry();
    const got = Object.fromEntries(await Promise.all(readdirSync(dir).filter((n) => /\.(csv|835)$/.test(n)).map(async (n) => [n, r.detect(await firstLines(join(dir, n))).map((a) => a.id)])));
    for (const [n, ids] of Object.entries(got)) {
      if (n.startsWith("BANK-ST-")) assert.deepEqual(ids, ["bank/bofa"], n);
      else if (n.startsWith("ERA-")) assert.deepEqual(ids, ["remit/x12-835"], n);
      else assert.deepEqual(ids, [], `${n} must not be claimed by an existing layout`);
    }
  });

  test(`${prms} SET-1/POS: bank and ERA load with every check ok, and every insurance EFT joins one 835 payment by TRN trace and amount`, { skip }, async () => {
    const r = registry();
    const bank = readdirSync(dir).find((n) => n.startsWith("BANK-ST-"))!, era = readdirSync(dir).find((n) => n.startsWith("ERA-"))!;
    const db = await openDb();
    try {
      const b = await r.get("bank/bofa").load(db, "bank", join(dir, bank), { patientNameFormat: "last_first" });
      const e = await r.get("remit/x12-835").load(db, "era", join(dir, era), { patientNameFormat: "last_first" });
      assert.deepEqual(b.checks.filter((c) => !c.ok), [], "bank checks");
      assert.deepEqual(e.checks.filter((c) => !c.ok), [], "ERA checks");
      const [j] = await rows<{ efts: number; joined: number; payments: number }>(db, `SELECT
        CAST((SELECT count(*) FROM bank WHERE des = 'HCCLAIMPMT') AS INTEGER) efts,
        CAST((SELECT count(*) FROM bank b JOIN era__payments p ON p.trace = b.trace AND p.paid_cents = b.cents WHERE b.des = 'HCCLAIMPMT') AS INTEGER) joined,
        CAST((SELECT count(*) FROM era__payments) AS INTEGER) payments`);
      assert.ok(j.efts > 0, "the set has insurance EFTs");
      assert.deepEqual(j, { efts: j.payments, joined: j.payments, payments: j.payments });
      const [mcr] = await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM era__lines l JOIN era c USING (claim_seq)
        WHERE c.filing_indicator = 'MB' AND l.code IN ('98940','98941','98942') AND coalesce(l.modifiers, '') NOT LIKE '%AT%'`);
      assert.equal(mcr.n, 0, "POS: every Medicare CMT line carries AT");
    } finally { db.close(); }
  });
}

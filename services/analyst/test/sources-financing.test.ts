/**
 * Phase 4a.2 (DESIGN/xrplh-25 §13), Phase 4c (xrplh-26): the financing adapters (CareCredit, Cherry, HFD). Headers are the
 * owner's GLOBAL-*-sample-fin-csv.csv signatures; every data row below is SYNTHETIC, invented by this test (no real patient,
 * amount or date). Rules are the shipped financing.json (partly verified from the owner's rows) or a synthetic copy of it
 * marked verified to exercise the happy path. The owner's files themselves are tested when present (DENTAL_DATA_ROOT).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceAdapter, SourceOptions } from "../src/core/ports.ts";
import { PackRegistry, SourceRegistry } from "../src/core/registry.ts";
import { readSourceConfigs } from "../src/core/source-configs.ts";
import { openDb, rows } from "../src/db.ts";
import { BUILT_IN_PACKS } from "../src/domain-packs/index.ts";
import { firstLines } from "../src/sources/lines.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { CARECREDIT } from "../src/sources/financing/carecredit.ts";
import { CHERRY } from "../src/sources/financing/cherry.ts";
import { HFD } from "../src/sources/financing/hfd.ts";
import { CARECREDIT_LAYOUT, CHERRY_LAYOUT, HFD_LAYOUT } from "../src/sources/financing/layouts.ts";
import { FINANCING_COLUMNS } from "../src/sources/financing/spec.ts";
import { SAMPLES } from "./data-root.ts";

const CONFIG_ROOT = fileURLToPath(new URL("../../../config", import.meta.url));
const packs = new PackRegistry(); for (const p of BUILT_IN_PACKS) packs.register(p);
const SHIPPED = readSourceConfigs(packs.resolve("finance/rcm/dental"), CONFIG_ROOT);
const dir = mkdtempSync(join(tmpdir(), "fin-")); after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, lines: string[], bom = true) => { const p = join(dir, name); writeFileSync(p, (bom ? "\uFEFF" : "") + lines.join("\r\n") + "\r\n"); return p; };
const hdr = (h: readonly string[], extra = "") => h.join(",") + extra;

/** A copy of the shipped config with every item marked verified (SYNTHETIC: only to exercise the happy path) and edits applied. */
function synthetic(edit: (p: any) => void = () => {}): SourceOptions {
  const c = JSON.parse(JSON.stringify(SHIPPED.financing));
  for (const p of Object.values(c.providers) as any[]) for (const it of Object.values(p) as any[]) it.verified = true;
  c.providers.carecredit.kind.value.map = { "SYN-SALE": "sale", "SYN-RETURN": "refund" };
  c.providers.hfd.kind.value.map = { "SYN-PLAN": "sale" };
  edit(c.providers);
  return { patientNameFormat: "last_first", configs: { financing: c } };
}
const shipped: SourceOptions = { patientNameFormat: "last_first", configs: SHIPPED };

async function load(a: SourceAdapter, path: string, opt: SourceOptions) {
  const db = await openDb();
  try {
    const l = await a.load(db, "t", path, opt);
    const cols = (await rows<{ column_name: string }>(db, `SELECT column_name FROM (DESCRIBE t)`)).map((c) => c.column_name);
    const tables = (await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM duckdb_tables()`))[0].n;
    // DuckDB JSON rows give BIGINT as text: numbers for row and *_cents, text for dates and the rest, null kept
    const data = (await rows<Record<string, unknown>>(db, `SELECT * FROM t ORDER BY "row"`)).map((d) =>
      Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === null ? null : /^row$|_cents$/.test(k) ? Number(v) : String(v)])));
    return { l, cols, tables, data };
  } finally { db.close(); }
}
const failed = (l: { checks: { name: string; ok: boolean }[] }) => l.checks.filter((c) => !c.ok).map((c) => c.name);

// SYNTHETIC rows (names, phones and digits are made up and must never appear in the table)
const CC_ROWS = ["M-SYN-1,01/15/2025 2:24 PM ET,SYNTHNAME ALPHA,\"$1,234.50 \",PROMO-SYN,SYN-SALE,,,,,,,,,,,", "M-SYN-1,01/20/2025 9:05 AM ET,SYNTHNAME BETA,($100.00),,SYN-RETURN,,,,,,,,,,,"];
const CH_ROWS = ["1/10/2025,REF-SYN-1,REF2-SYN-1,555-000-0001,SYNTHNAME GAMMA,1000.00,0.00,50.00,950.00", "1/11/2025,REF-SYN-2,REF2-SYN-2,555-000-0002,SYNTHNAME DELTA,500.00,100.00,20.00,380.00"];
const HFD_ROW = (amount = "2850.00") => `1/05/2025,HFD-SYN-1,SYNTHNAME EPSILON,1/09/2025,9991,3000.00,A,PID-SYN-1,SYN-PLAN,5%,150.00,${amount},3000.00,SYN PRACTICE,9992,8881,0.00`;

test("layout detection: each GLOBAL header picks exactly one adapter among all 9; unrelated headers pick none", async () => {
  const r = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) r.register(a);
  assert.deepEqual(r.list(), ["bank/bofa", "financing/carecredit", "financing/cherry", "financing/hfd", "prms/curve-hero/deposit-detail",
    "prms/curve-hero/ledger", "prms/curve-hero/patient-list", "prms/curve-hero/procedures", "remit/x12-835"]);
  const cases: [string, string][] = [[hdr(CARECREDIT_LAYOUT.headers, ",,,,,,,,,,,"), "financing/carecredit"], [hdr(CARECREDIT_LAYOUT.headers), "financing/carecredit"],
    [hdr(CHERRY_LAYOUT.headers), "financing/cherry"], [hdr(HFD_LAYOUT.headers), "financing/hfd"]];
  for (const [h, id] of cases) assert.deepEqual(r.detect(await firstLines(file("d.csv", [h]))).map((a) => a.id), [id], h);
  for (const h of ["Date,Name,Amount", hdr(CHERRY_LAYOUT.headers.slice(0, 8)), hdr(CARECREDIT_LAYOUT.headers, ",,X"), hdr(HFD_LAYOUT.headers, ",Extra")])
    assert.deepEqual(r.detect(await firstLines(file("u.csv", [h]))).map((a) => a.id), [], h);
});

test("the owner's GLOBAL-*-sample-fin-csv.csv files (when present): one adapter each, every row loads with the shipped rules, only the still-unverified items fail, no name/phone/bank digits loaded", { skip: !existsSync(join(SAMPLES, "GLOBAL-HFD-sample-fin-csv.csv")) }, async () => {
  const r = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) r.register(a);
  const cases: [string, string, number, string[]][] = [
    ["GLOBAL-CareCredit-sample-fin-csv.csv", "financing/carecredit", 3, ["amountFormat", "columns", "expectSign", "identities"]],
    ["GLOBAL-Cherry-sample-fin-csv.csv", "financing/cherry", 3, ["columns", "kind", "expectSign"]],
    ["GLOBAL-HFD-sample-fin-csv.csv", "financing/hfd", 6, ["columns"]]];
  for (const [n, id, count, unverified] of cases) {
    const p = join(SAMPLES, n);
    assert.deepEqual(r.detect(await firstLines(p)).map((a) => a.id), [id], n);
    const { l, data } = await load(r.get(id), p, shipped);
    assert.equal(l.rows, count, n);
    assert.deepEqual(failed(l), ["rules verified against real-format rows"], n);
    assert.deepEqual(l.meta.unverified, unverified, n);
    assert.ok(data.every((d) => d.date !== null && d.bank_cents !== null && d.kind !== null), n);
    assert.ok(!/PT\d+_(FM|LM)|\(\d{3}\)|••/.test(JSON.stringify(data)), `${n}: names, phones and masked card digits are never loaded`);
  }
});

test("synthetic happy path: canonical columns only, amounts in cents, kinds mapped, no name/phone/bank digits in the table, no staging table left", async () => {
  const cc = await load(CARECREDIT, file("cc.csv", [hdr(CARECREDIT_LAYOUT.headers, ",,,,,,,,,,,"), ...CC_ROWS]), synthetic());
  assert.deepEqual(failed(cc.l), []); assert.deepEqual(cc.cols, [...FINANCING_COLUMNS]); assert.equal(cc.tables, 1);
  assert.deepEqual(cc.data.map((d) => [d.row, d.date, d.bank_cents, d.gross_cents, d.kind]), [[2, "2025-01-15", 123450, 123450, "sale"], [3, "2025-01-20", -10000, -10000, "refund"]]);
  const ch = await load(CHERRY, file("ch.csv", [hdr(CHERRY_LAYOUT.headers), ...CH_ROWS]), synthetic());
  assert.deepEqual(failed(ch.l), []);
  assert.deepEqual(ch.data.map((d) => [d.ref, d.gross_cents, d.fee_cents, d.bank_cents, d.kind]), [["REF-SYN-1", 100000, 5000, 95000, "sale"], ["REF-SYN-2", 50000, 2000, 38000, "sale"]]);
  const hf = await load(HFD, file("hfd.csv", [hdr(HFD_LAYOUT.headers), HFD_ROW()]), synthetic());
  assert.deepEqual(failed(hf.l), []);
  assert.deepEqual(hf.data.map((d) => [d.date, d.funding_date, d.ref, d.patient_ref, d.gross_cents, d.fee_cents, d.bank_cents]), [["2025-01-05", "2025-01-09", "HFD-SYN-1", "PID-SYN-1", 300000, 15000, 285000]]);
  const all = JSON.stringify([cc.data, ch.data, hf.data]);
  for (const secret of ["SYNTHNAME", "555-000", "9991", "9992", "8881", "SYN PRACTICE", "M-SYN-1", "PROMO-SYN"]) assert.ok(!all.includes(secret), secret);
});

test("shipped config: a CareCredit Type other than Purchase fails its check, and the unverified items are flagged", async () => {
  const { l, data } = await load(CARECREDIT, file("cc2.csv", [hdr(CARECREDIT_LAYOUT.headers), ...CC_ROWS.map((r) => r.replace(/,+$/, ""))]), shipped);
  assert.ok(failed(l).includes("every Type is mapped to a kind")); assert.match(l.checks.find((c) => c.name === "every Type is mapped to a kind")!.detail, /2 row\(s\) unmapped/);
  assert.ok(failed(l).includes("rules verified against real-format rows")); assert.deepEqual(data.map((d) => d.kind), [null, null]);
  assert.deepEqual(l.meta.unverified, ["amountFormat", "columns", "expectSign", "identities"]);
});

test("dates: ambiguous across the accepted formats, unparseable, or outside the year range each fail; never guessed", async () => {
  const opt = synthetic((p) => { p.cherry.dateFormats.value = ["%m/%d/%Y", "%d/%m/%Y"]; });
  const row = (d: string) => `${d},REF-SYN,REF2-SYN,555-000-0003,SYNTHNAME ZETA,100.00,0.00,0.00,100.00`;
  const amb = await load(CHERRY, file("a.csv", [hdr(CHERRY_LAYOUT.headers), row("03/04/2025")]), opt);
  assert.ok(failed(amb.l).includes("every row has one date in the accepted formats")); assert.match(amb.l.checks[2].detail, /1 ambiguous/); assert.equal(amb.data[0].date, null);
  const one = await load(CHERRY, file("b.csv", [hdr(CHERRY_LAYOUT.headers), row("13/04/2025"), row("04/04/2025")]), opt);
  assert.deepEqual(failed(one.l), []); assert.deepEqual(one.data.map((d) => d.date), ["2025-04-13", "2025-04-04"]);
  const unp = await load(CHERRY, file("c.csv", [hdr(CHERRY_LAYOUT.headers), row("2025.04.03")]), synthetic());
  assert.match(unp.l.checks[2].detail, /1 unparseable/);
  const short = await load(CHERRY, file("d.csv", [hdr(CHERRY_LAYOUT.headers), row("4/3/25")]), synthetic());
  assert.ok(failed(short.l).some((n) => /date/.test(n)), "a 2-digit year must not pass silently");
});

test("identities and signs: a broken Cherry or HFD identity, a missing term, a positive refund, an unparseable amount each fail", async () => {
  const ch = await load(CHERRY, file("e.csv", [hdr(CHERRY_LAYOUT.headers), CH_ROWS[0].replace(/950\.00$/, "949.00"), "1/12/2025,REF-SYN-3,REF2-SYN-3,555-000-0004,SYNTHNAME ETA,10.00,,1.00,9.00"]), synthetic());
  assert.ok(failed(ch.l).includes("identity: Net Sale = Gross Sales - Refunds - Fees"));
  assert.match(ch.l.checks.find((c) => c.name.startsWith("identity"))!.detail, /^1 row\(s\) off .* 1 row\(s\) with a missing term$/);
  const hf = await load(HFD, file("f.csv", [hdr(HFD_LAYOUT.headers), HFD_ROW("2849.99")]), synthetic());
  assert.ok(failed(hf.l).includes("identity: Treatment Amount - Discount = Amount"));
  const sg = await load(CARECREDIT, file("g.csv", [hdr(CARECREDIT_LAYOUT.headers), "M-SYN-1,01/20/2025 1:00 PM ET,SYNTHNAME THETA,100.00,,SYN-RETURN"]), synthetic());
  assert.deepEqual(failed(sg.l), ["refund amounts are negative"]);
  const am = await load(CARECREDIT, file("h.csv", [hdr(CARECREDIT_LAYOUT.headers), "M-SYN-1,01/20/2025 1:00 PM ET,SYNTHNAME IOTA,12.345,,SYN-SALE", "M-SYN-1,01/21/2025 1:00 PM ET,SYNTHNAME KAPPA,10.00-,,SYN-SALE"]), synthetic());
  assert.ok(failed(am.l).includes("amounts parse")); assert.deepEqual(am.data.map((d) => d.bank_cents), [null, -1000]);
});

test("config plumbing: the dental pack names financing.json; an adapter without it refuses to load; describe shows sourceConfigs", async () => {
  assert.deepEqual(packs.resolve("finance/rcm/dental").sourceConfigs, { financing: "domain-packs/finance/rcm/dental/financing.json" });
  assert.equal(packs.resolve("finance/rcm/dental").from.sourceConfigs, "finance/rcm/dental");
  assert.equal(packs.resolve("finance/rcm").sourceConfigs, undefined);
  assert.deepEqual((packs.describe("finance/rcm/dental") as { sourceConfigs: unknown }).sourceConfigs, { financing: "domain-packs/finance/rcm/dental/financing.json" });
  await assert.rejects(load(CHERRY, file("i.csv", [hdr(CHERRY_LAYOUT.headers), CH_ROWS[0]]), { patientNameFormat: "last_first" }), /sourceConfigs\.financing/);
  assert.throws(() => readSourceConfigs({ id: "x", sourceConfigs: { f: "../package.json" } }, CONFIG_ROOT), /outside the config root/);
});

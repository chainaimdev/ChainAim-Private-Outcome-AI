/** privateAI-design-30 §6.3: the ASC X12N 835 parser (pure, no DuckDB). Fixture and its arithmetic: test/era-fixture.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { X12Error, delimiters, isEra835, parse835, tableRows, toCents, toDate } from "../src/sources/remit/x12-835-parse.ts";
import { chiroEra } from "./era-fixture.ts";

test("delimiters come from the fixed-width ISA, whatever they are", () => {
  assert.deepEqual(delimiters(chiroEra()), { element: "*", component: ":", repetition: "^", segment: "~" });
  assert.deepEqual(delimiters(chiroEra({ el: "|", comp: ">", seg: "\n", rep: "{" })), { element: "|", component: ">", repetition: "{", segment: "\n" });
  assert.equal(chiroEra().indexOf("GS*"), 106);
  assert.throws(() => delimiters("Date,Description,Amount"), X12Error);
  assert.throws(() => delimiters("ISA*00*short~"), /106-character ISA/);
});

test("amounts become exact integer cents and dates ISO; anything else is an error, not a guess", () => {
  assert.equal(toCents("150"), 15000); assert.equal(toCents("19.16"), 1916); assert.equal(toCents(".5"), 50); assert.equal(toCents("-2.50"), -250);
  assert.equal(toCents("0.07"), 7); assert.equal(toCents(""), null); assert.equal(toCents("-0"), 0);
  for (const bad of ["1.234", "1,000.00", "abc", "-", "."]) assert.throws(() => toCents(bad), X12Error, bad);
  assert.equal(toDate("20260915"), "2026-09-15"); assert.equal(toDate(""), null);
  assert.throws(() => toDate("20260231"), /not a real date/); assert.throws(() => toDate("09/15/2026"), /CCYYMMDD/);
});

test("payments: BPR, TRN (the EFT/check trace that matches the bank), payer and payee, one per ST", () => {
  const r = parse835(chiroEra());
  assert.equal(r.version, "005010X221A1"); assert.equal(r.isaControl, "000000101");
  assert.deepEqual(r.payments.map((p) => [p.st_control, p.trace, p.method, p.paid_cents, p.payment_date, p.payer_name, p.payee_id]), [
    ["0001", "EFT0001", "ACH", 9750, "2026-09-15", "ACME HEALTH PLAN", "1234567893"],
    ["0002", "CHK55501", "CHK", 120, "2026-09-18", "MEDICARE PART B", "1234567893"]]);
  assert.equal(r.payments[0].production_date, "2026-09-12"); assert.equal(r.payments[0].trace_originator, "1234567890");
});

test("claims, service lines (code, modifiers, units, allowed, remarks, line control) and dates", () => {
  const r = parse835(chiroEra());
  assert.deepEqual(r.claims.map((c) => [c.patient_control_no, c.status, c.charge_cents, c.paid_cents, c.patient_resp_cents, c.filing_indicator, c.payer_claim_no, c.trace]), [
    ["V1001", "1", 15000, 9500, 2000, "CI", "PCN-A1", "EFT0001"], ["V1002", "1", 4500, 0, 0, "CI", "PCN-B1", "EFT0001"],
    ["V1003", "1", 6000, 0, 6000, "CI", "PCN-C1", "EFT0001"], ["V2001", "1", 5200, 4120, 1030, "MB", "MCR-D1", "CHK55501"],
    ["V2000", "22", -5000, -4000, -1000, "MB", "MCR-E0", "CHK55501"]]);
  assert.equal(r.claims[0].period_start, "2026-09-01");
  const l = r.lines;
  assert.equal(l.length, 6);
  assert.deepEqual([l[0].code, l[0].modifiers, l[0].allowed_cents, l[0].line_control_no, l[0].service_date, l[0].units], ["98941", ["AT"], 9000, "L1", "2026-09-01", "1"]);
  assert.deepEqual([l[1].code, l[1].modifiers, l[1].remarks], ["97140", [], ["N130"]]);
  assert.deepEqual([l[2].code, l[2].modifiers, l[2].paid_cents], ["97140", ["59"], 0]);
});

test("CAS: every reason/amount triplet, claim vs line level, group codes as sent", () => {
  const r = parse835(chiroEra());
  assert.deepEqual(r.adjustments.map((a) => `${a.claim_seq}.${a.line_seq ?? "-"} ${a.group}-${a.carc} ${a.cents}`), [
    "1.1 CO-45 850", "1.1 CO-253 150", "1.1 PR-3 2000", "1.2 CO-45 2500", "2.1 CO-97 4500", "3.1 PR-119 6000", "4.1 CO-45 50", "4.1 PR-2 1030", "5.1 PR-2 -1000"]);
  assert.ok(r.adjustments.every((a) => a.level === "line"));
  const claimLevel = parse835(chiroEra({}, (s) => s.map((x) => (x === "CLP*V1002*1*45*0*0*CI*PCN-B1" ? `${x}~CAS*OA*23*0` : x))));
  assert.deepEqual(claimLevel.adjustments.filter((a) => a.level === "claim").map((a) => [a.claim_seq, a.group, a.carc]), [[2, "OA", "23"]]);
});

test("PLB: provider-level adjustments, reason and reference split", () => {
  const r = parse835(chiroEra());
  assert.deepEqual(r.plb, [{ st_control: "0001", trace: "EFT0001", provider_id: "1234567893", fiscal_date: "2026-12-31", reason: "L6", reference: "INT1", cents: -250 }]);
});

test("a balanced file passes every check, with any delimiters and with line breaks after segments", () => {
  for (const o of [{}, { el: "|", comp: ">", seg: "~", newline: true }, { seg: "\n" }]) {
    const r = parse835(chiroEra(o));
    assert.deepEqual(r.checks.filter((c) => !c.ok), [], JSON.stringify(o));
    assert.equal(r.claims.length, 5);
  }
});

test("unbalanced figures, a wrong SE count and a bad amount are reported with the claim and both figures", () => {
  const line = parse835(chiroEra({}, (s) => s.map((x) => x.replace("SVC*HC:97140*50.00*25.00", "SVC*HC:97140*50.00*26.00"))));
  const fail = (r: ReturnType<typeof parse835>) => Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
  assert.match(fail(line)["service lines balance: SVC02 - line CAS = SVC03"], /claim #1 line 2: 50\.00 - 25\.00 vs 26\.00/);
  const bpr = fail(parse835(chiroEra({}, (s) => s.map((x) => x.replace("BPR*I*97.50", "BPR*I*95.00")))));
  assert.match(bpr["payment balances: BPR02 = sum(CLP04) - sum(PLB) (TR3 rule, unverified source)"], /ST 0001: BPR02 95\.00/);
  const pr = fail(parse835(chiroEra({}, (s) => s.map((x) => x.replace("CLP*V1003*1*60*0*60", "CLP*V1003*1*60*0*0")))));
  assert.match(pr["patient responsibility: PR adjustments = CLP05 (payer practice, not a TR3 rule)"], /claim V1003 \(#3\): PR 60\.00 vs CLP05 0\.00/);
  const se = fail(parse835(chiroEra({}, (s) => s.map((x) => (x.startsWith("SE*") && x.endsWith("*0002") ? "SE*99*0002" : x)))));
  assert.match(se["ST 0002: SE01 segment count"], /SE01 99 vs 16 counted/);
  const bad = parse835(chiroEra({}, (s) => s.map((x) => x.replace("AMT*B6*90", "AMT*B6*9O"))));
  assert.match(bad.problems[0], /segment \d+ \(AMT\): not an amount/);
  assert.equal(bad.checks.find((c) => c.name.startsWith("every segment parsed"))!.ok, false);
});

test("a non-835 transaction set or a CAS with an unknown group is refused as a problem", () => {
  const r = parse835(chiroEra({}, (s) => s.map((x) => x.replace("CAS*CO*97*45", "CAS*XX*97*45"))));
  assert.match(r.problems.join(" "), /CAS01 group code "XX"/);
  const t = parse835(chiroEra({}, (s) => s.map((x) => x.replace("ST*835*0002", "ST*837*0002"))));
  assert.match(t.problems.join(" "), /transaction set 837 is not 835/);
});

test("names in NM1 are never kept; table rows carry only canonical columns", () => {
  const r = parse835(chiroEra());
  assert.equal(JSON.stringify(r).includes("DOE"), false);
  assert.equal(JSON.stringify(r).includes("JANE"), false);
  const rows = tableRows(r, "lines");
  assert.deepEqual(rows[0].slice(2, 6), ["HC", "98941", "AT", 10000]);
  assert.equal(rows[1][4], null, "no modifiers -> empty cell");
});

test("isEra835 (the remit/x12-835 adapter's detect) recognises an 835 from its first lines, and nothing else", () => {
  const first = (t: string) => t.split(/\r?\n/).slice(0, 12);
  assert.equal(isEra835(first(chiroEra())), true);
  assert.equal(isEra835(first(chiroEra({ newline: true }))), true);
  assert.equal(isEra835(first(chiroEra({ seg: "\n" }))), true);
  assert.equal(isEra835(first(chiroEra({}, (s) => s.map((x) => x.replace(/^ST\*835/, "ST*837"))))), false);
  assert.equal(isEra835(["Date,Description,Amount,Running Bal."]), false);
  assert.equal(isEra835(["Description,,Summary Amt.", "Beginning balance as of 07/01/2026,,1.00"]), false);
});

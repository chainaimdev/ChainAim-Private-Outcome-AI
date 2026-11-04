/**
 * Test fixture for the 835 parser (privateAI-design-30 §6.3): a synthetic chiro ERA, built in code so the fixed-width ISA is
 * always exactly 106 characters and any delimiters can be used. Two payments:
 *  ST 0001 commercial EFT (trace EFT0001): V1001 98941-AT + 97140 paid with CO-45 (two triplets) and PR-3 copay, LQ N130,
 *          V1002 97140-59 denied CO-97 (bundled), V1003 98940 PR-119 (visit cap); PLB L6 interest -2.50 => BPR02 97.50.
 *  ST 0002 Medicare check (trace CHK55501): V2001 98940-AT paid with CO-45 + PR-2, V2000 reversal (CLP02 22, negative amounts)
 *          => BPR02 1.20.
 * NM1*QC carries a fake name (DOE JANE) only to prove names are never kept. No real person, payer ID or account.
 */
export type Delims = { el?: string; comp?: string; seg?: string; rep?: string; newline?: boolean };

const pad = (s: string, n: number) => s.padEnd(n, " ").slice(0, n);
export function isa(d: Required<Omit<Delims, "newline">>, control = "000000101"): string {
  const f = ["00", pad("", 10), "00", pad("", 10), "ZZ", pad("SAMPLEPAYER", 15), "ZZ", pad("SAMPLECHIRO", 15), "260918", "1200", d.rep, "00501", control, "0", "T", d.comp];
  return `ISA${d.el}${f.join(d.el)}${d.seg}`;
}

export function chiroEra(o: Delims = {}, tweak: (segs: string[]) => string[] = (s) => s): string {
  const d = { el: o.el ?? "*", comp: o.comp ?? ":", seg: o.seg ?? "~", rep: o.rep ?? "^" };
  const S = (...f: string[]) => f.join(d.el);
  const c = (...f: string[]) => f.join(d.comp);
  const st1 = [
    S("ST", "835", "0001"),
    S("BPR", "I", "97.50", "C", "ACH", "CCP", "01", "999999999", "DA", "123456", "1234567890", "", "01", "888888888", "DA", "98765", "20260915"),
    S("TRN", "1", "EFT0001", "1234567890"), S("DTM", "405", "20260912"),
    S("N1", "PR", "ACME HEALTH PLAN", "XV", "60054"), S("N1", "PE", "SAMPLE CHIRO", "XX", "1234567893"), S("LX", "1"),
    S("CLP", "V1001", "1", "150", "95", "20", "CI", "PCN-A1"), S("NM1", "QC", "1", "DOE", "JANE", "", "", "", "MI", "X1"), S("DTM", "232", "20260901"),
    S("SVC", c("HC", "98941", "AT"), "100", "70", "", "1"), S("DTM", "472", "20260901"), S("CAS", "CO", "45", "8.50", "", "253", "1.50"), S("CAS", "PR", "3", "20"),
    S("REF", "6R", "L1"), S("AMT", "B6", "90"),
    S("SVC", c("HC", "97140"), "50.00", "25.00", "", "1"), S("DTM", "472", "20260901"), S("CAS", "CO", "45", "25"), S("LQ", "HE", "N130"),
    S("CLP", "V1002", "1", "45", "0", "0", "CI", "PCN-B1"), S("SVC", c("HC", "97140", "59"), "45", "0", "", "1"), S("DTM", "472", "20260903"), S("CAS", "CO", "97", "45"),
    S("CLP", "V1003", "1", "60", "0", "60", "CI", "PCN-C1"), S("SVC", c("HC", "98940"), "60", "0", "", "1"), S("DTM", "472", "20260905"), S("CAS", "PR", "119", "60"),
    S("PLB", "1234567893", "20261231", c("L6", "INT1"), "-2.50"),
  ];
  const st2 = [
    S("ST", "835", "0002"),
    S("BPR", "I", "1.20", "C", "CHK", "", "", "", "", "", "", "", "", "", "", "", "20260918"),
    S("TRN", "1", "CHK55501", "1999999999"),
    S("N1", "PR", "MEDICARE PART B", "XV", "00000"), S("N1", "PE", "SAMPLE CHIRO", "XX", "1234567893"), S("LX", "1"),
    S("CLP", "V2001", "1", "52", "41.20", "10.30", "MB", "MCR-D1"), S("SVC", c("HC", "98940", "AT"), "52", "41.20", "", "1"), S("DTM", "472", "20260910"),
    S("CAS", "CO", "45", ".50"), S("CAS", "PR", "2", "10.30"), S("AMT", "B6", "51.50"),
    S("CLP", "V2000", "22", "-50", "-40", "-10", "MB", "MCR-E0"), S("SVC", c("HC", "98940", "AT"), "-50", "-40", "", "1"), S("CAS", "PR", "2", "-10"),
  ];
  const close = (body: string[]) => [...body, S("SE", String(body.length + 1), body[0].split(d.el)[2])];
  const segs = tweak([S("GS", "HP", "SAMPLEPAYER", "SAMPLECHIRO", "20260918", "1200", "1", "X", "005010X221A1"), ...close(st1), ...close(st2), S("GE", "2", "1"), S("IEA", "1", "000000101")]);
  const nl = o.newline ? "\n" : "";
  return isa(d) + nl + segs.map((s) => s + d.seg).join(nl) + nl;
}

/**
 * ASC X12N 835 (005010X221A1) Health Care Claim Payment/Advice parser: pure TypeScript, no DuckDB, no I/O. Used by the
 * remit/x12-835 source adapter and by scripts/era-to-csv.ts (privateAI-design-30 §3, §6.3).
 *
 * Basis (read 2026-11-03, recorded in config/prms/curve-bofa-835-schema.csv rows x12_835):
 *  - AultCare 5010 835 Companion Guide v1.6 (2025-01-23): ISA16 component separator, BPR01-BPR16, TRN01-TRN03, DTM*405,
 *    CLP01-CLP07, NM1*QC, DTM*232/233, SVC01-SVC05, DTM*472, CAS01-CAS19 (up to six reason/amount/quantity triplets; a
 *    positive amount decreases SVC03/CLP04), AMT*B6 allowed amount.
 *  - CMS 835 TI Companion Guide 3.0 (2012-07-25, 005010X221A1): SVC06 original procedure, LQ*HE remark codes, PLB03 reason
 *    codes, group codes CO/OA/PR/PI.
 *  - Amerigroup 835 guide: PLB holds up to six adjustments after the claims (PLB*<provider>*<date>*<code>:<ref>*<amount>).
 *  Not seen in those sources (TR3 knowledge, UNVERIFIED until a real 835 arrives): REF*6R line item control number, and the
 *  transaction rule BPR02 = sum(CLP04) - sum(PLB amounts). Both are reported as checks, never used to change a figure.
 *
 * Privacy: patient, insured and provider names (NM1 segments) are never kept; a claim is identified by CLP01 (patient control
 * number, from the practice's own claim) and CLP07 (payer claim number). Amounts are integer cents, parsed from the text
 * without floating point; dates are ISO (YYYY-MM-DD).
 */

export type Delimiters = { element: string; component: string; repetition: string; segment: string };
export type Payment = {
  st_control: string; trace: string | null; trace_originator: string | null; handling: string | null; paid_cents: number | null;
  credit_debit: string | null; method: string | null; format: string | null; payment_date: string | null; production_date: string | null;
  payer_name: string | null; payer_id: string | null; payee_name: string | null; payee_id_qualifier: string | null; payee_id: string | null;
};
export type Claim = {
  st_control: string; trace: string | null; claim_seq: number; patient_control_no: string; status: string | null; charge_cents: number | null;
  paid_cents: number | null; patient_resp_cents: number | null; filing_indicator: string | null; payer_claim_no: string | null;
  facility_code: string | null; frequency: string | null; period_start: string | null; period_end: string | null;
};
export type Line = {
  claim_seq: number; line_seq: number; qualifier: string | null; code: string | null; modifiers: string[]; charge_cents: number | null;
  paid_cents: number | null; revenue_code: string | null; units: string | null; original_code: string | null; original_modifiers: string[];
  service_date: string | null; line_control_no: string | null; allowed_cents: number | null; remarks: string[];
};
export type Adjustment = { claim_seq: number; line_seq: number | null; level: "claim" | "line"; group: string; carc: string; cents: number; quantity: string | null };
export type ProviderAdjustment = { st_control: string; trace: string | null; provider_id: string | null; fiscal_date: string | null; reason: string; reference: string | null; cents: number };
export type Check = { name: string; ok: boolean; detail: string };
export type Era835 = {
  delimiters: Delimiters; isaControl: string | null; version: string | null; segments: number;
  payments: Payment[]; claims: Claim[]; lines: Line[]; adjustments: Adjustment[]; plb: ProviderAdjustment[]; problems: string[]; checks: Check[];
};

export class X12Error extends Error {}

/** ISA is fixed width: element separator = 4th character, ISA16 (component separator) = 105th, segment terminator = 106th. */
export function delimiters(text: string): Delimiters {
  const t = text.replace(/^﻿/, "").replace(/^\s+/, "");
  if (!t.startsWith("ISA") || t.length < 106) throw new X12Error("not an X12 interchange (no 106-character ISA segment at the start)");
  const element = t[3];
  const parts = t.slice(0, 106).split(element);
  if (parts.length !== 17 || parts[16].length !== 2) throw new X12Error(`ISA does not have 16 fixed-width elements with separator "${element}"`);
  const component = parts[16][0], segment = parts[16][1];
  const repetition = parts[11].length === 1 && parts[12] === "00501" ? parts[11] : "";
  return { element, component, repetition, segment };
}

/** True when these first lines (BOM removed) are an X12 interchange holding an ST*835 transaction, whatever the delimiters. */
export function isEra835(lines: readonly string[]): boolean {
  const text = lines.join("\n");
  let d: Delimiters;
  try { d = delimiters(text); } catch (e) { if (e instanceof X12Error) return false; throw e; }
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:${esc(d.segment)}|\\n)\\s*ST${esc(d.element)}835${esc(d.element)}`).test(text);
}

/** "150.00" | "-19.16" | "5" | ".5" -> integer cents; null for empty; throws for a non-amount or more than 2 decimals. */
export function toCents(raw: string | undefined): number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new X12Error(`not an amount with at most 2 decimals: "${t}"`);
  const v = Number(m[2] || "0") * 100 + Number(((m[3] ?? "") + "00").slice(0, 2));
  return m[1] === "-" && v !== 0 ? -v : v;
}

/** CCYYMMDD -> YYYY-MM-DD; null for empty; throws for anything else. */
export function toDate(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) throw new X12Error(`not a CCYYMMDD date: "${t}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new X12Error(`not a real date: "${t}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const nz = (s: string | undefined): string | null => { const t = (s ?? "").trim(); return t === "" ? null : t; };
const sum = (xs: (number | null)[]): number => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const money = (c: number | null): string => (c === null ? "missing" : `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`);

/** Parses one interchange (any number of GS groups and ST*835 transactions). Malformed values become problems, not guesses. */
export function parse835(text: string): Era835 {
  const d = delimiters(text);
  const body = text.replace(/^﻿/, "").replace(/^\s+/, "");
  const segs = body.split(d.segment).map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, "").trim()).filter((s) => s !== "").map((s) => s.split(d.element));
  const out: Era835 = { delimiters: d, isaControl: nz(segs[0]?.[13]), version: null, segments: segs.length, payments: [], claims: [], lines: [], adjustments: [], plb: [], problems: [], checks: [] };
  const comp = (v: string | undefined) => (v ?? "").split(d.component);
  let pay: Payment | null = null, claim: Claim | null = null, line: Line | null = null;
  let stCount = 0, stStart = 0, claimSeq = 0, lineSeq = 0, seen835 = false;
  const segChecks: Check[] = [];
  const at = (i: number, tag: string, f: () => void) => { try { f(); } catch (e) { if (e instanceof X12Error) out.problems.push(`segment ${i + 1} (${tag}): ${e.message}`); else throw e; } };

  segs.forEach((e, i) => at(i, e[0], () => {
    const tag = e[0];
    switch (tag) {
      case "GS": out.version = nz(e[8]) ?? out.version; break;
      case "ST":
        if (e[1] !== "835") throw new X12Error(`transaction set ${e[1]} is not 835`);
        seen835 = true; stCount++; stStart = i; claim = null; line = null;
        pay = { st_control: e[2] ?? "", trace: null, trace_originator: null, handling: null, paid_cents: null, credit_debit: null, method: null, format: null,
          payment_date: null, production_date: null, payer_name: null, payer_id: null, payee_name: null, payee_id_qualifier: null, payee_id: null };
        out.payments.push(pay); break;
      case "BPR":
        if (!pay) throw new X12Error("BPR outside a transaction");
        pay.handling = nz(e[1]); pay.paid_cents = toCents(e[2]); pay.credit_debit = nz(e[3]); pay.method = nz(e[4]); pay.format = nz(e[5]); pay.payment_date = toDate(e[16]); break;
      case "TRN": if (pay && e[1] === "1") { pay.trace = nz(e[2]); pay.trace_originator = nz(e[3]); } break;
      case "N1":
        if (!pay || claim) break;
        if (e[1] === "PR") { pay.payer_name = nz(e[2]); pay.payer_id = nz(e[4]); }
        else if (e[1] === "PE") { pay.payee_name = nz(e[2]); pay.payee_id_qualifier = nz(e[3]); pay.payee_id = nz(e[4]); }
        break;
      case "DTM": {
        const q = e[1], v = toDate(e[2]);
        if (line && (q === "472" || q === "150")) line.service_date = v;
        else if (claim && !line && q === "232") claim.period_start = v;
        else if (claim && !line && q === "233") claim.period_end = v;
        else if (pay && !claim && q === "405") pay.production_date = v;
        break;
      }
      case "CLP": {
        if (!pay) throw new X12Error("CLP outside a transaction");
        claimSeq++; lineSeq = 0; line = null;
        const f = comp(e[8]);
        claim = { st_control: pay.st_control, trace: pay.trace, claim_seq: claimSeq, patient_control_no: (e[1] ?? "").trim(), status: nz(e[2]),
          charge_cents: toCents(e[3]), paid_cents: toCents(e[4]), patient_resp_cents: toCents(e[5]), filing_indicator: nz(e[6]), payer_claim_no: nz(e[7]),
          facility_code: nz(f[0]), frequency: nz(e[9]), period_start: null, period_end: null };
        if (!claim.patient_control_no) throw new X12Error("CLP01 (patient control number) is empty");
        out.claims.push(claim); break;
      }
      case "SVC": {
        if (!claim) throw new X12Error("SVC outside a claim");
        lineSeq++;
        const p = comp(e[1]), o = comp(e[6]);
        line = { claim_seq: claim.claim_seq, line_seq: lineSeq, qualifier: nz(p[0]), code: nz(p[1]), modifiers: p.slice(2, 6).map((m) => m.trim()).filter(Boolean),
          charge_cents: toCents(e[2]), paid_cents: toCents(e[3]), revenue_code: nz(e[4]), units: nz(e[5]), original_code: nz(o[1]),
          original_modifiers: o.slice(2, 6).map((m) => m.trim()).filter(Boolean), service_date: null, line_control_no: null, allowed_cents: null, remarks: [] };
        out.lines.push(line); break;
      }
      case "CAS": {
        if (!claim) throw new X12Error("CAS outside a claim");
        const group = (e[1] ?? "").trim();
        if (!/^(CO|OA|PI|PR)$/.test(group)) throw new X12Error(`CAS01 group code "${group}" is not CO, OA, PI or PR`);
        for (let k = 2; k <= 17; k += 3) {
          const carc = nz(e[k]); if (!carc) continue;
          const cents = toCents(e[k + 1]); if (cents === null) throw new X12Error(`CAS reason ${carc} has no amount`);
          out.adjustments.push({ claim_seq: claim.claim_seq, line_seq: line ? line.line_seq : null, level: line ? "line" : "claim", group, carc, cents, quantity: nz(e[k + 2]) });
        }
        break;
      }
      case "REF": if (line && e[1] === "6R") line.line_control_no = nz(e[2]); break;
      case "AMT": if (line && e[1] === "B6") line.allowed_cents = toCents(e[2]); break;
      case "LQ": if (line && e[1] === "HE" && nz(e[2])) line.remarks.push(e[2].trim()); break;
      case "PLB": {
        if (!pay) throw new X12Error("PLB outside a transaction");
        claim = null; line = null;
        for (let k = 3; k < e.length && k <= 13; k += 2) {
          const r = comp(e[k]); if (!nz(r[0])) continue;
          const cents = toCents(e[k + 1]); if (cents === null) throw new X12Error(`PLB reason ${r[0]} has no amount`);
          out.plb.push({ st_control: pay.st_control, trace: pay.trace, provider_id: nz(e[1]), fiscal_date: toDate(e[2]), reason: r[0].trim(), reference: nz(r[1]), cents });
        }
        break;
      }
      case "SE": {
        const n = Number(e[1]), actual = i - stStart + 1;
        segChecks.push({ name: `ST ${pay?.st_control ?? "?"}: SE01 segment count`, ok: n === actual, detail: `SE01 ${e[1]} vs ${actual} counted` });
        segChecks.push({ name: `ST ${pay?.st_control ?? "?"}: SE02 = ST02`, ok: (e[2] ?? "") === (pay?.st_control ?? ""), detail: `SE02 ${e[2]} vs ST02 ${pay?.st_control}` });
        pay = null; claim = null; line = null; break;
      }
      default: break;
    }
  }));
  if (!seen835) out.problems.push("no ST*835 transaction in the interchange");
  out.checks = [...balance(out), ...segChecks,
    { name: "every segment parsed (amounts, dates, codes)", ok: out.problems.length === 0, detail: out.problems.length ? out.problems.slice(0, 5).join("; ") : `${stCount} transaction(s), ${out.claims.length} claim(s)` }];
  return out;
}

/** Balancing checks; each failure names the claim or line and the two figures. */
function balance(r: Era835): Check[] {
  const adj = (claimSeq: number, lineSeq: number | null | "any", group?: string) =>
    sum(r.adjustments.filter((a) => a.claim_seq === claimSeq && (lineSeq === "any" || a.line_seq === lineSeq) && (!group || a.group === group)).map((a) => a.cents));
  const badLines = r.lines.filter((l) => l.charge_cents !== null && l.paid_cents !== null && l.charge_cents - adj(l.claim_seq, l.line_seq) !== l.paid_cents);
  const badClaims = r.claims.filter((c) => c.charge_cents !== null && c.paid_cents !== null && c.charge_cents - adj(c.claim_seq, "any") !== c.paid_cents);
  const badPr = r.claims.filter((c) => c.patient_resp_cents !== null && adj(c.claim_seq, "any", "PR") !== c.patient_resp_cents);
  const badPay = r.payments.filter((p) => p.paid_cents !== null &&
    sum(r.claims.filter((c) => c.st_control === p.st_control).map((c) => c.paid_cents)) - sum(r.plb.filter((x) => x.st_control === p.st_control).map((x) => x.cents)) !== p.paid_cents);
  const name = (c: Claim) => `claim ${c.patient_control_no} (#${c.claim_seq})`;
  return [
    { name: "service lines balance: SVC02 - line CAS = SVC03", ok: badLines.length === 0,
      detail: badLines.length ? badLines.slice(0, 5).map((l) => `claim #${l.claim_seq} line ${l.line_seq}: ${money(l.charge_cents)} - ${money(adj(l.claim_seq, l.line_seq))} vs ${money(l.paid_cents)}`).join("; ") : `${r.lines.length} line(s)` },
    { name: "claims balance: CLP03 - all CAS = CLP04", ok: badClaims.length === 0,
      detail: badClaims.length ? badClaims.slice(0, 5).map((c) => `${name(c)}: ${money(c.charge_cents)} - ${money(adj(c.claim_seq, "any"))} vs ${money(c.paid_cents)}`).join("; ") : `${r.claims.length} claim(s)` },
    { name: "patient responsibility: PR adjustments = CLP05 (payer practice, not a TR3 rule)", ok: badPr.length === 0,
      detail: badPr.length ? badPr.slice(0, 5).map((c) => `${name(c)}: PR ${money(adj(c.claim_seq, "any", "PR"))} vs CLP05 ${money(c.patient_resp_cents)}`).join("; ") : `${r.claims.length} claim(s)` },
    { name: "payment balances: BPR02 = sum(CLP04) - sum(PLB) (TR3 rule, unverified source)", ok: badPay.length === 0,
      detail: badPay.length ? badPay.map((p) => `ST ${p.st_control}: BPR02 ${money(p.paid_cents)}`).join("; ") : `${r.payments.length} payment(s)` },
  ];
}

/** Table rows for CSV or SQL: one record per table, canonical column order. */
export const ERA_TABLES = {
  payments: ["st_control", "trace", "trace_originator", "handling", "paid_cents", "credit_debit", "method", "format", "payment_date", "production_date",
    "payer_name", "payer_id", "payee_name", "payee_id_qualifier", "payee_id"],
  claims: ["st_control", "trace", "claim_seq", "patient_control_no", "status", "charge_cents", "paid_cents", "patient_resp_cents", "filing_indicator",
    "payer_claim_no", "facility_code", "frequency", "period_start", "period_end"],
  lines: ["claim_seq", "line_seq", "qualifier", "code", "modifiers", "charge_cents", "paid_cents", "revenue_code", "units", "original_code",
    "original_modifiers", "service_date", "line_control_no", "allowed_cents", "remarks"],
  adjustments: ["claim_seq", "line_seq", "level", "group", "carc", "cents", "quantity"],
  plb: ["st_control", "trace", "provider_id", "fiscal_date", "reason", "reference", "cents"],
} as const;
export type EraTable = keyof typeof ERA_TABLES;

/** Lists (modifiers, remarks) are joined with "+" so one cell holds them in order. */
export function tableRows(r: Era835, t: EraTable): (string | number | null)[][] {
  const src = (r as unknown as Record<EraTable, Record<string, unknown>[]>)[t];
  return src.map((rec) => ERA_TABLES[t].map((c) => { const v = rec[c]; return Array.isArray(v) ? (v.length ? v.join("+") : null) : (v as string | number | null); }));
}

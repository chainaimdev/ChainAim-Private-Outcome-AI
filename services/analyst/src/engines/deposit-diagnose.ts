/**
 * Why a deposit did not reconcile (Phase 4b-1): turns deposit-match's unmatched Curve sums and bank credits, the ledger
 * link and the references into exceptions with a cause, an amount, a date and the payment IDs as evidence. Rules, in order
 * (each consumes what it explains; proven on tools/dental-synth NEG sets: 10 scenarios + 40 sweep sets):
 *   1. HFD_LAG (watch): an unmatched card credit equal to one late-funding payment (config lateFundingMethods) dated after
 *      the group's lag window (<= lateFundingMaxDays), whose own day's Curve sum is unmatched and is explained by removing it.
 *   2. Short / over pairs, only for groups with partialDeposits: an unmatched Curve sum and an unmatched credit of the same
 *      group within the lag window, smallest difference first. Short by exactly one check -> UNDEPOSITED_CHECK; by one of two
 *      identical postings (same patient pseudonym, method, amount) -> POSTED_TWICE; by less than the day's cash ->
 *      CASH_SHORT; a card batch -> CARD_BATCH_SHORT; otherwise DEPOSIT_SHORT. A credit above the sum -> DEPOSIT_OVER.
 *   3. Curve sums left: an insurance EFT -> EFT_MISSING; a lone check -> UNDEPOSITED_CHECK; else DEPOSIT_MISSING.
 *   4. Credits left -> BANK_UNPOSTED.
 *   5. Per payment: a check whose deposit Ref. ID differs from the ledger reference -> REF_MISMATCH.
 *   6. Ledger link: ID_NOT_IN_LEDGER, ID_NOT_IN_DEPOSIT, LEDGER_AMOUNT_MISMATCH; unmapped methods -> UNMAPPED_METHOD.
 * Severity "watch" for config watchCodes (timing, not loss); every other code is an "exception".
 */
import { type Db, ident, rows } from "../db.ts";
import { type BankCredit, type CurveGroup, type ReconcileConfig, type ReconcileResult, days, samePayer } from "./deposit-match.ts";

export type Exception = { code: string; severity: "exception" | "watch"; group: string | null; payer: string | null; date: string; cents: number; paymentIds: string[]; bankRows: number[]; detail: string };
type Payment = { id: string; date: string; method: string; payer: string | null; pt: string | null; cents: number; ref: string | null };
type Credit = BankCredit & { group: string; payer: string | null };

export async function diagnose(db: Db, t: { deposit: string; ledger: string | null }, cfg: ReconcileConfig, r: ReconcileResult): Promise<Exception[]> {
  const dg = cfg.diagnose;
  const pay = new Map((await rows<Payment & { cents: number }>(db, `SELECT payment_id AS "id", CAST(min("date") AS VARCHAR) AS "date", min(method) AS "method", min(payer) AS "payer",
      min(rp_pseudonym) AS "pt", CAST(sum(cents) AS BIGINT) AS "cents", min(ref_id) AS "ref" FROM ${ident(t.deposit)} GROUP BY payment_id`)).map((p) => [p.id, { ...p, cents: Number(p.cents) }]));
  const out: Exception[] = [];
  const add = (code: string, e: Partial<Exception> & { date: string; cents: number }) => out.push({ code, severity: dg.watchCodes.includes(code) ? "watch" : "exception",
    group: null, payer: null, paymentIds: [], bankRows: [], detail: "", ...e, paymentIds: [...(e.paymentIds ?? [])].sort() });
  const money = (c: number) => (c / 100).toFixed(2);
  let UC: CurveGroup[] = [...r.depositToBank.unmatchedCurve];
  let UB: Credit[] = [...r.depositToBank.unmatchedBank];

  // 1. late funding (watch)
  for (const b of [...UB]) {
    if (!UB.includes(b)) continue;
    const [, hi] = cfg.groups[b.group].lagDays;
    for (const p of [...pay.values()].filter((p) => dg.lateFundingMethods.includes(p.method) && p.cents === b.cents && cfg.methodGroups[p.method] === b.group)) {
      const lag = days(b.date, p.date);
      if (!(lag > hi && lag <= dg.lateFundingMaxDays)) continue;
      const u = UC.find((u) => u.group === b.group && u.date === p.date && u.ids.includes(p.id));
      if (!u) continue;
      const rest = u.cents - p.cents;
      const [lo2, hi2] = cfg.groups[u.group].lagDays;
      const b2 = rest === 0 ? null : UB.find((x) => x !== b && x.group === u.group && x.cents === rest && days(x.date, u.date) >= lo2 && days(x.date, u.date) <= hi2);
      if (rest !== 0 && !b2) continue;
      UC = UC.filter((x) => x !== u); UB = UB.filter((x) => x !== b && x !== b2);
      add("HFD_LAG", { group: b.group, date: p.date, cents: p.cents, paymentIds: [p.id], bankRows: [b.row, ...(b2 ? [b2.row] : [])],
        detail: `${p.method} payment ${p.id} (${money(p.cents)}) funded ${lag} day(s) after posting, beyond the ${hi}-day window` });
      break;
    }
  }
  // 2. short / over pairs (batch groups only)
  const pairs: { d: number; lag: number; u: CurveGroup; b: Credit }[] = [];
  for (const u of UC) {
    const g = cfg.groups[u.group]; if (!g.partialDeposits) continue;
    for (const b of UB) {
      const lag = days(b.date, u.date);
      if (b.group === u.group && (u.payer === null || samePayer(b.payer, u.payer)) && lag >= g.lagDays[0] && lag <= g.lagDays[1]) pairs.push({ d: Math.abs(u.cents - b.cents), lag: Math.abs(lag), u, b });
    }
  }
  pairs.sort((x, y) => x.d - y.d || x.lag - y.lag || x.u.date.localeCompare(y.u.date) || x.b.row - y.b.row);
  const takenU = new Set<CurveGroup>(), takenB = new Set<Credit>();
  for (const { u, b } of pairs) {
    if (takenU.has(u) || takenB.has(b)) continue;
    takenU.add(u); takenB.add(b);
    const diff = u.cents - b.cents, ps = u.ids.map((i) => pay.get(i)!).filter(Boolean);
    const base = { group: u.group, payer: u.payer, date: u.date, bankRows: [b.row] };
    if (diff <= 0) { add("DEPOSIT_OVER", { ...base, cents: -diff, detail: `bank credit ${money(b.cents)} above the Curve sum ${money(u.cents)}` }); continue; }
    const checks = ps.filter((p) => p.method === dg.checkMethod && p.cents === diff);
    const twins = ps.flatMap((p) => ps.filter((q) => p.id < q.id && p.pt === q.pt && p.method === q.method && p.cents === q.cents && p.cents === diff).map((q) => [p, q] as const));
    const cash = ps.filter((p) => p.method === dg.cashMethod).reduce((s, p) => s + p.cents, 0);
    if (checks.length === 1) add("UNDEPOSITED_CHECK", { ...base, cents: diff, paymentIds: [checks[0].id], detail: `deposit short by exactly check payment ${checks[0].id}` });
    else if (twins.length === 1) add("POSTED_TWICE", { ...base, cents: diff, paymentIds: [twins[0][0].id, twins[0][1].id], detail: `payments ${twins[0][0].id} and ${twins[0][1].id}: same patient, method and amount; banked once` });
    else if (cash > 0 && diff < cash) add("CASH_SHORT", { ...base, cents: diff, detail: `deposit ${money(b.cents)} vs Curve ${money(u.cents)}; the day's cash is ${money(cash)}` });
    else if (u.group === "card_processor") add("CARD_BATCH_SHORT", { ...base, cents: diff, detail: `settlement ${money(b.cents)} vs the day's card payments ${money(u.cents)}` });
    else add("DEPOSIT_SHORT", { ...base, cents: diff, detail: `deposit ${money(b.cents)} vs Curve ${money(u.cents)}` });
  }
  UC = UC.filter((u) => !takenU.has(u)); UB = UB.filter((b) => !takenB.has(b));
  // 3. Curve sums with no credit
  for (const u of UC) {
    const ps = u.ids.map((i) => pay.get(i)!).filter(Boolean);
    const base = { group: u.group, payer: u.payer, date: u.date, cents: u.cents, paymentIds: u.ids };
    if (!cfg.groups[u.group].partialDeposits) add("EFT_MISSING", { ...base, detail: `${u.payer ?? "payer"} remittance posted ${u.date}, no bank credit` });
    else if (ps.length === 1 && ps[0].method === dg.checkMethod) add("UNDEPOSITED_CHECK", { ...base, detail: `check payment ${ps[0].id} in no deposit` });
    else add("DEPOSIT_MISSING", { ...base, detail: `no bank credit for the ${u.group} sum of ${u.date}` });
  }
  // 4. credits with no Curve posting
  for (const b of UB) add("BANK_UNPOSTED", { group: b.group, payer: b.payer, date: b.date, cents: b.cents, bankRows: [b.row], detail: b.description });
  // 5. check references
  if (t.ledger) {
    const refs = await rows<{ id: string; ref: string | null }>(db, `SELECT entry_id AS "id", min("ref") AS "ref" FROM ${ident(t.ledger)} WHERE entry = 'payment' GROUP BY 1`);
    const lref = new Map(refs.map((x) => [x.id, x.ref]));
    for (const p of pay.values()) {
      if (p.method !== dg.checkMethod) continue;
      const l = lref.get(p.id) ?? null;
      if ((p.ref ?? null) !== l) add("REF_MISMATCH", { group: cfg.methodGroups[p.method] ?? null, date: p.date, cents: p.cents, paymentIds: [p.id], detail: `ledger reference ${l ?? "none"} vs deposit detail Ref. ID ${p.ref ?? "none"}` });
    }
  }
  // 6. ledger link and methods
  const l2d = r.ledgerToDeposit;
  if (l2d) {
    for (const id of l2d.missingInLedger) { const p = pay.get(id); add("ID_NOT_IN_LEDGER", { date: p?.date ?? "", cents: p?.cents ?? 0, paymentIds: [id], detail: "in the deposit detail, not in the ledger" }); }
    for (const id of l2d.missingInDeposit) add("ID_NOT_IN_DEPOSIT", { date: "", cents: 0, paymentIds: [id], detail: "in the ledger, not in the deposit detail" });
    for (const m of l2d.amountMismatch) add("LEDGER_AMOUNT_MISMATCH", { date: pay.get(m.id)?.date ?? "", cents: Math.abs(m.depositCents - m.ledgerCents), paymentIds: [m.id], detail: `deposit ${money(m.depositCents)} vs ledger ${money(m.ledgerCents)}` });
  }
  for (const m of r.depositToBank.unmappedMethods) add("UNMAPPED_METHOD", { date: "", cents: m.cents, detail: `payment type "${m.method}" (${m.rows} row(s)) is in no method group of the pack config` });
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code) || a.cents - b.cents);
}

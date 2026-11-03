/**
 * The evidence pack for a deposit reconciliation (Phase 4b-3): the text a model gets to explain a /reconcile run.
 * Code computed everything; the model only explains it, and /verify (verifyMoney) checks every figure in its answer.
 *
 * Owner decisions (2026-11-01 20:59 and 21:02):
 *   - every directional amount is signed, bank minus Curve, per the pack's evidence.directions ("-45.00" = money missing from
 *     the bank, "+12.00" = extra money in the bank); neutral figures (totals, IDs, a reference mismatch) carry no sign;
 *   - no names and no raw bank descriptions: payment IDs, bank row numbers, payer codes, groups and structured bank fields only
 *     (an ACH originator only when it is a known payer alias); details of evidence.omitDetailCodes are left out;
 *   - exceptions are never dropped: the pack narrows the match trail, then the file checks, and refuses when the exceptions
 *     alone do not fit the budget.
 */
import type { EvidenceConfig } from "./engines/deposit-match.ts";
import type { ReconcileReport } from "./reconcile.ts";

export type ReconcileEvidence = { text: string; chars: number; budget: number; exceptionsShown: number; exceptionsTotal: number;
  trailShown: number; trailTotal: number; fileChecksShown: boolean };

const SIGN_WORD = { negative: "bank below Curve", positive: "bank above Curve", neutral: "no bank difference" } as const;
/** 123456 -> "1,234.56" (unsigned; the sign is added by the caller). */
export function moneyText(cents: number): string {
  const c = Math.abs(Math.round(cents));
  const whole = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${String(c % 100).padStart(2, "0")}`;
}

export function reconcileEvidenceOf(rep: ReconcileReport, ev: EvidenceConfig, budget: number, trailRows = ev.trailRows): ReconcileEvidence {
  const missing = [...new Set(rep.exceptions.map((e) => e.code))].filter((c) => !ev.directions[c]);
  if (missing.length) throw new Error(`evidence: no direction configured for cause code(s) ${missing.join(", ")} (pack ${rep.pack}, evidence.directions)`);
  const r = rep.result.depositToBank;
  const head = [
    "DEPOSIT RECONCILIATION (computed by code over every row of every file; every amount is exact)",
    "Sign convention: a signed amount is bank minus Curve. A minus sign means money missing from the bank; a plus sign means extra money in the bank. Unsigned figures (totals, IDs) have no direction.",
    `Pack: ${rep.pack}. Files: ${rep.files.map((f) => `${f.name} (${f.adapter ?? "unknown layout"}, ${f.rows ?? "?"} rows)`).join("; ")}.`,
    "Totals per group (Curve payments posted, of which matched to bank credits):",
    ...Object.entries(rep.result.totals).map(([g, t]) => `- ${g}: Curve ${moneyText(t.curveCents)}, matched ${moneyText(t.matchedCents)}, not matched ${moneyText(t.curveCents - t.matchedCents)}`),
    `Bank credits matched: ${r.matched.length}. Curve sums with no bank credit: ${r.unmatchedCurve.length}. Bank credits matching no Curve sum: ${r.unmatchedBank.length}.`
      + (rep.result.ledgerToDeposit ? ` Ledger vs deposit detail: ${rep.result.ledgerToDeposit.matched} of ${rep.result.ledgerToDeposit.checkedIds} payment IDs agree.` : " No ledger file."),
  ];
  const unmatchedBank = new Map(r.unmatchedBank.map((b) => [b.row, b]));
  const exc = rep.exceptions.length ? [`Exceptions (${rep.exceptions.length}; watch = timing, not loss):`, ...rep.exceptions.map((e, i) => {
    const d = ev.directions[e.code], sign = d === "negative" ? "-" : d === "positive" ? "+" : "";
    const amount = e.cents === 0 && d === "neutral" ? "amount n/a" : `amount ${sign}${moneyText(e.cents)} (${SIGN_WORD[d]})`;
    const bank = e.bankRows.map((row) => { const b = unmatchedBank.get(row); return b ? `${row} (${b.kind}${b.payer ? `, payer ${b.payer}` : ""})` : String(row); });
    return [`${i + 1}. ${e.code}`, e.severity, e.date ? `date ${e.date}` : "date n/a", e.group ? `group ${e.group}` : null, e.payer ? `payer ${e.payer}` : null, amount,
      e.paymentIds.length ? `payments ${e.paymentIds.join(";")}` : null, bank.length ? `bank rows ${bank.join(";")}` : null,
      ev.omitDetailCodes.includes(e.code) || !e.detail ? null : `detail: ${e.detail}`].filter(Boolean).join(" | ");
  })] : ["Exceptions: none. Every Curve payment in a bank-deposited group reached the bank in full."];
  const checks = [`File checks: ${rep.checksFailed} failed.`, ...rep.files.flatMap((f) => f.checks.filter((c) => !c.ok).map((c) => `- ${f.name}: ${c.name} failed`))];
  const trailAll = r.matched.map((m) => `- bank row ${m.bankRow} ${m.bankDate} ${m.group}${m.payer ? ` payer ${m.payer}` : ""}: ${moneyText(m.cents)} = Curve ${m.curveDate} (lag ${m.lagDays} day(s)), payments ${m.paymentIds.join(";")}`);
  const build = (trailN: number, withChecks: boolean) => [...head, ...exc, ...(withChecks ? checks : [`File checks: ${rep.checksFailed} failed.`]),
    ...(trailN > 0 ? [`Match trail (first ${Math.min(trailN, trailAll.length)} of ${trailAll.length}):`, ...trailAll.slice(0, trailN)] : [])].join("\n");
  for (const withChecks of [true, false]) {
    for (let n = Math.min(trailRows, trailAll.length); n >= 0; n--) {
      const text = build(n, withChecks);
      if (text.length <= budget) return { text, chars: text.length, budget, exceptionsShown: rep.exceptions.length, exceptionsTotal: rep.exceptions.length,
        trailShown: Math.min(n, trailAll.length), trailTotal: trailAll.length, fileChecksShown: withChecks };
    }
  }
  throw new Error(`evidence: the ${rep.exceptions.length} exception(s) need ${build(0, false).length} characters, more than the budget of ${budget}; exceptions are never dropped: raise --evidence-max-chars or the budget`);
}

/**
 * The number check behind "code computes, the LLM explains": every figure in a model's answer must appear in the evidence
 * it was given. Pure. Moved unchanged from services/analyst/src/report.ts (decoupling Phase 2); used by crossAsk and by the
 * analyst's /verify route.
 */
/** Numbers in an answer that do not appear in the evidence. A heuristic: a figure the model derived (its own sum) is listed too, as "not found", not as wrong. */
export function verifyAnswer(answer: string, evidence: string): { checked: number; notFound: string[] } {
  const norm = (s: string) => { const neg = /^\(.*\)$/.test(s) || s.startsWith("-"); const v = Number(s.replace(/[^0-9.]/g, "")); return Number.isFinite(v) ? Math.round((neg ? -v : v) * 100) : NaN; };
  const NUM = /\(?-?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\$?\d+\.\d+\)?|\b\d{3,}\b/g;
  const known = new Set<number>();
  for (const m of evidence.match(NUM) ?? []) { const v = norm(m); if (!Number.isNaN(v)) { known.add(v); known.add(-v); } }
  const seen = new Set<string>(), notFound: string[] = [];
  let checked = 0;
  for (const m of answer.match(NUM) ?? []) {
    if (/^(19|20)\d\d$/.test(m)) continue; // years
    const v = norm(m);
    if (Number.isNaN(v) || seen.has(m)) continue;
    seen.add(m); checked++;
    if (!known.has(v)) notFound.push(m);
  }
  return { checked, notFound };
}

/**
 * Strict money check for reconciliation answers (Phase 4b-3; owner-approved 2026-11-01 20:59). The evidence writes every
 * directional amount with an explicit sign (bank minus Curve: "-45.00" = money missing, "+12.00" = extra in the bank) and
 * neutral figures (totals, IDs) without one. For each figure in the answer:
 *   - more than 2 decimals                                   -> notFound (no figure in the evidence has them)
 *   - its size (in cents) is not in the evidence             -> notFound
 *   - written with a sign ("-45.00", "(45.00)", "+12.00")    -> the evidence must hold that size with that sign, else signMismatch
 *   - unsigned, with a direction word in the same clause     -> the implied sign must be held, else signMismatch
 *     ("short by $45.00" = -, "over by $12.00" = +; both kinds of word in one clause = no direction)
 *   - unsigned, no direction word                            -> passes only when every evidence figure of that size has one sign,
 *                                                               else signUnclear
 * A figure whose size is only held as neutral passes whatever words surround it. Checked: every figure with a $ or a sign,
 * and any other with a decimal point, a thousands comma or 3+ digits; dates (ISO, m/d/yyyy) and years are skipped.
 */
export type MoneyVerifyOptions = { negativeWords?: readonly string[]; positiveWords?: readonly string[] };
export const NEGATIVE_WORDS = ["short", "shortfall", "missing", "below", "less", "under", "lower", "debit", "deficit", "undeposited", "lost"];
export const POSITIVE_WORDS = ["over", "extra", "above", "more", "excess", "higher", "credit", "surplus"];
export type MoneyVerifyResult = { checked: number; notFound: string[]; signMismatch: string[]; signUnclear: string[] };

type Fig = { raw: string; at: number; end: number; cents: number; sign: -1 | 0 | 1; decimals: number; strong: boolean };
const DATES = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const FIG = /(\()?([+\-−])?(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\))?/g;

function figures(text: string): Fig[] {
  const t = text.replace(DATES, (d) => " ".repeat(d.length));
  const out: Fig[] = [];
  for (const m of t.matchAll(FIG)) {
    const at = m.index!, prev = at > 0 ? t[at - 1] : "";
    if (/[\w.]/.test(prev)) continue; // part of a word or of a longer number (PL12, v1.2)
    const [raw, open, sg, dollar, int, frac, close] = m;
    const digits = int.replace(/,/g, "");
    if (!frac && /^(19|20)\d\d$/.test(digits) && !dollar && !sg) continue; // years
    const paren = Boolean(open && close);
    const sign: -1 | 0 | 1 = paren || sg === "-" || sg === "−" ? -1 : sg === "+" ? 1 : 0;
    const decimals = frac ? frac.length - 1 : 0;
    const cents = Math.round(Number(digits + (frac ?? "")) * 100);
    const strong = Boolean(dollar || sg || paren || frac || int.includes(",") || digits.length >= 3);
    out.push({ raw: raw.trim(), at, end: at + raw.length, cents, sign, decimals, strong });
  }
  return out;
}

/** The clause around a figure: bounded by ; or a newline, or by a . or , that is not inside a number. */
function clauseOf(text: string, at: number, end: number): string {
  const isStop = (i: number) => text[i] === ";" || text[i] === "\n" || ((text[i] === "." || text[i] === ",") && !/\d/.test(text[i + 1] ?? "") );
  let a = at; while (a > 0 && !isStop(a - 1)) a--;
  let b = end; while (b < text.length && !isStop(b)) b++;
  return text.slice(a, at) + " " + text.slice(end, b);
}

export function verifyMoney(answer: string, evidence: string, opts: MoneyVerifyOptions = {}): MoneyVerifyResult {
  const neg = new RegExp(`\\b(${(opts.negativeWords ?? NEGATIVE_WORDS).join("|")})\\b`, "i");
  const pos = new RegExp(`\\b(${(opts.positiveWords ?? POSITIVE_WORDS).join("|")})\\b`, "i");
  const held = new Map<number, Set<-1 | 0 | 1>>();
  for (const f of figures(evidence)) { if (!held.has(f.cents)) held.set(f.cents, new Set()); held.get(f.cents)!.add(f.sign); }
  const res: MoneyVerifyResult = { checked: 0, notFound: [], signMismatch: [], signUnclear: [] };
  const seen = new Set<string>();
  for (const f of figures(answer)) {
    if (!f.strong) continue;
    const words = clauseOf(answer, f.at, f.end);
    const isNeg = neg.test(words), isPos = pos.test(words);
    const dir: -1 | 0 | 1 = f.sign !== 0 ? f.sign : isNeg && !isPos ? -1 : isPos && !isNeg ? 1 : 0;
    const key = `${f.raw}|${dir}`;
    if (seen.has(key)) continue;
    seen.add(key); res.checked++;
    const signs = held.get(f.cents);
    if (f.decimals > 2 || !signs) { res.notFound.push(f.raw); continue; }
    if ([...signs].every((s) => s === 0)) continue; // a neutral figure (total, ID): no direction to check
    if (dir !== 0) { if (!signs.has(dir)) res.signMismatch.push(f.raw); continue; }
    const directional = new Set([...signs].filter((s) => s !== 0));
    if (directional.size > 1) res.signUnclear.push(f.raw);
  }
  return res;
}

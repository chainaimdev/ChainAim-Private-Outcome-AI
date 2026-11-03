/**
 * Fact sheets for a local model (Phase 4c): the deposit reconciliation's results, already classified, totalled, ranked and
 * given an action by code (DuckDB queries in scripts/dental.ts), written as tagged lines a small model only has to reword.
 * Pure: no DuckDB, no network. Owner run 2026-11-03 (local/deepseek-r1-8b, NEG-ALL): with the generic evidence the model passed
 * the old figure check 5/5 but was fully right on 2/5 (it called +863.57 a loss, borrowed payment IDs from the match trail,
 * filed a timing item under the wrong group, left out a payer). Hence: the model gets only the facts its question needs, must
 * cite the fact behind every figure, and verifyFactAnswer checks each figure and ID against the fact it cites, the category
 * words, and that every fact was mentioned. When the check fails, the caller shows plainFacts() instead (always correct).
 *
 * Tags: [T#] totals, [G#] deposit-group totals, [F#] one exception each. Amounts are cents; an F/T amount is signed bank minus
 * Curve (negative = money missing from the bank, positive = extra in the bank); posting errors and G figures are unsigned.
 */

export const CATEGORIES = ["loss", "extra", "timing", "posting"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  loss: "LOSS (money missing from the bank)", extra: "NOT A LOSS: extra money in the bank, not posted in Curve",
  timing: "NOT A LOSS: timing, money expected late (watch)", posting: "NOT A LOSS: posting error, no money moved",
};

/**
 * The model-facing words. The gateway masks a 6-18 digit number or a grouped number (a date) as a BANK_ACCOUNT when a context
 * word is near it ("bank", "account", "routing", "sort", ...: services/gateway/src/privacy/entities.ts); owner run 2026-11-03
 * showed BANK_ACCOUNT x6 per sheet, so the model copied placeholders instead of payment IDs. The sheet therefore never uses
 * those words; what a person reads (CATEGORY_LABEL, plainFacts) keeps the plain wording.
 */
export const SHEET_LABEL: Record<Category, string> = {
  loss: "LOSS (money Curve recorded that never arrived)", extra: "NOT A LOSS: money that arrived but Curve never recorded",
  timing: "NOT A LOSS: timing, money expected late (watch)", posting: "NOT A LOSS: posting error, no money moved",
};
export const MASK_CONTEXT_WORDS = /\b(account|acct|a\/c|ac|acc|bsb|ifsc|sort|routing|bank|iban)\b/i;

export type ExceptionFact = { tag: string; kind: "F"; category: Category; code: string; date: string | null; cents: number; payer: string | null;
  group: string | null; paymentIds: string[]; bankRows: number[]; action: string };
export type TotalFact = { tag: string; kind: "T"; category: Category; items: number; cents: number };
export type GroupFact = { tag: string; kind: "G"; group: string; curveCents: number; matchedCents: number; unmatchedCents: number };
export type Fact = ExceptionFact | TotalFact | GroupFact;
export type FactSheet = { text: string; facts: Fact[] };

/**
 * How tags and dates are WRITTEN in the sheet (owner scan 2026-11-03 02:19, gateway /v1/privacy/scan): the tag "F4" was masked as
 * US_DRIVER_LICENSE (a letter then a digit) and "2024-09-13" next to BANK_UNPOSTED as BANK_ACCOUNT (dash-grouped digits near a
 * context word). The sheet writes F_4 and 2024/09/13; the checker reads F4, F_4, (F4) and either date separator. Internally a
 * tag stays "F4".
 */
const showTag = (tag: string) => `${tag[0]}_${tag.slice(1)}`;
const showDate = (d: string | null) => (d ? d.replaceAll("-", "/") : "none");
/** Amounts in the sheet carry "$": the owner's probe (2026-11-03 02:21) showed "-164.00" masked as PHONE_NUMBER (score 0.40) and
 * "-$164.00" clean in the same line; "-164.00 USD" and "USD -164.00" were still masked. The checker reads both forms. */
const usd = (cents: number) => `$${money(cents)}`;
const signedUsd = (category: Category, cents: number) => category === "posting" ? usd(cents) : `${cents < 0 ? "-" : "+"}${usd(cents)}`;

/** 123456 -> "1,234.56" (unsigned). */
export const money = (cents: number): string => {
  const a = Math.abs(cents); const s = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${s}.${String(a % 100).padStart(2, "0")}`;
};
/** Signed text for F/T amounts: posting errors carry no direction. */
const signed = (category: Category, cents: number) => category === "posting" ? money(cents) : `${cents < 0 ? "-" : "+"}${money(cents)}`;

/** The sheet text: one line per fact, in the order given (code has already ranked them). */
export function renderSheet(facts: readonly Fact[], headline: string): FactSheet {
  const lines = [`FACTS (computed by code; copy figures exactly; amounts are signed: - = money Curve recorded that never arrived, + = money that arrived but Curve never recorded)`, headline];
  for (const f of facts) {
    if (f.kind === "T") lines.push(`[${showTag(f.tag)}] TOTAL ${SHEET_LABEL[f.category]}: ${signedUsd(f.category, f.cents)} in ${f.items} item(s)`);
    else if (f.kind === "G") lines.push(`[${showTag(f.tag)}] GROUP ${f.group}: recorded in Curve ${usd(f.curveCents)}, arrived ${usd(f.matchedCents)}, never arrived ${usd(f.unmatchedCents)}`);
    else lines.push(`[${showTag(f.tag)}] ${SHEET_LABEL[f.category]} | ${f.code} | date ${showDate(f.date)} | amount ${signedUsd(f.category, f.cents)}`
      + `${f.group ? ` | group ${f.group}` : ""}${f.payer ? ` | payer ${f.payer}` : ""}${f.paymentIds.length ? ` | payments ${f.paymentIds.join(";")}` : ""}`
      + `${f.bankRows.length ? ` | statement lines ${f.bankRows.join(";")}` : ""} | action: ${f.action}`);
  }
  return { text: lines.join("\n"), facts: [...facts] };
}

export const FACT_SYSTEM = [
  "You turn FACTS that code has already computed into a short answer for a dental office manager.",
  "Use ONLY the FACTS. Never compute, add, round, estimate or reorder: totals and rankings are already facts, listed in order.",
  "Write one line per fact and START each line with the tag of the fact it comes from, exactly as written in the FACTS, e.g. \"[F_2] UNDEPOSITED_CHECK on 2024/09/19: -$180.80 ...\"; keep each fact's code, date, amount and IDs on its own line.",
  "A line that cites a [T_#] total covers the items of that category.",
  "Mention every [F#] fact once. Only facts labelled LOSS are losses; never call extra money, timing or posting errors a loss.",
  "Copy each amount with its sign and two decimals. Plain sentences or bullets, no tables, no reasoning shown.",
].join(" ");

/** [F2] or (F2): small models write either; both bind the line to that fact. */
const TAG = /[[(]([FTG])_?(\d+)[\])]/g;
const tagOf = (m: RegExpMatchArray) => `${m[1]}${m[2]}`;
const CODE = /\b([A-Z]{2,}(?:_[A-Z]+)+)\b/g;
const DATE = /\b(\d{4})[-/](\d{2})[-/](\d{2})\b/g;
const PLACEHOLDER = /<[A-Z][A-Z0-9_]*_\d+>/g;
/** Words that name a category; a line using one must cite a fact of that category (negations like "not a loss" excepted). */
const CATEGORY_WORDS: [Category, RegExp][] = [
  ["loss", /\b(loss|losses|lose|loses|lost|losing)\b/i], ["timing", /\b(timing|watch|late|lag)\b/i],
  ["posting", /\b(posting errors?|posting mistakes?)\b/i], ["extra", /\b(extra|unposted|not posted|over)\b/i],
];
const AMOUNT = /(^|[^\w.,])([+\-−]?)\$?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d])/g;
/** A 6-digit payment ID: not part of a word, a decimal or a thousands group ("300,264.00"); "300264, 300266" is a list. */
const ID = /(?<![\w.-])(?<!\d,)(\d{6})(?![\w.]|,\d)/g;
const NOT_LOSS = /\b(not|no|isn't|is not|never)\s+(a\s+|an\s+|real\s+|actual\s+)*(loss|losses|lost)\b/gi;

export type FactCheck = { ok: boolean; checked: number; problems: string[] };

/** Checks an answer against the sheet it was given. Every rule is strict: a problem means the plain facts are shown instead. */
export function verifyFactAnswer(answer: string, sheet: FactSheet): FactCheck {
  const byTag = new Map(sheet.facts.map((f) => [f.tag, f]));
  const problems: string[] = []; const mentioned = new Set<string>(); let checked = 0;
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const units = text.split(/\n+|(?<=[.!?;])\s+(?=[A-Z*\-\d[])/).map((u) => u.trim()).filter(Boolean);
  for (const u of units) {
    const cited = [...u.matchAll(TAG)].map(tagOf);
    for (const t of cited) { if (!byTag.has(t)) problems.push(`cites [${t}], which is not in the facts`); else mentioned.add(t); }
    const facts = cited.map((t) => byTag.get(t)).filter((f): f is Fact => !!f);
    const bare = u.replace(TAG, " ");
    for (const m of u.matchAll(PLACEHOLDER)) problems.push(`placeholder ${m[0]} left in the answer`);
    const efacts = facts.filter((f): f is ExceptionFact => f.kind === "F");
    for (const m of bare.matchAll(CODE)) {
      if (!KNOWN_CODES.test(m[1]) && !sheet.facts.some((f) => f.kind === "F" && f.code === m[1])) continue;
      checked++;
      if (!facts.length) problems.push(`${m[1]} has no fact tag`);
      else if (efacts.length && !efacts.some((f) => f.code === m[1])) problems.push(`${m[1]} is not the code of ${cited.map((t) => `[${t}]`).join(" ")}`);
    }
    for (const m of bare.matchAll(DATE)) {
      checked++; const d = `${m[1]}-${m[2]}-${m[3]}`;
      if (efacts.length && !efacts.some((f) => f.date === d)) problems.push(`date ${m[0]} is not the date of ${cited.map((t) => `[${t}]`).join(" ")}`);
    }
    for (const m of bare.matchAll(AMOUNT)) {
      checked++;
      const sign = m[2] === "−" ? "-" : m[2]; const cents = Math.round(Number(m[3].replace(/,/g, "")) * 100);
      if (!facts.length) { problems.push(`${sign}${m[3]} has no [F#]/[T#]/[G#] tag: "${clip(u)}"`); continue; }
      const hits = facts.filter((f) => amountsOf(f).includes(cents));
      if (!hits.length) { problems.push(`${sign}${m[3]} is not the amount of ${cited.map((t) => `[${t}]`).join(" ")}`); continue; }
      const dirs = hits.filter((f) => f.kind !== "G" && f.category !== "posting").map((f) => ((f as ExceptionFact | TotalFact).cents < 0 ? "-" : "+"));
      if (sign && dirs.length && !dirs.includes(sign)) problems.push(`${sign}${m[3]} has the wrong direction for ${hits.map((f) => `[${f.tag}]`).join(" ")}`);
    }
    for (const m of bare.matchAll(ID)) {
      checked++;
      const ids = facts.flatMap((f) => (f.kind === "F" ? f.paymentIds : []));
      if (!facts.length) problems.push(`payment ${m[1]} has no fact tag`);
      else if (!ids.includes(m[1])) problems.push(`payment ${m[1]} does not belong to ${cited.map((t) => `[${t}]`).join(" ")}`);
    }
    const cats = facts.filter((f): f is ExceptionFact | TotalFact => f.kind !== "G").map((f) => f.category);
    const plain = u.replace(NOT_LOSS, " ").replace(/\bNOT A LOSS\b/gi, " ");
    // A line naming exactly one category speaks for every fact it cites (owner run 2: "Posting errors: +863.57 (F6) and +74.50 (F8)"
    // filed extra money under posting errors). A line naming several categories is a mix and is not judged by its words.
    const named = CATEGORY_WORDS.filter(([, rx]) => rx.test(plain)).map(([c]) => c).filter((c) => c !== "extra");
    if (named.length === 1 && cats.length) {
      const cat = named[0]; const wrong = facts.filter((f): f is ExceptionFact | TotalFact => f.kind !== "G" && f.category !== cat);
      const word = cat === "loss" ? "a loss" : cat === "posting" ? "a posting error" : "timing";
      if (wrong.length) problems.push(`calls ${wrong.map((f) => `[${f.tag}]`).join(" ")} ${word}, but ${wrong.length > 1 ? "they are" : "it is"} ${wrong.map((f) => f.category).join("/")}`);
    }
  }
  const coveredCats = new Set(sheet.facts.filter((f): f is TotalFact => f.kind === "T" && mentioned.has(f.tag)).map((f) => f.category));
  for (const f of sheet.facts) if (f.kind === "F" && !mentioned.has(f.tag) && !coveredCats.has(f.category)) problems.push(`not mentioned: [${f.tag}] ${f.code} ${signed(f.category, f.cents)}`);
  if (!units.length) problems.push("empty answer");
  return { ok: problems.length === 0, checked, problems };
}

/** Cause codes the engine emits (a capitalised token outside this list, e.g. a group name, is not checked as a code). */
const KNOWN_CODES = /^(UNDEPOSITED_CHECK|CASH_SHORT|CARD_BATCH_SHORT|DEPOSIT_SHORT|DEPOSIT_OVER|DEPOSIT_MISSING|EFT_MISSING|POSTED_TWICE|BANK_UNPOSTED|HFD_LAG|REF_MISMATCH|ID_NOT_IN_LEDGER|ID_NOT_IN_DEPOSIT|LEDGER_AMOUNT_MISMATCH|UNMAPPED_METHOD|PROCEDURE_NOT_INVOICED|FINANCING_UNFUNDED|FINANCING_CANCELLATION_UNPOSTED|CHARGEBACK_UNPOSTED|FINANCING_DISCOUNT_OVER)$/;
const amountsOf = (f: Fact): number[] => f.kind === "G" ? [f.curveCents, f.matchedCents, f.unmatchedCents].map(Math.abs) : [Math.abs(f.cents)];
const clip = (s: string) => (s.length > 70 ? s.slice(0, 67) + "..." : s);

/** The facts as plain sentences (the fallback answer; always correct because it is the facts). */
export function plainFacts(sheet: FactSheet): string {
  return sheet.facts.map((f) => {
    if (f.kind === "T") return `- ${CATEGORY_LABEL[f.category]}: ${signed(f.category, f.cents)} in ${f.items} item(s).`;
    if (f.kind === "G") return `- ${f.group}: posted ${money(f.curveCents)}, reached the bank ${money(f.matchedCents)}, did not reach the bank ${money(f.unmatchedCents)}.`;
    return `- ${f.code} on ${f.date ?? "(no date)"}: ${signed(f.category, f.cents)}${f.payer ? `, payer ${f.payer}` : ""}${f.paymentIds.length ? `, payments ${f.paymentIds.join(", ")}` : ""}`
      + `${f.bankRows.length ? `, bank rows ${f.bankRows.join(", ")}` : ""}. ${CATEGORY_LABEL[f.category]}. Action: ${f.action}`;
  }).join("\n");
}

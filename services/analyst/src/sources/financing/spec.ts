/**
 * Patient-financing exports (Phase 4a.2, DESIGN/xrplh-25 §13): the pure part shared by the CareCredit, Cherry and HFD
 * adapters, with no DuckDB import so it runs anywhere. A layout is only its header signature (read from the owner's
 * header-only GLOBAL-*.csv files); every business rule (date formats, amount format, which column is gross / fee / bank,
 * Type -> kind, sign expectations, arithmetic identities) comes from the pack's financing config, item by item with
 * { value, verified, basis }. Until real-format rows arrive every item is verified: false, and each loaded file says so in
 * its checks. Unknown or ambiguous input fails a check; nothing is guessed.
 */
import { headerOf } from "../lines.ts";

/** A layout: exact header names in order; trailing empty header cells allowed when trailingEmptyOk. */
export type FinancingLayout = {
  /** Key of this provider in the config's "providers". */
  provider: string;
  headers: readonly string[];
  trailingEmptyOk: boolean;
  /** Columns never loaded and never mappable: names, phones, bank/routing digits. */
  forbidden: readonly string[];
};

export const FINANCING_COLUMNS = ["row", "date", "funding_date", "ref", "patient_ref", "gross_cents", "fee_cents", "bank_cents", "kind"] as const;
export const KINDS = ["sale", "refund"] as const;
export type Kind = (typeof KINDS)[number];
export type Sign = "positive" | "negative";

export type Item<T> = { value: T; verified: boolean; basis: string };
export type ColumnMap = { date: string; funding_date: string | null; ref: string | null; patient_ref: string | null; gross: string | null; fee: string | null; bank: string };
export type AmountFormat = { currencySymbols: string[]; parenthesesNegative: boolean; trailingMinusNegative: boolean };
export type KindRule = { column: string | null; map: Record<string, Kind>; default: Kind | null };
export type Identity = { name: string; enabled: boolean; left: string; plus: string[]; minus: string[]; emptyAsZero: boolean };
export type ProviderConfig = {
  dateFormats: string[]; dateYearRange: [number, number]; amountFormat: AmountFormat; columns: ColumnMap; kind: KindRule;
  expectSign: Partial<Record<Kind, Sign>>; identities: { toleranceCents: number; rules: Identity[] };
};
export const ITEMS = ["dateFormats", "dateYearRange", "amountFormat", "columns", "kind", "expectSign", "identities"] as const;

/** True when the first non-blank line is exactly this layout's header (BOM already removed by firstLines). */
export function detectLayout(layout: FinancingLayout, lines: readonly string[]): boolean {
  const h = headerOf(lines);
  const n = layout.headers.length;
  if (h.length < n || (h.length > n && !layout.trailingEmptyOk)) return false;
  return layout.headers.every((x, i) => h[i] === x) && h.slice(n).every((x) => x === "");
}

/** 0-based index of a header name; the name must appear exactly once in the layout and must not be forbidden. */
export function columnIndex(layout: FinancingLayout, name: string, where: string): number {
  if (layout.forbidden.includes(name)) throw new Error(`${where}: column "${name}" is never loaded (names, phones, bank digits)`);
  const at = layout.headers.flatMap((h, i) => (h === name ? [i] : []));
  if (at.length === 0) throw new Error(`${where}: "${name}" is not a column of this layout (${layout.headers.join(", ")})`);
  if (at.length > 1) throw new Error(`${where}: "${name}" appears ${at.length} times in this layout; it cannot be mapped`);
  return at[0];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const strList = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");

/**
 * The provider's slice of SourceOptions.configs.financing, checked against the layout. Returns the values and the names of
 * the items not yet verified. Throws with the item path on anything malformed (a config error is not a data finding).
 */
export function financingConfig(configs: Readonly<Record<string, unknown>> | undefined, layout: FinancingLayout): { cfg: ProviderConfig; unverified: string[] } {
  const raw = configs?.financing;
  const at = `financing config, provider ${layout.provider}`;
  const bad = (m: string): never => { throw new Error(`${at}: ${m}`); };
  if (raw === undefined) bad(`missing: the pack must name it (sourceConfigs.financing)`);
  if (!isObj(raw) || raw.version !== 1) bad("version must be 1");
  const prov = isObj((raw as Record<string, unknown>).providers) ? ((raw as Record<string, Record<string, unknown>>).providers)[layout.provider] : undefined;
  if (!isObj(prov)) bad("no such provider in providers");
  const out: Record<string, unknown> = {}; const unverified: string[] = [];
  for (const k of ITEMS) {
    const it = (prov as Record<string, unknown>)[k];
    if (!isObj(it) || !("value" in it) || typeof it.verified !== "boolean" || typeof it.basis !== "string" || !it.basis.trim()) bad(`${k} must be { value, verified (true|false), basis (text) }`);
    const item = it as Item<unknown>;
    out[k] = item.value; if (!item.verified) unverified.push(k);
  }
  const c = out as ProviderConfig;
  if (!strList(c.dateFormats) || c.dateFormats.length === 0 || c.dateFormats.some((f) => !/%[dmYyb]/.test(f))) bad("dateFormats.value must be a non-empty list of strptime formats");
  if (new Set(c.dateFormats).size !== c.dateFormats.length) bad("dateFormats.value lists a format twice");
  const yr = c.dateYearRange;
  if (!Array.isArray(yr) || yr.length !== 2 || !yr.every(Number.isInteger) || !(yr[0] <= yr[1])) bad("dateYearRange.value must be [first year, last year]");
  const af = c.amountFormat;
  if (!isObj(af) || !strList(af.currencySymbols) || typeof af.parenthesesNegative !== "boolean" || typeof af.trailingMinusNegative !== "boolean"
    || af.currencySymbols.some((s) => !s || /[0-9.,()\-]/.test(s))) bad("amountFormat.value needs currencySymbols (no digits, dot, comma, parentheses or minus), parenthesesNegative, trailingMinusNegative");
  const cm = c.columns;
  if (!isObj(cm)) bad("columns.value must be an object");
  for (const k of ["date", "funding_date", "ref", "patient_ref", "gross", "fee", "bank"] as const) {
    const v = cm[k];
    if (v === undefined || (v !== null && typeof v !== "string")) bad(`columns.value.${k} must be a header name or null`);
    if ((k === "date" || k === "bank") && v === null) bad(`columns.value.${k} is required`);
    if (v !== null) columnIndex(layout, v, `${at}: columns.value.${k}`);
  }
  for (const k of Object.keys(cm)) if (!["date", "funding_date", "ref", "patient_ref", "gross", "fee", "bank"].includes(k)) bad(`columns.value.${k} is not a canonical column`);
  const kr = c.kind;
  if (!isObj(kr) || !isObj(kr.map) || (kr.column !== null && typeof kr.column !== "string") || (kr.default !== null && !KINDS.includes(kr.default as Kind))) bad(`kind.value needs column (header or null), map (value -> ${KINDS.join("|")}), default (${KINDS.join("|")} or null)`);
  if (kr.column !== null) columnIndex(layout, kr.column, `${at}: kind.value.column`);
  if (kr.column === null && kr.default === null) bad("kind.value: with no column, default is required");
  if (kr.column === null && Object.keys(kr.map).length) bad("kind.value: map given but no column to read it from");
  if (kr.column !== null && kr.default !== null) bad("kind.value: default is used only when there is no column (an unmapped Type fails the check, never defaulted)");
  for (const [v, k] of Object.entries(kr.map)) if (!KINDS.includes(k)) bad(`kind.value.map["${v}"] must be ${KINDS.join(" or ")}`);
  if (!isObj(c.expectSign)) bad("expectSign.value must be an object (kind -> positive | negative)");
  for (const [k, s] of Object.entries(c.expectSign)) if (!KINDS.includes(k as Kind) || (s !== "positive" && s !== "negative")) bad(`expectSign.value.${k} must be a kind mapped to positive or negative`);
  const id = c.identities;
  if (!isObj(id) || !Number.isInteger(id.toleranceCents) || id.toleranceCents < 0 || !Array.isArray(id.rules)) bad("identities.value needs toleranceCents (integer >= 0) and rules (list)");
  for (const [i, r] of id.rules.entries()) {
    const w = `${at}: identities.value.rules[${i}]`;
    if (!isObj(r) || typeof r.name !== "string" || typeof r.enabled !== "boolean" || typeof r.left !== "string" || !strList(r.plus) || !strList(r.minus) || typeof r.emptyAsZero !== "boolean")
      throw new Error(`${w}: needs name, enabled, left, plus, minus, emptyAsZero`);
    for (const col of [r.left, ...r.plus, ...r.minus]) columnIndex(layout, col, w);
  }
  return { cfg: c, unverified };
}

// ---- SQL builders (text only; run by load.ts). Positional columns are "column0".."columnN" from read_csv(header = false).

export const col = (i: number): string => `"column${i}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** SQL: the text, trimmed, NULL when empty. */
export const textExpr = (i: number): string => `nullif(trim(${col(i)}), '')`;

/** SQL list of the distinct dates the text parses to under the accepted formats (NULLs dropped): 0 = unparseable, >1 = ambiguous. */
export const dateListExpr = (i: number, formats: readonly string[]): string =>
  `list_distinct([${formats.map((f) => `CAST(try_strptime(${textExpr(i)}, ${lit(f)}) AS DATE)`).join(", ")}])`;

/** SQL: the amount text normalised by the configured format (symbols and thousands commas removed, negatives made "-"). */
export function amountNormExpr(i: number, af: AmountFormat): string {
  let t = `replace(${textExpr(i)}, ' ', '')`;
  for (const s of af.currencySymbols) t = `replace(${t}, ${lit(s)}, '')`;
  t = `replace(${t}, ',', '')`;
  const parts = [`WHEN ${t} IS NULL THEN NULL`];
  if (af.parenthesesNegative) parts.push(`WHEN regexp_full_match(${t}, '\\(([0-9.]+)\\)') THEN '-' || regexp_extract(${t}, '\\(([0-9.]+)\\)', 1)`);
  if (af.trailingMinusNegative) parts.push(`WHEN regexp_full_match(${t}, '[0-9.]+-') THEN '-' || rtrim(${t}, '-')`);
  return `CASE ${parts.join(" ")} ELSE ${t} END`;
}
/** SQL: normalised amount text -> integer cents, NULL when it is not a plain amount with at most 2 decimals. */
export const centsFromNorm = (norm: string): string =>
  `CASE WHEN regexp_full_match(${norm}, '-?[0-9]+([.][0-9]{1,2})?') THEN CAST(round(CAST(${norm} AS DECIMAL(18, 2)) * 100) AS BIGINT) END`;

/** SQL: Type text -> kind through the configured map (NULL when unmapped), or the default when there is no Type column. */
export function kindExpr(kr: KindRule, layout: FinancingLayout): string {
  if (kr.column === null) return lit(kr.default!);
  const t = textExpr(columnIndex(layout, kr.column, "kind"));
  const whens = Object.entries(kr.map).map(([v, k]) => `WHEN ${t} = ${lit(v)} THEN ${lit(k)}`);
  return whens.length ? `CASE ${whens.join(" ")} ELSE NULL END` : "CAST(NULL AS VARCHAR)";
}

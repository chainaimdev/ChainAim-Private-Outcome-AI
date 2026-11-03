/**
 * Python's csv.writer with the default "excel" dialect (delimiter ',', quotechar '"', doublequote, no escapechar,
 * QUOTE_MINIMAL) and a caller-chosen lineterminator (Phase 4b-2). Source: CPython v3.10.12 Modules/_csv.c join_append_data
 * (a field is quoted when it holds the delimiter, the quotechar, or any character of the lineterminator; an embedded
 * quotechar is doubled), csv_writerow (None writes nothing; a record made of one empty field is written as "").
 * Callers convert non-string values the way Python's str() would (pyFloatStr, Dec.toString(), String(int)) before writing.
 */

export type CsvField = string | null;

export function csvRow(fields: readonly CsvField[], lineterminator = "\r\n"): string {
  const special = new Set([",", '"', ...lineterminator]);
  const out = fields.map((f) => {
    const s = f ?? "";
    let quoted = false;
    for (const ch of s) if (special.has(ch)) { quoted = true; break; }
    return quoted ? '"' + s.replaceAll('"', '""') + '"' : s;
  });
  if (fields.length > 0 && out.join(",") === "") out[out.length - 1] = '""';
  return out.join(",") + lineterminator;
}

/** csv.writer(buf, lineterminator=...).writerows(rows), optionally prefixed with U+FEFF as the generator's csv_text does. */
export function csvText(rows: readonly (readonly CsvField[])[], opts: { bom?: boolean; lineterminator?: string } = {}): string {
  return (opts.bom ? "\uFEFF" : "") + rows.map((r) => csvRow(r, opts.lineterminator ?? "\r\n")).join("");
}

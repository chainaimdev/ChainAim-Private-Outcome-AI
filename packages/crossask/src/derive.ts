/**
 * Possible derivations of a number the answer check could not find in the result (privateAI-design-31 §2). Pure.
 * When a model writes a figure that is not a value in the result, it has often worked it out itself (a column total, a row
 * count times a price, two cells multiplied). This finds the first simple arithmetic on the result that gives exactly the
 * figure, so the console can say what it equals. It is a hint, not a proof: the console words it as "equals" and keeps the
 * figure marked as not checked against the data. Exact in cents; nothing is rounded to make a match.
 */
export type ResultTable = { columns: string[]; rows: Record<string, unknown>[] };

/** Cents of a figure as written ("2,880", "$1,234.50", "(45.00)", "-12"), or null. */
export function figureCents(raw: string): number | null {
  const s = raw.trim();
  if (!/^\(?[-−]?\$?\d{1,3}(,\d{3})*(\.\d+)?\)?$|^\(?[-−]?\$?\d+(\.\d+)?\)?$/.test(s)) return null; // only text shaped like a figure
  const neg = /^\(.*\)$/.test(s) || /^[-−]/.test(s);
  const t = s.replace(/[^0-9.]/g, "");
  const v = Math.round(Number(t) * 100);
  return neg ? -v : v;
}

/** Cents of a result cell when it is a number or a plain numeric text ("480.00", "1,069.50"), else null. */
function cellCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
  if (typeof v === "bigint") return Number(v) * 100;
  if (typeof v === "string" && /^-?\$?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(v.trim())) return figureCents(v.trim());
  return null;
}
const show = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

/** A sentence fragment saying what the figure equals ("the total of Price over 6 rows"), or null when nothing simple does. */
export function deriveFigure(raw: string, table: ResultTable | null, maxRows = 500): string | null {
  const want = figureCents(raw);
  if (want === null || !table || !table.rows.length) return null;
  const rows = table.rows.slice(0, maxRows);
  const numeric = table.columns.filter((c) => rows.every((r) => r[c] === null || r[c] === undefined || cellCents(r[c]) !== null) && rows.some((r) => cellCents(r[c]) !== null));
  const n = rows.length;
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  // 1. a column total
  for (const c of numeric) {
    const sum = rows.reduce((s, r) => s + (cellCents(r[c]) ?? 0), 0);
    if (n > 1 && sum === want) return `the total of ${c} over ${plural(n, "row")}`;
  }
  // 2. the number of rows times a value of a column (e.g. 6 plans x 480.00)
  for (const c of numeric) {
    for (const v of new Set(rows.map((r) => cellCents(r[c])).filter((x): x is number => x !== null))) {
      if (n > 1 && v * n === want) return `${plural(n, "row")} × ${show(v)} (${c})`;
    }
  }
  // 3. two cells of the same row: product, sum, difference
  for (let i = 0; i < rows.length; i++) {
    for (const a of numeric) for (const b of numeric) {
      if (a === b) continue;
      const x = cellCents(rows[i][a]), y = cellCents(rows[i][b]);
      if (x === null || y === null) continue;
      if (a < b && x * y === want * 100) return `${a} × ${b} on row ${i + 1} (${show(x)} × ${show(y)})`;
      if (a < b && x + y === want) return `${a} + ${b} on row ${i + 1}`;
      if (x - y === want) return `${a} − ${b} on row ${i + 1}`;
    }
  }
  // 4. a column average (exact to the cent)
  for (const c of numeric) {
    const vals = rows.map((r) => cellCents(r[c])).filter((x): x is number => x !== null);
    if (vals.length > 1 && vals.reduce((s, x) => s + x, 0) === want * vals.length) return `the average of ${c} over ${plural(vals.length, "row")}`;
  }
  return null;
}

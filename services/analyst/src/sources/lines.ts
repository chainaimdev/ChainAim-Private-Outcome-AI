/** Helpers shared by source adapters: the first lines of a file (for layout detection) and one CSV line split into fields. */
import { open } from "node:fs/promises";

/** Up to `max` lines from the start of a file (reads at most `bytes`), BOM removed, line endings stripped. */
export async function firstLines(path: string, max = 12, bytes = 16384): Promise<string[]> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8").replace(/^﻿/, "").split(/\r?\n/).slice(0, max);
  } finally { await fh.close(); }
}

/** RFC 4180 fields of one line (quotes, doubled quotes, commas inside quotes). */
export function csvFields(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** "1,234.56" or "-656,973.74" -> integer cents; null when not a plain amount. */
export function cents(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** The header line (first non-blank line) as a list of trimmed names. */
export const headerOf = (lines: readonly string[]): string[] => csvFields(lines.find((l) => l.replace(/,/g, "").trim() !== "") ?? "").map((h) => h.trim());
export const sameHeaders = (lines: readonly string[], expected: readonly string[]): boolean => {
  const h = headerOf(lines);
  return h.length === expected.length && h.every((x, i) => x === expected[i]);
};
/** Like sameHeaders, but empty header cells after the expected ones are allowed (exports padded with trailing commas). */
export const sameHeadersPadded = (lines: readonly string[], expected: readonly string[]): boolean => {
  const h = headerOf(lines);
  return h.length >= expected.length && expected.every((x, i) => h[i] === x) && h.slice(expected.length).every((x) => x === "");
};

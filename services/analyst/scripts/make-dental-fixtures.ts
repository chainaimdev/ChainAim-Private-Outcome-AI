/**
 * make-dental-fixtures.ts: the TypeScript port of tools/dental-synth/gen_dental_set.py (Phase 4b-2), with the same flags,
 * defaults and outputs: four Curve/BofA CSV files plus _answer-key/truth.json and expected-matches.csv. For the same flags
 * every CSV is byte-identical to the Python script's and truth.json is equal as JSON apart from flags.out (proof:
 * tools/dental-synth/compare_port.py). Needs no Python. All generated data is SYNTHETIC.
 *
 *   node scripts/make-dental-fixtures.ts --out <dir> [--scenario pos|neg-all|neg-<leak>] [--seed N] [--leak-seed N]
 *        [--set-name SET1] [--start 2024-09-01] [--days 30] [--bank-tail-days 10] [--patients 260] [--providers 4]
 *        [--clinic S1] [--self-pay-share 0.25] [--cash-share 0.12] [--zero-invoice-share 0.08] [--min-invoices-day 6]
 *        [--max-invoices-day 12] [--claim-lag-days 5] [--first-id 300001] [--card-lag-days 1] [--card-fee-pct 2.9]
 *        [--card-fee-mode monthly|daily-net] [--merchant-id ...] [--practice-name ...] [--legal-name ...]
 *        [--opening-balance 120000] [--rent 6200] [--payroll 28000] [--patient-name-format last_first|first_last]
 *        [--hfd-lag-extra-days 5] [--short-max 50]
 * Exit 0 written; 1 the generator refused the flags (same messages as the Python script's SystemExit); 2 bad flags.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { FLAG_SPEC, GenError, generate, type DentalFlags } from "../src/synth/dental-gen.ts";

const usage = (msg: string): never => { process.stderr.write(`make-dental-fixtures: ${msg}\n`); process.exit(2); };
const kebab = (k: string) => k.replaceAll("_", "-");
let parsed: Record<string, string | undefined>;
try {
  parsed = parseArgs({ strict: true, allowPositionals: false,
    options: Object.fromEntries(Object.keys(FLAG_SPEC).map((k) => [kebab(k), { type: "string" as const }])) }).values as Record<string, string | undefined>;
} catch (e) { usage((e as Error).message); }

const flags: Record<string, unknown> = {};
for (const [k, spec] of Object.entries(FLAG_SPEC)) {
  const raw = parsed![kebab(k)];
  if (raw === undefined) { if (spec.dflt === undefined) usage(`--${kebab(k)} is required`); flags[k] = spec.dflt; continue; }
  if (spec.kind === "int") {
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) usage(`--${kebab(k)}: invalid int value: '${raw}'`);
    const v = Number(raw.trim()); if (!Number.isSafeInteger(v)) usage(`--${kebab(k)}: ${raw} is out of range`);
    flags[k] = v;
  } else if (spec.kind === "float") {
    const v = raw.trim() === "" ? NaN : Number(raw.trim());
    if (!Number.isFinite(v)) usage(`--${kebab(k)}: invalid float value: '${raw}'`);
    flags[k] = v;
  } else {
    if (spec.choices && !spec.choices.includes(raw)) usage(`--${kebab(k)}: invalid choice: '${raw}' (choose from ${spec.choices.join(", ")})`);
    flags[k] = raw;
  }
}

try {
  const a = flags as unknown as DentalFlags;
  const set = generate(a);
  for (const [rel, text] of set.files) { const p = join(a.out, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); }
  const t = set.truth as Record<string, unknown>;
  process.stdout.write(JSON.stringify({ counts: t.counts, posted: t.posted_to_bank_by_group, matched: t.matched_in_bank_by_group, bank: t.bank_totals }, null, 2) + "\n");
} catch (e) {
  if (e instanceof GenError) { process.stderr.write(e.message + "\n"); process.exit(1); }
  throw e;
}

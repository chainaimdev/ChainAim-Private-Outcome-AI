/**
 * Runs the deposit reconciliation on a folder and compares it with that folder's answer key (tools/dental-synth output:
 * _answer-key/expected-matches.csv and truth.json). Pass = every expected bank credit matched to exactly the expected Curve
 * payment IDs, nothing extra matched, the diagnosed exceptions equal truth.json's expected_exceptions (same code, date, amount
 * and payment IDs; Phase 4b-1), and every source check ok. Works for POS and every NEG scenario.
 *
 *   node scripts/reconcile-check.ts --folder <abs folder> [--answer-key <dir>] [--pack finance/rcm/dental]
 *        [--config-root <dir>] [--tolerance-cents N] [--patient-name-format last_first|first_last] [--json]
 * Exit 0 = pass, 1 = differences (listed), 2 = usage or setup error.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PackRegistry, SourceRegistry } from "../src/core/registry.ts";
import { openDb } from "../src/db.ts";
import { BUILT_IN_PACKS } from "../src/domain-packs/index.ts";
import { reconcileFolder } from "../src/reconcile.ts";
import { csvFields } from "../src/sources/lines.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { readdirSync, statSync } from "node:fs";

const { values: o } = parseArgs({ options: {
  folder: { type: "string" }, "answer-key": { type: "string" }, pack: { type: "string", default: "finance/rcm/dental" },
  "config-root": { type: "string", default: fileURLToPath(new URL("../../../config", import.meta.url)) },
  "tolerance-cents": { type: "string" }, "patient-name-format": { type: "string", default: "last_first" }, json: { type: "boolean", default: false },
} });
const usage = (m: string): never => { process.stderr.write(`reconcile-check: ${m}\n`); process.exit(2); };
if (!o.folder) usage("--folder is required");
const folder = resolve(o.folder!), keyDir = resolve(o["answer-key"] ?? join(folder, "_answer-key"));
const nf = o["patient-name-format"]; if (nf !== "last_first" && nf !== "first_last") usage("--patient-name-format must be last_first or first_last");
const tol = o["tolerance-cents"] === undefined ? null : Number(o["tolerance-cents"]);
if (tol !== null && !(Number.isInteger(tol) && tol >= 0)) usage("--tolerance-cents must be a non-negative integer");

const packs = new PackRegistry(); for (const p of BUILT_IN_PACKS) packs.register(p);
const sources = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) sources.register(a);
const files = readdirSync(folder).filter((n) => /\.(csv|tsv)$/i.test(n) && statSync(join(folder, n)).isFile()).sort().map((n) => ({ name: n, path: join(folder, n) }));
let report;
try { report = await reconcileFolder({ files, sources, pack: packs.resolve(o.pack!), configRoot: o["config-root"]!, sourceOptions: { patientNameFormat: nf as "last_first" }, toleranceCents: tol, open: openDb }); }
catch (e) { usage((e as Error).message); }

const iso = (mdy: string) => { const [m, d, y] = mdy.split("/").map(Number); return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; };
const lines = readFileSync(join(keyDir, "expected-matches.csv"), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
const head = csvFields(lines[0]);
const expected = lines.slice(1).map((l) => Object.fromEntries(csvFields(l).map((v, i) => [head[i], v])));
const truth = JSON.parse(readFileSync(join(keyDir, "truth.json"), "utf8"));
const r = report!.result.depositToBank;
const key = (date: string, cents: number, group: string, ids: string[]) => `${date}|${cents}|${group}|${[...ids].sort().join(";")}`;
const got = new Map(r.matched.map((m) => [key(m.bankDate, m.cents, m.group, m.paymentIds), m]));
const want = new Map(expected.map((e) => [key(iso(e.bank_date), Math.round(Number(e.bank_amount) * 100), e.group, e.curve_payment_ids.split(";").filter(Boolean)), e]));
const missing = [...want.keys()].filter((k) => !got.has(k)), extra = [...got.keys()].filter((k) => !want.has(k));
const l2d = report!.result.ledgerToDeposit;
const ekey = (code: string, date: string, cents: number, ids: (string | number)[]) => `${code}|${date}|${cents}|${ids.map(String).sort().join(";")}`;
const gotExc = new Map(report!.exceptions.map((e) => [ekey(e.code, e.date, e.cents, e.paymentIds), e]));
const wantExc = new Map((truth.expected_exceptions ?? []).map((e: { code: string; date: string; cents: number; payment_ids: number[] }) => [ekey(e.code, e.date, e.cents, e.payment_ids), e]));
const missingExc = [...wantExc.keys()].filter((k) => !gotExc.has(k)), extraExc = [...gotExc.keys()].filter((k) => !wantExc.has(k));
const exceptions = report!.exceptions.length, expectedExceptions = wantExc.size;
const failedChecks = report!.files.flatMap((f) => f.checks.filter((c) => !c.ok).map((c) => `${f.name}: ${c.name} (${c.detail})`));
const pass = !missing.length && !extra.length && !missingExc.length && !extraExc.length && !failedChecks.length;
const summary = { pass, pack: report!.pack, files: report!.files.map((f) => `${f.name}=${f.adapter ?? "unknown"}`), expectedMatches: want.size, matched: r.matched.length,
  missing, extra, exceptions, expectedExceptions, missingExceptions: missingExc, extraExceptions: extraExc, failedChecks, ledgerToDeposit: l2d && { checkedIds: l2d.checkedIds, matched: l2d.matched },
  unaliasedAch: r.unaliasedAch.length, otherCredits: r.otherCredits, aliasBases: [...new Set(r.matched.map((m) => m.aliasBasis).filter(Boolean))] };
if (o.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
else {
  process.stdout.write(`reconcile-check: ${pass ? "PASS" : "FAIL"} — matched ${r.matched.length}/${want.size} expected bank credits; exceptions ${exceptions} (expected ${expectedExceptions}); ledger<->deposit ${l2d ? `${l2d.matched}/${l2d.checkedIds} IDs` : "no ledger file"}\n`);
  for (const k of missing) process.stdout.write(`  missing match: ${k}\n`);
  for (const k of extra) process.stdout.write(`  unexpected match: ${k}\n`);
  for (const c of failedChecks) process.stdout.write(`  failed check: ${c}\n`);
  for (const k of missingExc) process.stdout.write(`  expected exception not found: ${k}\n`);
  for (const k of extraExc) process.stdout.write(`  unexpected exception: ${k} (${gotExc.get(k)!.detail})\n`);
  for (const e of report!.exceptions) process.stdout.write(`  ${e.severity === "watch" ? "watch    " : "exception"} ${e.code} ${e.date} ${(e.cents / 100).toFixed(2)} ${e.paymentIds.join(";")} - ${e.detail}\n`);
}
process.exit(pass ? 0 : 1);

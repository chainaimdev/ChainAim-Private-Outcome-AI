/**
 * Deposit reconciliation of one folder (POST /reconcile and scripts/reconcile-check.ts): detect each file's layout with the
 * registered source adapters, load the files, lock file access, run the pack's reconciliation engine. Core: it receives the
 * registries and the resolved pack; it never imports a plugin.
 */
import { join } from "node:path";
import { HttpError } from "./config.ts";
import type { LoadedSource, ResolvedPack, SourceOptions } from "./core/ports.ts";
import type { SourceRegistry } from "./core/registry.ts";
import { type Db, lockFiles } from "./db.ts";
import { type ReconcileResult, depositMatch, readReconcileConfig } from "./engines/deposit-match.ts";
import { type Exception, diagnose } from "./engines/deposit-diagnose.ts";
import { readSourceConfigs } from "./core/source-configs.ts";
import { firstLines } from "./sources/lines.ts";

/** Source ids the deposit reconciliation needs (required) or uses when present. */
export const RECONCILE_SOURCES = { deposit: "pms/curve-hero/deposit-detail", bank: "bank/bofa", ledger: "pms/curve-hero/ledger", patients: "pms/curve-hero/patient-list" } as const;

export type FileReport = { name: string; adapter: string | null; rows: number | null; checks: LoadedSource["checks"] };
export type ReconcileReport = { pack: string; packChain: string[]; files: FileReport[]; checksFailed: number; exceptions: Exception[]; result: ReconcileResult };

export async function reconcileFolder(o: { files: { name: string; path: string }[]; sources: SourceRegistry; pack: ResolvedPack; configRoot: string;
  sourceOptions: SourceOptions; toleranceCents: number | null; open: () => Promise<Db>;
  /** Phase 4c (scripts/dental.ts query): read the loaded tables and the report before the database closes. File access is
   * already locked; the hook gets source id -> table name. Optional; the report is the same with or without it. */
  inspect?: (db: Db, tables: Readonly<Record<string, string>>, report: ReconcileReport) => Promise<void> }): Promise<ReconcileReport> {
  if (!o.pack.reconcile) throw new HttpError(400, `pack ${o.pack.id} has no reconciliation config (use finance/rcm/dental)`);
  const { cfg, aliases } = readReconcileConfig(join(o.configRoot, o.pack.reconcile), o.configRoot);
  const sourceOptions: SourceOptions = { ...o.sourceOptions, configs: { ...readSourceConfigs(o.pack, o.configRoot), ...(o.sourceOptions.configs ?? {}) } };
  const byAdapter = new Map<string, { name: string; path: string }>();
  const files: FileReport[] = [];
  for (const f of o.files) {
    const hits = o.sources.detect(await firstLines(f.path));
    if (hits.length > 1) throw new HttpError(400, `${f.name}: matches more than one layout (${hits.map((h) => h.id).join(", ")})`);
    const id = hits[0]?.id ?? null;
    if (id && byAdapter.has(id)) throw new HttpError(400, `two files have the layout ${id}: ${byAdapter.get(id)!.name} and ${f.name}; keep one per folder`);
    if (id) byAdapter.set(id, f);
    files.push({ name: f.name, adapter: id, rows: null, checks: [] });
  }
  for (const need of [RECONCILE_SOURCES.deposit, RECONCILE_SOURCES.bank]) if (!byAdapter.has(need)) throw new HttpError(400, `no file with the layout ${need} in this folder (found: ${files.map((f) => `${f.name}=${f.adapter ?? "unknown"}`).join(", ")})`);
  const db = await o.open();
  try {
    const tables: Record<string, string> = {};
    for (const [id, f] of byAdapter) {
      const table = `src_${id.replace(/[^a-z0-9]+/g, "_")}`;
      const loaded = await o.sources.get(id).load(db, table, f.path, sourceOptions);
      tables[id] = table;
      const r = files.find((x) => x.name === f.name)!; r.rows = loaded.rows; r.checks = loaded.checks;
    }
    await lockFiles(db);
    const result = await depositMatch(db, { deposit: tables[RECONCILE_SOURCES.deposit], bank: tables[RECONCILE_SOURCES.bank], ledger: tables[RECONCILE_SOURCES.ledger] ?? null },
      cfg, aliases, o.toleranceCents ?? cfg.amountToleranceCents);
    const exceptions = await diagnose(db, { deposit: tables[RECONCILE_SOURCES.deposit], ledger: tables[RECONCILE_SOURCES.ledger] ?? null }, cfg, result);
    const report: ReconcileReport = { pack: o.pack.id, packChain: o.pack.chain, files, checksFailed: files.reduce((n, f) => n + f.checks.filter((c) => !c.ok).length, 0), exceptions, result };
    if (o.inspect) await o.inspect(db, tables, report);
    return report;
  } finally { db.close(); }
}

/**
 * Load-only domain-pack runs (DESIGN/xrplh-29, chiro CHIRO-1b-2 before stage 3): a pack with a query bank but no reconciliation
 * config. Every data file is claimed by its source layout (the same rules as reconcileFolder: one layout per file, one file per
 * layout), loaded into DuckDB, file access is locked, then the bank's TablesSpec views and file_checks are built and the caller's
 * inspect hook runs the exact (sql) entries. No matching, no exceptions, no fact sheets: model (question) entries need a
 * reconciliation and are refused by the caller. Owner decision 2026-11-06 (chiro: Table answers now, Explained after stage 3).
 */
import { HttpError } from "./config.ts";
import type { ResolvedPack, SourceOptions } from "./core/ports.ts";
import type { SourceRegistry } from "./core/registry.ts";
import { readSourceConfigs } from "./core/source-configs.ts";
import { type Db, lockFiles } from "./db.ts";
import { type TablesSpec, buildFileChecks, buildViews } from "./packquery.ts";
import { type FileReport, detectFiles } from "./reconcile.ts";

export type LoadReport = { pack: string; packChain: string[]; files: FileReport[]; checksFailed: number; views: string[] };

export async function loadPackFolder(o: { files: { name: string; path: string }[]; sources: SourceRegistry; pack: ResolvedPack; configRoot: string;
  sourceOptions: SourceOptions; spec: TablesSpec | undefined; open: () => Promise<Db>;
  /** Runs while the database is open, after the views exist; gets the report so far. */
  inspect?: (db: Db, report: LoadReport) => Promise<void> }): Promise<LoadReport> {
  if (o.pack.reconcile) throw new HttpError(400, `pack ${o.pack.id} has a reconciliation config: use the reconcile run`);
  const sourceOptions: SourceOptions = { ...o.sourceOptions, configs: { ...readSourceConfigs(o.pack, o.configRoot), ...(o.sourceOptions.configs ?? {}) } };
  const { byAdapter, files } = await detectFiles(o.files, o.sources);
  if (!byAdapter.size) throw new HttpError(400, `no file in this folder has a known layout (found: ${files.map((f) => f.name).join(", ") || "no data files"})`);
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
    await buildFileChecks(db, files);
    const views = await buildViews(db, tables, o.spec);
    const report: LoadReport = { pack: o.pack.id, packChain: o.pack.chain, files, checksFailed: files.reduce((n, f) => n + f.checks.filter((c) => !c.ok).length, 0), views };
    if (o.inspect) await o.inspect(db, report);
    return report;
  } finally { db.close(); }
}

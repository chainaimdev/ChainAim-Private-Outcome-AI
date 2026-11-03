/**
 * Ports: the interfaces between the analyst's core/engines and its plugins (decoupling Phase 3, DESIGN/xrplh-24 §5.3, §5.5).
 * One-way: core <- engines <- plugins. Plugins import this file; core and engines never import a plugin. Only main.ts (the
 * composition root) knows which plugins exist.
 *
 * Rule of two: DomainPack (finance-generic, finance/rcm, finance/rcm/dental) and SourceAdapter (Phase 4a: BofA statement,
 * Curve deposit detail, ledger and patient list). An Engine port waits for a second engine; deposit-match is the first.
 *
 * Role names (date, amount, debit, credit, party, reference, category) and measures (net, inflows, outflows, abs) are engine
 * terms (analyze.ts reads them by name), so they stay in core (profile.ts). A pack owns the domain's vocabulary of file
 * kinds and the rules that propose a recipe.
 */
import type { Db } from "../db.ts";

/** A domain pack as written: any field may be left out and comes from the pack it extends. */
export type DomainPack = {
  id: string;
  title: string;
  /** Explicit parent; the chain is at most 3 packs (e.g. finance -> rcm -> dental). */
  extends?: string;
  /** File kinds a recipe may use, in display order. */
  kinds?: readonly string[];
  /** Header-name pattern for each engine role, used to propose which column plays it. */
  nameHints?: readonly (readonly [string, RegExp])[];
  /** File kind from the file name (first) or its headers (second), first match wins. */
  kindHints?: readonly (readonly [string, RegExp])[];
  /** Party column, most useful first (e.g. payer before patient before free-text description). */
  partyPriority?: readonly RegExp[];
  /** Order of kinds in the proposed money flow. */
  flowOrder?: readonly string[];
  /** Kinds never put in the proposed flow (they are explained against it, e.g. adjustments). */
  excludeFromFlow?: readonly string[];
  /** Measure proposed for each kind. */
  defaultMeasure?: Readonly<Record<string, string>>;
  /** Kind given to a file no hint matches. */
  fallbackKind?: string;
  /** Optional: reconciliation config for this domain, a path under the config root (e.g. domain-packs/.../reconcile.json). */
  reconcile?: string;
  /**
   * Optional (Phase 4a.2): per-adapter configs, key -> a JSON file under the config root (e.g. financing ->
   * domain-packs/.../financing.json). Core reads each file and hands the parsed JSON to adapters as SourceOptions.configs[key];
   * core never interprets it, each adapter validates its own slice.
   */
  sourceConfigs?: Readonly<Record<string, string>>;
};

export const PACK_FIELDS = ["kinds", "nameHints", "kindHints", "partyPriority", "flowOrder", "excludeFromFlow", "defaultMeasure", "fallbackKind"] as const;
export type PackField = (typeof PACK_FIELDS)[number];
/** Fields a pack chain may leave unset; when set, provenance is reported like the required ones. */
export const OPTIONAL_PACK_FIELDS = ["reconcile", "sourceConfigs"] as const;
export type OptionalPackField = (typeof OPTIONAL_PACK_FIELDS)[number];

/** The effective pack after following `extends`: every field set, and where each one came from. */
export type ResolvedPack = { id: string; title: string; chain: string[]; from: Partial<Record<PackField | OptionalPackField, string>> }
  & { [K in PackField]-?: NonNullable<DomainPack[K]> } & { reconcile?: string; sourceConfigs?: Readonly<Record<string, string>> };

// ---- sources -------------------------------------------------------------------------------------------------

/** A check a source runs on its own file (e.g. a bank statement's totals); failures are reported, never hidden. */
export type SourceCheck = { name: string; ok: boolean; detail: string };
export type LoadedSource = { adapter: string; table: string; rows: number; checks: SourceCheck[]; meta: Record<string, unknown> };
/** configs: the pack's sourceConfigs files, parsed (key -> JSON); an adapter that needs one and finds none fails its load. */
export type SourceOptions = { patientNameFormat: "last_first" | "first_last"; configs?: Readonly<Record<string, unknown>> };

/**
 * A file format (layout), not a business rule: it recognises its layout from the file's first lines, then loads every row
 * into one DuckDB table with canonical column names (amounts as integer cents, dates as DATE, row = line in the file).
 * Packs name sources; sources never know packs.
 */
export type SourceAdapter = {
  id: string;
  title: string;
  /** Canonical columns of the loaded table. */
  columns: readonly string[];
  /** True when these first lines (BOM removed) are this layout. */
  detect(firstLines: readonly string[]): boolean;
  load(db: Db, table: string, path: string, opt: SourceOptions): Promise<LoadedSource>;
};

/**
 * Chain query contracts (DESIGN/xrplh-28 §3): the registry format, the rows every adapter returns, the field mapper used for
 * contract sources (JSON paths into a view-call result, never code in config), and address rules. Pure: no network, no fs
 * except loadRegistry, which reads one file.
 */
import { readFileSync } from "node:fs";

export type Capability = "payments" | "vaults" | "loans";
export const CAPABILITIES: readonly Capability[] = ["payments", "vaults", "loans"];

/** One way a vault or loan-term row is read: "native" ledger objects (XRPL) or a contract's view methods (NEAR and similar). */
export type MethodSpec = {
  view: string;
  args?: Record<string, unknown>;
  /** JSON path to the array of items in the result ("$" = the result itself). */
  list?: string;
  /** Output field -> JSON path inside one item. */
  map: Record<string, string>;
  /** Explicit conversions per output field. */
  units?: Record<string, UnitSpec | string>;
};
export type UnitSpec = { bpsToPercent?: boolean; tenthBpsToPercent?: boolean; decimals?: number; decimalsFrom?: string };
export type SourceSpec = {
  id: string; label?: string; kind: "native" | "own" | "protocol";
  contract?: string; repo?: string; docs?: string;
  methods?: { vaults?: MethodSpec; loanTerms?: MethodSpec };
  /** XRPL native: accounts whose owned Vault / LoanBroker entries are listed, and entries read by ID. */
  vaultOwners?: string[]; vaultIds?: string[]; loanBrokerIds?: string[];
};
export type EnvSpec = {
  label?: string;
  rpc: { http?: string; ws?: string; fallbacks?: string[] };
  caip2?: string; explorer?: string; explorerApi?: string; faucet?: string;
  capabilities: Capability[];
  sources: SourceSpec[];
};
export type ChainSpec = { label: string; adapter: string; addressRule: string; environments: Record<string, EnvSpec> };
export type Registry = { version: 1; notes?: string; chains: Record<string, ChainSpec> };

/** A vault as every adapter reports it. Amounts stay as the chain's own decimal strings unless a unit rule converted them. */
export type VaultRow = { chain: string; env: string; source: string; vaultId: string | null; owner: string | null; asset: string | null;
  available: string | null; total: string | null; maximum: string | null; extra?: Record<string, unknown> };
export type LoanTermRow = { chain: string; env: string; source: string; lender: string | null; available: string | null; structure: string | null;
  termMonths: string | null; annualRate: string | null; graceDays: string | null; lateFee: string | null; extra?: Record<string, unknown> };
export type SourceResult<T> = { source: string; rows: T[]; error?: string };

export class RegistryError extends Error {}

const PLACEHOLDER = /<PLACEHOLDER\b/;
/** True when a value (or anything inside it) is still a <PLACEHOLDER ...> marker. */
export function hasPlaceholder(v: unknown): boolean {
  if (typeof v === "string") return PLACEHOLDER.test(v);
  if (Array.isArray(v)) return v.some(hasPlaceholder);
  if (v && typeof v === "object") return Object.values(v).some(hasPlaceholder);
  return false;
}
/** The placeholder fields of a source, as dotted paths, so --validate and the UI can say exactly what is missing. */
export function placeholderPaths(v: unknown, at = ""): string[] {
  if (typeof v === "string") return PLACEHOLDER.test(v) ? [at || "(value)"] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => placeholderPaths(x, `${at}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => placeholderPaths(x, at ? `${at}.${k}` : k));
  return [];
}

/** Reads and checks config/chains/networks.json. The file keeps chains at the top level next to "version" and "notes". */
export function loadRegistry(path: string): Registry {
  let raw: Record<string, unknown>;
  try {
    const text = readFileSync(path, "utf8");
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) { throw new RegistryError(`cannot read the chain registry ${path}: ${(e as Error).message}`); }
  return parseRegistry(raw, path);
}
export function parseRegistry(raw: Record<string, unknown>, where = "registry"): Registry {
  if (raw.version !== 1) throw new RegistryError(`${where}: "version" must be 1`);
  const chains: Record<string, ChainSpec> = {};
  for (const [id, c] of Object.entries(raw)) {
    if (id === "version" || id === "notes") continue;
    if (!/^[a-z0-9-]+$/.test(id)) throw new RegistryError(`${where}: chain id "${id}" must be lowercase letters, digits or dashes`);
    const chain = c as ChainSpec;
    if (!chain || typeof chain !== "object" || typeof chain.adapter !== "string" || !chain.environments || typeof chain.environments !== "object")
      throw new RegistryError(`${where}: chain ${id} needs "adapter" and "environments"`);
    for (const [envId, env] of Object.entries(chain.environments)) {
      const at = `${where}: ${id}.${envId}`;
      if (!/^[a-z0-9-]+$/.test(envId)) throw new RegistryError(`${at}: environment id must be lowercase letters, digits or dashes`);
      if (!env.rpc || (typeof env.rpc.http !== "string" && typeof env.rpc.ws !== "string")) throw new RegistryError(`${at}: needs rpc.http or rpc.ws`);
      if (!Array.isArray(env.capabilities) || env.capabilities.some((x) => !CAPABILITIES.includes(x))) throw new RegistryError(`${at}: capabilities must be a list of ${CAPABILITIES.join(", ")}`);
      if (!Array.isArray(env.sources)) throw new RegistryError(`${at}: needs a "sources" list`);
      const seen = new Set<string>();
      for (const s of env.sources) {
        if (typeof s.id !== "string" || !s.id) throw new RegistryError(`${at}: every source needs an "id"`);
        if (!hasPlaceholder(s.id) && seen.has(s.id)) throw new RegistryError(`${at}: duplicate source id ${s.id}`);
        seen.add(s.id);
        if (!["native", "own", "protocol"].includes(s.kind)) throw new RegistryError(`${at}: source ${s.id}: kind must be native, own or protocol`);
      }
    }
    chains[id] = chain;
  }
  if (!Object.keys(chains).length) throw new RegistryError(`${where}: no chains`);
  return { version: 1, notes: typeof raw.notes === "string" ? raw.notes : undefined, chains };
}
export function findEnv(reg: Registry, chain: string, env: string): { chain: ChainSpec; env: EnvSpec } {
  const c = reg.chains[chain];
  if (!c) throw new RegistryError(`unknown chain "${chain}" (known: ${Object.keys(reg.chains).join(", ")})`);
  const e = c.environments[env];
  if (!e) throw new RegistryError(`unknown environment "${env}" for ${chain} (known: ${Object.keys(c.environments).join(", ")})`);
  return { chain: c, env: e };
}

// ---- JSON paths and the field mapper -----------------------------------------------------------------------------
/** Reads "$", "$.a.b", "$.a[0].b" or "$['a b']" from a value. Undefined when any step is missing. No filters or wildcards. */
export function jsonPath(value: unknown, path: string): unknown {
  if (typeof path !== "string" || !path.startsWith("$")) throw new RegistryError(`JSON path must start with $: ${path}`);
  const steps: (string | number)[] = [];
  const re = /\.([A-Za-z_][\w-]*)|\[(\d+)\]|\['([^']*)'\]/gy;
  re.lastIndex = 1;
  while (re.lastIndex < path.length) {
    const m = re.exec(path);
    if (!m) throw new RegistryError(`unsupported JSON path: ${path} (use $.a.b, $.a[0], $['a b'])`);
    steps.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]));
  }
  let cur: unknown = value;
  for (const s of steps) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
}
const asText = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Divides a non-negative or negative integer-like decimal string by 10^d exactly (no floating point), trimming zeros. */
export function shiftDecimals(v: string, d: number): string {
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new RegistryError(`cannot scale "${v}": not a decimal number`);
  if (!Number.isInteger(d) || d < 0 || d > 60) throw new RegistryError(`decimals must be 0..60, got ${d}`);
  const neg = v.startsWith("-"); const [w, f = ""] = (neg ? v.slice(1) : v).split(".");
  const digits = (w + f).replace(/^0+(?=\d)/, ""); const point = w.replace(/^0+(?=\d)/, "").length - d;
  const padded = point <= 0 ? "0".repeat(1 - point) + digits : digits;
  const p = Math.max(point, 1);
  const whole = padded.slice(0, p).replace(/^0+(?=\d)/, ""), frac = padded.slice(p).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return (neg && /[1-9]/.test(out) ? "-" : "") + out;
}
/** Applies one unit rule to a mapped value; the item is passed so decimalsFrom can read a sibling field. */
export function applyUnit(value: string | null, rule: UnitSpec | string | undefined, item: unknown): string | null {
  if (value === null || rule === undefined) return value;
  if (typeof rule === "string") throw new RegistryError(`unit rule is still text: ${rule}`);
  if (rule.bpsToPercent) return shiftDecimals(value, 2);
  if (rule.tenthBpsToPercent) return shiftDecimals(value, 3);
  if (rule.decimals !== undefined) return shiftDecimals(value, rule.decimals);
  if (rule.decimalsFrom !== undefined) {
    const d = Number(jsonPath(item, rule.decimalsFrom));
    if (!Number.isInteger(d)) throw new RegistryError(`decimalsFrom ${rule.decimalsFrom} is not an integer`);
    return shiftDecimals(value, d);
  }
  return value;
}
/** Maps a view-call result to rows: takes the list at spec.list, reads each mapped field, applies its unit rule. */
export function mapItems(result: unknown, spec: MethodSpec): Record<string, string | null>[] {
  const list = jsonPath(result, spec.list ?? "$");
  if (!Array.isArray(list)) throw new RegistryError(`${spec.list ?? "$"} is not a list in the ${spec.view} result`);
  return list.map((item) => {
    const row: Record<string, string | null> = {};
    for (const [field, path] of Object.entries(spec.map)) row[field] = applyUnit(asText(jsonPath(item, path)), spec.units?.[field], item);
    return row;
  });
}

// ---- address rules ------------------------------------------------------------------------------------------------
/** XRPL classic address shape (base58 alphabet, starts with r). Shape only: the checksum is not verified here. */
export const XRPL_CLASSIC = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
/** NEAR account ID rules: 2-64 chars, lowercase a-z 0-9 and - _ . separators (no leading/trailing/double separators), or a 64-hex implicit account. */
export const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function validAddress(rule: string, s: string): boolean {
  if (rule === "xrpl-classic") return XRPL_CLASSIC.test(s);
  if (rule === "near-account") return NEAR_ACCOUNT.test(s);
  throw new RegistryError(`unknown address rule ${rule}`);
}
/** "rn5h...gBej": enough to recognise, never the whole value. */
export function maskValue(s: string, keep = 4): string { return s.length <= keep * 2 + 1 ? "*".repeat(s.length) : `${s.slice(0, keep)}...${s.slice(-keep)}`; }

// ---- CSV ----------------------------------------------------------------------------------------------------------
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== "extra")))];
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

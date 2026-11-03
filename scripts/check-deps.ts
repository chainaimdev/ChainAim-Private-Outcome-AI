/**
 * Dependency rules for the repository (decoupling plan, DESIGN/xrplh-24 §5.5 and §7, xrplh-25 §4/§7). Run by `npm test`.
 * Reads every source file, finds every relative import and enforces config/deps/rules.json:
 *   - forbidden directions (package -> service/app/tool, service -> another service/app/tool, app -> service/app/tool,
 *     tool -> service/app), except entries in "allow" (each with a reason and the phase that removes it);
 *   - no import cycle between units, except the unit sets in "allowCycles";
 *   - every relative import resolves to a file inside the repository;
 *   - ratchet: an "allow" or "allowCycles" entry that nothing needs any more is an error (--allow-stale to report only).
 * Seen: static import/export ... from, side-effect import, import("..."), require("..."), single or double quotes.
 * Not seen: specifiers built at run time; import-like text inside strings IS seen, so files holding it as data are listed
 * in "ignoreFiles" with a reason. Also not seen: paths in strings passed to spawn/exec, non-relative (package-name) imports.
 *
 *   node scripts/check-deps.ts [--root <dir>] [--rules <file>] [--format text|json] [--allow-stale]
 * Exit 0 = clean, 1 = violations, 2 = usage or rules file error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Kind = "package" | "service" | "app" | "tool";
type UnitRule = { prefix: string; kind: Kind; unit?: string; why?: string };
type Forbid = { from: Kind; to: Kind[]; why: string };
type Allow = { from: string; to: string; fromPath?: string; reason: string; until: string };
type AllowCycle = { units: string[]; reason: string; until: string };
type IgnoreFile = { path: string; reason: string };
type Rules = { version: 1; ignoreDirs: string[]; ignoreFiles?: IgnoreFile[]; extensions: string[]; units: UnitRule[]; forbid: Forbid[]; allow: Allow[]; allowCycles: AllowCycle[] };
type Edge = { file: string; line: number; spec: string; target: string; from: string; to: string; fromKind: Kind; toKind: Kind };
type Problem = { rule: string; message: string; where?: string };

const here = dirname(fileURLToPath(import.meta.url));
const { values: o } = parseArgs({
  options: {
    root: { type: "string", default: resolve(here, "..") },
    rules: { type: "string" },
    format: { type: "string", default: "text" },
    "allow-stale": { type: "boolean", default: false },
  },
});
const usage = (m: string): never => { process.stderr.write(`check-deps: ${m}\n`); process.exit(2); };
if (o.format !== "text" && o.format !== "json") usage("--format must be text or json");
const root = resolve(o.root!);
const rulesPath = resolve(o.rules ?? join(root, "config", "deps", "rules.json"));
let rules: Rules;
try { rules = JSON.parse(readFileSync(rulesPath, "utf8")); } catch (e) { usage(`cannot read ${rulesPath}: ${(e as Error).message}`); }
if (rules!.version !== 1 || !Array.isArray(rules!.units) || !Array.isArray(rules!.forbid)) usage(`${rulesPath}: not a version 1 rules file`);
rules!.allow ??= []; rules!.allowCycles ??= []; rules!.ignoreFiles ??= [];
const R = rules!;
const posix = (p: string) => p.split(sep).join("/");

// ---- files ---------------------------------------------------------------------------------------------------
const files: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!R.ignoreDirs.includes(e.name)) walk(join(dir, e.name)); }
    else if (e.isFile() && R.extensions.includes(extname(e.name)) && !e.name.endsWith(".d.ts")) files.push(join(dir, e.name));
  }
})(root);
// Files whose import-like text is data (e.g. this script's own test fixtures). Each needs a reason; a missing one is an error.
for (const ig of R.ignoreFiles!) {
  const i = files.findIndex((f) => posix(relative(root, f)) === ig.path);
  if (i === -1) usage(`ignoreFiles: ${ig.path} not found (remove the entry)`); else files.splice(i, 1);
}

// ---- units -----------------------------------------------------------------------------------------------------
function unitOf(rel: string): { unit: string; kind: Kind } {
  const parts = rel.split("/");
  for (const u of R.units) {
    const pre = u.prefix === "" ? [] : u.prefix.split("/");
    if (pre.length > parts.length - 1 && u.prefix !== "") continue;
    if (!pre.every((p, i) => p === "*" || p === parts[i])) continue;
    return { unit: u.unit ?? pre.map((p, i) => (p === "*" ? parts[i] : p)).join("/"), kind: u.kind };
  }
  return usage(`no unit rule matches ${rel} (add a catch-all with prefix "")`);
}

// ---- imports -----------------------------------------------------------------------------------------------------
const STATIC = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
const SIDE = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
const DYNAMIC = /\b(?:import|require)\(\s*(['"])([^'"\n]+)\1\s*\)/g;
function specifiers(text: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  const commented = (i: number) => { const s = text.lastIndexOf("\n", i) + 1; const t = text.slice(s, i).trimStart(); return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"); };
  for (const re of [STATIC, SIDE]) for (const m of text.matchAll(re)) if (!commented(m.index! + m[0].search(/\S/))) out.push({ spec: m[2], line: lineAt(m.index! + m[0].search(/\S/)) });
  for (const m of text.matchAll(DYNAMIC)) if (!commented(m.index!)) out.push({ spec: m[2], line: lineAt(m.index!) });
  return out;
}
function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const tries = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")];
  for (const t of tries) { try { if (statSync(t).isFile()) return t; } catch { /* next */ } }
  return null;
}

const problems: Problem[] = [];
const edges: Edge[] = [];
for (const f of files) {
  const rel = posix(relative(root, f));
  const from = unitOf(rel);
  for (const { spec, line } of specifiers(readFileSync(f, "utf8"))) {
    if (!spec.startsWith(".")) continue;
    const where = `${rel}:${line}`;
    const t = resolveSpec(f, spec);
    if (!t) { problems.push({ rule: "unresolved", message: `"${spec}" does not resolve to a file`, where }); continue; }
    const trel = posix(relative(root, t));
    if (trel.startsWith("..")) { problems.push({ rule: "outside-root", message: `"${spec}" leaves the repository`, where }); continue; }
    const to = unitOf(trel);
    if (to.unit !== from.unit) edges.push({ file: rel, line, spec, target: trel, from: from.unit, to: to.unit, fromKind: from.kind, toKind: to.kind });
  }
}

// ---- direction rules + allowlist -------------------------------------------------------------------------------
const used = new Map<Allow, number>();
for (const e of edges) {
  const rule = R.forbid.find((r) => r.from === e.fromKind && r.to.includes(e.toKind));
  if (!rule) continue;
  const ok = R.allow.find((a) => a.from === e.from && a.to === e.to && (!a.fromPath || e.file.startsWith(a.fromPath)));
  if (ok) { used.set(ok, (used.get(ok) ?? 0) + 1); continue; }
  problems.push({ rule: "direction", message: `${e.from} (${e.fromKind}) -> ${e.to} (${e.toKind}): ${rule.why}`, where: `${e.file}:${e.line} "${e.spec}"` });
}
for (const a of R.allow) if (!used.has(a)) problems.push({ rule: "stale-allow", message: `allow ${a.from} -> ${a.to}${a.fromPath ? ` (${a.fromPath})` : ""} is no longer needed: remove it from the rules file` });

// ---- cycles between units (Tarjan) -----------------------------------------------------------------------------
const graph = new Map<string, Set<string>>();
for (const e of edges) { if (!graph.has(e.from)) graph.set(e.from, new Set()); graph.get(e.from)!.add(e.to); if (!graph.has(e.to)) graph.set(e.to, new Set()); }
const sccs: string[][] = [];
{
  let n = 0; const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), st: string[] = [];
  const visit = (v: string) => {
    idx.set(v, n); low.set(v, n); n++; st.push(v); on.add(v);
    for (const w of graph.get(v)!) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) { const c: string[] = []; let w: string; do { w = st.pop()!; on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c.sort()); }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
for (const c of sccs) if (!R.allowCycles.some((a) => sameSet(a.units, c))) {
  const sample = edges.filter((e) => c.includes(e.from) && c.includes(e.to)).map((e) => `${e.file}:${e.line}`).slice(0, 4);
  problems.push({ rule: "cycle", message: `import cycle between ${c.join(" <-> ")}`, where: sample.join(", ") });
}
for (const a of R.allowCycles) if (!sccs.some((c) => sameSet(a.units, c))) problems.push({ rule: "stale-allow", message: `allowCycles ${a.units.join(" <-> ")} is no longer needed: remove it from the rules file` });

// ---- report --------------------------------------------------------------------------------------------------
const failing = problems.filter((p) => !(o["allow-stale"] && p.rule === "stale-allow"));
const allowed = R.allow.map((a) => ({ from: a.from, to: a.to, fromPath: a.fromPath, imports: used.get(a) ?? 0, until: a.until }));
if (o.format === "json") process.stdout.write(JSON.stringify({ files: files.length, crossUnitImports: edges.length, problems, allowed }, null, 2) + "\n");
else {
  for (const p of problems) process.stdout.write(`${failing.includes(p) ? "FAIL" : "warn"} [${p.rule}] ${p.message}${p.where ? `\n     at ${p.where}` : ""}\n`);
  process.stdout.write(`check-deps: ${files.length} files, ${edges.length} cross-unit imports; allowed until a later phase: ${allowed.map((a) => `${a.from}->${a.to} ${a.imports} (${a.until})`).join("; ") || "none"}\n`);
  process.stdout.write(failing.length ? `check-deps: ${failing.length} problem(s)\n` : "check-deps: OK\n");
}
process.exit(failing.length ? 1 : 0);

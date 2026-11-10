/**
 * The agent image (services/paywall/agent.Dockerfile, compose service "agent", architecture-tab03-agent-mode.md ARCH-310)
 * holds every file agent-jobs.ts loads at run time. Since privateAI-design-32 ARCH-620 the agent imports
 * packages/agent-policy, outside services/, so the build context moved to the repository root; this guard is the
 * agent's twin of console-docker.test.ts "ARCH-615 ... console image" (the console image once started without
 * packages/receipt). Files only: no Docker is run here; the image itself is built by desk.ps1 / up.ps1 -Build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(ROOT, "services/paywall/scripts/agent-jobs.ts");
const DOCKERFILE = join(ROOT, "services/paywall/agent.Dockerfile");
const IGNORE = join(ROOT, "services/paywall/agent.Dockerfile.dockerignore");
const COMPOSE = join(ROOT, "docker-compose.yml");

// As console-docker.test.ts: `import type` loads nothing (type stripping) and is skipped; every other import counts.
const STATIC_IMPORT = /^\s*(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function runtimeImports(entry: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs: string[] = [];
    for (const m of src.matchAll(STATIC_IMPORT)) if (!/^type\s/.test(m[1])) specs.push(m[2]);
    for (const m of src.matchAll(SIDE_EFFECT_IMPORT)) specs.push(m[1]);
    for (const m of src.matchAll(DYNAMIC_IMPORT)) specs.push(m[1]);
    for (const s of specs) {
      if (!s.startsWith(".")) { bare.add(s); continue; }
      const target = resolve(dirname(file), s);
      assert.ok(existsSync(target), `${relative(ROOT, file)} imports ${s}, which does not exist`);
      visit(target);
    }
  };
  visit(entry);
  return { files: [...seen].map((f) => relative(ROOT, f).split(sep).join("/")).sort(), bare: [...bare].sort() };
}

/** COPY sources (repository-relative, as written); --from stages are not the build context. */
function copySources(dockerfile: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(dockerfile, "utf8").split(/\r?\n/)) {
    const m = /^\s*COPY\s+(.*)$/i.exec(line);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    if (parts.some((p) => p.startsWith("--from"))) continue;
    out.push(...parts.filter((p) => !p.startsWith("--")).slice(0, -1).map((p) => p.replace(/\/+$/, "")));
  }
  return out;
}
const under = (file: string, path: string) => file === path || file.startsWith(path + "/");

/** Whether the ignore file keeps `file` (last matching line wins); only the pattern shapes used here are understood. */
function keptByIgnore(ignoreFile: string, file: string): boolean {
  let kept = true;
  for (const raw of readFileSync(ignoreFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const neg = line.startsWith("!");
    const p = neg ? line.slice(1) : line;
    let hit: boolean;
    if (p === "*") hit = true;
    else if (/^\*\*\/\*\.[A-Za-z0-9]+$/.test(p)) hit = file.endsWith(p.slice(4));
    else if (/^\*\*\/[A-Za-z0-9._-]+$/.test(p)) hit = file.split("/").includes(p.slice(3));
    else if (/^[A-Za-z0-9._/-]+$/.test(p)) hit = under(file, p.replace(/\/+$/, ""));
    else throw new Error(`${relative(ROOT, ignoreFile)}: pattern ${line} is not one this check understands; extend keptByIgnore`);
    if (hit) kept = neg;
  }
  return kept;
}

test("ARCH-310 ARCH-620: every module agent-jobs.ts loads at run time is copied by agent.Dockerfile and kept by its ignore file; npm packages are the paywall's", () => {
  const { files, bare } = runtimeImports(ENTRY);
  assert.ok(files.includes("packages/agent-policy/src/index.ts"), "the walk follows agent-jobs-core.ts into packages/agent-policy");
  const sources = copySources(DOCKERFILE);
  const notCopied = files.filter((f) => !sources.some((s) => under(f, s)));
  assert.deepEqual(notCopied, [], `agent.Dockerfile does not COPY: ${notCopied.join(", ")}`);
  const ignored = files.filter((f) => !keptByIgnore(IGNORE, f));
  assert.deepEqual(ignored, [], `agent.Dockerfile.dockerignore leaves out: ${ignored.join(", ")}`);
  // npm packages: installed by `npm ci --include=dev` from services/paywall's lockfile; a deep import names its package.
  const pkg = JSON.parse(readFileSync(join(ROOT, "services/paywall/package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const installed = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const nameOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  const missing = bare.filter((b) => !b.startsWith("node:") && !installed.has(nameOf(b)));
  assert.deepEqual(missing, [], `agent-jobs.ts loads npm packages services/paywall does not install: ${missing.join(", ")}`);
});

test("ARCH-620: the check itself catches a module the image would miss (packages/agent-policy without its COPY line)", () => {
  const sources = copySources(DOCKERFILE).filter((s) => !s.startsWith("packages/agent-policy"));
  const missed = runtimeImports(ENTRY).files.filter((f) => !sources.some((s) => under(f, s)));
  assert.deepEqual(missed, ["packages/agent-policy/src/index.ts"]);
});

test("ARCH-620: the ignore file keeps no secret, env file, tenant file or test in the build context", () => {
  for (const f of ["rig/tenants/t01/tenant.json", "services/paywall/test/agent-policy.test.ts", "test-console/local-gateway-key.txt", "services/paywall/.env", "runtime/agent-spend/t01/spend-2026-11-10.jsonl", "packages/agent-policy/test/policy.test.ts"]) {
    assert.equal(keptByIgnore(IGNORE, f), false, `${f} would be in the build context`);
  }
});

test("ARCH-620: compose builds the agent from the repository root and keeps its spend ledger on the volume the image's default --spend-dir names", () => {
  const compose = readFileSync(COMPOSE, "utf8");
  const agent = compose.slice(compose.indexOf("\n  agent:\n"), compose.indexOf("\n  attest:\n"));
  assert.match(agent, /build: \{ context: \., dockerfile: services\/paywall\/agent\.Dockerfile,/);
  assert.match(agent, /- chainaim-agent-spend:\/data\/spend/);
  assert.match(compose, /^  chainaim-agent-spend:$/m);
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  assert.match(dockerfile, /RUN mkdir -p \/data\/spend && chown node:node \/data\/spend/);
  assert.match(dockerfile, /"--spend-dir", "\/data\/spend"\]/);
  assert.match(readFileSync(join(ROOT, "test-console/up.ps1"), "utf8"), /"--agent-policy=on", "--spend-dir=\/data\/spend"/);
});

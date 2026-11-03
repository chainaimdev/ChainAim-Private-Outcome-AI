/** scripts/check-deps.ts on small temporary repositories: one case per rule and per import syntax. Synthetic files only. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../check-deps.ts", import.meta.url));
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type Extra = { allow?: unknown[]; allowCycles?: unknown[]; ignoreFiles?: unknown[] };
function repo(files: Record<string, string>, extra: Extra = {}): string {
  const root = mkdtempSync(join(tmpdir(), "check-deps-")); roots.push(root);
  const rules = { version: 1, ignoreDirs: ["node_modules", ".git", "dist", "data"], extensions: [".ts", ".js", ".mjs"],
    units: [{ prefix: "packages/*", kind: "package" }, { prefix: "services/*", kind: "service" }, { prefix: "apps/*", kind: "app" },
      { prefix: "tools/*", kind: "tool" }, { prefix: "scripts", unit: "services/gateway", kind: "service" }, { prefix: "", unit: "services/gateway", kind: "service" }],
    forbid: [{ from: "package", to: ["service", "app", "tool"], why: "pkg" }, { from: "service", to: ["service", "app", "tool"], why: "svc" },
      { from: "app", to: ["service", "app", "tool"], why: "app" }, { from: "tool", to: ["service", "app"], why: "tool" }],
    allow: extra.allow ?? [], allowCycles: extra.allowCycles ?? [], ignoreFiles: extra.ignoreFiles ?? [] };
  for (const [p, body] of Object.entries({ ...files, "config/deps/rules.json": JSON.stringify(rules) })) {
    mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body);
  }
  return root;
}
const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [script, "--root", root, "--format", "json", ...args], { encoding: "utf8" });
  return { status: r.status, out: r.status === 2 ? null : JSON.parse(r.stdout), err: r.stderr };
};
const rulesOf = (r: ReturnType<typeof run>) => r.out.problems.map((p: { rule: string }) => p.rule).sort();

test("clean: service and app may import packages; packages may import packages; same-unit imports are free", () => {
  const r = run(repo({ "packages/a/src/index.ts": `import { b } from "../../b/src/index.ts";\nexport const a = b;`, "packages/b/src/index.ts": "export const b = 1;",
    "services/s/src/main.ts": `import { a } from "../../../packages/a/src/index.ts";\nimport { x } from "./x.ts";`, "services/s/src/x.ts": "export const x = 1;",
    "apps/c/main.ts": `import { a } from "../../packages/a/src/index.ts";` }));
  assert.equal(r.status, 0); assert.deepEqual(r.out.problems, []);
});
test("a package importing a service fails, naming the file, line and specifier", () => {
  const r = run(repo({ "packages/p/src/index.ts": `export const z = 0;\nimport { s } from "../../../services/s/src/s.ts";`, "services/s/src/s.ts": "export const s = 1;" }));
  assert.equal(r.status, 1); assert.deepEqual(rulesOf(r), ["direction"]);
  assert.match(r.out.problems[0].where, /packages\/p\/src\/index\.ts:2 "\.\.\/\.\.\/\.\.\/services\/s\/src\/s\.ts"/);
});
test("service -> service, app -> service and tool -> service fail; package -> tool fails", () => {
  const r = run(repo({ "services/s/a.ts": `import "../t/b.ts";`, "services/t/b.ts": "", "apps/c/m.ts": `import { b } from "../../services/t/b.ts";`,
    "tools/g/g.ts": `import { b } from '../../services/t/b.ts';`, "packages/p/i.ts": `export * from "../../tools/g/g.ts";` }));
  assert.equal(r.status, 1); assert.equal(rulesOf(r).filter((x: string) => x === "direction").length, 4);
});
test("sees import(), require(), single quotes, export-from and multi-line imports; ignores commented-out imports", () => {
  const r = run(repo({ "services/s/a.ts": [
    `const m = await import('../t/b.ts');`, `const r = require("../t/b.ts");`, `export { b } from '../t/b.ts';`, `import {\n  b as c,\n} from "../t/b.ts";`,
    `// import { b } from "../t/b.ts";`, `/* import("../t/b.ts") */`, ` * import { b } from "../t/b.ts";`].join("\n"), "services/t/b.ts": "export const b = 1;" }));
  assert.equal(r.status, 1); assert.equal(r.out.problems.length, 4);
});
test("allow entries pass the matching imports only (fromPath scopes them), and a stale entry fails unless --allow-stale", () => {
  const files = { "services/s/test/a.test.ts": `import "../../t/b.ts";`, "services/s/src/a.ts": `import "../../t/b.ts";`, "services/t/b.ts": "" };
  const scoped = run(repo(files, { allow: [{ from: "services/s", to: "services/t", fromPath: "services/s/test/", reason: "r", until: "P9" }] }));
  assert.equal(scoped.status, 1); assert.deepEqual(rulesOf(scoped), ["direction"]); assert.match(scoped.out.problems[0].where, /src\/a\.ts/);
  const stale = repo({ "services/s/a.ts": "" }, { allow: [{ from: "services/s", to: "services/t", reason: "r", until: "P9" }] });
  assert.equal(run(stale).status, 1); assert.deepEqual(rulesOf(run(stale)), ["stale-allow"]);
  assert.equal(run(stale, "--allow-stale").status, 0);
});
test("a cycle between units fails unless its exact unit set is in allowCycles; a stale allowCycles entry fails", () => {
  const files = { "services/s/a.ts": `import "../t/b.ts";`, "services/t/b.ts": `import "../s/a.ts";` };
  const allow = [{ from: "services/s", to: "services/t", reason: "r", until: "P" }, { from: "services/t", to: "services/s", reason: "r", until: "P" }];
  assert.deepEqual(rulesOf(run(repo(files, { allow }))), ["cycle"]);
  assert.equal(run(repo(files, { allow, allowCycles: [{ units: ["services/t", "services/s"], reason: "r", until: "P" }] })).status, 0);
  assert.deepEqual(rulesOf(run(repo({ "services/s/a.ts": "" }, { allowCycles: [{ units: ["services/s", "services/t"], reason: "r", until: "P" }] }))), ["stale-allow"]);
});
test("an import that resolves to no file fails; .js resolves to the .ts source; a path to a file outside the repo fails", () => {
  const root = repo({ "packages/p/a.ts": `import "./missing.ts";\nimport { b } from "./b.js";\nimport "../../../outside-of-repo.ts";`, "packages/p/b.ts": "export const b = 1;" });
  writeFileSync(join(root, "..", "outside-of-repo.ts"), ""); roots.push(join(root, "..", "outside-of-repo.ts"));
  const r = run(root);
  assert.equal(r.status, 1); assert.deepEqual(rulesOf(r), ["outside-root", "unresolved"]);
  assert.ok(r.out.problems.some((p: { rule: string; message: string }) => p.rule === "unresolved" && /missing\.ts/.test(p.message)));
});
test("root scripts and the gateway are one unit: no violation between them", () => {
  const r = run(repo({ "scripts/stub.ts": `import { g } from "../services/gateway/src/g.ts";`, "services/gateway/src/g.ts": "export const g = 1;", "services/gateway/test/t.ts": `import "../../../scripts/stub.ts";` }));
  assert.equal(r.status, 0);
});
test("ignoreFiles skips a file whose import text is data; an entry for a missing file is a rules error (exit 2)", () => {
  const files = { "packages/p/fixture.ts": `const text = "import { s } from '../../services/s/s.ts'";\nimport("../../services/s/s.ts");`, "services/s/s.ts": "" };
  assert.equal(run(repo(files)).status, 1);
  assert.equal(run(repo(files, { ignoreFiles: [{ path: "packages/p/fixture.ts", reason: "data" }] })).status, 0);
  assert.equal(run(repo({ "packages/p/a.ts": "" }, { ignoreFiles: [{ path: "packages/p/gone.ts", reason: "data" }] })).status, 2);
});
test("usage and rules errors exit 2", () => {
  assert.equal(spawnSync(process.execPath, [script, "--format", "xml"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, "--rules", join(tmpdir(), "no-such-rules.json")], { encoding: "utf8" }).status, 2);
});

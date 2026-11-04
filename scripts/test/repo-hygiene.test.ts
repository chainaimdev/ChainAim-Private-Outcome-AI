/**
 * Inputs and outputs never reach git or a Docker image (DESIGN/xrplh-29): sample datasets (sample-data/), anything a program writes
 * (runtime/, data/), per-PC settings (config/local/, config/data-sources.json) and secrets. Checks the ignore files with git itself
 * when git is available, and the file text always.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const lines = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8").split(/\r?\n/).map((l) => l.trim());

test(".gitignore ignores inputs, outputs, per-PC settings and secrets", () => {
  const g = lines(".gitignore");
  for (const entry of ["sample-data/", "runtime/", "data/", "config/local/*", "!config/local/*.example.json", "config/data-sources.json", ".env", "secrets/"])
    assert.ok(g.includes(entry), `.gitignore lacks ${entry}`);
});

test("git agrees: a sample file, a runtime file and a local profile are ignored; the example profile is not", (t) => {
  const probe = ["sample-data/x/y.csv", "runtime/logs/x.log", "data/x.json", "config/local/chain-profile.json", "config/data-sources.json"];
  const r = spawnSync("git", ["-C", repo, "check-ignore", "--no-index", ...probe], { encoding: "utf8" });
  if (r.error) { t.skip("git is not available here"); return; }
  const ignored = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
  for (const p of probe) assert.ok(ignored.has(p), `git does not ignore ${p}`);
  const ex = spawnSync("git", ["-C", repo, "check-ignore", "--no-index", "config/local/chain-profile.example.json"], { encoding: "utf8" });
  assert.equal(ex.status, 1, "the example profile must stay committable");
});

test(".dockerignore keeps data, outputs and per-PC settings out of every image built from the repository root", () => {
  const d = lines(".dockerignore");
  for (const entry of ["sample-data", "runtime", "data", "config/local", "config/data-sources.json", ".env", "secrets"])
    assert.ok(d.includes(entry), `.dockerignore lacks ${entry}`);
});

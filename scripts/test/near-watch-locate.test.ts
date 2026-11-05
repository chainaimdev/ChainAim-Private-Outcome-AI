/**
 * privateAI-design-31 §4: where the near-watch checkout is for the ARCH-205 tests, so they are not tied to one folder
 * layout. Order: env NEAR_WATCH_DIR, then config/local/repos.json nearWatchDir, then the sibling folder; a relative path is
 * resolved from the repository root; not found -> skipped with the reason, unless REQUIRE_NEAR_WATCH=1. Pure: a temp
 * folder stands in for the repository root and for the checkout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { locateNearWatch, nearWatchMissing, nearWatchSkip } from "./near-watch-server.ts";

/** <base>/repos/private-ai (the root) and <base>/other/adminUI/services/near-watch/src/server.ts (a checkout). */
function layout(reposJson?: string) {
  const base = mkdtempSync(join(tmpdir(), "nw-"));
  const root = join(base, "repos", "private-ai");
  const nw = join(base, "other", "adminUI", "services", "near-watch");
  mkdirSync(join(root, "config", "local"), { recursive: true });
  mkdirSync(join(nw, "src"), { recursive: true });
  writeFileSync(join(nw, "src", "server.ts"), "// stand-in\n");
  if (reposJson !== undefined) writeFileSync(join(root, "config", "local", "repos.json"), reposJson);
  return { base, root, nw };
}

test("the env wins; a relative env path is resolved from the repository root, not the current folder", () => {
  const { root, nw } = layout(JSON.stringify({ nearWatchDir: "/nowhere" }));
  assert.deepEqual(locateNearWatch(root, { NEAR_WATCH_DIR: nw }), { dir: resolve(nw), source: "env NEAR_WATCH_DIR", found: true });
  const rel = locateNearWatch(root, { NEAR_WATCH_DIR: "../../other/adminUI/services/near-watch" });
  assert.equal(rel.dir, resolve(nw)); assert.equal(rel.found, true);
});

test("config/local/repos.json: relative (from the root) or absolute; a blank env is ignored", () => {
  const rel = layout(JSON.stringify({ nearWatchDir: "../../other/adminUI/services/near-watch" }));
  assert.deepEqual(locateNearWatch(rel.root, { NEAR_WATCH_DIR: "  " }), { dir: resolve(rel.nw), source: "config/local/repos.json nearWatchDir", found: true });
  const abs = layout(JSON.stringify({ nearWatchDir: layout().nw }));
  assert.equal(locateNearWatch(abs.root, {}).found, true);
  const bom = layout("﻿" + JSON.stringify({ nearWatchDir: "../../other/adminUI/services/near-watch" })); // Notepad writes a BOM
  assert.equal(locateNearWatch(bom.root, {}).found, true);
});

test("no env and no file: the sibling folder ../chainaim-adminUI-NEAR, reported as the default", () => {
  const { root } = layout();
  const loc = locateNearWatch(root, {});
  assert.equal(loc.dir, resolve(root, "..", "chainaim-adminUI-NEAR", "services", "near-watch"));
  assert.match(loc.source, /^default: the sibling folder/); assert.equal(loc.found, false);
});

test("a broken repos.json is refused with the file's name, never guessed around", () => {
  assert.throws(() => locateNearWatch(layout("{ nearWatchDir: ").root, {}), /config\/local\/repos\.json is not valid JSON/);
  assert.throws(() => locateNearWatch(layout(JSON.stringify({ nearWatchDir: 42 })).root, {}), /nearWatchDir must be a non-empty path/);
  assert.throws(() => locateNearWatch(layout(JSON.stringify({ nearWatchDir: " " })).root, {}), /nearWatchDir must be a non-empty path/);
  assert.equal(locateNearWatch(layout(JSON.stringify({ notes: "only notes" })).root, {}).source.startsWith("default"), true);
});

test("not found: skipped with the reason (where it looked, from which setting, how to fix); REQUIRE_NEAR_WATCH=1 runs (and fails) instead", () => {
  const missing = { dir: "/x/near-watch", source: "config/local/repos.json nearWatchDir", found: false };
  const why = nearWatchSkip(missing, {});
  assert.equal(why, nearWatchMissing(missing));
  assert.match(String(why), /\/x\/near-watch \(from config\/local\/repos\.json nearWatchDir\): set "nearWatchDir" in config\/local\/repos\.json/);
  assert.equal(nearWatchSkip(missing, { REQUIRE_NEAR_WATCH: "1" }), false);
  assert.equal(nearWatchSkip({ ...missing, found: true }, {}), false);
});

test("the locate block is identical in both helpers (check-deps forbids sharing it by import)", () => {
  const block = (p: string) => { const s = readFileSync(new URL(p, import.meta.url), "utf8"); const a = s.indexOf("// ---- locate near-watch"), b = s.indexOf("// ---- end locate near-watch");
    assert.ok(a >= 0 && b > a, `${p}: markers missing`); return s.slice(a, b); };
  assert.equal(block("./near-watch-server.ts"), block("../../test-console/test/near-watch-server.ts"));
});

test("the example file is valid and names the same setting", () => {
  const ex = JSON.parse(readFileSync(new URL("../../config/local/repos.example.json", import.meta.url), "utf8"));
  assert.equal(typeof ex.nearWatchDir, "string"); assert.match(ex.notes, /repos\.json/);
});

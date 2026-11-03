/** Domain packs (decoupling Phase 3): registry, explicit extends, the finance-generic pack, recipe checks, --print-pack. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DomainPack } from "../src/core/ports.ts";
import { PackError, PackRegistry } from "../src/core/registry.ts";
import { FINANCE_GENERIC } from "../src/domain-packs/finance/pack.ts";
import { BUILT_IN_PACKS, DEFAULT_PACK } from "../src/domain-packs/index.ts";
import { type FileProfile, proposeRecipe, validateRecipe } from "../src/profile.ts";

const registry = () => new PackRegistry().register(FINANCE_GENERIC);
const child = (id: string, ext: string, extra: Partial<DomainPack> = {}): DomainPack => ({ id, title: id, extends: ext, ...extra });

test("finance-generic is the default and keeps the analyst's vocabulary and proposal order unchanged", () => {
  assert.equal(DEFAULT_PACK, "finance-generic");
  assert.deepEqual(BUILT_IN_PACKS.map((p) => p.id), ["finance-generic", "finance/rcm", "finance/rcm/dental"]);
  const f = registry().resolve("finance-generic");
  assert.deepEqual(f.kinds, ["production", "billing", "income", "collections", "deposits", "ledger", "tax", "adjustments", "other"]);
  assert.deepEqual(f.flowOrder, ["production", "billing", "income", "collections", "deposits", "ledger", "tax"]);
  assert.deepEqual(f.excludeFromFlow, ["adjustments"]);
  assert.equal(f.fallbackKind, "other");
  assert.deepEqual(f.defaultMeasure, { production: "abs", billing: "abs", income: "abs", collections: "abs", deposits: "inflows", ledger: "net", tax: "abs", adjustments: "abs", other: "net" });
  assert.deepEqual(f.nameHints.map(([r]) => r), ["date", "debit", "credit", "amount", "reference", "party", "category"]);
  assert.equal(f.partyPriority.length, 3);
  assert.deepEqual(f.chain, ["finance-generic"]);
});

test("extends: a child field replaces the parent's whole; every effective field reports the pack it came from", () => {
  const r = registry().register(child("finance/rcm", "finance-generic", { kinds: ["remit", "deposits", "other"], flowOrder: ["remit", "deposits"] }))
    .register(child("finance/rcm/dental", "finance/rcm", { fallbackKind: "remit" })).resolve("finance/rcm/dental");
  assert.deepEqual(r.chain, ["finance/rcm/dental", "finance/rcm", "finance-generic"]);
  assert.deepEqual(r.kinds, ["remit", "deposits", "other"]);
  assert.equal(r.fallbackKind, "remit");
  assert.equal(r.from.kinds, "finance/rcm"); assert.equal(r.from.fallbackKind, "finance/rcm/dental"); assert.equal(r.from.nameHints, "finance-generic");
});

test("refuses: unknown pack, unknown parent, a cycle, a chain deeper than 3, a duplicate id, a bad id, a field no pack sets", () => {
  assert.throws(() => registry().resolve("nope"), (e: unknown) => e instanceof PackError && /unknown pack nope \(known: finance-generic\)/.test((e as Error).message));
  assert.throws(() => registry().register(child("a", "missing")).resolve("a"), /a extends unknown pack missing/);
  assert.throws(() => new PackRegistry().register(child("a", "b")).register(child("b", "a")).resolve("a"), /extends cycle a -> b -> a/);
  const deep = registry().register(child("l2", "finance-generic")).register(child("l3", "l2")).register(child("l4", "l3"));
  assert.doesNotThrow(() => deep.resolve("l3"));
  assert.throws(() => deep.resolve("l4"), /longer than 3/);
  assert.throws(() => registry().register(FINANCE_GENERIC), /registered twice/);
  assert.throws(() => registry().register({ id: "Bad Id", title: "x" }), /lower-case/);
  assert.throws(() => new PackRegistry().register({ id: "bare", title: "x", kinds: ["a"] }).resolve("bare"), /sets nameHints/);
});

const profile = (name: string, cols: [string, "date" | "number" | "text"][]): FileProfile =>
  ({ name, path: `/x/${name}`, bytes: 1, modified: "", rows: 3, columns: cols.map(([n, type]) => ({ name: n, type, filled: 3, samples: [] })), dateRange: null, tooBig: false });
const files = [profile("bank-statement.csv", [["Posted Date", "date"], ["Amount", "number"], ["Description", "text"]]),
  profile("adjustments.csv", [["Date", "date"], ["Amount", "number"]]), profile("collections.csv", [["Payment Date", "date"], ["Paid", "number"], ["Payer", "text"]])];

test("the proposal follows the pack: kinds from file names, measures per kind, adjustments kept out of the flow", () => {
  const r = proposeRecipe("/x", files, registry().resolve("finance-generic"));
  assert.equal(r.pack, undefined, "the default pack is never stamped into a recipe");
  assert.deepEqual(Object.fromEntries(Object.entries(r.files).map(([n, f]) => [n, [f.kind, f.measure]])),
    { "bank-statement.csv": ["deposits", "inflows"], "adjustments.csv": ["adjustments", "abs"], "collections.csv": ["collections", "abs"] });
  assert.deepEqual(r.flow, ["collections.csv", "bank-statement.csv"]);
  assert.equal(r.files["collections.csv"].roles.party, "Payer");
});

test("a recipe is checked against its pack's kinds; an explicit pack is kept, the default is never added", () => {
  const f = registry().resolve("finance-generic");
  const ok = validateRecipe(proposeRecipe("/x", files, f), files, f);
  assert.equal("pack" in ok, false);
  assert.equal(validateRecipe({ ...ok, pack: "finance-generic" }, files, f).pack, "finance-generic");
  const bad = { ...ok, files: { ...ok.files, "adjustments.csv": { ...ok.files["adjustments.csv"], kind: "remit" } } };
  assert.throws(() => validateRecipe(bad, files, f), /adjustments\.csv: kind must be one of production, billing, income, collections, deposits, ledger, tax, adjustments, other/);
});

test("--print-pack prints the effective pack with provenance and exits 0; an unknown --pack or --print-pack exits 2", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const run = (...a: string[]) => spawnSync(process.execPath, [main, ...a], { encoding: "utf8", timeout: 60000 });
  const ok = run("--print-pack", "finance-generic");
  assert.equal(ok.status, 0, ok.stderr);
  const d = JSON.parse(ok.stdout);
  assert.equal(d.id, "finance-generic"); assert.deepEqual(d.chain, ["finance-generic"]); assert.equal(d.from.kindHints, "finance-generic");
  assert.equal(d.kindHints[0][0], "production"); assert.match(d.kindHints[0][1], /^\/prod\|charge/);
  const unknown = run("--print-pack", "nope");
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /unknown pack nope/);
  assert.equal(run("--pack", "nope", "--port", "1").status, 2);
});

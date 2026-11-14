import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/data.ts";
import { inventory, parseInventoryRequest } from "../src/inventory.ts";
import { AS_OF, jupiter } from "./helpers.ts";

const data = jupiter();
const ask = (sku: string, qty: number, shipBy: string) => inventory(data, AS_OF, { sku, qty, shipBy });
const isApi = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;

test("ARCH-731 T01/T08 20,000 grade A from free stock (ATP = on hand - reserved - QC hold)", () => {
  const a = ask("FAB-COT-180-A", 20000, "2026-12-20");
  assert.deepEqual(a.sources, [{ lot: "L-180A-01", kind: "FREE", units: 20000, readyDate: "2026-11-16", warehouse: "MADRAS-WH-1" }]);
  assert.equal(a.shortfall, 0);
});

test("ARCH-731 T03 30,000: free stock first (23,000 after QC hold), then the WIP lot", () => {
  const a = ask("FAB-COT-180-A", 30000, "2026-12-20");
  assert.deepEqual(a.sources.map((s) => [s.lot, s.kind, s.units, s.readyDate]), [
    ["L-180A-01", "FREE", 23000, "2026-11-16"],
    ["L-180A-02", "WIP", 7000, "2026-12-03"],
  ]);
  assert.equal(a.shortfall, 0);
});

test("ARCH-731 45,000 by 2026-12-20: one production cycle (as-of + 30 lead + 2 QC days) covers the rest", () => {
  const a = ask("FAB-COT-180-A", 45000, "2026-12-20");
  assert.deepEqual(a.sources.map((s) => [s.kind, s.units, s.readyDate]), [
    ["FREE", 23000, "2026-11-16"],
    ["WIP", 12000, "2026-12-03"],
    ["PRODUCTION", 10000, "2026-12-18"],
  ]);
  assert.equal(a.shortfall, 0);
});

test("ARCH-731 T07 45,000 by 2026-12-10: production too late, shortfall 10,000; reallocatable TIER2 (Sales Officer) before TIER1 (CEO)", () => {
  const a = ask("FAB-COT-180-A", 45000, "2026-12-10");
  assert.equal(a.shortfall, 10000);
  assert.ok(!a.sources.some((s) => s.kind === "PRODUCTION"));
  assert.deepEqual(a.reallocatable.map((r) => [r.lot, r.units, r.tier, r.requiredAuthority, r.premiumPct, r.replacementOk]), [
    ["L-180A-03", 10000, "TIER2", "SALES_OFFICER", 4, true],
    ["L-180A-04", 12000, "TIER1", "CEO", 8, true],
  ]);
});

test("ARCH-731 T05 grade B has no stock: shortfall, and grade A offered as the alternative", () => {
  const a = ask("FAB-COT-180-B", 12000, "2026-12-10");
  assert.deepEqual(a.sources, []);
  assert.equal(a.shortfall, 12000);
  assert.deepEqual(a.gradeAlternatives, [{ sku: "FAB-COT-180-A", grade: "A" }]);
});

test("ARCH-731 an unknown SKU is 422 and a bad body is 400", () => {
  assert.throws(() => ask("NOPE", 1, "2026-12-01"), isApi(422));
  assert.throws(() => parseInventoryRequest({ requestId: "r", sku: "FAB-COT-180-A", qty: 0, shipBy: "2026-12-01" }), isApi(400));
  assert.throws(() => parseInventoryRequest({ requestId: "r", sku: "FAB-COT-180-A", qty: 5, shipBy: "2026-13-01" }), isApi(400));
  assert.throws(() => parseInventoryRequest({ sku: "FAB-COT-180-A", qty: 5, shipBy: "2026-12-01" }), isApi(400));
});

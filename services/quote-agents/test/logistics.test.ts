import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/data.ts";
import { logistics } from "../src/logistics.ts";
import { jupiter } from "./helpers.ts";

const data = jupiter();
const SKU = "FAB-COT-180-A";
const lot = (l: string, units: number, readyDate: string, warehouse = "MADRAS-WH-1") => ({ lot: l, units, readyDate, warehouse });

test("ARCH-732 T01 20,000 ready 11-16: first standard sailing whose cutoff (ETD-2) is on or after the at-port date; delivered = ETA + 4 + 1", () => {
  const a = logistics(data, { sku: SKU, lots: [lot("L-180A-01", 20000, "2026-11-16")], deadline: "2027-01-08", allowAir: false });
  assert.deepEqual(a.legs, [{ lot: "L-180A-01", units: 20000, mode: "SEA_STD", carrier: "MSC", etd: "2026-11-20", delivered: "2026-12-22", freightCents: 420000, late: false }]);
  assert.equal(a.freightCents, 420000);
  assert.equal(a.meetsDeadline, true);
  assert.equal(a.airOption, null);
});

test("ARCH-732 T03 standard + express split: the WIP lot misses the standard cutoff and takes express to meet 01-05", () => {
  const a = logistics(data, { sku: SKU, lots: [lot("L-180A-01", 23000, "2026-11-16"), lot("L-180A-02", 7000, "2026-12-03")], deadline: "2027-01-05", allowAir: false });
  assert.deepEqual(a.legs.map((g) => [g.mode, g.carrier, g.etd, g.delivered, g.freightCents]), [
    ["SEA_STD", "MSC", "2026-11-20", "2026-12-22", 420000],
    ["SEA_EXP", "Maersk", "2026-12-08", "2027-01-04", 540000],
  ]);
  assert.equal(a.freightCents, 960000);
  assert.equal(a.meetsDeadline, true);
});

test("ARCH-732 containers = ceil(units / units per 40HC): 30,000 on one sailing is 2 containers", () => {
  const a = logistics(data, { sku: SKU, lots: [lot("X", 30000, "2026-11-16")], deadline: "2027-01-08", allowAir: false });
  assert.equal(a.freightCents, 2 * 420000);
});

test("ARCH-732 a late lot without air: counted late on the earliest sea option, and the air option offered", () => {
  const a = logistics(data, { sku: SKU, lots: [lot("P", 4000, "2026-12-20")], deadline: "2027-01-05", allowAir: false });
  assert.deepEqual(a.legs.map((g) => [g.mode, g.etd, g.delivered, g.late]), [["SEA_STD", "2027-01-01", "2027-02-02", true]]);
  assert.equal(a.lateUnits, 4000);
  assert.equal(a.meetsDeadline, false);
  assert.deepEqual(a.airOption, { deliveredBy: "2026-12-26", centsPerUnit: 95, maxUnits: 5000 });
});

test("ARCH-732 with allowAir the late lot flies (units x cents per unit), only within the air capacity", () => {
  const a = logistics(data, { sku: SKU, lots: [lot("P", 4000, "2026-12-20")], deadline: "2027-01-05", allowAir: true });
  assert.deepEqual(a.legs.map((g) => [g.mode, g.delivered, g.freightCents, g.late]), [["AIR", "2026-12-26", 380000, false]]);
  assert.equal(a.meetsDeadline, true);
  const over = logistics(data, { sku: SKU, lots: [lot("P", 6000, "2026-12-20")], deadline: "2027-01-05", allowAir: true });
  assert.equal(over.legs[0]!.mode, "SEA_STD");
  assert.equal(over.lateUnits, 6000);
});

test("ARCH-732 TIRUPUR lots take 2 inland days; an unknown warehouse or no sailing is 422", () => {
  const a = logistics(data, { sku: SKU, lots: [lot("T", 1000, "2026-11-16", "TIRUPUR-WH-2")], deadline: "2027-01-08", allowAir: false });
  assert.equal(a.legs[0]!.etd, "2026-11-20");
  const b = logistics(data, { sku: SKU, lots: [lot("T", 1000, "2026-11-17", "TIRUPUR-WH-2")], deadline: "2027-01-08", allowAir: false });
  assert.deepEqual([b.legs[0]!.mode, b.legs[0]!.etd, b.legs[0]!.delivered], ["SEA_STD", "2026-12-04", "2027-01-05"]);
  assert.throws(() => logistics(data, { sku: SKU, lots: [lot("Z", 1, "2026-11-16", "NOWHERE")], deadline: "2027-01-08", allowAir: false }), (e: unknown) => e instanceof ApiError && e.status === 422);
  assert.throws(() => logistics(data, { sku: SKU, lots: [lot("Z", 1, "2027-03-01")], deadline: "2027-04-08", allowAir: false }), (e: unknown) => e instanceof ApiError && e.code === "no_sailing");
});

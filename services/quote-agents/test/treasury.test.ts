import assert from "node:assert/strict";
import { test } from "node:test";
import { treasury, type TreasuryRequest } from "../src/treasury.ts";
import { AS_OF, jupiter } from "./helpers.ts";

const data = jupiter();
const MARGINS = [0.15, 0.135, 0.12, 0.11, 0.1, 0.09, 0.08];
const req = (qty: number, freightCents: number, extra: Partial<TreasuryRequest> = {}): TreasuryRequest => ({
  sku: "FAB-COT-180-A", qty, freightCents, reallocUnits: { TIER1: 0, TIER2: 0 }, termsDays: 30, advancePct: 0, margins: MARGINS, ...extra,
});

test("ARCH-733 T01/T08 20,000 + $4,200 freight + $300 overhead: landed 352.5c -> 415 at 15%, 384 at 8% (companion oracle)", () => {
  const a = treasury(data, AS_OF, req(20000, 420000));
  assert.equal(a.landedCents, 353);
  assert.equal(a.pricesAtMargin["0.15"], 415);
  assert.equal(a.pricesAtMargin["0.135"], 408);
  assert.equal(a.pricesAtMargin["0.12"], 401);
  assert.equal(a.pricesAtMargin["0.1"], 392);
  assert.equal(a.pricesAtMargin["0.08"], 384);
});

test("ARCH-733 T02 18,000: 411 at 13.5% (companion oracle ACCEPT 411 R2)", () => {
  assert.equal(treasury(data, AS_OF, req(18000, 420000)).pricesAtMargin["0.135"], 411);
});

test("ARCH-733 T03 30,000 with standard + express freight $9,600: 413 at 12% (companion oracle ACCEPT 413 R3)", () => {
  const a = treasury(data, AS_OF, req(30000, 960000));
  assert.equal(a.landedCents, 363);
  assert.equal(a.pricesAtMargin["0.12"], 413);
});

test("ARCH-733 the unit cost never appears in an answer", () => {
  for (const q of [req(20000, 420000), req(45000, 0, { reallocUnits: { TIER1: 12000, TIER2: 10000 }, advancePct: 30 })]) {
    const text = JSON.stringify(treasury(data, AS_OF, q));
    assert.ok(!/unitCost/i.test(text));
    const values: unknown[] = [];
    JSON.parse(text, (_k, v) => {
      values.push(v);
      return v;
    });
    assert.ok(!values.includes(330), "330 (the unit cost) is a value in the answer");
  }
});

test("ARCH-733 liquidity: net30 = cash + headroom + AR - AP due within 30 days; a large order is a DEFICIT and a 30% advance gives one point", () => {
  const small = treasury(data, AS_OF, req(20000, 420000));
  assert.deepEqual(small.liquidity, { net30Usd: 138000, status: "SURPLUS" });
  assert.equal(small.advanceLever.applies, false);
  const big = treasury(data, AS_OF, req(45000, 0, { advancePct: 30 }));
  assert.equal(big.liquidity.status, "DEFICIT");
  assert.deepEqual(big.advanceLever, { minAdvancePct: 30, marginRelief: 0.01, applies: true });
  assert.equal(treasury(data, AS_OF, req(45000, 0, { advancePct: 20 })).advanceLever.applies, false);
});

test("ARCH-733 reallocation premium per unit: (TIER2 units x cost x 4% + TIER1 units x cost x 8%) / qty, rounded up", () => {
  assert.equal(treasury(data, AS_OF, req(45000, 0, { reallocUnits: { TIER1: 12000, TIER2: 10000 } })).reallocPremiumCents, 10);
  assert.equal(treasury(data, AS_OF, req(20000, 420000)).reallocPremiumCents, 0);
});

test("ARCH-733 buyer credit: headroom = limit - open receivable; terms 0 or an advance can make an order fit", () => {
  assert.deepEqual(treasury(data, AS_OF, req(45000, 0)).credit, { headroomUsd: 180000, ok: true });
  assert.equal(treasury(data, AS_OF, req(50000, 0)).credit.ok, false);
  assert.equal(treasury(data, AS_OF, req(50000, 0, { advancePct: 30 })).credit.ok, true);
  assert.equal(treasury(data, AS_OF, req(50000, 0, { termsDays: 0 })).credit.ok, true);
});

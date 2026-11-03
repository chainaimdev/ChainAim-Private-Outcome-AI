/** verifyMoney (Phase 4b-3): the strict, sign-aware number check for reconciliation answers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMoney } from "../src/verify.ts";

const EV = `TOTALS card_processor Curve 12,345.67 banked 12,300.00
EXC CASH_SHORT 2024-09-12 amount -45.00 (bank below Curve) bank row 31
EXC DEPOSIT_OVER 2024-09-18 amount +12.00 (bank above Curve)
EXC REF_MISMATCH 2024-09-20 amount 489.00 (no money difference) payment 300123
EXC EFT_MISSING 2024-09-22 amount -227.00 (bank below Curve)
EXC BANK_UNPOSTED 2024-09-23 amount +227.00 (bank above Curve)`;
const v = (a: string) => verifyMoney(a, EV);
const ok = { notFound: [], signMismatch: [], signUnclear: [] };
const pick = (r: ReturnType<typeof v>) => ({ notFound: r.notFound, signMismatch: r.signMismatch, signUnclear: r.signUnclear });

test("a direction word must agree with the evidence sign", () => {
  assert.deepEqual(pick(v("The ATM deposit on 9/12 was short by $45.00.")), ok);
  assert.deepEqual(pick(v("The ATM deposit was over by $45.00.")), { ...ok, signMismatch: ["$45.00"] });
  assert.deepEqual(pick(v("Deposit $12.00 above Curve.")), ok);
  assert.deepEqual(pick(v("The bank was $12.00 short.")), { ...ok, signMismatch: ["$12.00"] });
});
test("an explicit sign must match: -, (), +", () => {
  assert.deepEqual(pick(v("A difference of -45.00 on the 12th.")), ok);
  assert.deepEqual(pick(v("(45.00) short")), ok);
  assert.deepEqual(pick(v("A difference of +45.00.")), { ...ok, signMismatch: ["+45.00"] });
});
test("the same size held with both signs needs a direction", () => {
  assert.deepEqual(pick(v("An amount of 227.00 is involved.")), { ...ok, signUnclear: ["227.00"] });
  assert.deepEqual(pick(v("The EFT of $227.00 is missing.")), ok);
  assert.deepEqual(pick(v("There is an unposted bank credit of $227.00.")), ok);
});
test("neutral figures (totals, IDs, a reference mismatch amount) pass whatever the words", () => {
  assert.deepEqual(pick(v("Card total 12,345.67 vs 12,300.00 banked; payment 300123 below; check 489.00.")), ok);
});
test("invented figures, more than 2 decimals and small dollar amounts are checked", () => {
  assert.deepEqual(pick(v("$46.00 short")), { ...ok, notFound: ["$46.00"] });
  assert.deepEqual(pick(v("45.004 short")), { ...ok, notFound: ["45.004"] });
  assert.deepEqual(pick(v("only $7 is missing")), { ...ok, notFound: ["$7"] });
  assert.equal(v("$45 missing").checked, 1);
});
test("dates, years and small plain counts are not figures", () => {
  assert.deepEqual(v("In 2024 there were 3 issues on 2024-09-12 and 9/18/2024."), { checked: 0, ...ok });
});

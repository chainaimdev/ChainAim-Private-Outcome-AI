/** privateAI-design-31 §2: possible derivations of a figure the answer check could not find in the result. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFigure, figureCents } from "../src/derive.ts";

const plans = { columns: ["Plan ID", "Price"], rows: ["PL1", "PL2", "PL3", "PL4", "PL5", "PL6"].map((p) => ({ "Plan ID": p, Price: 480 })) };

test("figureCents reads the ways a model writes a figure", () => {
  assert.equal(figureCents("2,880"), 288000);
  assert.equal(figureCents("$1,234.50"), 123450);
  assert.equal(figureCents("(45.00)"), -4500);
  assert.equal(figureCents("-12"), -1200);
  assert.equal(figureCents("<PERSON_1>"), null);
});

test("a column total: 6 plans at 480.00 -> 2,880 is the total of Price", () => {
  assert.equal(deriveFigure("2,880", plans), "the total of Price over 6 rows");
});

test("rows times a value, when the column total is not it", () => {
  const t = { columns: ["patient", "price"], rows: [{ patient: "PT1", price: "480.00" }, { patient: "PT2", price: "160.00" }, { patient: "PT3", price: "480.00" }] };
  assert.equal(deriveFigure("1,440", t), "3 rows × 480 (price)");
});

test("two cells of one row: product, sum, difference", () => {
  const t = { columns: ["visits", "price", "paid"], rows: [{ visits: 12, price: 40, paid: 300 }] };
  assert.equal(deriveFigure("480", t), "price × visits on row 1 (40 × 12)");
  assert.equal(deriveFigure("340", t), "paid + price on row 1");
  assert.equal(deriveFigure("260", t), "paid − price on row 1");
});

test("an average exact to the cent", () => {
  const t = { columns: ["amount"], rows: [{ amount: 10 }, { amount: 20 }, { amount: 33 }] };
  assert.equal(deriveFigure("21.00", t), "the average of amount over 3 rows");
});

test("nothing simple gives it, or there is no table: null (never a guess)", () => {
  assert.equal(deriveFigure("1,234.56", plans), null);
  assert.equal(deriveFigure("2,880", null), null);
  assert.equal(deriveFigure("2,880", { columns: ["a"], rows: [] }), null);
  assert.equal(deriveFigure("<PERSON_1>", plans), null);
  // rounding is never used to make a match: 2,880.01 is not 6 x 480
  assert.equal(deriveFigure("2,880.01", plans), null);
});

test("crossAsk end to end: a figure the model worked out is listed as not found, with what it equals", async () => {
  const { crossAsk } = await import("../src/index.ts");
  const analyst = async (route: string) => (route === "relations" ? { schema: "careplans(Plan ID, Price)", relations: [] }
    : { columns: plans.columns, rows: plans.rows, truncated: false });
  const chat = async () => ({ text: "The six care plans total $2,880.", model: "stand-in/model" });
  const out = await crossAsk({ folder: "f", question: "care plans?", model: "stand-in/model", phrase: "llm", sqlRetries: 0, answerMaxRows: 50, sql: 'SELECT "Plan ID", Price FROM careplans' },
    { analyst, chat } as never);
  assert.deepEqual(out.unverified, ["$2,880"]);
  assert.deepEqual(out.derivations, { "$2,880": "the total of Price over 6 rows" });
});

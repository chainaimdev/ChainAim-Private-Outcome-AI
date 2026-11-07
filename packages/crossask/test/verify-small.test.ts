/**
 * verifyAnswer smallNumbers (owner decision 2026-11-07): tab 03 says "Calculated, NOT made up by the AI", so a whole number
 * under 100 the AI wrote ("37 claims") must be checked too. Default off keeps the old rule (analyst /verify route).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAnswer } from "../src/verify.ts";
import { crossAsk, figuresVerdict, FIGURES_TEXT, type CrossAskDeps } from "../src/index.ts";

/** The evidence as crossAsk builds it (answerEvidence: the question, then resultText's pipe table). */
const EVIDENCE = "Question: paid by payer\npayer | claims | paid\nAETNA | 37 | 12480.50\nCIGNA | 12 | 1069.50";

test("default (off): small whole numbers are not checked, exactly as before", () => {
  const r = verifyAnswer("AETNA paid $12,480.50 on 99 claims.", EVIDENCE);
  assert.deepEqual(r, { checked: 1, notFound: [] });
});

test("on: a small number in the evidence passes; an invented one is not found", () => {
  assert.deepEqual(verifyAnswer("AETNA paid $12,480.50 on 37 claims.", EVIDENCE, { smallNumbers: true }), { checked: 2, notFound: [] });
  assert.deepEqual(verifyAnswer("AETNA paid $12,480.50 on 99 claims.", EVIDENCE, { smallNumbers: true }), { checked: 2, notFound: ["99"] });
});

test("on: $45, -12 and 45% are checked as numbers", () => {
  const r = verifyAnswer("Short by $45, down -12, about 45% of claims.", EVIDENCE, { smallNumbers: true });
  assert.deepEqual(r.notFound, ["45"]);
  assert.equal(r.checked, 2, "45 counted once, 12 found");
});

test("on: a number from the question (\"top 5\") or the row count passes", () => {
  assert.deepEqual(verifyAnswer("The top 5 payers are listed.", EVIDENCE, { smallNumbers: true, allowFrom: "show the top 5 payers" }).notFound, []);
  assert.deepEqual(verifyAnswer("There are 2 payers.", EVIDENCE, { smallNumbers: true, rowCount: 2 }).notFound, []);
  assert.deepEqual(verifyAnswer("There are 3 payers.", EVIDENCE, { smallNumbers: true, rowCount: 2 }).notFound, ["3"]);
});

test("on: dates, times, years, ordinals, decimals and ids are not read as small numbers", () => {
  const answer = "On 2026-03-05 at 10:31, and 3/5/2026, in 2026, the 12th claim, 12.5 units, Q3, PL12 and <PERSON_1> were seen.";
  const r = verifyAnswer(answer, "12.5", { smallNumbers: true });
  assert.deepEqual(r.notFound, [], JSON.stringify(r));
});

test("on: parts of larger figures are not split into small numbers", () => {
  const r = verifyAnswer("Total $1,069.50 and 12480.50.", EVIDENCE, { smallNumbers: true });
  assert.deepEqual(r, { checked: 2, notFound: [] });
});

// ---- crossAsk + the tab 03 figures line --------------------------------------------------------------------------------
const ROWS = [{ payer: "AETNA", claims: 37, paid: 12480.5 }, { payer: "CIGNA", claims: 12, paid: 1069.5 }];
const deps = (answer: string): CrossAskDeps => ({
  analyst: async (route) => (route === "relations" ? { schema: "t(payer, claims, paid)", relations: [], tables: ["t"] } : { columns: ["payer", "claims", "paid"], rows: ROWS, truncated: false }),
  chat: async () => ({ text: answer, model: "m" }),
});
const ask = (answer: string, checkSmallNumbers?: boolean) =>
  crossAsk({ folder: "f", question: "paid by payer", model: "m", phrase: "llm", sqlRetries: 0, answerMaxRows: 50, sql: "SELECT 1", ...(checkSmallNumbers === undefined ? {} : { checkSmallNumbers }) }, deps(answer));

test("crossAsk: checkSmallNumbers off (default) misses an invented small count; on catches it", async () => {
  assert.deepEqual((await ask("AETNA paid $12,480.50 on 99 claims.")).unverified, []);
  assert.deepEqual((await ask("AETNA paid $12,480.50 on 99 claims.", true)).unverified, ["99"]);
  assert.deepEqual((await ask("AETNA paid $12,480.50 on 37 claims; 2 payers in all.", true)).unverified, [], "37 is a cell, 2 is the row count");
});

test("figures line: every number found -> calculated (the approved green text)", async () => {
  const v = figuresVerdict(await ask("AETNA paid $12,480.50 on 37 claims.", true));
  assert.deepEqual(v, { verdict: "calculated", derived: [], unmatched: [] });
  assert.equal(FIGURES_TEXT.calculated, "Calculated, NOT made up by the AI. AI only explains.");
});

test("figures line: an AI total that exact arithmetic reproduces stays green, listed as derived (owner decision)", async () => {
  const r = await ask("Together they paid $13,550.00 on 49 claims.", true);
  const v = figuresVerdict(r);
  assert.equal(v.verdict, "calculated", JSON.stringify(r.unverified));
  assert.deepEqual(v.derived.sort(), ["$13,550.00", "49"].sort());
  assert.match(r.derivations["$13,550.00"], /total of paid over 2 rows/);
});

test("figures line: an invented number -> review (the approved warning text)", async () => {
  const v = figuresVerdict(await ask("AETNA paid $12,999.00.", true));
  assert.deepEqual([v.verdict, v.unmatched], ["review", ["$12,999.00"]]);
  assert.equal(FIGURES_TEXT.review, "Review before use: AI explanation may differ from the figures below.");
});

test("figures line: a placeholder left in the answer -> review", async () => {
  assert.equal(figuresVerdict(await ask("AETNA paid <PERSON_1> on 37 claims.", true)).verdict, "review");
});

test("figures line: no AI explanation -> no line", async () => {
  const none = await crossAsk({ folder: "f", question: "q", model: "m", phrase: "none", sqlRetries: 0, answerMaxRows: 50, sql: "SELECT 1" }, deps("x"));
  assert.equal(figuresVerdict(none).verdict, null);
});

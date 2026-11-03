import { test } from "node:test";
import assert from "node:assert/strict";
import { answerEvidence } from "../src/index.ts";
import { verifyAnswer } from "../src/verify.ts";

test("a figure from the user's own question is not flagged; one in neither question nor result is", () => {
  const table = "DATE | net\n2026-10-04 | 1500\n742.25";
  const q = "Could it cover a loan installment of 20,368 a month?";
  assert.deepEqual(verifyAnswer("It cannot cover 20,368; the net is 742.25.", answerEvidence(q, table)).notFound, []);
  assert.deepEqual(verifyAnswer("It cannot cover 20,368; the net is 9,999.", answerEvidence(q, table)).notFound, ["9,999."].map((x) => x.replace(/\.$/, "")));
  assert.deepEqual(verifyAnswer("It cannot cover 20,368.", table).notFound, ["20,368"], "against the result alone it is still flagged");
});

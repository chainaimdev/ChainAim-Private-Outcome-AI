/**
 * Phase 4c fact sheets (src/facts.ts). The cases are the owner's run of 2026-11-03 (local/deepseek-r1-8b on SET-2/NEG-ALL):
 * answers that passed the old figure check yet were wrong (+863.57 called a loss, payment IDs borrowed from other items, a payer
 * left out) must now fail; a correct answer must pass. Facts below are NEG-ALL's real exceptions; nothing else is invented.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type ExceptionFact, type Fact, MASK_CONTEXT_WORDS, plainFacts, renderSheet, verifyFactAnswer } from "../src/facts.ts";

const F = (tag: string, category: ExceptionFact["category"], code: string, date: string, cents: number, ids: string[], extra: Partial<ExceptionFact> = {}): ExceptionFact =>
  ({ tag, kind: "F", category, code, date, cents, payer: null, group: null, paymentIds: ids, bankRows: [], action: "act", ...extra });
const LOSSES: Fact[] = [
  { tag: "T1", kind: "T", category: "loss", items: 5, cents: -167847 },
  F("F1", "loss", "EFT_MISSING", "2024-09-14", -131080, ["300264", "300266", "300268"], { payer: "DELTA DENTAL MA(COVERSME.COM)" }),
  F("F2", "loss", "UNDEPOSITED_CHECK", "2024-09-19", -18080, ["300386"]),
  F("F3", "loss", "POSTED_TWICE", "2024-09-08", -16400, ["300125", "300445"]),
  F("F4", "loss", "CARD_BATCH_SHORT", "2024-09-05", -1845, [], { bankRows: [17] }),
  F("F5", "loss", "CASH_SHORT", "2024-09-01", -442, [], { bankRows: [12] }),
];
const losses = renderSheet(LOSSES, "Scope: totals, losses.");
const PAYERS = renderSheet([
  F("F1", "loss", "EFT_MISSING", "2024-09-14", -131080, ["300264", "300266", "300268"], { payer: "DELTA DENTAL MA(COVERSME.COM)" }),
  F("F2", "extra", "BANK_UNPOSTED", "2024-09-13", 86357, [], { payer: "MH", bankRows: [38] }),
], "Scope: payers.");
const ALL = renderSheet([...LOSSES.slice(1), F("F6", "extra", "BANK_UNPOSTED", "2024-09-13", 86357, [], { payer: "MH" }), F("F7", "timing", "HFD_LAG", "2024-09-15", -160000, ["300306"])], "Scope: all.");

const GOOD = [
  "Money missing from the bank totals -1,678.47 across 5 items [T1].",
  "- EFT_MISSING on 2024-09-14: -1,310.80, payments 300264, 300266, 300268; call Delta Dental [F1].",
  "- UNDEPOSITED_CHECK: -180.80, payment 300386 [F2].",
  "- POSTED_TWICE: -164.00, payments 300125 and 300445 [F3].",
  "- CARD_BATCH_SHORT: -18.45 [F4].",
  "- CASH_SHORT: -4.42 [F5].",
].join("\n");

test("a correct, fully cited answer passes; the facts render with tags, signs and actions", () => {
  const c = verifyFactAnswer(GOOD, losses);
  assert.deepEqual(c.problems, []); assert.ok(c.ok); assert.equal(c.checked, 6 + 6 + 5 + 1); // 6 amounts, 6 payment IDs, 5 cause codes, 1 date
  assert.match(losses.text, /\[F_1\] LOSS \(money Curve recorded that never arrived\) \| EFT_MISSING \| date 2024\/09\/14 \| amount -\$1,310\.80 .*payments 300264;300266;300268 \| action: act/);
  assert.match(losses.text, /\[T_1\] TOTAL LOSS .*: -\$1,678\.47 in 5 item\(s\)/);
  // owner probe 2026-11-03: "-164.00" was read as a phone number, "-$164.00" was not
  assert.ok(!/(^|[^$\d,.])\d{1,3}(,\d{3})*\.\d{2}\b/m.test(losses.text.replace(/^FACTS.*$/m, "")), "every amount in the sheet carries $");
  // owner scan 2026-11-03: "F4" read as a driver licence, "2024-09-13" as a bank account; the sheet writes neither form
  assert.ok(!/\b[FTG]\d+\b/.test(losses.text) && !/\d{4}-\d{2}-\d{2}/.test(losses.text));
  assert.ok(verifyFactAnswer(GOOD.replaceAll("[F", "[F_").replaceAll("[T", "[T_").replace("2024-09-14", "2024/09/14").replace("-1,310.80", "-$1,310.80"), losses).ok, "the sheet's own forms are read");
});

test("owner run: +863.57 (extra money) called a loss fails, and so does a timing item called a loss", () => {
  const c = verifyFactAnswer("EFT_MISSING is a loss of -1,310.80 [F1].\nBANK_UNPOSTED is a loss of +863.57 [F6].\nOther items [F2] [F3] [F4] [F5]. HFD_LAG lost -1,600.00 [F7].", ALL);
  assert.ok(!c.ok);
  assert.ok(c.problems.some((p) => /calls \[F6\] a loss, but it is extra/.test(p)), c.problems.join("; "));
  assert.ok(c.problems.some((p) => /calls \[F7\] a loss, but it is timing/.test(p)), c.problems.join("; "));
  const ok = verifyFactAnswer("BANK_UNPOSTED +863.57 is not a loss: post it [F6]. HFD_LAG -1,600.00 is timing, not a real loss [F7]. Losses: [F1] [F2] [F3] [F4] [F5].", ALL);
  assert.deepEqual(ok.problems, []);
});

test("owner run: payment IDs borrowed from another item fail; an amount on the wrong fact or with the wrong sign fails", () => {
  const borrowed = verifyFactAnswer(GOOD.replace("- CASH_SHORT: -4.42 [F5].", "- CASH_SHORT: -4.42, payments 300006;300012 [F5]."), losses);
  assert.ok(borrowed.problems.some((p) => /payment 300006 does not belong to \[F5\]/.test(p)), borrowed.problems.join("; "));
  const wrongFact = verifyFactAnswer(GOOD.replace("-18.45 [F4]", "-164.00 [F4]"), losses);
  assert.ok(wrongFact.problems.some((p) => /-164\.00 is not the amount of \[F4\]/.test(p)));
  const flipped = verifyFactAnswer(GOOD.replace("-180.80, payment 300386 [F2]", "+180.80, payment 300386 [F2]"), losses);
  assert.ok(flipped.problems.some((p) => /\+180\.80 has the wrong direction for \[F2\]/.test(p)));
});

test("owner run: a payer left out fails (every fact must be mentioned); an uncited figure and an unknown tag fail", () => {
  const omitted = verifyFactAnswer("Delta Dental: missing EFT of -1,310.80 on 2024-09-14, payments 300264, 300266, 300268 [F1]. Ask about the remittance.", PAYERS);
  assert.deepEqual(omitted.problems, ["not mentioned: [F2] BANK_UNPOSTED +863.57"]);
  const uncited = verifyFactAnswer(GOOD + "\nIn total the office lost 1,678.47 this month.", losses);
  assert.ok(uncited.problems.some((p) => /1,678\.47 has no \[F#\]\/\[T#\]\/\[G#\] tag/.test(p)));
  const unknown = verifyFactAnswer(GOOD + " See [F9].", losses);
  assert.ok(unknown.problems.some((p) => /cites \[F9\], which is not in the facts/.test(p)));
});

test("a reasoning model's <think> block is ignored; an empty answer fails; the fallback text holds every fact", () => {
  assert.ok(verifyFactAnswer(`<think>maybe 999.99 [F9] is a loss</think>\n${GOOD}`, losses).ok);
  assert.ok(!verifyFactAnswer("   ", losses).ok);
  const plain = plainFacts(ALL);
  for (const s of ["EFT_MISSING on 2024-09-14: -1,310.80", "payments 300264, 300266, 300268", "BANK_UNPOSTED on 2024-09-13: +863.57", "NOT A LOSS: extra money", "HFD_LAG", "NOT A LOSS: timing"])
    assert.ok(plain.includes(s), s);
});

// Second owner run (2026-11-03 01:45, fact sheets, local/deepseek-r1-8b): the answers exactly as the model wrote them.
test("owner run 2: ask-missing-money with shuffled codes and dates (passed the first fact check) now fails", () => {
  const answer = [
    "Here are the exceptions where money is missing from the bank, largest first:",
    "*   [F1] | code EFT_MISSING | date 2024-09-14 | amount -1,310.80 | payments 300264;300266;300268",
    "*   [F3] | code UNDEPOSITED_CHECK | date 2024-09-08 | amount -164.00 | payments 300125;300445",
    "*   [F2] | code CARD_BATCH_SHORT | date 2024-09-19 | amount -180.80 | payments 300386",
    "*   [F4] | code CASH_SHORT | date 2024-09-05 | amount -18.45 | bank rows 17",
    "*   [F5] | code branch_atm_deposit | date 2024-09-01 | amount -4.42 | bank rows 12"].join("\n");
  const c = verifyFactAnswer(answer, renderSheet(LOSSES.slice(1), "Scope: losses."));
  assert.ok(!c.ok);
  for (const p of [/UNDEPOSITED_CHECK is not the code of \[F3\]/, /CARD_BATCH_SHORT is not the code of \[F2\]/, /CASH_SHORT is not the code of \[F4\]/]) assert.ok(c.problems.some((x) => p.test(x)), `${p}: ${c.problems.join("; ")}`);
  assert.ok(!c.problems.some((x) => /EFT_MISSING/.test(x)), "the right line stays right");
});

test("owner run 2: '(F7)' counts as a tag; a cited total covers its category; +863.57 called a posting error fails; a leftover placeholder fails", () => {
  const sheet = renderSheet([...LOSSES, { tag: "T2", kind: "T", category: "extra", items: 1, cents: 86357 }, { tag: "T3", kind: "T", category: "timing", items: 1, cents: -160000 },
    { tag: "T4", kind: "T", category: "posting", items: 1, cents: 7450 }, F("F6", "extra", "BANK_UNPOSTED", "2024-09-13", 86357, [], { payer: "MH" }),
    F("F7", "timing", "HFD_LAG", "2024-09-15", -160000, ["300306"]), F("F8", "posting", "REF_MISMATCH", "2024-09-19", 7450, ["300382"])], "Scope: totals, all.");
  const asWritten = verifyFactAnswer("Real losses: -1,678.47 (T1)\n\nTiming items: -1,600.00 (F7)\n\nPosting errors: +863.57 (F6) and +74.50 (F8)", sheet);
  assert.deepEqual(asWritten.problems, ["calls [F6] a posting error, but it is extra"]);
  assert.ok(!asWritten.problems.some((x) => /has no \[F#\]/.test(x)), "(T1)/(F7) are tags");
  const right = verifyFactAnswer("Real losses: -1,678.47 (T1)\nExtra money in the bank, not a loss: +863.57 [T2]\nTiming items: -1,600.00 (T3)\nPosting errors: 74.50 [T4]", sheet);
  assert.deepEqual(right.problems, [], "totals cover their categories");
  const ph = verifyFactAnswer("[F1] BANK_UNPOSTED on <BANK_DATE_1>: +863.57, payer MH; post it.", PAYERS);
  assert.ok(ph.problems.some((x) => /placeholder <BANK_DATE_1> left in the answer/.test(x)));
});

test("owner run 2 ledger: the model-facing sheet and every configured action avoid the gateway's bank-account context words", () => {
  for (const sheet of [losses, PAYERS, ALL]) assert.ok(!MASK_CONTEXT_WORDS.test(sheet.text), sheet.text.match(MASK_CONTEXT_WORDS)?.[0]);
  const cfg = JSON.parse(readFileSync(new URL("../../../config/domain-packs/finance/rcm/dental/reconcile.json", import.meta.url), "utf8"));
  for (const [code, action] of Object.entries(cfg.actions as Record<string, string>)) assert.ok(!MASK_CONTEXT_WORDS.test(action), `${code}: ${action}`);
});

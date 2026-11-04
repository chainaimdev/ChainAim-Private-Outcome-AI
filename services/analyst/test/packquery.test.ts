/** The query bank behind /pack-queries and /pack-run (DESIGN/xrplh-29): the shipped dental bank loads; a bad bank is refused. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bankPathOf, loadBank, SECTIONS } from "../src/packquery.ts";

const configRoot = fileURLToPath(new URL("../../../config", import.meta.url));

test("the dental pack's bank: 25 exact queries and 14 model questions, each question naming known fact sections", () => {
  const bank = loadBank(bankPathOf(configRoot, "finance/rcm/dental"));
  assert.equal(bank.queries.filter((q) => q.sql).length, 25);
  assert.equal(bank.queries.filter((q) => q.question).length, 14);
  for (const q of bank.queries.filter((x) => x.question)) assert.ok(q.facts!.every((f) => SECTIONS.includes(f)));
});

test("refuses a bank entry with both sql and question, a duplicate id, or a question without facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bank-"));
  const write = (queries: unknown[]) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify({ version: 1, queries })); return p; };
  assert.throws(() => loadBank(write([{ id: "a", title: "t", sql: "SELECT 1", question: "q" }])), /exactly one of sql/);
  assert.throws(() => loadBank(write([{ id: "a", title: "t", sql: "SELECT 1" }, { id: "a", title: "t", sql: "SELECT 2" }])), /unique/);
  assert.throws(() => loadBank(write([{ id: "a", title: "t", question: "q" }])), /needs "facts"/);
});

test("the dental bank's topics: every entry in a known topic; pairs are one exact + one model entry of the same topic, pointing at each other", () => {
  const bank = loadBank(bankPathOf(configRoot, "finance/rcm/dental"));
  assert.ok(bank.topics!.length >= 5);
  const pairs = bank.queries.filter((q) => q.pair);
  assert.ok(pairs.length >= 8 && pairs.length % 2 === 0);
  for (const t of bank.topics!) assert.ok(bank.queries.some((q) => q.topic === t.id), `topic ${t.id} has no question`);
});

test("refuses an unknown topic and a pair that does not point back or is the same kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "bank-"));
  const write = (b: unknown) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(b)); return p; };
  const topics = [{ id: "a", label: "A" }];
  assert.throws(() => loadBank(write({ version: 1, topics, queries: [{ id: "x", title: "t", topic: "b", sql: "SELECT 1" }] })), /not in topics/);
  assert.throws(() => loadBank(write({ version: 1, topics, queries: [{ id: "x", title: "t", topic: "a", sql: "SELECT 1", pair: "y" }, { id: "y", title: "t", topic: "a", sql: "SELECT 2", pair: "x" }] })), /other kind/);
  assert.throws(() => loadBank(write({ version: 1, topics, queries: [{ id: "x", title: "t", topic: "a", sql: "SELECT 1", pair: "y" }, { id: "y", title: "t", topic: "a", question: "q", facts: ["all"] }] })), /pairs back/);
});

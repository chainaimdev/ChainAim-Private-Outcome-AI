/**
 * The query prompt stays under a size limit (2026-11-06: a ChiroTouch SQL-fix retry reached 58,063 characters and the gateway,
 * which refuses more than 48,000, turned it away): fitPrompt keeps the system prompt and the table list + question, then the
 * latest attempts; crossAsk cuts a long error and applies the limit before every model call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type CrossAskDeps, type Msg, crossAsk, fitPrompt } from "../src/index.ts";

const size = (ms: readonly Msg[]) => ms.reduce((n, m) => n + m.content.length, 0);
const head: Msg[] = [{ role: "system", content: "S".repeat(100) }, { role: "user", content: "T".repeat(1000) }];
const pair = (i: number, n: number): Msg[] => [{ role: "assistant", content: `q${i} ` + "a".repeat(n) }, { role: "user", content: `f${i} ` + "u".repeat(n) }];

test("fitPrompt: under the limit nothing changes; the head alone over the limit is null", () => {
  const ms = [...head, ...pair(1, 50)];
  assert.deepEqual(fitPrompt(ms, 10_000), ms);
  assert.equal(fitPrompt(head, 1000), null);
});

test("fitPrompt: the oldest attempts are left out first, the latest feedback says how many, and the result fits", () => {
  const ms = [...head, ...pair(1, 2000), ...pair(2, 2000), ...pair(3, 2000)];
  const out = fitPrompt(ms, 1100 + 4200 + 200)!;
  assert.ok(size(out) <= 1100 + 4200 + 200);
  assert.deepEqual(out.slice(0, 2), head, "system prompt and table list always kept");
  assert.ok(out[2].content.startsWith("q3 ") && out.length === 4, "only the latest attempt is kept");
  assert.match(out[3].content, /^\(2 earlier failed attempt\(s\) left out to keep the request small\.\)\nf3 /);
});

test("fitPrompt: when even the latest attempt is too big, its feedback is cut, never the table list", () => {
  const out = fitPrompt([...head, ...pair(1, 50_000)], 5000)!;
  assert.ok(size(out) <= 5000, String(size(out)));
  assert.deepEqual(out.slice(0, 2), head);
  assert.match(out[out.length - 1].content, /\.\.\.\(cut\)$|^\(cut to keep the request small\)$/);
});

/** The analyst fails the first query with a very long error (like a DuckDB binder error listing every column), then succeeds. */
function deps(sizes: number[], schemaChars = 30_000): CrossAskDeps {
  let sqlCalls = 0;
  return {
    analyst: async (route) => {
      if (route === "relations") return { schema: "TABLE t (" + "c".repeat(schemaChars) + ")", relations: [], tables: ["t"] };
      if (sqlCalls++ === 0) throw new Error("Binder Error: Referenced column \"Credit Amount\" not found. Candidate bindings: " + "\"col\", ".repeat(4000));
      return { columns: ["n"], rows: [{ n: 1 }], truncated: false };
    },
    chat: async (messages) => { sizes.push(size(messages)); return { text: "```sql\nSELECT 1 AS n\n```" }; },
  };
}
const base = { folder: "/x", question: "How much?", model: "m/x", phrase: "none" as const, sqlRetries: 1, answerMaxRows: 10 };

test("crossAsk with maxPromptChars + retryErrorMaxChars: the retry stays under the limit and carries the cut error", async () => {
  const sizes: number[] = [];
  const r = await crossAsk({ ...base, maxPromptChars: 40_000, retryErrorMaxChars: 2000 }, deps(sizes));
  assert.equal(r.error, undefined, r.error); assert.equal(sizes.length, 2);
  assert.ok(sizes.every((n) => n <= 40_000), JSON.stringify(sizes));
  assert.deepEqual(r.sentToModel.map((s) => s.chars), sizes, "sentToModel reports what was sent");
  assert.ok(r.attempts[0].error!.length > 20_000, "the attempt keeps the full error (about 28,000 characters) for the run log");
});

test("crossAsk without the options behaves as before (the retry grows past 48,000: the 2026-11-06 failure)", async () => {
  const sizes: number[] = [];
  await crossAsk(base, deps(sizes));
  assert.ok(sizes[1] > 48_000, JSON.stringify(sizes));
});

test("crossAsk: a table list + question over maxPromptChars is refused before any model call, with a plain reason", async () => {
  const sizes: number[] = [];
  const r = await crossAsk({ ...base, maxPromptChars: 10_000 }, deps(sizes));
  assert.equal(sizes.length, 0, "no model call");
  assert.match(r.error!, /characters, over the 10000 a query request may have: pick fewer files or a smaller folder/);
});

test("ARCH-635 sentToModel carries the UTF-8 bytes of exactly what was sent, beside chars (calibration of bytesPerChar / tokensPerByte)", async () => {
  const sent: { role: string; content: string }[][] = [];
  const r = await crossAsk({ folder: "/x", question: "Combien d'été ? 💶", model: "m/x", phrase: "llm", sqlRetries: 0, answerMaxRows: 10 }, {
    analyst: async (route) => route === "relations" ? { schema: "TABLE t (n BIGINT)", relations: [], tables: ["t"] } : { columns: ["n"], rows: [{ n: 1 }], truncated: false },
    chat: async (messages) => { sent.push(messages.map((m) => ({ ...m }))); return { text: sent.length === 1 ? "```sql\nSELECT 1 AS n\n```" : "One." }; },
  });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.sentToModel.length, 2);
  r.sentToModel.forEach((s, i) => {
    assert.equal(s.bytes, sent[i].reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0), s.step);
    assert.equal(s.chars, sent[i].reduce((n, m) => n + m.content.length, 0), s.step);
    assert.ok(s.bytes > s.chars, "the accents and the emoji take more bytes than UTF-16 units");
  });
});

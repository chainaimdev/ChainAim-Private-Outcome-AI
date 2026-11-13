/**
 * privateAI-design-41 ARCH-697 / ARCH-699 on the console: the receipt's egress comes from the replies only when every call
 * has one; a refused header is a job-log line (call and reason, no content); the sent bytes are held per job in memory and
 * gone after the job expires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatReply } from "../../packages/crossask/src/index.ts";
import { receiptEgress } from "../console/receipt.ts";
import { egressRefusedLines, SentStore, sentOf } from "../console/egress.ts";

const eg = (sha: string) => ({ destination: "cloud-api.near.ai", zone: "private-cloud", sentSha256: sha, sentBytes: 10, masked: { PERSON: 1 }, residual: "pass" as const, dataClass: "PII" as const });
const reply = (over: Partial<ChatReply> = {}): ChatReply => ({ text: "answer text", model: "nearai/x", ...over });
const JOB = "0123456789abcdef0123456789abcdef";

test("ARCH-697 receiptEgress: one entry per call in run order with its index; none when any call has no egress (gateway flag off or a refused header)", () => {
  assert.deepEqual(receiptEgress([reply({ egress: eg("a".repeat(64)) }), reply({ egress: eg("b".repeat(64)) })]), [{ call: 0, ...eg("a".repeat(64)) }, { call: 1, ...eg("b".repeat(64)) }]);
  assert.equal(receiptEgress([reply({ egress: eg("a".repeat(64)) }), reply({ egressRefused: "unknown member prompt" })]), undefined);
  assert.equal(receiptEgress([reply()]), undefined);
  assert.equal(receiptEgress([]), undefined);
});

test("ARCH-697 a refused egress header is logged with the call and the reason, never content", () => {
  const lines = egressRefusedLines("offer", JOB, [reply({ egress: eg("a".repeat(64)) }), reply({ egressRefused: "unknown member prompt" })]);
  assert.equal(lines.length, 1);
  const l = JSON.parse(lines[0]);
  assert.deepEqual([l.event, l.jobId, l.call, l.reason], ["egress_refused", JOB, 1, "unknown member prompt"]);
  assert.ok(!lines[0].includes("answer text"));
});

test("ARCH-699 SentStore: the bytes per call while the job is held; 404 material (undefined) after expiry, for an unknown call, or beyond max", () => {
  let now = 1_000;
  const store = new SentStore(2, () => now);
  const bytes = new TextEncoder().encode('{"model":"x"}');
  const bySha = new Map([["a".repeat(64), bytes]]);
  store.hold(JOB, sentOf([reply({ egress: eg("a".repeat(64)) }), reply({ egress: eg("c".repeat(64)) })], bySha), 2_000);
  assert.deepEqual(store.get(JOB, 0), bytes);
  assert.equal(store.get(JOB, 1), undefined, "not fetched: no download for that call");
  assert.equal(store.get(JOB, 5), undefined);
  now = 2_000;
  assert.equal(store.get(JOB, 0), undefined, "gone once the job expires");
  store.hold("1".repeat(32), [bytes], 9_000);
  store.hold("2".repeat(32), [bytes], 9_000);
  store.hold("3".repeat(32), [bytes], 9_000);
  assert.equal(store.get("1".repeat(32), 0), undefined, "the oldest goes beyond max");
  assert.deepEqual(store.get("3".repeat(32), 0), bytes);
  store.hold("4".repeat(32), [undefined], 9_000);
  assert.equal(store.get("4".repeat(32), 0), undefined, "nothing kept for a job with no bytes");
});

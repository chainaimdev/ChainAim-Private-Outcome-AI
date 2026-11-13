/**
 * privateAI-design-38 ARCH-683: a tenant's optional allowedModels / maxTokensPerCall, read from the SIGNED checkout limits.
 * Absent = no check, so existing tenants decide exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checksFor, decide, parsePolicy, type Quote } from "../src/index.ts";

const RAW = { autoApproveMaxUsd: "0.10", maxPerJobUsd: "1.00", dailyCapUsd: "5.00", requireAttestedRoute: false, requoteAutoAcceptPct: 0, counter: { enabled: false, maxRounds: 0, acceptReduced: [] } };
const NOW = 1_800_000_000_000;
const ctx = { spentTodayMicro: 0n, now: NOW };
const q = (extra: Partial<Quote> = {}): Quote => ({ quoteId: "q1", route: "nearai/deepseek-v4.1-flash", priceUsd: "0.02", attested: true, expiresAt: NOW + 60_000, ...extra });
const SIGNED = { models: ["nearai/deepseek-v4.1-flash"], maxTokens: 2048 };

test("ARCH-683: allowedModels and maxTokensPerCall are optional and checked field by field", () => {
  const plain = parsePolicy(RAW, "t01");
  assert.equal("allowedModels" in plain || "maxTokensPerCall" in plain, false, "absent stays absent");
  const p = parsePolicy({ ...RAW, allowedModels: ["nearai/deepseek-v4.1-flash"], maxTokensPerCall: 2048 }, "t01");
  assert.deepEqual([p.allowedModels, p.maxTokensPerCall], [["nearai/deepseek-v4.1-flash"], 2048]);
  assert.throws(() => parsePolicy({ ...RAW, allowedModels: [] }, "t01"), /allowedModels must be a non-empty list of model ids/);
  assert.throws(() => parsePolicy({ ...RAW, allowedModels: ["gpt"] }, "t01"), /allowedModels must be a non-empty list of model ids/);
  assert.throws(() => parsePolicy({ ...RAW, maxTokensPerCall: 0 }, "t01"), /maxTokensPerCall must be a whole number of at least 1/);
});

test("ARCH-683: without the rules a quote decides as before, with or without signed limits", () => {
  const p = parsePolicy(RAW, "t01");
  assert.equal(decide(p, [q()], ctx).action, "pay");
  assert.equal(decide(p, [q({ limits: SIGNED })], ctx).action, "pay");
  assert.deepEqual(checksFor(p, q(), ctx).map((c) => c.check), ["not_expired", "max_per_job", "daily_cap", "auto_approve"]);
});

test("ARCH-683: the rules read the signed limits: another model, more tokens per call, or no signed limits is refused", () => {
  const p = parsePolicy({ ...RAW, allowedModels: ["nearai/deepseek-v4.1-flash"], maxTokensPerCall: 2048 }, "t01");
  assert.equal(decide(p, [q({ limits: SIGNED })], ctx).action, "pay");
  const other = decide(p, [q({ limits: { models: ["nearai/deepseek-v4.1-flash", "nearai/glm-5"], maxTokens: 2048 } })], ctx);
  assert.deepEqual(other, { action: "refuse", reason: "the signed limits allow nearai/glm-5, which is not in allowedModels" });
  const big = decide(p, [q({ limits: { ...SIGNED, maxTokens: 4096 } })], ctx);
  assert.deepEqual(big, { action: "refuse", reason: "the signed limits allow 4096 tokens per call, above maxTokensPerCall 2048" });
  assert.deepEqual(decide(p, [q()], ctx), { action: "refuse", reason: "the policy limits models or tokens and the quote carries no signed limits" });
  // checksFor explains the same decision.
  const checks = checksFor(p, q({ limits: { ...SIGNED, maxTokens: 4096 } }), ctx);
  assert.deepEqual(checks.filter((c) => c.check === "allowed_models" || c.check === "max_tokens_per_call").map((c) => [c.check, c.ok]), [["allowed_models", true], ["max_tokens_per_call", false]]);
  assert.equal(checksFor(p, q(), ctx).find((c) => c.check === "allowed_models")!.value, "no signed limits");
});

test("ARCH-688: requireAttestation reads the SIGNED attestation mode: weaker, unsigned or no signed limits is refused", () => {
  assert.equal("requireAttestation" in parsePolicy(RAW, "t01"), false, "absent stays absent");
  assert.throws(() => parsePolicy({ ...RAW, requireAttestation: "always" }, "t01"), /requireAttestation must be off, evidence or verified/);
  const off = parsePolicy({ ...RAW, requireAttestation: "off" }, "t01");
  assert.equal(decide(off, [q()], ctx).action, "pay", "off checks nothing");
  const p = parsePolicy({ ...RAW, requireAttestation: "verified" }, "t01");
  assert.equal(decide(p, [q({ limits: { ...SIGNED, attestation: "verified" } })], ctx).action, "pay");
  assert.deepEqual(decide(p, [q({ limits: { ...SIGNED, attestation: "evidence" } })], ctx), { action: "refuse", reason: "the signed limits promise attestation evidence, weaker than requireAttestation verified" });
  assert.deepEqual(decide(p, [q({ limits: SIGNED })], ctx), { action: "refuse", reason: "the signed limits promise attestation none, weaker than requireAttestation verified" });
  assert.deepEqual(decide(p, [q()], ctx), { action: "refuse", reason: "the policy requires attestation verified and the quote carries no signed limits" });
  const ev = parsePolicy({ ...RAW, requireAttestation: "evidence" }, "t01");
  assert.equal(decide(ev, [q({ limits: { ...SIGNED, attestation: "verified" } })], ctx).action, "pay", "stronger than required is fine");
  // checksFor explains the same decision.
  assert.deepEqual(checksFor(p, q({ limits: { ...SIGNED, attestation: "evidence" } }), ctx).filter((c) => c.check === "require_attestation").map((c) => [c.limit, c.value, c.ok]), [["verified", "evidence", false]]);
  assert.equal(checksFor(p, q({ limits: SIGNED }), ctx).find((c) => c.check === "require_attestation")!.value, "not signed");
});

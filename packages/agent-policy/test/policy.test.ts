import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, parsePolicy, SpendLedger, usdToMicro, type Quote } from "../src/index.ts";

const RAW = {
  autoApproveMaxUsd: "0.10",
  maxPerJobUsd: "1.00",
  dailyCapUsd: "5.00",
  requireAttestedRoute: true,
  requoteAutoAcceptPct: 0,
  counter: { enabled: true, maxRounds: 2, acceptReduced: ["answerMaxRows", "phrase"] },
};
const NOW = 1_800_000_000_000;
const q = (price: string, extra: Partial<Quote> = {}): Quote => ({ quoteId: `q-${price}`, route: "nearai", priceUsd: price, attested: true, expiresAt: NOW + 60_000, ...extra });

test("ARCH-620 money is whole micro-USD and more than 6 decimals is refused", () => {
  assert.equal(usdToMicro("0.10"), 100_000n);
  assert.equal(usdToMicro("1"), 1_000_000n);
  assert.throws(() => usdToMicro("0.0000001"), /at most 6 decimals/);
  assert.throws(() => usdToMicro("-1"), /decimal USD/);
});

test("ARCH-620 the policy block is checked field by field", () => {
  assert.throws(() => parsePolicy(undefined, "t01"), /tenant t01: tenant.json has no "policy" block/);
  assert.throws(() => parsePolicy({ ...RAW, autoApproveMaxUsd: "2.00" }, "t01"), /autoApproveMaxUsd must not exceed maxPerJobUsd/);
  assert.throws(() => parsePolicy({ ...RAW, maxPerJobUsd: 1 }, "t01"), /maxPerJobUsd must be a decimal USD string/);
  assert.throws(() => parsePolicy({ ...RAW, counter: { ...RAW.counter, acceptReduced: ["everything"] } }, "t01"), /acceptReduced must list only/);
  assert.equal(parsePolicy(RAW, "t01").counter.maxRounds, 2);
});

test("ARCH-620 a quote within the auto-approve limit and the daily cap is paid; the cheapest usable quote wins", () => {
  const p = parsePolicy(RAW, "t01");
  const d = decide(p, [q("0.08"), q("0.05"), q("0.01", { attested: false, route: "bedrock" })], { spentTodayMicro: 0n, now: NOW });
  assert.equal(d.action, "pay");
  assert.equal(d.action === "pay" && d.quote.priceUsd, "0.05");
});

test("ARCH-620 the attested-route rule and expiry refuse", () => {
  const p = parsePolicy(RAW, "t01");
  assert.equal(decide(p, [q("0.01", { attested: false })], { spentTodayMicro: 0n, now: NOW }).action, "refuse");
  assert.equal(decide(p, [q("0.01", { expiresAt: NOW })], { spentTodayMicro: 0n, now: NOW }).action, "refuse");
});

test("ARCH-620 the daily cap refuses", () => {
  const p = parsePolicy(RAW, "t01");
  const d = decide(p, [q("0.05")], { spentTodayMicro: usdToMicro("4.99"), now: NOW });
  assert.equal(d.action, "refuse");
  assert.match(d.reason, /daily cap/);
});

test("ARCH-624 above the auto-approve limit the seller is countered at the auto-approve ceiling, then a human approves", () => {
  const p = parsePolicy(RAW, "t01");
  const first = decide(p, [q("0.40")], { spentTodayMicro: 0n, now: NOW });
  assert.equal(first.action, "counter");
  assert.equal(first.action === "counter" && first.ceilingUsd, "0.1");
  const out = decide(p, [q("0.40")], { spentTodayMicro: 0n, now: NOW, counterRound: 2 });
  assert.equal(out.action, "approve");
});

test("ARCH-621 counters off: above the auto-approve limit waits for a human; above maxPerJob is refused", () => {
  const p = parsePolicy({ ...RAW, counter: { enabled: false, maxRounds: 0, acceptReduced: [] } }, "t01");
  assert.equal(decide(p, [q("0.40")], { spentTodayMicro: 0n, now: NOW }).action, "approve");
  assert.equal(decide(p, [q("1.50")], { spentTodayMicro: 0n, now: NOW }).action, "refuse");
});

test("ARCH-624 a counter offer is accepted only when every reduced limit is allowed", () => {
  const p = parsePolicy(RAW, "t01");
  const ok = decide(p, [q("0.09", { counterOf: "q-0.40", reduced: ["answerMaxRows"] })], { spentTodayMicro: 0n, now: NOW, counterRound: 1 });
  assert.equal(ok.action, "pay");
  const no = decide(p, [q("0.09", { counterOf: "q-0.40", reduced: ["route"] })], { spentTodayMicro: 0n, now: NOW, counterRound: 1 });
  assert.equal(no.action, "refuse");
});

test("ARCH-610 a requote above requoteAutoAcceptPct goes to a human", () => {
  const p = parsePolicy(RAW, "t01");
  assert.equal(decide(p, [q("0.06")], { spentTodayMicro: 0n, now: NOW, requoteOfUsd: "0.05" }).action, "approve");
  assert.equal(decide(p, [q("0.05")], { spentTodayMicro: 0n, now: NOW, requoteOfUsd: "0.05" }).action, "pay");
});

test("ARCH-620 the spend ledger sums today's settled payments per tenant and starts again the next UTC day", () => {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  try {
    let t = Date.parse("2026-11-10T23:00:00Z");
    const l = new SpendLedger(dir, () => t);
    l.record("t02", "j1", "0.05", "tx1");
    l.record("t02", "j2", "0.10", "tx2");
    assert.equal(l.spentToday("t02"), 150_000n);
    assert.equal(l.spentToday("t03"), 0n);
    t = Date.parse("2026-11-11T00:30:00Z");
    assert.equal(l.spentToday("t02"), 0n);
    assert.throws(() => l.record("../x", "j", "0.01", "tx"), /tenant id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

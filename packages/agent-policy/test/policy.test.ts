import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksFor, decide, parsePolicy, policyView, SpendLedger, usdToMicro, type Quote } from "../src/index.ts";

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

test("ARCH-620 checksFor explains a single quote the way decide() decides it: pay exactly when every check passes", () => {
  // The owner's demo values (2026-11-10): t01 pays a 0.01 job, t03 refuses it.
  const t01 = parsePolicy({ ...RAW, autoApproveMaxUsd: "0.05", maxPerJobUsd: "0.05", dailyCapUsd: "1.00", counter: { enabled: false, maxRounds: 0, acceptReduced: [] } }, "t01");
  const t03 = parsePolicy({ ...RAW, autoApproveMaxUsd: "0.005", maxPerJobUsd: "0.005", dailyCapUsd: "2.00", requireAttestedRoute: false, counter: { enabled: false, maxRounds: 0, acceptReduced: [] } }, "t03");
  const cases: [string, ReturnType<typeof parsePolicy>, Quote, bigint][] = [
    ["t01 pays", t01, q("0.01"), 0n],
    ["t01 daily cap", t01, q("0.01"), usdToMicro("0.995")],
    ["t01 not attested", t01, q("0.01", { attested: false }), 0n],
    ["t01 expired", t01, q("0.01", { expiresAt: NOW }), 0n],
    ["t01 above max", t01, q("0.06"), 0n],
    ["t03 refuses", t03, q("0.01", { attested: false }), 0n],
    ["t03 pays a small job", t03, q("0.004", { attested: false }), 0n],
  ];
  for (const [name, p, quote, spent] of cases) {
    const d = decide(p, [quote], { spentTodayMicro: spent, now: NOW });
    const checks = checksFor(p, quote, { spentTodayMicro: spent, now: NOW });
    assert.equal(d.action === "pay", checks.every((c) => c.ok), name);
  }
  const refused = checksFor(t03, q("0.01", { attested: false }), { spentTodayMicro: 0n, now: NOW });
  assert.deepEqual(refused.map((c) => [c.check, c.limit, c.value, c.ok]).slice(1), [["max_per_job", "0.005", "0.01", false], ["daily_cap", "2", "0.01", true], ["auto_approve", "0.005", "0.01", false]]);
  assert.equal(refused.some((c) => c.check === "attested_route"), false, "no attested-route row when the policy does not require it");
  assert.deepEqual(checksFor(t01, q("0.01"), { spentTodayMicro: 0n, now: NOW }).map((c) => c.check), ["not_expired", "attested_route", "max_per_job", "daily_cap", "auto_approve"]);
});

test("ARCH-620 policyView shows the owner's limits and today's spend as decimal USD, nothing else", () => {
  assert.deepEqual(policyView(parsePolicy(RAW, "t01"), usdToMicro("0.02")), {
    autoApproveMaxUsd: "0.1", maxPerJobUsd: "1", dailyCapUsd: "5", requireAttestedRoute: true, counter: true, spentTodayUsd: "0.02",
  });
});

test("ARCH-620 the spend ledger refuses at start-up when its folder cannot be written", () => {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  try {
    new SpendLedger(join(dir, "new", "deeper")).ensureWritable();
    writeFileSync(join(dir, "a-file"), "x");
    assert.throws(() => new SpendLedger(join(dir, "a-file", "x")).ensureWritable(), /the spend ledger folder .* cannot be written/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

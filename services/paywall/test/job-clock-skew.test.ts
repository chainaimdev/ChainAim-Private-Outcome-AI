/**
 * ARCH-106 job registration and clock differences (owner test runs 2026-11-10): the console sets a job's expiresAt to its
 * own now + --job-ttl-min (default 15 min), and the paywall allowed at most its now + PAID_JOBS_TTL_SEC (default 900 s), so
 * with no allowance a console clock even 1 ms ahead of the paywall's refused every paid job (agent-jobs.test.ts failed 3,
 * then 7 tests with "expiresAt must be at most PAID_JOBS_TTL_SEC"). PAID_JOBS_CLOCK_SKEW_SEC (default 30) allows that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJob } from "../src/jobs.ts";

const now = 1_800_000_000_000;
const body = (expiresAt: number) => ({ jobId: "a".repeat(32), amount: "3000", expiresAt });

test("ARCH-106 a console clock up to PAID_JOBS_CLOCK_SKEW_SEC ahead is accepted; beyond it is refused, naming both settings", () => {
  const ttl = 900, skew = 30;
  assert.ok(!("error" in parseJob(body(now + ttl * 1000), now, ttl, skew)), "exactly the TTL");
  assert.ok(!("error" in parseJob(body(now + ttl * 1000 + 1), now, ttl, skew)), "the console 1 ms ahead (the failing case)");
  assert.ok(!("error" in parseJob(body(now + (ttl + skew) * 1000), now, ttl, skew)), "at the allowance");
  const r = parseJob(body(now + (ttl + skew) * 1000 + 1), now, ttl, skew);
  assert.ok("error" in r && /PAID_JOBS_TTL_SEC \(900 s\)/.test(r.error) && /PAID_JOBS_CLOCK_SKEW_SEC \(30 s\)/.test(r.error));
});

test("ARCH-106 with no allowance (0) the check is strict, as before; a past expiresAt is refused whatever the allowance", () => {
  assert.ok("error" in parseJob(body(now + 900_000 + 1), now, 900));
  assert.ok("error" in parseJob(body(now + 900_000 + 1), now, 900, 0));
  assert.ok("error" in parseJob(body(now), now, 900, 30), "not in the future");
});

test("ARCH-106 PAID_JOBS_CLOCK_SKEW_SEC is read with paid jobs on, default 30, 0..300, and the release route passes it to parseJob", () => {
  const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(config, /const clockSkewSec = integer\("PAID_JOBS_CLOCK_SKEW_SEC", 30\);/);
  assert.match(config, /if \(clockSkewSec < 0 \|\| clockSkewSec > 300\)/);
  assert.match(config, /ttlSec, clockSkewSec, max \};/);
  const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.match(app, /parseJob\(body, \(deps\.now \?\? Date\.now\)\(\), paidJobs\.ttlSec, paidJobs\.clockSkewSec \?\? 0\)/);
});

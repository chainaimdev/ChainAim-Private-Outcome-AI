/**
 * privateAI-design-31 §5: test-console/desk.ps1, the one command for the desk, read as text (no PowerShell needed). Guards
 * what must not regress: ASCII only (Windows PowerShell 5.1), keys never printed, the paywall's paid-jobs keys passed by
 * name, no "$name:" parse traps, every service logged, and the settings example complete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ps = readFileSync(new URL("../../test-console/desk.ps1", import.meta.url), "utf8");
const ex = JSON.parse(readFileSync(new URL("../../config/local/desk.example.json", import.meta.url), "utf8"));

test("ASCII only, and no PowerShell parse traps: \"$name:\" outside $env:/$script:, a -Profile parameter, a Start-Service function", () => {
  assert.ok(/^[\x00-\x7F]*$/.test(ps), "desk.ps1 must be ASCII");
  const traps = [...ps.matchAll(/"[^"\n]*\$([A-Za-z_][A-Za-z0-9_]*):(?!:)/g)].map((m) => m[1]).filter((v) => !["env", "script", "global"].includes(v));
  assert.deepEqual(traps, []);
  assert.ok(!/\[string\]\$Profile\b/.test(ps), "$Profile is PowerShell's own variable");
  assert.ok(!/function Start-Service\(/.test(ps), "Start-Service is a Windows cmdlet");
});

test("keys are never printed: no output line names a key variable; secrets are read by name into the process only", () => {
  for (const line of ps.split(/\r?\n/)) {
    if (/\b(Say|Write-Host|Fail|Stop-Here)\b/.test(line)) assert.ok(!/\$env:[A-Z_]*KEY/.test(line), `prints a key: ${line.trim()}`);
  }
  assert.match(ps, /SetEnvironmentVariable\(\$Matches\[1\], \$Matches\[2\]\.Trim\(\), "Process"\)/);
  assert.match(ps, /\$lines = \$null/, "the paywall's env lines are dropped after the in-memory comparison");
});

test("the paywall is rebuilt with the paid-jobs names passed by name, and only when missing or asked", () => {
  assert.match(ps, /-PassEnv FACILITATOR_URL_TESTNET, FACILITATOR_URL_MAINNET, RLUSD_ISSUER_TESTNET, RLUSD_ISSUER_MAINNET, PRICE_SCAN, PRICE_MASK, PRICE_CHAT, PUBLIC_BASE_URL, PAID_JOBS, PAID_JOBS_KEY, PAID_JOBS_RESULT_URL, NEAR_RPC_URL_TESTNET/);
  assert.match(ps, /if \(\$RebuildPaywall\) \{ \$reasons \+= /);
  assert.match(ps, /if \(\$reasons\.Count\) \{/, "one rebuild covers every reason");
});

test("the paywall's NEAR RPC is tested from inside the container and switched to the first answering candidate (FastNEAR -429, 2026-11-05)", () => {
  assert.match(ps, /function RpcAnswers\(/);
  assert.match(ps, /docker exec ca-paywall node -e \$js/);
  assert.match(ps, /foreach \(\$u in \$cands\) \{ if \(RpcAnswers \$u\) \{ \$rpcWant = \$u; break \} \}/);
  assert.match(ps, /\$reasons \+= "NEAR RPC"/);
  assert.ok(Array.isArray(ex.paywall.nearRpcCandidates) && ex.paywall.nearRpcCandidates.every((u: string) => /^https:\/\//.test(u)));
});

test("every service runs hidden with its own log; the READY table and the paywall-to-console reachability check are there", () => {
  assert.match(ps, /-WindowStyle Hidden -RedirectStandardOutput \$out -RedirectStandardError \$err/);
  for (const s of ["analyst", "chainQuery", "nearWatch", "adminUi", "console"]) assert.match(ps, new RegExp(`Start-DeskService "${s}"`));
  assert.match(ps, /docker exec ca-paywall node -e/);
  assert.match(ps, /Say "READY"/);
  for (const sw of ["Restart", "Stop", "Check", "Test", "RebuildPaywall", "NoBrowser"]) assert.match(ps, new RegExp(`\\[switch\\]\\$${sw}\\b`));
});

test("models follow the gateway (summary.json) unless set; fees are required and never defaulted", () => {
  assert.match(ps, /config\\generated\\summary\.json/);
  assert.match(ps, /must be a number written as text/);
  assert.deepEqual(Object.keys(ex.paidJobs).sort(), ["enabled", "feeAnalystUsd", "feePerModelCallUsd", "marginPct", "minPriceUsd", "nearGasFeeUsd", "pricingCatalog", "secretsFile"]);
  for (const k of ["feePerModelCallUsd", "feeAnalystUsd", "marginPct", "minPriceUsd"]) assert.ok(!/^[0-9.]+$/.test(ex.paidJobs[k]), `${k}: the example must not ship a price`);
  assert.equal(ex.console.modelsFile, "auto"); assert.ok(Array.isArray(ex.adminUi.watch));
});

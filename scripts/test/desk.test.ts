/**
 * privateAI-design-31 §5 (rewritten 2026-11-06): test-console/desk.ps1 is a CONDUCTOR over the two repositories' own Docker
 * launchers (adminUI nearadminup.ps1, private test-console/up.ps1). Read as text (no PowerShell needed). Guards: it starts no
 * service itself, stops only node processes (never Docker's port owners), never reads a secret value, calls the launchers in
 * order with this PC's watch list, ASCII only, no "$name:" parse traps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ps = readFileSync(new URL("../../test-console/desk.ps1", import.meta.url), "utf8");
const ex = JSON.parse(readFileSync(new URL("../../config/local/desk.example.json", import.meta.url), "utf8"));
const code = ps.slice(ps.indexOf("#>") + 2); // without the help comment

test("ASCII only, and no PowerShell parse traps (\"$name:\" outside $env:/$script:, $Profile, cmdlet-name clashes)", () => {
  assert.ok(/^[\x00-\x7F]*$/.test(ps), "desk.ps1 must be ASCII");
  const traps = [...code.matchAll(/"[^"\r\n]*"/g)].flatMap((m) => [...m[0].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):(?!:)/g)].map((v) => v[1])).filter((v) => !["env", "script", "global"].includes(v));
  assert.deepEqual(traps, []);
  assert.ok(!/\[string\]\$Profile\b/.test(code));
  assert.ok(!/function (Start-Service|Stop-Service|Get-Service)\b/.test(code));
});

test("a conductor: runs nearadminup.ps1 then test-console\\up.ps1, and their down.ps1 for -Stop; starts no service itself", () => {
  const a = code.indexOf("& $adminUp @adminArgs"), b = code.indexOf("& $privUp @privArgs");
  assert.ok(a > 0 && b > a, "admin side first, then the private side");
  assert.match(code, /\$adminUp = Join-Path \$adminRoot "nearadminup\.ps1"/);
  assert.match(code, /\$privUp = Join-Path \$repo "test-console\\up\.ps1"/);
  assert.match(code, /ReplaceRunning = \$true/);
  assert.match(code, /& \$privDown/); assert.match(code, /& \$adminDown/);
  assert.ok(!/Start-Process -FilePath\s+(\$exe|"node")/.test(code), "no service started by this script");
  assert.ok(!/&\s*\(?[^\n]*stack\.ps1/.test(code), "never calls stack.ps1 (compose owns the containers)");
});

test("leftovers: only node processes on the old ports are stopped, never Docker's port owners", () => {
  assert.match(code, /if \(\$p -and \$p\.ProcessName -eq "node"\) \{ Stop-Process/);
  assert.equal((code.match(/Stop-Process/g) ?? []).length, 1);
});

test("secrets: files checked by name only; no value read, set or printed", () => {
  assert.ok(!/SetEnvironmentVariable/.test(code));
  assert.ok(!/Get-Content[^\n]*PRIV-AI-SECRETS|Get-Content[^\n]*\$secrets/.test(code), "no secrets file is read");
  assert.match(code, /Select-String -Path \(Join-Path \$secrets "near-testnet\.env"\) -Pattern '\^\\s\*NEAR_RPC_URL_TESTNET\\s\*=\\s\*\\S'/);
  for (const line of code.split(/\r?\n/)) if (/\b(Say|Write-Host|Problem|Stop-Here)\b/.test(line)) assert.ok(!/\$env:[A-Z_]*KEY/.test(line), line.trim());
});

test("model attestation (ARCH-411): attest.enabled auto/on/off and gpuCheck go to up.ps1; READY row reads commands.yml, not a secret", () => {
  assert.match(code, /\[switch\]\$Attest,/);
  assert.match(code, /if \(\$attestMode -ne "auto"\) \{ \$privArgs\.Attest = \$attestMode \}/);
  assert.match(code, /\$privArgs\.AttestGpuCheck = \$attestGpu/);
  assert.match(code, /"attest \(ca-attest\)", "http:\/\/127\.0\.0\.1:8770\/healthz"/);
  assert.match(code, /runtime\\compose\\commands\.yml/);
  assert.ok(code.indexOf("$privArgs.Attest") < code.indexOf("& $privUp @privArgs"));
  assert.equal(ex.attest.enabled, "auto"); assert.equal(ex.attest.gpuCheck, "on");
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.ok(/^[\x00-\x7F]*$/.test(up), "up.ps1 must be ASCII");
  assert.match(up, /\[ValidateSet\("on", "off"\)\]\[string\]\$Attest = "on"/);
  assert.match(up, /--attest-url=http:\/\/attest:\$AttestPort/);
  assert.match(up, /& docker rm -f ca-attest/);
  // Images always rebuilt (cache) unless -NoBuild, so no image runs code older than the flags (2026-11-06 --attest-url).
  assert.match(up, /@\("up", "-d"\) \+ \$\(if \(-not \$NoBuild\) \{ @\("--build"\) \}/);
  const down = readFileSync(new URL("../../test-console/down.ps1", import.meta.url), "utf8");
  assert.match(down, /--profile attest/);
});

test("this PC's watch list and gas go to nearadminup.ps1; the paywall's NEAR RPC is tested from inside ca-paywall", () => {
  assert.match(code, /\$adminArgs\.Watch = \$watch/); assert.match(code, /\$adminArgs\.GasPerPaymentNear =/);
  assert.match(code, /docker exec ca-paywall node -e \$js/);
  assert.ok(Array.isArray(ex.adminUi.watch) && ex.adminUi.watch.length > 0);
  assert.equal(ex.paidJobs.feePerModelCallUsd, undefined, "prices live in up.ps1's price files, not here");
});

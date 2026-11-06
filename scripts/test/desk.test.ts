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

test("re-judge of false reconcile mismatches (owner rule: one script): inside ca-near-watch, both options together, checked before any start", () => {
  assert.match(code, /\[string\]\$RejudgeReceiver = "",/);
  assert.match(code, /\[string\]\$RejudgeReason = "",/);
  assert.match(code, /& docker exec ca-near-watch node --env-file=\/run\/secrets\/near-watch\.env src\/rejudge\.ts --all-mismatches --receiver \$RejudgeReceiver --reason \$RejudgeReason/);
  assert.ok(code.indexOf("-RejudgeReceiver and -RejudgeReason go together") < code.indexOf("# 1. pre-flight"), "options checked before anything starts");
  assert.ok(code.indexOf("& $privUp @privArgs") < code.indexOf("src/rejudge.ts"), "re-judge runs after the start");
  assert.ok(!/ADMIN_API_KEY/.test(code), "the admin key is never named or read here: it stays inside ca-near-watch");
});

test("the admin UI (Next.js) is rebuilt when its source is newer than .next\\BUILD_ID, before nearadminup.ps1 starts it (one script)", () => {
  assert.match(code, /\$buildId = Join-Path \$consoleDir "\.next\\BUILD_ID"/);
  assert.match(code, /& npm --prefix \$consoleDir run build/);
  assert.ok(code.indexOf("run build") < code.indexOf("& $adminUp @adminArgs"), "built before it is started");
  assert.ok(code.indexOf("Stop-Process") < code.indexOf("run build"), "the old 8800 process is stopped first, so the new build is served");
});

test("-Logs NAME: read-only log view of known services only, before anything starts (one script, no raw docker commands)", () => {
  assert.match(code, /\[string\[\]\]\$Logs = @\(\),/);
  assert.match(code, /& docker logs --tail \$LogLines \$known\[\$n\]/);
  assert.match(code, /if \(-not \$known\.Contains\(\$n\)\) \{ Stop-Here/);
  assert.ok(code.indexOf("if ($Logs.Count)") < code.indexOf("# 1. pre-flight"), "no start, no change");
  for (const s of ["ca-gateway", "ca-paywall", "ca-console-api", "ca-attest", "ca-near-watch"]) assert.ok(code.includes(`"${s}"`), s);
});

test("no positional parameters: a stray word (\"-Check memor\", 2026-11-06) is refused instead of binding to -Logs", () => {
  assert.match(code, /\[CmdletBinding\(PositionalBinding = \$false\)\]\s*\r?\nparam\(/);
});

test("-Memory: read-only memory report (RAM, Docker, ollama ps, model pulled), flags for model and need, before anything starts", () => {
  assert.match(code, /\[switch\]\$Memory,/);
  assert.match(code, /\[string\]\$MemoryModel = "deepseek-r1:8b",/);
  assert.match(code, /\[double\]\$MemoryNeedGb = 7,/);
  assert.match(code, /Get-CimInstance Win32_ComputerSystem/);
  assert.match(code, /Get-CimInstance Win32_OperatingSystem/);
  // Judged on Available (free + standby, Task Manager's figure), not FreePhysicalMemory alone (1.6 GB "free" on 15.7 GB, 2026-11-06).
  assert.match(code, /Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory/);
  assert.match(code, /\$freeGb = if \(\$perf -and \$perf\.AvailableBytes\)/);
  assert.match(code, /Get-Process -Name vmmem, vmmemWSL/);
  assert.match(code, /& docker stats --no-stream/);
  assert.match(code, /& ollama ps/);
  assert.match(code, /& ollama list/);
  const m = code.slice(code.indexOf("if ($Memory) {"), code.indexOf("# ---------------------------------------------------------------- -Test"));
  assert.ok(m.length > 0 && code.indexOf("if ($Memory) {") < code.indexOf("# 1. pre-flight"), "no start, no change");
  assert.ok(!/ollama (pull|rm|run)|docker (rm|stop|kill|compose)|Stop-Process/.test(m), "changes nothing");
  assert.match(m, /exit 0/);
});

test("-Smoke: the UI template smoke check runs scripts\\ui-smoke.ts on the sample root through the running console API, before any start", () => {
  assert.match(code, /\[switch\]\$Smoke,/);
  assert.match(code, /\[string\]\$SmokeModel = "bedrock\/nemotron-nano-3-30b",/);
  assert.match(code, /\[string\]\$SmokeSets = "default",/);
  assert.match(code, /\[switch\]\$SmokeDryRun,/);
  const s = code.slice(code.indexOf("if ($Smoke) {"), code.indexOf("# ---------------------------------------------------------------- -Test"));
  assert.ok(s.length > 0 && code.indexOf("if ($Smoke) {") < code.indexOf("# 1. pre-flight"), "no start, no change");
  assert.match(s, /\$smokeArgs = @\("scripts\\ui-smoke\.ts", "--api", "http:\/\/127\.0\.0\.1:8735", "--root", "samples"/);
  assert.match(s, /HttpStatus "http:\/\/127\.0\.0\.1:8735\/"/);
  assert.match(s, /& node @smokeArgs\s*\r?\n\s*exit \$LASTEXITCODE/);
  assert.ok(!/docker|ollama|Stop-Process|& \$privUp|& \$adminUp/.test(s), "changes nothing");
});

test("-SmbSample: writes and verifies the smb-fin-1 receivables and payables (tools\\smb-synth), before any start", () => {
  assert.match(code, /\[switch\]\$SmbSample,/);
  assert.match(code, /\[int\]\$SmbSeed = 1,/);
  const s = code.slice(code.indexOf("if ($SmbSample) {"), code.indexOf("# ---------------------------------------------------------------- -Smoke"));
  assert.ok(s.length > 0 && code.indexOf("if ($SmbSample) {") < code.indexOf("# 1. pre-flight"), "no start");
  assert.match(s, /& python tools\\smb-synth\\gen_ar_ap\.py --out-dir \$smbDir --seed \$SmbSeed --force/);
  assert.match(s, /& python tools\\smb-synth\\verify_ar_ap\.py --dir \$smbDir\s*\r?\n\s*exit \$LASTEXITCODE/);
  assert.ok(!/docker|Stop-Process/.test(s), "touches no service");
});

test("this PC's watch list and gas go to nearadminup.ps1; the paywall's NEAR RPC is tested from inside ca-paywall", () => {
  assert.match(code, /\$adminArgs\.Watch = \$watch/); assert.match(code, /\$adminArgs\.GasPerPaymentNear =/);
  assert.match(code, /docker exec ca-paywall node -e \$js/);
  assert.ok(Array.isArray(ex.adminUi.watch) && ex.adminUi.watch.length > 0);
  assert.equal(ex.paidJobs.feePerModelCallUsd, undefined, "prices live in up.ps1's price files, not here");
});

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

test("ARCH-613 ARCH-620 ARCH-626 -Test, -All and -Ship run the receipt, agent-policy and ap2 package suites", () => {
  const suites = code.slice(code.indexOf("function Invoke-Suites"), code.indexOf("if ($Test) {"));
  assert.match(suites, /"packages\/receipt\/test\/\*\.test\.ts"/);
  assert.match(suites, /"packages\/agent-policy\/test\/\*\.test\.ts"/);
  assert.match(suites, /"packages\/ap2\/test\/\*\.test\.ts"/, "design-33 ARCH-626: the AP2 package suite runs with -Test, -All and -Ship");
  assert.match(suites, /"packages\/offer\/test\/\*\.test\.ts"/, "design-34 ARCH-634: the offer package suite runs with -Test, -All and -Ship");
  assert.match(suites, /"packages\/crossask\/test\/\*\.test\.ts"/);
  assert.match(suites, /& npm --prefix services\\paywall test/);
  assert.match(suites, /return @\(\$a, \$b, \$c\)/);
  // every caller fails on the paywall suite too
  assert.equal((code.match(/-or \$r\[2\]/g) ?? []).length, 2);
  assert.match(code, /\$r\[2\] -eq 0/);
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
  // --check-answers (2026-11-06): on by default, on|off only, passed through to ui-smoke.ts
  assert.match(code, /\[string\]\$SmokeCheckAnswers = "on",/);
  // -SmokeDatasets chiro-ct,chiro-jane (owner run 2026-11-06: "Cannot convert value to type System.String"): a list, joined
  assert.match(code, /\[string\[\]\]\$SmokeDatasets = @\("all"\),/);
  assert.match(s, /\[string\]\$smokeDs = @\(\$SmokeDatasets\) -join ","/);
  assert.match(s, /"--datasets", \$smokeDs,/);
  assert.match(s, /@\("on", "off"\) -notcontains \$SmokeCheckAnswers/);
  assert.match(s, /"--check-answers", \$SmokeCheckAnswers\)/);
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

test("-ChiroSample: regenerates and verifies every chiro sample set (tools\\chiro-synth), scenarios from the generator, before any start", () => {
  assert.match(code, /\[switch\]\$ChiroSample,/);
  assert.match(code, /\[int\]\$ChiroSeed = 1,/); assert.match(code, /\[int\]\$ChiroLeakSeed = 1,/);
  const s = code.slice(code.indexOf("if ($ChiroSample) {"), code.indexOf("# ---------------------------------------------------------------- -Smoke"));
  assert.ok(s.length > 0 && code.indexOf("if ($ChiroSample) {") < code.indexOf("# 1. pre-flight"), "no start");
  assert.match(s, /gen_chiro_set\.py --prms \$p --list-scenarios/, "the scenario list comes from the generator");
  assert.match(s, /gen_chiro_set\.py --prms \$p --scenario \$sc --seed \$ChiroSeed --leak-seed \$ChiroLeakSeed --out \$out/);
  assert.match(s, /verify_chiro_set\.py", "--dir", \$x\[2\]/); assert.match(s, /"--compare", \$other/);
  assert.match(s, /if \(\$chiroFailed\) \{ Say "FAIL" .*; exit 1 \}/, "a set that fails verification fails the run");
  assert.ok(!/docker|Stop-Process/.test(s), "touches no service");
});

test("this PC's watch list and gas go to nearadminup.ps1; the paywall's NEAR RPC is tested from inside ca-paywall", () => {
  assert.match(code, /\$adminArgs\.Watch = \$watch/); assert.match(code, /\$adminArgs\.GasPerPaymentNear =/);
  assert.match(code, /docker exec ca-paywall node -e \$js/);
  assert.ok(Array.isArray(ex.adminUi.watch) && ex.adminUi.watch.length > 0);
  assert.equal(ex.paidJobs.feePerModelCallUsd, undefined, "prices live in up.ps1's price files, not here");
});

test("-Ship: test, commit and push in one command (owner, 2026-11-07); refuses behind/detached/clean; only the listed paths; never force", () => {
  assert.match(code, /\[switch\]\$Ship,/);
  assert.match(code, /\[string\]\$ShipMessage = "",/);
  assert.match(code, /\[string\[\]\]\$ShipFiles = @\(\),/);
  assert.match(code, /\[string\]\$ShipRemote = "origin",/);
  const s = code.slice(code.indexOf("if ($Ship) {"), code.indexOf("# ---------------------------------------------------------------- settings and paths"));
  assert.ok(s.length > 0 && code.indexOf("if ($Ship) {") < code.indexOf("# 1. pre-flight"), "no start");
  assert.ok(code.indexOf("-Ship runs on its own") < code.indexOf("if ($Logs.Count)"), "options checked before anything runs");
  assert.ok(s.indexOf("rev-list --count \"HEAD..") < s.indexOf("Invoke-Suites"), "behind the remote: stop before testing");
  assert.ok(s.indexOf("Invoke-Suites") < s.indexOf("@(\"add\""), "tests before anything is staged");
  // 2026-11-13: a removal staged by hand (git rm --cached of a now git-ignored file) is not added again (git add refuses an
  // ignored path) and is committed from the index with --include; anything staged but not listed stops the ship
  assert.match(s, /\$addPaths = @\(\$want \| Where-Object \{ \$stagedDel -notcontains \$_ \}\)/);
  assert.match(s, /\$addArgs = @\("add", "--"\) \+ \$addPaths/);
  // 2026-11-13 (v2.1.0 ship): the commit takes the index with NO pathspec, after the staged set was read back and found to be
  // exactly the list; a rename's old path or a staged removal is never named in `git commit -- <paths>`.
  assert.match(s, /\$stagedNow = @\(Get-StagedChanges @\(Quiet \{ & git -c core\.quotePath=false diff --cached --name-status -M 2>\$null \}\)\)/);
  assert.match(s, /\$outside = @\(Get-StagedOutside \$stagedNow \$want\)/);
  assert.match(s, /if \(\$outside\.Count\) \{ Stop-Here \("staged but not in this commit's list: "/);
  assert.ok(s.indexOf("$outside = @(Get-StagedOutside") < s.indexOf("Quiet { & git @commitArgs }"), "checked before the commit");
  assert.ok(!/commitArgs \+= @\("--include"|commitArgs \+= @\("--"|"--include"/.test(s), "no pathspec on the commit");
  assert.match(s, /already staged but not in this commit's list/, "only the listed paths: a staged path not listed stops it");
  assert.ok(s.indexOf("already staged but not in this commit's list") < s.indexOf("@(\"add\""), "checked before anything is staged");
  assert.ok(!/add -A|add \.|"-A"|--force|push -f|reset|checkout|pull|stash/.test(s), "never force, pull, reset, checkout or stash");
  assert.ok(!/docker|Stop-Process/.test(s), "touches no service");
  assert.match(code, /function Invoke-Suites \{/);
});

test("-All: terminal suites before any start, then the start, log windows, the UI smoke check, the pages (owner, 2026-11-07)", () => {
  assert.match(code, /\[switch\]\$All,/); assert.match(code, /\[string\[\]\]\$Windows = @\(\),/);
  const t1 = code.indexOf("if ($All) {"), start = code.indexOf("# 1. pre-flight"), up = code.indexOf("& $privUp @privArgs");
  const win = code.indexOf("Start-Process powershell -ArgumentList"), smoke = code.indexOf("& $PSCommandPath -Smoke"), pages = code.lastIndexOf("Start-Process \"http://127.0.0.1:8730\"");
  assert.ok(t1 > 0 && t1 < start, "tests run before anything starts");
  assert.ok(code.slice(t1, start).includes("Invoke-Suites"));
  assert.ok(up < win && win < pages && pages < smoke, "start, then windows, then the pages, then smoke: a smoke FAIL never hides the UIs (owner run 2026-11-07)");
  assert.ok(code.indexOf("$READY") === -1 && code.indexOf("Say \"READY\"") < win, "windows only after READY");
  assert.match(code, /docker logs -f --tail 50 ' \+ \$c/, "a log window only follows a log");
  assert.match(code, /if \(\$All -and -not \$WindowNames\.Count\) \{ \$WindowNames = @\("analyst"\) \}/);
  assert.ok(code.indexOf("-All runs the tests") < code.indexOf("if ($Logs.Count)"), "options checked before anything runs");
  assert.equal((code.match(/Stop-Process/g) ?? []).length, 1);
});

test("-Ship -ShipTag (owner 2026-11-07): an annotated tag, refused when it exists here or on the remote, pushed after the branch and checked", () => {
  assert.match(code, /\[string\]\$ShipTag = "",/); assert.match(code, /\[string\]\$ShipTagMessage = "",/);
  assert.match(code, /if \(\$ShipTag -and \$ShipTag -notmatch '\^v\\d\+\\\.\\d\+\\\.\\d\+\$'\)/, "vX.Y.Z only");
  const s = code.slice(code.indexOf("if ($Ship) {"), code.indexOf("# ---------------------------------------------------------------- settings and paths"));
  const exists = s.indexOf("rev-parse -q --verify \"refs/tags/$ShipTag\""), remote = s.indexOf("ls-remote --tags $ShipRemote");
  assert.ok(exists > 0 && remote > 0 && remote < s.indexOf("Invoke-Suites"), "both checks before any test or commit");
  const tag = s.indexOf("git tag -a $ShipTag -m $tagMsg"), commit = s.indexOf("Quiet { & git @commitArgs }");
  const pushBranch = s.indexOf("git push $ShipRemote $branch }"), pushTag = s.indexOf("git push $ShipRemote \"refs/tags/$ShipTag\"");
  assert.ok(commit < tag && tag < pushBranch && pushBranch < pushTag, "commit, tag, push the branch, then push the tag");
  assert.match(s, /does not list tag \$ShipTag/, "the pushed tag is checked on the remote");
  assert.ok(!/tag -d|tag -f|--delete|push -f|--force/.test(s), "never moves or deletes a tag");
});

test("-All -AllSmbSample: the smb-fin-1 key is regenerated (this script's own -SmbSample) after the suites and before any start (owner 2026-11-07)", () => {
  assert.match(code, /\[switch\]\$AllSmbSample,/);
  const t1 = code.indexOf("if ($All) {"), start = code.indexOf("# 1. pre-flight"), smb = code.indexOf("& $PSCommandPath -SmbSample -SmbSeed $SmbSeed");
  assert.ok(t1 < code.indexOf("Invoke-Suites", t1) && code.indexOf("Invoke-Suites", t1) < smb && smb < start, "suites, then the sample, then the start");
  assert.match(code, /-SmbSample failed \(exit \$LASTEXITCODE\); nothing started/);
  assert.match(code, /if \(-not \$All -and \(\$AllSkipTests -or \$AllSkipSmoke -or \$AllSmbSample\)\)/, "-AllSmbSample needs -All");
});

test("ARCH-614 ARCH-615 -ReceiptKey runs scripts\\receipt-key.ts on <secretsDir>\\chainaim.env and stops; receipts auto/on/off reach up.ps1, which passes the key by name; compose and image keep /receipts", () => {
  // desk.ps1: the switches, checked before anything runs; the block only passes a path (no secret read here) and stops.
  assert.match(code, /\[switch\]\$Receipts,/); assert.match(code, /\[switch\]\$ReceiptKey,/); assert.match(code, /\[switch\]\$ReceiptKeyRotate,/);
  assert.match(code, /\[string\]\$ReceiptKeyName = "RECEIPT_SIGNING_KEY",/);
  assert.ok(code.indexOf("-ReceiptKey runs on its own") < code.indexOf("if ($Logs.Count)"), "options checked before anything runs");
  const k = code.slice(code.indexOf("if ($ReceiptKey) {"), code.indexOf("# ---------------------------------------------------------------- -Ap2Key")); // AdminRoot moved above -Ship (2026-11-12)
  assert.ok(k.length > 0 && code.indexOf("if ($ReceiptKey) {") < code.indexOf("# 1. pre-flight"), "no start");
  assert.match(k, /\$keyArgs = @\("scripts\\receipt-key\.ts", "--secrets-file", \(Join-Path \$secrets "chainaim\.env"\), "--var", \$ReceiptKeyName\)/);
  assert.ok(!/"--env-file"/.test(k), "never --env-file: Node takes it as its own option even after the script name (owner run 2026-11-10)");
  assert.match(k, /if \(\$ReceiptKeyRotate\) \{ \$keyArgs \+= "--rotate" \}/);
  // Step B: the PUBLIC key is also written to config\receipt-public-key.pem, the key the agent pins (committed).
  assert.match(k, /\$keyArgs \+= @\("--public-out", "config\\receipt-public-key\.pem"\)/);
  assert.match(k, /& node @keyArgs/); assert.match(k, /exit 0/);
  assert.ok(!/docker|Stop-Process|Get-Content|Select-String/.test(k), "touches no service and reads no file itself");
  // auto / on / off from -Receipts or receipts.enabled, handed to up.ps1 before it runs; the READY row asks the console API.
  assert.match(code, /if \(\$receiptsMode -ne "auto"\) \{ \$privArgs\.Receipts = \$receiptsMode \}/);
  assert.match(code, /\$privArgs\.ReceiptKeyName = \$ReceiptKeyName/);
  assert.ok(code.indexOf("$privArgs.Receipts") < code.indexOf("& $privUp @privArgs"));
  const r = code.slice(code.indexOf("function Report"), code.indexOf("# ================================================================= -Stop"));
  assert.match(r, /HttpJson "http:\/\/127\.0\.0\.1:8735\/jobs\/config"/);
  assert.equal(ex.receipts.enabled, "auto");
  // up.ps1: read by name from -SecretsFile, set by name for compose only when on, flags without the value, value dropped after.
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.match(up, /\[ValidateSet\("on", "off"\)\]\[string\]\$Receipts = "on",/);
  assert.match(up, /\[string\]\$ReceiptKeyName = "RECEIPT_SIGNING_KEY",/);
  assert.match(up, /Read-EnvFile \$SecretsFile \('\^' \+ \$ReceiptKeyName \+ '\$'\)/);
  const on = up.slice(up.indexOf("# Signed receipts (ARCH-614/615)"), up.indexOf("$port = \"127.0.0.1:"));
  assert.ok(on.length > 0);
  assert.match(on, /Set-Secret "RECEIPT_SIGNING_KEY" \$receiptKey/);
  assert.match(on, /\$consoleCmd \+= @\("--receipts=on", "--receipt-key-env=RECEIPT_SIGNING_KEY", "--receipt-dir=\/receipts"\)/);
  assert.match(on, /\$receiptKey = \$null/);
  assert.ok(on.indexOf("Set-Secret") < on.indexOf("$receiptKey = $null"));
  for (const line of up.split(/\r?\n/)) {
    const said = /\b(Say|Write-Host|Stop-Here)\b(.*)$/.exec(line); // what is printed, not the condition before it
    if (said) assert.ok(!/\$receiptKey\b/.test(said[2]), `the key value is never printed: ${line.trim()}`);
    if (/\$consoleCmd \+=/.test(line)) assert.ok(!/\$receiptKey\b/.test(line), "the key value never goes into commands.yml");
  }
  // the PowerShell "$name:" trap (a variable followed by a colon in a string is a parse error) in the new lines
  const traps = [...on.matchAll(/"[^"\r\n]*"/g)].flatMap((m) => [...m[0].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):(?!:)/g)].map((v) => v[1])).filter((v) => !["env", "script", "global"].includes(v));
  assert.deepEqual(traps, []);
  // compose: the key by name, a named volume at /receipts; the image makes /receipts for the node user.
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const api = compose.slice(compose.indexOf("  console-api:"), compose.indexOf("  agent:"));
  assert.match(api, /^\s+- RECEIPT_SIGNING_KEY$/m);
  assert.match(api, /- chainaim-console-receipts:\/receipts/);
  assert.match(compose, /^  chainaim-console-receipts:$/m);
  const df = readFileSync(new URL("../../test-console/console.Dockerfile", import.meta.url), "utf8");
  assert.match(df, /RUN mkdir -p \/runs \/receipts && chown node:node \/runs \/receipts/);
  assert.ok(df.indexOf("/receipts") < df.indexOf("USER node"));
});

test("the console shows Node's UTF-8 output as written (owner run 2026-11-10: test ticks printed as junk), set before anything runs", () => {
  assert.match(code, /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  const at = code.indexOf("[Console]::OutputEncoding");
  for (const runs of ["if ($Test) {", "if ($All) {", "if ($Ship) {"]) assert.ok(at < code.indexOf(runs), `set before ${runs} runs the suites`);
});

test("READY needs local, Bedrock and NEAR AI in the tab 02 / 03 model lists (owner 2026-11-07); -RequireModels changes the families", () => {
  assert.match(code, /\[string\[\]\]\$RequireModels = @\("local", "bedrock", "nearai"\),/);
  const r = code.slice(code.indexOf("function Report"), code.indexOf("# ================================================================= -Stop"));
  assert.match(r, /HttpJson "http:\/\/127\.0\.0\.1:8735\/gateway\/models"/);
  assert.match(r, /foreach \(\$fam in \$RequireModels\)/);
  assert.match(r, /switch-models\.ps1 -To ollama-cpu-8gb-all-nearai/);
  assert.match(r, /\$bad\+\+/);
});

test("ARCH-613 step B up.ps1 -Agent on needs config\\receipt-public-key.pem (the agent image carries it) and starts the agent with --receipt-verify=on", () => {
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  const a = up.slice(up.indexOf('if ($Agent -eq "on") {'), up.indexOf("# NEAR AI model attestation (ARCH-411)"));
  assert.ok(a.length > 0);
  assert.match(a, /if \(-not \(Test-Path \(Join-Path \$repo "config\\receipt-public-key\.pem"\)\)\) \{ Stop-Here "-Agent on needs config\\receipt-public-key\.pem .*desk\.ps1 -ReceiptKey once" \}/);
  assert.match(a, /"--agent-policy=on", "--spend-dir=\/data\/spend", "--receipt-verify=on"\)/);
  assert.ok(a.indexOf("receipt-public-key.pem") < a.indexOf("$agentCmd = @("), "checked before the agent's command is built");
});

test("ARCH-613 ARCH-620 step C/D -AgentAsk runs scripts\\agent-ask.ts against the console API and -VerifyReceipt runs scripts\\verify-receipt.ts with the pinned key; each runs on its own, before any start", () => {
  assert.match(code, /\[switch\]\$AgentAsk,/); assert.match(code, /\[string\]\$Tenant = "t01",/); assert.match(code, /\[string\]\$Dataset = "smb-fin-1",/);
  assert.match(code, /\[string\]\$Template = "1",/); assert.match(code, /\[string\]\$AgentAnswerModel = "default",/);
  assert.match(code, /\[string\]\$AgentQueryModel = "default",/);
  assert.match(code, /\[string\]\$VerifyReceipt = "",/); assert.match(code, /\[string\]\$VerifyResult = "auto",/);
  assert.match(code, /if \(\$AgentAsk -and \(\$otherModes -or \$VerifyReceipt\)\) \{ Stop-Here "-AgentAsk runs on its own/);
  assert.match(code, /if \(\$VerifyReceipt -and \$otherModes\) \{ Stop-Here "-VerifyReceipt runs on its own/);
  assert.ok(code.indexOf("$otherModes =") < code.indexOf("if ($Logs.Count)"), "checked before anything runs");
  const a = code.slice(code.indexOf("if ($AgentAsk) {"), code.indexOf("if ($VerifyReceipt) {"));
  assert.match(a, /\$askArgs = @\("scripts\\agent-ask\.ts", "--api", "http:\/\/127\.0\.0\.1:8735", "--tenant", \$Tenant, "--dataset", \$Dataset, "--template", \$Template, "--answer-model", \$AgentAnswerModel, "--query-model", \$AgentQueryModel\)/);
  assert.match(a, /if \(\$AgentQueryModel -ne "default" -and \$AgentQueryModel -notmatch '\^\[\\w\.-\]\+\/\[\\w\.:-\]\+\$'\) \{ Stop-Here "-AgentQueryModel must be default or provider\/name" \}/);
  assert.match(a, /HttpStatus "http:\/\/127\.0\.0\.1:8735\/"/); assert.match(a, /& node @askArgs\s+exit \$LASTEXITCODE/);
  const v = code.slice(code.indexOf("if ($VerifyReceipt) {"), code.indexOf("# ---------------------------------------------------------------- -Smoke"));
  assert.match(v, /\$verArgs = @\("scripts\\verify-receipt\.ts", "--file", \$VerifyReceipt, "--public-key", "config\\receipt-public-key\.pem", "--result", \$VerifyResult\)/);
  assert.match(v, /& node @verArgs\s+exit \$LASTEXITCODE/);
  assert.ok(!/docker|Get-Content|RECEIPT_SIGNING_KEY/.test(a + v), "no service started, no file or secret read by desk.ps1 itself");
  assert.ok(code.indexOf("if ($AgentAsk) {") < code.indexOf("# 1. pre-flight") && code.indexOf("if ($VerifyReceipt) {") < code.indexOf("# 1. pre-flight"), "no start");
});

test("ARCH-627 -Ap2Key runs scripts\\receipt-key.ts --alg ES256 on <secretsDir>\\chainaim.env, writes config\\ap2-public-key.jwk.json and stops; checked before anything runs", () => {
  assert.match(code, /\[switch\]\$Ap2Key,/); assert.match(code, /\[switch\]\$Ap2KeyRotate,/);
  assert.match(code, /\[string\]\$Ap2KeyName = "AP2_SIGNING_KEY",/);
  assert.match(ps, /-Ap2Key \[-Ap2KeyRotate\] \[-Ap2KeyName AP2_SIGNING_KEY\]/, "documented in the help");
  for (const m of ["-Ap2Key runs on its own", "-Ap2KeyRotate needs -Ap2Key", "-Ap2KeyName and -ReceiptKeyName must differ"]) {
    assert.ok(code.indexOf(m) > 0 && code.indexOf(m) < code.indexOf("if ($Logs.Count)"), `${m}: checked before anything runs`);
  }
  assert.match(code, /\$otherModes = [^\n]*-or \$Ap2Key -or/, "-AgentAsk / -VerifyReceipt refuse it beside them");
  const k = code.slice(code.indexOf("if ($Ap2Key) {"), code.indexOf("$adminRoot = AdminRoot")); // AdminRoot moved above -Ship (2026-11-12)
  assert.ok(k.length > 0 && code.indexOf("if ($Ap2Key) {") < code.indexOf("# 1. pre-flight"), "no start");
  assert.match(k, /\$ap2Args = @\("scripts\\receipt-key\.ts", "--secrets-file", \(Join-Path \$secrets "chainaim\.env"\), "--alg", "ES256", "--var", \$Ap2KeyName\)/);
  assert.match(k, /\$ap2Args \+= @\("--public-out", "config\\ap2-public-key\.jwk\.json"\)/);
  assert.match(k, /if \(\$Ap2KeyRotate\) \{ \$ap2Args \+= "--rotate" \}/);
  assert.match(k, /& node @ap2Args/); assert.match(k, /exit 0/);
  assert.ok(!/"--env-file"/.test(k), "never --env-file (lesson 2)");
  assert.ok(!/docker|Stop-Process|Get-Content|Select-String/.test(k), "touches no service and reads no file itself");
});

test("privateAI-design-33 ARCH-628 ARCH-630: up.ps1 -Ap2 passes AP2_SIGNING_KEY to compose by name (never into commands.yml), cent prices, the agent's pinned-key check, and the admin feed flags", () => {
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.ok(/^[\x00-\x7F]*$/.test(up), "up.ps1 must be ASCII");
  assert.match(up, /\[ValidateSet\("on", "off"\)\]\[string\]\$Ap2 = "on",/);
  assert.match(up, /Set-Secret "AP2_SIGNING_KEY" \$ap2Key/);
  assert.match(up, /\$consoleCmd \+= @\("--ap2=on", "--ap2-key-env=AP2_SIGNING_KEY", "--ap2-alg=ES256", "--ap2-terms-url=\$Ap2TermsUrl", "--price-round=cent"\)/);
  assert.match(up, /if \(\$agentCmd\) \{ \$agentCmd \+= @\("--ap2-verify=on", "--ap2-public-key=\/app\/config\/ap2-public-key\.jwk\.json"\) \}/);
  assert.match(up, /\$consoleCmd \+= "--job-feed-receipts=on"/);
  assert.match(up, /\$consoleCmd \+= "--job-feed-ap2=on"/);
  assert.match(up, /\$ap2Key = \$null/, "the key is dropped from the script's memory once set for compose");
  assert.ok(!/--ap2-[a-z-]*=\$ap2Key/.test(up), "the key itself never goes into a command line");
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /- RECEIPT_SIGNING_KEY\n(?:\s*#.*\n)*\s*- AP2_SIGNING_KEY\n/, "passed by name only (lesson 2: never --env-file)");
});

test("ARCH-635 -Calibrate runs scripts\\calibrate.ts on the sample root through the running console API and writes config\\cost-model.json; the compute price is never defaulted; runs on its own, before any start", () => {
  assert.match(code, /\[switch\]\$Calibrate,/); assert.match(code, /\[string\]\$CalibrateComputeUsdPerHour = "",/);
  assert.match(code, /\[string\]\$CalibrateModel = "bedrock\/nemotron-nano-3-30b",/); assert.match(code, /\[string\]\$CalibrateAnswerModel = "same",/);
  assert.match(code, /\[int\]\$CalibrateRuns = 3,/); assert.match(code, /\[string\[\]\]\$CalibrateDatasets = @\("all"\),/);
  assert.match(code, /\[string\]\$CalibrateTokensPerByte = "bound",/); assert.match(code, /\[switch\]\$CalibrateDryRun,/);
  assert.match(code, /\$otherModes = [^\n]*-or \$Calibrate\b/, "-AgentAsk / -VerifyReceipt refuse it beside them");
  assert.match(code, /if \(\$Calibrate -and \([^\n]*-or \$All -or \$Ship[^\n]*-or \$AgentAsk -or \$VerifyReceipt\)\) \{ Stop-Here "-Calibrate runs on its own/);
  assert.ok(code.indexOf('Stop-Here "-Calibrate runs on its own') < code.indexOf("if ($Logs.Count)"), "checked before anything runs");
  const c = code.slice(code.indexOf("if ($Calibrate) {"), code.indexOf("# ---------------------------------------------------------------- -Test"));
  assert.ok(c.length > 0 && code.indexOf("if ($Calibrate) {") < code.indexOf("# 1. pre-flight"), "no start");
  assert.match(c, /\$calArgs = @\("scripts\\calibrate\.ts", "--api", "http:\/\/127\.0\.0\.1:8735", "--root", "samples", [^\n]*"--out", "config\\cost-model\.json"\)/);
  assert.match(c, /\[string\]\$calDs = @\(\$CalibrateDatasets\) -join ","/);
  assert.match(c, /if \(\$CalibrateRuns -lt 2 -or \$CalibrateRuns -gt 20\)/);
  // the compute price: the switch, else COMPUTE_USD_PER_HOUR in the committed team price file; neither = stop (no invented number)
  assert.match(c, /\$priceFile = "config\\paid-jobs-prices\.conf"/); assert.match(c, /COMPUTE_USD_PER_HOUR/);
  assert.match(c, /if \(-not \$cuh -and -not \$CalibrateDryRun\) \{ Stop-Here "no compute price/);
  assert.match(c, /HttpStatus "http:\/\/127\.0\.0\.1:8735\/"/); assert.match(c, /& node @calArgs\s+exit \$LASTEXITCODE/);
  assert.ok(!/docker|ollama|Stop-Process|secretsDir|chainaim\.env/.test(c), "starts nothing, reads no secret");
});

test("ARCH-615 ARCH-631 -VerifyJob JOBID fetches the job's receipt from the console API (the file Download receipt saves), writes it to runtime\\agent-ask and runs -VerifyReceipt on it; runs on its own (owner run 2026-11-12: no download in the browser)", () => {
  assert.match(code, /\[string\]\$VerifyJob = "",/);
  assert.match(code, /if \(\$VerifyJob -and \(\$AgentAsk -or \$VerifyReceipt -or \$Calibrate[^\n]*\)\) \{ Stop-Here "-VerifyJob runs on its own/);
  assert.match(code, /\$otherModes = [^\n]*-or \$VerifyJob\n/);
  const j = code.slice(code.indexOf("if ($VerifyJob) {"), code.indexOf("if ($VerifyReceipt) {"));
  assert.ok(j.length > 0 && code.indexOf("if ($VerifyJob) {") < code.indexOf("if ($VerifyReceipt) {"), "fetched first, then the same offline check");
  assert.match(j, /if \(\$VerifyJob -notmatch '\^\[0-9a-f\]\{32\}\$'\)/);
  assert.match(j, /\$rcptUrl = "http:\/\/127\.0\.0\.1:8735\/jobs\/\$VerifyJob\/receipt"/);
  assert.match(j, /\$VerifyReceipt = Join-Path \$rcptDir "chainaim-receipt-\$VerifyJob\.json"/);
  assert.match(j, /UTF8Encoding\(\$false\)/, "written as UTF-8 without a BOM, byte for byte what the console sent");
  assert.ok(!/docker|Get-Content|RECEIPT_SIGNING_KEY/.test(j), "no service started, no secret read");
  assert.ok(code.indexOf("if ($VerifyJob) {") < code.indexOf("# 1. pre-flight"), "no start");
});

test("-Ship -ShipRepo admin (2026-11-12): the same test, commit and push for the chainaim-adminUI-NEAR checkout, found by AdminRoot; its own suites", () => {
  assert.match(code, /\[string\]\$ShipRepo = "private",/);
  assert.match(code, /if \(@\("private", "admin"\) -notcontains \$ShipRepo\)/); assert.match(code, /if \(\$ShipRepo -ne "private" -and -not \$Ship\) \{ Stop-Here "-ShipRepo needs -Ship" \}/);
  assert.ok(code.indexOf("function AdminRoot {") < code.indexOf("if ($Ship) {"), "defined before -Ship uses it");
  assert.equal((code.match(/function AdminRoot \{/g) ?? []).length, 1, "one finder, shared with the start");
  const s = code.slice(code.indexOf("if ($Ship) {"), code.indexOf("# ---------------------------------------------------------------- settings and paths"));
  assert.ok(s.indexOf("$shipRoot = AdminRoot") < s.indexOf("git fetch") || s.indexOf("$shipRoot = AdminRoot") < s.indexOf("& git fetch"), "in the admin checkout before any git command");
  assert.match(s, /Set-Location \$shipRoot/);
  assert.match(s, /foreach \(\$d in @\("services\\near-watch", "apps\\admin-console"\)\)/); assert.match(s, /foreach \(\$task in @\("test", "typecheck"\)\)/);
  assert.match(s, /& npm --prefix \$d run \$task/);
  assert.ok(s.indexOf("all admin suites passed") < s.indexOf('@("add"'), "admin tests before anything is staged");
  assert.ok(!/add -A|add \.|"-A"|--force|push -f|reset|checkout|pull|stash/.test(s), "never force, pull, reset, checkout or stash");
});

test("privateAI-design-34 ARCH-636 ARCH-642: up.ps1 -OfferMode auto (estimate-first when config\\cost-model.json exists) passes the offer flags to the console and the agent; -AgentAsk -OfferMode estimate-first by default", () => {
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.match(up, /\[ValidateSet\("auto", "estimate-first", "run-hold"\)\]\[string\]\$OfferMode = "auto",/);
  assert.match(up, /if \(Test-Path -LiteralPath \$costModel\) \{ \$om = "estimate-first" \}/);
  assert.match(up, /Stop-Here "-OfferMode estimate-first needs config\\cost-model\.json: run \.\\test-console\\desk\.ps1 -Calibrate first"/);
  assert.match(up, /\$consoleCmd \+= @\("--offer-mode=\$om", "--offer-modes=\$oms", "--cost-model=\/app\/config\/cost-model\.json"\)/);
  assert.match(up, /if \(\$agentCmd\) \{ \$agentCmd \+= "--offer-mode=\$om" \}/);
  assert.ok(!/[^\x00-\x7F]/.test(up), "up.ps1 stays ASCII (lesson 4)");
  assert.match(code, /\[string\]\$OfferMode = "estimate-first",/);
  const a = code.slice(code.indexOf("if ($AgentAsk) {"), code.indexOf("if ($VerifyJob) {"));
  assert.match(a, /\$askArgs \+= @\("--offer-mode", \$OfferMode\)/);
});

test("privateAI-design-35 ARCH-651: -CrossaskMaxPromptChars (default desk.json console.crossaskMaxPromptChars, else 16000) goes to up.ps1, which checks 2000..200000 and always passes --crossask-max-prompt-chars to the console", () => {
  assert.match(ps, /\[int\]\$CrossaskMaxPromptChars = 0,/);
  assert.match(ps, /\$maxPrompt = if \(\$CrossaskMaxPromptChars -gt 0\) \{ \$CrossaskMaxPromptChars \} elseif \(\$P\.console -and \$P\.console\.crossaskMaxPromptChars\) \{ \[int\]\$P\.console\.crossaskMaxPromptChars \} else \{ 16000 \}/);
  assert.match(ps, /\$privArgs\.CrossaskMaxPromptChars = \$maxPrompt/);
  assert.equal(ex.console.crossaskMaxPromptChars, 16000, "the example settings show the key");
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.match(up, /\[int\]\$CrossaskMaxPromptChars = 16000,/);
  assert.match(up, /if \(\$CrossaskMaxPromptChars -lt 2000 -or \$CrossaskMaxPromptChars -gt 200000\) \{ Stop-Here/);
  assert.match(up, /\$consoleCmd \+= "--crossask-max-prompt-chars=\$CrossaskMaxPromptChars"/);
  // Passed outside the paid-jobs block: the free /crossask and the quote use the same cap.
  const at = up.indexOf('$consoleCmd += "--crossask-max-prompt-chars');
  assert.ok(at > 0 && at < up.indexOf('if ($PaidJobs -eq "on") {\n    $consoleCmd += @("--paid-jobs=on"'), "before, not inside, the paid-jobs block");
});

test("privateAI-design-37: -PaidFlow (default desk.json paidJobs.flow, else authorization) goes to up.ps1; upfront needs the separate signer and its NEAR key; -Refunds [-RefundRetry] runs the Node script, which reads the request key itself", () => {
  assert.match(ps, /\[string\]\$PaidFlow = "",/);
  assert.match(ps, /\$paidFlow = if \(\$PaidFlow\) \{ \$PaidFlow \} elseif \(\$P\.paidJobs -and \$P\.paidJobs\.flow\) \{ \[string\]\$P\.paidJobs\.flow \} else \{ "authorization" \}/);
  assert.match(ps, /\$privArgs\.PaidFlow = \$paidFlow/);
  assert.match(ps, /\[switch\]\$Refunds,/);
  assert.match(ps, /\$refArgs = @\("scripts\\refunds\.ts", "--signer-url", \$hostSigner, "--client-file", \(Join-Path \$secrets "signer-client\.env"\)\)/);
  assert.match(ps, /if \(\$RefundRetry\) \{ \$refArgs \+= @\("--retry", \$RefundRetry\) \}/);
  assert.equal(/SIGNER_REQUEST_KEY/.test(ps.slice(ps.indexOf("if ($Refunds) {"), ps.indexOf("if ($Refunds) {") + 1200)), false, "desk.ps1 never reads the request key for -Refunds");
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.match(up, /\[ValidateSet\("authorization", "upfront"\)\]\[string\]\$PaidFlow = "authorization"/);
  assert.match(up, /if \(\$Signer -ne "separate"\) \{ Stop-Here "-PaidFlow upfront needs -Signer separate/);
  assert.match(up, /"--refunds=on", "--refund-store=\/data\/refunds", "--refund-account=\$nPayTo"/);
  assert.match(up, /Set-Secret "PAID_JOBS_FLOW" "upfront"; Set-Secret "PAID_JOBS_REFUND_URL" \$SignerUrl\.TrimEnd\('\/'\); Set-Secret "PAID_JOBS_REFUND_KEY_ENV" "PAYWALL_SIGNER_KEY"; Set-Secret "PAYWALL_SIGNER_KEY" \$signerReqKey/);
  // The payTo key goes to the signer's compose command only, and leaves this process with the other seller keys.
  assert.match(up, /\$sigKeys = @\("AP2_SIGNING_KEY", "RECEIPT_SIGNING_KEY"\) \+ \$\(if \(\$refundKeyOn\) \{ @\("SELLER_NEAR_PRIVATE_KEY"\) \} else \{ @\(\) \}\)/);
  assert.match(up, /finally \{ foreach \(\$k in \$sigKeys\) \{ Remove-Item "env:\$k"/);
  assert.equal(/Set-Secret "SELLER_NEAR_PRIVATE_KEY"/.test(up), false, "never set for the data plane");
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  assert.equal(/SELLER_NEAR_PRIVATE_KEY/.test(compose), false, "the data plane's compose file never names the payTo key");
  for (const n of ["PAID_JOBS_FLOW", "PAID_JOBS_REFUND_URL", "PAID_JOBS_REFUND_KEY_ENV", "PAYWALL_SIGNER_KEY"]) assert.ok(compose.split(/\r?\n/).some((line) => line.trim() === `- ${n}`), n);
  const script = readFileSync(new URL("../refunds.ts", import.meta.url), "utf8");
  assert.match(script, /const key = requestKeyOf\(text!\);/);
});

test("privateAI-design-37: scripts/refunds.ts reads SIGNER_REQUEST_KEY from the client file and prints amounts with 6 decimals", async () => {
  const { requestKeyOf, formatRows } = await import("../refunds.ts");
  assert.equal(requestKeyOf("﻿OTHER=1\r\nSIGNER_REQUEST_KEY=\"abc123\"\r\n"), "abc123");
  assert.equal(requestKeyOf("NOPE=1\n"), undefined);
  const [line] = formatRows([{ invoiceId: "C702E26D", jobId: "8314afbf", status: "refunded", payer: "chainaim-buyer-seller.testnet", amountUnits: "20000", paidTx: "4vv6", refundTx: "9xyz", reason: "over_estimate", at: "2026-11-13T12:00:00.000Z" }]);
  assert.match(line, /refunded\s+0\.020000 USDC  to chainaim-buyer-seller\.testnet  invoice C702E26D  job 8314afbf  paid 4vv6  refund 9xyz  \(over_estimate\)/);
  assert.deepEqual(formatRows([]), ["(no refunds in the ledger)"]);
});

test("ARCH-666 -MandateKey ADDS the tenant's new public key and keeps the ones already listed (owner run 2026-11-13: t01's 964b1199 was dropped)", async () => {
  const mk = ps.slice(ps.indexOf("if ($MandateKey) {"), ps.indexOf("# ---------------------------------------------------------------- -Planes"));
  assert.match(mk, /"scripts\\signer-keys\.ts", "mandate", .*"--registry", "config\\ap2-mandate-keys\.json"/);
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { ensureMandateKey } = await import("../signer-keys-core.ts");
  const { parseMandateRegistry } = await import("../../packages/ap2/src/index.ts");
  const d = mkdtempSync(join(tmpdir(), "mandate-add-"));
  try {
    const env = join(d, "agent-tenants.env"), reg = join(d, "ap2-mandate-keys.json");
    writeFileSync(env, "");
    const kids = () => parseMandateRegistry(JSON.parse(readFileSync(reg, "utf8"))).find((t) => t.tenant === "t01")!.keys.map((k) => (k as { kid: string }).kid);
    const first = ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t01", accountId: "chainaim-buyer-seller.testnet" });
    const other = ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t02", accountId: "chainaim-t02-seller.testnet" });
    const second = ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t01", accountId: "chainaim-buyer-seller.testnet", rotate: true });
    assert.deepEqual(kids(), [second.kid, first.kid], "the new key first, the earlier one kept");
    ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t01", accountId: "chainaim-buyer-seller.testnet" });
    assert.deepEqual(kids(), [second.kid, first.kid], "a kept key is not listed twice");
    assert.deepEqual(parseMandateRegistry(JSON.parse(readFileSync(reg, "utf8"))).find((t) => t.tenant === "t02")!.keys.map((k) => (k as { kid: string }).kid), [other.kid], "other tenants untouched");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("privateAI-design-39: -PayOnlyAttested (default desk.json paidJobs.payOnlyAttested, else evidence) and its deadline go to up.ps1; verified needs ca-attest and raises the paywall's run timeout", () => {
  assert.match(ps, /\[string\]\$PayOnlyAttested = "",/);
  assert.match(ps, /\[int\]\$PayOnlyAttestedDeadlineMs = 0,/);
  assert.match(ps, /\$payOnly = if \(\$PayOnlyAttested\) \{ \$PayOnlyAttested \} elseif \(\$P\.paidJobs -and \$P\.paidJobs\.payOnlyAttested\) \{ \[string\]\$P\.paidJobs\.payOnlyAttested \} else \{ "evidence" \}/);
  assert.match(ps, /if \(\$payOnlyMs -lt 1000 -or \$payOnlyMs -gt 240000\) \{ Stop-Here/);
  assert.match(ps, /if \(\$payOnly -eq "verified" -and \$attestMode -eq "off"\) \{ Stop-Here/);
  assert.match(ps, /\$privArgs\.PayOnlyAttested = \$payOnly/);
  assert.match(ps, /\$privArgs\.PayOnlyAttestedDeadlineMs = \$payOnlyMs/);
  assert.ok(ps.indexOf("$attestMode = ") < ps.indexOf("$payOnly = "), "attest mode is known before it is checked");
  const up = readFileSync(new URL("../../test-console/up.ps1", import.meta.url), "utf8");
  assert.match(up, /\[ValidateSet\("off", "evidence", "verified"\)\]\[string\]\$PayOnlyAttested = "evidence",/);
  const blk = up.slice(up.indexOf("# privateAI-design-39 ARCH-685: what a paid job must show"), up.indexOf("$override = [ordered]@{ services"));
  assert.ok(blk.length > 0);
  assert.match(blk, /if \(\$PayOnlyAttested -ne "evidence"\) \{/, "evidence = the console's default, no flag: the command is as before");
  assert.match(blk, /if \(\$PayOnlyAttested -eq "verified" -and \$Attest -ne "on"\) \{ Stop-Here/);
  assert.match(blk, /\$consoleCmd \+= "--pay-only-attested=\$PayOnlyAttested"/);
  assert.match(blk, /\$consoleCmd \+= "--pay-only-attested-deadline-ms=\$PayOnlyAttestedDeadlineMs"/);
  assert.match(blk, /Set-Secret "PAID_JOBS_RUN_TIMEOUT_SEC" \(\[string\]\(300 \+ \[math\]::Ceiling\(\$PayOnlyAttestedDeadlineMs \/ 1000\) \+ 10\)\)/);
  // 300 + 240 + 10 = 550: within the paywall's limit (XRPL_MAX_TIMEOUT_SECONDS 600 - 30) at the longest deadline.
  assert.ok(300 + 240 + 10 <= 600 - 30);
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const paywall = compose.slice(compose.indexOf("container_name: ca-paywall"), compose.indexOf("container_name: ca-paywall") + 6000);
  assert.match(paywall, /\n {6}- PAID_JOBS_RUN_TIMEOUT_SEC\n/, "by name; unset = the paywall's default 300");
});

test("privateAI-design-39 section 5: -StopService / -StartService NAME stop or start one known container and nothing else; they run on their own, before any start", () => {
  assert.match(ps, /\[string\]\$StopService = "",/);
  assert.match(ps, /\[string\]\$StartService = "",/);
  const blk = code.slice(code.indexOf("if ($StopService -or $StartService) {"), code.indexOf("# ---------------------------------------------------------------- -Logs"));
  assert.ok(blk.length > 0);
  assert.match(blk, /if \(\$StopService -and \$StartService\) \{ Stop-Here/);
  assert.match(blk, /if \(\$otherModes -or \$keyModes -or \$Refunds -or \$AgentAsk -or \$VerifyReceipt\) \{ Stop-Here/);
  assert.match(blk, /if \(-not \$LogContainers\.Contains\(\$svcName\)\) \{ Stop-Here/, "only a service of this stack");
  assert.match(blk, /& docker \$svcVerb \$LogContainers\[\$svcName\]/);
  assert.equal((blk.match(/& docker /g) ?? []).length, 1, "one docker call: this container only");
  assert.ok(!/compose|down\.ps1|up\.ps1|nearadminup/.test(blk), "no other start or stop");
  assert.match(blk, /exit 0/);
  assert.ok(code.indexOf("if ($StopService -or $StartService) {") < code.indexOf("# 1. pre-flight"), "before anything starts");
  assert.ok(code.indexOf("$otherModes = ") < code.indexOf("if ($StopService -or $StartService) {"), "the mode checks are known first");
});

test("-Ship (2026-11-13, v2.1.0 ship failed with \"pathspec did not match\"): a staged rename and a staged delete are read from the index, never named in the commit's pathspec", async () => {
  const { spawnSync } = await import("node:child_process");
  const fnOf = (name: string): string => {
    const at = code.indexOf(`function ${name}(`);
    assert.ok(at >= 0, name);
    const end = code.indexOf("\n}\n", at);
    return code.slice(at, end + 2);
  };
  // What `git diff --cached --name-status -M` printed for the v2.1.0 ship (tab-separated), plus a delete, an add and a change.
  const lines = [
    "R100\tdocs/judge/demo-script-2026-11-13T0530Z.md\tdocs/judge/older/demo-script-2026-11-13T0530Z.md",
    "R100\tdocs/judge/sample-receipt-2026-11-13T0547Z.json\tdocs/judge/older/sample-receipt-2026-11-13T0547Z.json",
    "D\tdocs/gone.md",
    "A\tdocs/judge/sample-receipt-2026-11-13T1716Z.json",
    "M\tREADME.md",
  ];
  // The list as -Ship builds it from git status: renames by their new path; for an unstaged move both halves were listed.
  const want = ["docs/judge/older/demo-script-2026-11-13T0530Z.md", "docs/judge/sample-receipt-2026-11-13T0547Z.json", "docs/judge/older/sample-receipt-2026-11-13T0547Z.json", "docs/gone.md", "docs/judge/sample-receipt-2026-11-13T1716Z.json", "README.md"];
  const ps1 = (list: string[], w: string[]) => [
    fnOf("Get-StagedChanges"), fnOf("Get-StagedOutside"),
    `$lines = @(${list.map((l) => `"${l.replace(/\t/g, "`t")}"`).join(", ")})`,
    `$want = @(${w.map((x) => `"${x}"`).join(", ")})`,
    "$c = @(Get-StagedChanges $lines)",
    "$o = @(Get-StagedOutside $c $want)",
    "ConvertTo-Json -Compress -Depth 3 @{ changes = $c; outside = $o }",
  ].join("\n");
  const run = (list: string[], w: string[]) => {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps1(list, w)], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { changes: { Status: string; Path: string; From: string | null }[]; outside: string[] | null };
  };
  const ok = run(lines, want);
  assert.deepEqual(ok.changes.map((c) => [c.Status, c.Path, c.From]), [
    ["R", "docs/judge/older/demo-script-2026-11-13T0530Z.md", "docs/judge/demo-script-2026-11-13T0530Z.md"],
    ["R", "docs/judge/older/sample-receipt-2026-11-13T0547Z.json", "docs/judge/sample-receipt-2026-11-13T0547Z.json"],
    ["D", "docs/gone.md", null],
    ["A", "docs/judge/sample-receipt-2026-11-13T1716Z.json", null],
    ["M", "README.md", null],
  ], "a rename is its new path, with the old one beside it");
  assert.deepEqual(ok.outside ?? [], [], "the staged set is exactly the list: the commit takes the index");
  // A staged path that is not in the list stops the ship: a delete, and a rename whose new path is not listed.
  const bad = run(lines, want.filter((x) => x !== "docs/gone.md" && x !== "docs/judge/older/demo-script-2026-11-13T0530Z.md"));
  assert.deepEqual([...(bad.outside ?? [])].sort(), ["docs/gone.md", "docs/judge/older/demo-script-2026-11-13T0530Z.md"]);
  // And the commit names no path at all, so neither old path can reach `git commit -- <paths>`.
  const s = code.slice(code.indexOf("if ($Ship) {"), code.indexOf("# ---------------------------------------------------------------- settings and paths"));
  const commit = s.slice(s.indexOf('$commitArgs = @("commit"'), s.indexOf("Quiet { & git @commitArgs }"));
  assert.ok(commit.length > 0 && !/"--"|--include|\$addPaths|\$want/.test(commit), "the commit takes the index, no pathspec");
});

/**
 * privateAI-design-36 ARCH-664: how the control plane is deployed on the PC, read as text (no Docker, no PowerShell on the
 * test machine): services/signer/compose.yml, its Dockerfile and ignore file, test-console/up.ps1 -Signer, desk.ps1
 * -SignerKeys / -MandateKey / -Planes and docker-compose.yml's console-api.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const compose = read("services/signer/compose.yml");
const dockerfile = read("services/signer/Dockerfile");
const ignore = read("services/signer/Dockerfile.dockerignore");
const up = read("test-console/up.ps1");
const desk = read("test-console/desk.ps1");
const down = read("test-console/down.ps1");
const data = read("docker-compose.yml");

test("ARCH-664 compose: ca-control-signer is alone in project chainaim-control-plane, on its own network, published on 127.0.0.1 only", () => {
  assert.match(compose, /^name: chainaim-control-plane$/m);
  assert.match(compose, /container_name: ca-control-signer/);
  assert.match(compose, /networks:\n {2}chainaim-control:\n {4}name: chainaim-control/);
  assert.equal(/chainaim-test/.test(compose.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")), false, "not on the data plane's network");
  assert.match(compose, /ports: \["127\.0\.0\.1:8780:8780"\]/);
  for (const n of ["SIGNER_REQUEST_KEY", "AP2_SIGNING_KEY", "RECEIPT_SIGNING_KEY"]) assert.match(compose, new RegExp(`\\n {6}- ${n}\\n`), `${n} by name only`);
  assert.equal(/=/.test(compose.split("environment:")[1].split("command:")[0]), false, "no value in the file");
  // privateAI-design-37 ARCH-676 amends ARCH-660: exactly one named volume, the signed refund ledger; no host folder.
  const mounts = [...compose.matchAll(/^\s+- ([^\s#]+:\/[^\s]*)\r?$/gm)].map((m) => m[1]);
  assert.deepEqual(mounts, ["chainaim-refunds:/data/refunds"], "no data folder is mounted into the signer; only the refund ledger volume");
  assert.match(compose, /^volumes:\r?\n(?:\s*#.*\r?\n)*\s+chainaim-refunds:\r?\n\s+name: chainaim-refunds\r?$/m);
});

test("ARCH-660 image: zero npm dependencies, no key copied in, only the signer's packages and public config", () => {
  assert.match(dockerfile, /^FROM node:24-slim$/m);
  assert.equal(/npm (ci|install)/.test(dockerfile), false);
  assert.match(dockerfile, /ENTRYPOINT \["node", "services\/signer\/src\/main\.ts"\]/);
  for (const p of ["packages/signer/src", "packages/ap2/src", "packages/receipt/src", "packages/offer/src", "packages/crossask/src/cost.ts", "services/signer/src"]) {
    assert.match(dockerfile, new RegExp(`COPY ${p.replace(/\//g, "\\/").replace(/\./g, "\\.")} `), p);
    assert.match(ignore, new RegExp(`^!${p.replace(/\//g, "\\/").replace(/\./g, "\\.")}$`, "m"), `${p} let in`);
  }
  assert.match(ignore, /^\*$/m, "everything else left out");
  assert.match(ignore, /^\*\*\/\*\.env$/m);
  assert.match(ignore, /^config\/data-sources\.json$/m);
  assert.equal(/test-console|services\/gateway|services\/analyst|sample-data/.test(dockerfile.split("\n").filter((l) => l.startsWith("COPY")).join("\n")), false, "no data-plane code or data");
});

test("ARCH-664 up.ps1 -Signer separate: the console API gets the request key only; seller keys exist for the signer's compose command alone", () => {
  assert.match(up, /\[ValidateSet\("auto", "separate", "in-console"\)\]\[string\]\$Signer = "auto"/);
  assert.match(up, /\[string\]\$SellerSecretsFile = "C:\\CHAINAIM-SELLER-SECRETS\\signer\.env"/);
  const sep = up.slice(up.indexOf('if ($Signer -eq "separate") { $consoleCmd += @("--receipts=on"'), up.indexOf("# Tab 03 offer modes"));
  assert.ok(sep.length > 0);
  assert.match(sep, /if \(\$Signer -eq "separate"\) \{ \$consoleCmd \+= @\("--receipts=on", "--receipt-dir=\/receipts"\) \}/);
  assert.match(sep, /if \(\$Signer -eq "separate"\) \{ \$consoleCmd \+= @\("--ap2=on", "--ap2-alg=ES256", "--price-round=cent"\) \}/);
  assert.match(up, /\$consoleCmd \+= @\("--signer=remote", "--signer-url=\$\(\$SignerUrl\.TrimEnd\('\/'\)\)", "--signer-key-env=SIGNER_REQUEST_KEY"/);
  assert.match(up, /Set-Secret "SIGNER_REQUEST_KEY" \$signerReqKey/);
  // The seller keys: set right before the control-plane compose up, removed in its finally, before the data plane starts.
  const sig = up.slice(up.indexOf("if ($signerCmd) {"), up.indexOf("$upArgs = $composeArgs"));
  // privateAI-design-37: with -PaidFlow upfront the payTo key joins them, under the same set-then-remove rule.
  assert.match(sig, /\$sigKeys = @\("AP2_SIGNING_KEY", "RECEIPT_SIGNING_KEY"\) \+ \$\(if \(\$refundKeyOn\) \{ @\("SELLER_NEAR_PRIVATE_KEY"\) \} else \{ @\(\) \}\)/);
  assert.match(sig, /foreach \(\$k in \$sigKeys\) \{ Set-Item -Path "env:\$k" -Value \$sellerKeys\[\$k\] \}/);
  assert.match(sig, /"compose", "-p", "chainaim-control-plane", "-f", "services\/signer\/compose\.yml"/);
  assert.match(sig, /finally \{ foreach \(\$k in \$sigKeys\) \{ Remove-Item "env:\$k"/);
  assert.ok(up.indexOf("if ($signerCmd) {") < up.indexOf("$upArgs = $composeArgs"), "the control plane starts first");
  assert.match(up, /if \(-not \$signerReqKey -or \$signerReqKey -ne \$sellerKeys\["SIGNER_REQUEST_KEY"\]\)/, "both sides hold the same request key");
  assert.match(up, /still in \$SecretsFile \(not used now; remove those lines/);
});

test("ARCH-664 docker-compose.yml: console-api takes SIGNER_REQUEST_KEY by name and reaches the host's 8780", () => {
  const start = data.indexOf("\n  console-api:\n");
  const block = data.slice(start, data.indexOf("\n  agent:\n"));
  assert.match(block, /\n {6}- SIGNER_REQUEST_KEY\n/);
  assert.match(block, /extra_hosts: \["host\.docker\.internal:host-gateway"\]/);
});

test("ARCH-664 ARCH-666 desk.ps1: -SignerKeys and -MandateKey hand the file work to scripts\\signer-keys.ts; -Planes reads names only", () => {
  for (const m of ["[switch]$SignerKeys,", "[switch]$MandateKey,", "[string]$MandateTenant = \"\",", "[switch]$Planes,"]) assert.ok(desk.includes(m), m);
  const sk = desk.slice(desk.indexOf("if ($SignerKeys) {"), desk.indexOf("# ---------------------------------------------------------------- -MandateKey"));
  assert.match(sk, /"scripts\\signer-keys\.ts", "signer", "--buyer-file", \(Join-Path \$secrets "chainaim\.env"\), "--seller-file", \(Join-Path \$sellerSecrets "signer\.env"\), "--client-file", \(Join-Path \$secrets "signer-client\.env"\)/);
  assert.ok(!/docker|Get-Content|Set-Content|Out-File|Add-Content/.test(sk), "touches no service and no file itself");
  const mk = desk.slice(desk.indexOf("if ($MandateKey) {"), desk.indexOf("# ---------------------------------------------------------------- -Planes"));
  assert.match(mk, /"scripts\\signer-keys\.ts", "mandate", "--agent-env-file", \$agentEnv, "--tenant", \$MandateTenant/);
  assert.ok(!/docker|Get-Content|Set-Content|Out-File|Add-Content/.test(mk));
  const env = desk.slice(desk.indexOf("function EnvNames"), desk.indexOf("function PlanesReport"));
  assert.match(env, /Substring\(0, \$ix\)/, "only the part before = is kept");
  assert.match(env, /\$raw = \$null/, "the raw lines are dropped at once");
  assert.match(desk, /sellerSecretsDir must be another folder than secretsDir/);
  assert.match(desk, /\$privArgs\.Signer = \$signerMode/);
  assert.match(down, /"-p", "chainaim-control-plane", "-f", "services\/signer\/compose\.yml"/);
});

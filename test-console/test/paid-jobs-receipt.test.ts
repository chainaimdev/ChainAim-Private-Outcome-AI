/**
 * privateAI-design-32 ARCH-613 / ARCH-615 on tab 03 (test-console/console/paid-jobs.html): the paid request names the
 * dataset and template for the receipt, and after a paid release the page shows and offers the signed receipt. Read as
 * text, like the other page guards; the receipt itself is built and verified by test/receipt.test.ts and the e2e test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { signerFromKey, signMerchantAuthorization } from "../../packages/ap2/src/index.ts";

const html = readFileSync(new URL("../console/paid-jobs.html", import.meta.url), "utf8");
const js = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));

test("ARCH-613 both payment paths send the request through withReceiptFields (Me: /jobs/crossask, AI agent: /agent/crossask)", () => {
  const wrap = js.slice(js.indexOf("postData = async (url, body) =>"));
  assert.match(wrap, /const sent = withReceiptFields\(body\);/);
  assert.match(wrap, /if \(agentChosen\(\)\) return agentStep\(sent\);/);
  // privateAI-design-34 ARCH-642: the Me path posts /offers (estimate first) or /jobs/crossask (run first), both with sent.
  assert.match(wrap, /const job = await free\(modeChosen\(\) === "estimate-first" \? "\/offers" : "\/jobs\/crossask", sent\);/);
  assert.ok(!/free\("\/jobs\/crossask", body\)/.test(wrap) && !/agentStep\(body\)/.test(wrap), "never the bare body");
});

test("ARCH-613 datasetId is the picked dataset's config id; templateLabel only while the question is that template's own text", () => {
  const f = js.slice(js.indexOf("const withReceiptFields"), js.indexOf("function receiptPanel"));
  assert.match(f, /typeof ds !== "undefined" \? ds\.cur : undefined/, "no error when index.html has no ds");
  assert.match(f, /if \(inside && typeof cur\.id === "string" && DATASET_ID\.test\(cur\.id\)\)/, "a folder browsed to by hand is not named as the dataset");
  assert.match(f, /on\.title === body\.question/, "an edited question is not labelled as the template");
  assert.match(f, /typeof document\.querySelector === "function"/, "works in the page tests' minimal document (console-agent.test.ts)");
  assert.match(js, /DATASET_ID = \/\^\[A-Za-z0-9_\.-\]\{1,64\}\$\//, "the console's datasetIdOf shape");
  assert.match(js, /TEMPLATE_LABEL = \/\^\[\\x20-\\x7E\]\{1,120\}\$\//, "the console's templateLabelOf shape");
});

test("ARCH-615 the receipt panel runs after both paid releases, only with receipts on, polls GET /jobs/<id>/receipt and downloads {receipt, publicKeyPem}", () => {
  assert.match(js, /attestPanel\(job\.jobId\);\s*receiptPanel\(job\.jobId\);/, "Me path");
  assert.match(js, /if \(result !== undefined && settled && ranJob\) receiptPanel\(ranJob, receiptCheck\);/, "AI agent path, with what the agent's own check found (step B)");
  assert.match(js, /if \(result !== undefined && settled && ranJob\) attestPanel\(ranJob\);/, "the AI proof line is unchanged (console-progress.test.ts)");
  const p = js.slice(js.indexOf("function receiptPanel"), js.indexOf("const explorerLink"));
  assert.match(p, /config\.receipts !== true/, "nothing shown when the console has receipts off");
  assert.match(p, /fetch\(`\/jobs\/\$\{jobId\}\/receipt`\)/);
  assert.match(p, /RECEIPT_POLL_MAX/);
  assert.match(p, /r\.sig\.keyId/, "the key id is shown, so the owner can match it to desk.ps1 -ReceiptKey");
  assert.match(p, /JSON\.stringify\(\{ receipt: r, publicKeyPem: j\.publicKeyPem, \.\.\.\(j\.ap2 \? \{ ap2: j\.ap2 \} : \{\}\), \.\.\.\(typeof j\.mandate === "string" \? \{ mandate: j\.mandate \} : \{\}\), \.\.\.\(j\.attestation \? \{ attestation: j\.attestation \} : \{\}\) \}/, "ARCH-631: the signed quote rides along when there is one; privateAI-design-36 ARCH-668: and the checkout mandate; privateAI-design-40 ARCH-692: and the attestation bundle");
  assert.match(p, /a\.download = `chainaim-receipt-\$\{jobId\}\.json`/);
  assert.match(js, /pay\.replaceChildren\(\); proof\.replaceChildren\(\); rcpt\.replaceChildren\(\);/, "cleared on every new paid Ask");
});

test("ARCH-613 the console's /agent/crossask relay passes datasetId and templateLabel on to the agent (it rebuilds the run with known fields only)", () => {
  const server = readFileSync(new URL("../console/server.ts", import.meta.url), "utf8");
  const relay = server.slice(server.indexOf("async function relayAgent"), server.indexOf("async function forwardStream"));
  assert.ok(relay.length > 0);
  assert.match(relay, /const runLabel = templateLabelOf\(b\.templateLabel\);/);
  assert.match(relay, /typeof b\.datasetId === "string" && \/\^\[A-Za-z0-9_\.-\]\{1,64\}\$\/\.test\(b\.datasetId\) \? \{ datasetId: b\.datasetId \}/);
  assert.match(relay, /\.\.\.\(runLabel \? \{ templateLabel: runLabel \} : \{\}\)/);
});

test("tab 03 and the console no longer point at retired launchers (start-analyst.cmd, start-chain-query.cmd, start-ui.ps1): everything runs in Docker via desk.ps1", () => {
  const server = readFileSync(new URL("../console/server.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("../console/index.html", import.meta.url), "utf8");
  for (const [name, text] of [["server.ts", server], ["index.html", index], ["paid-jobs.html", html]] as const) {
    assert.ok(!/start-analyst|start-chain-query|start-ui\.ps1/.test(text), name);
  }
});

test("ARCH-615 the payment line names the NEAR transaction \"transaction\", so \"receipt\" on the page means only the signed receipt", () => {
  assert.ok(!/· receipt `/.test(js), "no transaction link labelled receipt");
  assert.equal((js.match(/· transaction `/g) ?? []).length, 2, "Me and AI agent paths");
});

test("ARCH-615 the page never handles a key or the released rows in the receipt panel", () => {
  const p = js.slice(js.indexOf("function receiptPanel"), js.indexOf("const explorerLink"));
  assert.ok(!/PRIVATE KEY|RECEIPT_SIGNING_KEY|localStorage|sessionStorage/.test(p));
  assert.ok(!/result\.rows|\.answer\b/.test(p), "the receipt panel shows hashes' metadata only, never the result");
});

test("step B ARCH-613 the receipt panel says whether the paying agent verified the receipt with its pinned key; the Me path passes no check", () => {
  const p = js.slice(js.indexOf("function receiptPanel"), js.indexOf("const explorerLink"));
  assert.match(p, /function receiptPanel\(jobId, agentCheck\)/);
  assert.match(p, /agentCheck\.ok \? ` · verified by \$\{agentCheck\.who\} ✓` : ` · \$\{agentCheck\.who\}'s check failed ✗`/);
  assert.match(js, /attestPanel\(job\.jobId\);\s*receiptPanel\(job\.jobId\);/, "Me path: no agent check");
  const run = js.slice(js.indexOf("async function agentRun"), js.indexOf("function attestPanel") > 0 ? js.indexOf("function attestPanel") : undefined);
  assert.match(run, /type === "receipt_verified"/);
  assert.match(run, /type === "receipt_failed"/);
  assert.ok(run.indexOf('type === "receipt_failed"') < run.indexOf('type === "refused"'), "a failed receipt check is a step, not a thrown refusal");
});

// ---- privateAI-design-33 section 7: the AP2 signed quote on tab 03 ----
test("ARCH-630 the agent path shows quote_signed between the quote and the policy, and a refusal's AP2 code", () => {
  const run = js.slice(js.indexOf("async function agentRun"), js.indexOf("function attestPanel"));
  assert.match(run, /type === "quote_signed"\) step\(by\(AGENT\), `Quote signed by ChainAim ✓ · key id \$\{String\(d\.kid\)\.slice\(0, 8\)\}… · price, payee and network match`\)/);
  assert.ok(run.indexOf('type === "quoted"') < run.indexOf('type === "quote_signed"') && run.indexOf('type === "quote_signed"') < run.indexOf('type === "policy"'));
  assert.match(run, /Not paid\$\{typeof d\.code === "string" \? ` \[\$\{d\.code\}\]` : ""\}: \$\{d\.reason\}/);
});

test("ARCH-628 the Me path: with a signed quote Pay starts disabled, is enabled only by a passing check, and the label says what it proves", () => {
  const p = js.slice(js.indexOf("function payStep"), js.indexOf("// Ticked: tab 03's own Ask flow"));
  assert.match(p, /if \(job\.ap2\) \{/);
  assert.match(p, /button\.disabled = true;\s*void checkSignedQuote\(job\)/);
  assert.match(p, /if \(v && v\.ok\) \{[\s\S]*if \(!cancel\.disabled\) button\.disabled = false;[\s\S]*\} else \{[\s\S]*Pay is disabled\./);
  assert.match(p, /it does not prove who runs this console/);
});

test("ARCH-631 the receipt panel shows the quote hash the receipt carries", () => {
  const p = js.slice(js.indexOf("function receiptPanel"), js.indexOf("const explorerLink"));
  assert.match(p, /r\.body\.merchantAuthSha256\.slice\(0, 8\)/);
});

test("ARCH-628 the page's own WebCrypto check verifies a real ES256 quote, and refuses another key, a changed price or payee, and a missing key", async () => {
  const block = js.slice(js.indexOf("// ---- AP2 signed quote, Me path"), js.indexOf("/** Agent mode: one run"));
  const signer = signerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  const other = signerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  let profileKeys: unknown[] = [signer.publicJwk];
  const fetchProfile = async (url: string) => { assert.equal(url, "/.well-known/ucp"); return { ok: true, json: async () => ({ keys: profileKeys }) }; };
  const checkSignedQuote = new Function("fetch", `${block}; return checkSignedQuote;`)(fetchProfile) as (job: unknown) => Promise<{ ok: boolean; kid?: string; reason?: string } | null>;
  const job = { jobId: "0123456789abcdef0123456789abcdef", amount: "20000", payTo: "merchant.testnet", asset: "usdc.testnet", network: "near:testnet" };
  // Keys in an order JCS must sort, a non-ASCII title and a nested array, so the page's JCS is exercised.
  const checkout = { status: "ready_for_complete", id: job.jobId, currency: "USD", totals: [{ type: "subtotal", amount: 2 }, { type: "total", amount: 2 }],
    line_items: [{ item: { title: "Analyse – privée", price: 2, id: "x" }, id: "job", quantity: 1 }],
    "dev.chainaim.job": { usdcDecimals: 6, amountUnits: "20000", payTo: job.payTo, asset: job.asset, network: job.network } };
  const ap2 = { checkout, merchant_authorization: signMerchantAuthorization(checkout, signer) };
  assert.equal(await checkSignedQuote({ ...job }), null, "no ap2: no line");
  assert.deepEqual(await checkSignedQuote({ ...job, ap2 }), { ok: true, kid: signer.kid });
  const bad = async (j: unknown, re: RegExp) => { const v = await checkSignedQuote(j); assert.equal(v?.ok, false); assert.match(v!.reason!, re); };
  await bad({ ...job, ap2: { checkout, merchant_authorization: signMerchantAuthorization(checkout, other) } }, /has no key/);
  await bad({ ...job, amount: "30000", ap2 }, /signed price is not the price shown/);
  await bad({ ...job, payTo: "evil.testnet", ap2 }, /payee, asset or network/);
  await bad({ ...job, ap2: { ...ap2, checkout: { ...checkout, status: "completed" } } }, /does not verify/);
  profileKeys = [];
  await bad({ ...job, ap2 }, /has no key/);
});

test("ARCH-628 tab 03 Payment has the Show the UCP profile button (GET /.well-known/ucp) beside the Try buttons", () => {
  const index = readFileSync(new URL("../console/index.html", import.meta.url), "utf8");
  const t3 = index.slice(index.indexOf('<section class="sheet" id="t3"'), index.indexOf('<section class="sheet" id="t4"'));
  assert.match(t3, /data-route="chat">Try chat<\/button>\s*<button class="ghost" id="ucpProfile"[^>]*>Show the UCP profile<\/button>/);
  assert.match(index, /if \(\$\("ucpProfile"\)\) \$\("ucpProfile"\)\.onclick = \(\) => busy\(\$\("ucpProfile"\), async \(\) => \{\s*const out = \$\("payOut"\); out\.replaceChildren\(\);\s*const res = await fetch\("\/\.well-known\/ucp"\);/);
});

test("privateAI-design-39 ARCH-689 ARCH-688 tab 03: a refund because privacy was not proven says so; the policy row for the signed attestation mode", () => {
  assert.match(html, /d\.privacy \? `Refused: privacy not proven \(\$\{d\.privacy\}\) → refunded ✓` : "Refunded ✓"/);
  assert.match(html, /d\.privacy \? `Refused: privacy not proven \(\$\{d\.privacy\}\)` : "Run refused after the payment"/);
  assert.match(html, /require_attestation: \(c\) => `attestation \$\{c\.limit\} or stronger \(signed: \$\{c\.value\}\)`/);
});

test("privateAI-design-40 ARCH-692 tab 03: Download receipt carries the attestation bundle when the console sends it, so verify-receipt re-hashes it offline", () => {
  assert.match(html, /\.\.\.\(j\.attestation \? \{ attestation: j\.attestation \} : \{\}\) \}, null, 2\)\], \{ type: "application\/json" \}\);/);
});

test("privateAI-design-41 ARCH-699 tab 03: What left your PC per call (host, zone, masked counts, hash, = the attested request hash), the owner's download, and counts and hashes only in the observer view", () => {
  assert.match(html, /if \(Array\.isArray\(r\.body\.egress\) && r\.body\.egress\.length\) rcpt\.append\(egressPanel\(jobId, r\.body\)\);/);
  assert.match(html, /What left your PC: \$\{body\.egress\.length\} model call/);
  assert.match(html, /`→ \$\{e\.destination\} \(\$\{e\.zone\}\) · masked \$\{masked\} · \$\{e\.sentBytes\} bytes, sha256 \$\{e\.sentSha256\.slice\(0, 12\)\}…\$\{tied\}`/);
  assert.match(html, /call\.reqSha256 === e\.sentSha256 \? " · = the attested request hash ✓"/);
  assert.match(html, /fetch\(`\/jobs\/\$\{jobId\}\/egress\/\$\{e\.call\}`\)/);
  assert.match(html, /Your data files and their rows stay on your PC\./);
  assert.doesNotMatch(html, /nothing leaves your PC/i, "masked prompts do leave");
  assert.match(html, /row\(`Left the PC, call \$\{e\.call \+ 1\} \(receipt\)`, `\$\{e\.sentBytes\} bytes, sha256/);
});

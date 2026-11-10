/**
 * privateAI-design-32 ARCH-613 / ARCH-615 on tab 03 (test-console/console/paid-jobs.html): the paid request names the
 * dataset and template for the receipt, and after a paid release the page shows and offers the signed receipt. Read as
 * text, like the other page guards; the receipt itself is built and verified by test/receipt.test.ts and the e2e test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../console/paid-jobs.html", import.meta.url), "utf8");
const js = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));

test("ARCH-613 both payment paths send the request through withReceiptFields (Me: /jobs/crossask, AI agent: /agent/crossask)", () => {
  const wrap = js.slice(js.indexOf("postData = async (url, body) =>"));
  assert.match(wrap, /const sent = withReceiptFields\(body\);/);
  assert.match(wrap, /if \(agentChosen\(\)\) return agentStep\(sent\);/);
  assert.match(wrap, /const job = await free\("\/jobs\/crossask", sent\);/);
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
  assert.match(js, /if \(result !== undefined && settled && ranJob\) receiptPanel\(ranJob\);/, "AI agent path");
  assert.match(js, /if \(result !== undefined && settled && ranJob\) attestPanel\(ranJob\);/, "the AI proof line is unchanged (console-progress.test.ts)");
  const p = js.slice(js.indexOf("function receiptPanel"), js.indexOf("const explorerLink"));
  assert.match(p, /config\.receipts !== true/, "nothing shown when the console has receipts off");
  assert.match(p, /fetch\(`\/jobs\/\$\{jobId\}\/receipt`\)/);
  assert.match(p, /RECEIPT_POLL_MAX/);
  assert.match(p, /r\.sig\.keyId/, "the key id is shown, so the owner can match it to desk.ps1 -ReceiptKey");
  assert.match(p, /JSON\.stringify\(\{ receipt: r, publicKeyPem: j\.publicKeyPem \}/);
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

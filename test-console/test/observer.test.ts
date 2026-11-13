/**
 * privateAI-design-35 ARCH-650 on tab 03 and the console route (packages/observer does the chain read; its own tests are
 * packages/observer/test). Read as text, like the other page guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---- tab 03 page and console route (read as text, like the other page guards) ----
const html = readFileSync(new URL("../console/paid-jobs.html", import.meta.url), "utf8");
const js = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
const server = readFileSync(new URL("../console/server.ts", import.meta.url), "utf8");

test("ARCH-650 tab 03 states the limit and offers the observer view after both paid releases, only when the console has it on", () => {
  assert.match(js, /receiptPanel\(job\.jobId\);\s*observerPanel\(job\.jobId\);/, "Me path");
  assert.match(js, /if \(result !== undefined && settled && ranJob\) observerPanel\(ranJob\);/, "AI agent path");
  const p = js.slice(js.indexOf("function observerPanel"), js.indexOf("const explorerLink"));
  assert.match(p, /config\.observer !== true/, "nothing shown when the console has it off");
  assert.match(p, /fetch\(`\/jobs\/\$\{jobId\}\/observer`\)/);
  assert.ok(!/innerHTML/.test(p), "chain data is put in the page as text only");
  assert.match(js, /OBSERVER_LINE = "Your content stays private: it was de-identified before any model saw it, every NEAR AI call is attested, and nothing about it goes on chain\. Only the payment is on NEAR, like any transfer: who paid, how much and when\."/);
  assert.match(js, /pay\.replaceChildren\(\); proof\.replaceChildren\(\); rcpt\.replaceChildren\(\); obs\.replaceChildren\(\);/, "cleared on a new run");
});

test("ARCH-650 the console route needs receipts and the observer on, answers 409 before the settlement, and maps ObserverError statuses", () => {
  const r = server.slice(server.indexOf("// ARCH-650: what anyone reading NEAR learns"), server.indexOf("// Run, meter, quote, hold, register"));
  assert.match(r, /\/\^\\\/jobs\\\/\[0-9a-f\]\{32\}\\\/observer\$\/\.test\(url\.pathname\)/);
  assert.match(r, /if \(!hostOk\(req\)\) return dataJson\(res, 403/);
  assert.match(r, /if \(!RECEIPTS \|\| !OBSERVER\) return dataJson\(res, 404/);
  assert.match(r, /if \(!receipt\.settlement\) return dataJson\(res, 409/);
  assert.match(r, /await observe\(receipt\.settlement, OBSERVER\)/);
  assert.match(r, /e instanceof ObserverError \? e\.status : 502/);
  assert.match(server, /const OBSERVER = RECEIPTS \? observerConfig\(flags\) : undefined;/);
  assert.match(server, /receipts: RECEIPTS !== undefined, observer: OBSERVER !== undefined,/);
});

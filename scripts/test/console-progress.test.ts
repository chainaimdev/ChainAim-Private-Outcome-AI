/**
 * Guards the console's UI CONTRACT (DESIGN/xrplh-28 section 10): every long action shows that it is working. A change that drops
 * the activity bar, the button spinner or the seconds counter fails `npm test`. Reads test-console/console/index.html as text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../../test-console/console/index.html", import.meta.url), "utf8");
const fnBody = (name: string): string => {
  const start = page.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} is missing from index.html`);
  return page.slice(start, page.indexOf("\n}\n", start));
};

test("the activity bar exists: markup, live region, spinner, seconds", () => {
  assert.match(page, /<div id="activity" role="status" aria-live="polite">/);
  for (const part of ['class="bar"', 'class="glyph"', 'class="what"', 'class="secs"']) assert.ok(page.includes(part), `activity bar lacks ${part}`);
  assert.match(page, /#activity\.on \{ display: flex; \}/);
  assert.match(page, /@keyframes act-spin/);
  assert.match(page, /button\[aria-busy="true"\]::before/);
});

test("busy() drives the activity bar and the button spinner, and always clears them", () => {
  const body = fnBody("busy");
  assert.match(body, /aria-busy", "true"/);
  assert.match(body, /activity\.start\(/);
  assert.match(body, /finally \{[^}]*removeAttribute\("aria-busy"\)[^}]*activity\.stop\(\)/);
});

test("the activity bar counts seconds and explains long waits", () => {
  const i = page.indexOf("const activity = ");
  assert.ok(i >= 0, "activity helper missing");
  const helper = page.slice(i, page.indexOf("})();", i));
  assert.match(helper, /setInterval\(paint, 1000\)/);
  assert.match(helper, /\$\{s\} s/);
  assert.match(helper, /s >= 30/);
  assert.match(helper, /const FRAMES = \[/, "the animated live-activity glyph is gone");
  assert.match(helper, /setInterval\(turn, 120\)/);
  assert.match(page, /@keyframes act-shimmer/);
});

test("every server action button runs through busy(), and the slow ones say what they wait for", () => {
  for (const id of ["scan", "mask", "send", "xaskGo", "xaskRel", "ledger"]) assert.match(page, new RegExp(`\\$\\("${id}"\\)\\.onclick = \\(\\) => busy\\(\\$\\("${id}"\\)`), `${id} is not wrapped in busy()`);
  for (const id of ["xaskGo", "send"]) assert.match(page, new RegExp(`id="${id}" data-busy="[^"]+"`), `${id} has no data-busy label`);
});

test("blockchain queries use the activity bar and stop it in finally", () => {
  const body = fnBody("chainRun");
  assert.match(body, /activity\.start\(/);
  assert.match(body, /finally \{[\s\S]*activity\.stop\(\)/);
  assert.match(body, /AbortSignal\.timeout\(/);
});

test("Dental (domain-pack) questions: a Topic picklist, one question per intent with Answer as Table | Explained, and a 'How this was answered' strip (DESIGN/xrplh-29 section 8)", () => {
  assert.match(page, /function dsIntents\(topic\)/);
  assert.match(page, /el\("select", \{ id: "dsTopic" \}/);
  assert.match(fnBody("dsStyleRender"), /"Answer as"/);
  // owner 2026-11-07: the model picker is always shown when the question can be Explained (it was Explained-only), and it
  // starts on the console's --default-answer-model when the gateway lists it
  assert.match(fnBody("dsStyleRender"), /it\.model \? el\("label", \{ className: "blabel ds-model" \}/, "the model picker shows whenever Explained is offered");
  assert.match(fnBody("dsStyleRender"), /\$\("dsModel"\)\?\.value \|\| defaultAnswerModel/, "the default answer model is the first choice");
  const ask = fnBody("packAsk");
  assert.equal((ask.match(/howStrip\(\[/g) ?? []).length, 2, "both answer paths say how the answer was obtained");
  assert.match(ask, /Nothing was sent to any model/);
});

test("tab 03 AI proof (owner 2026-11-07): after a paid release the page asks GET /jobs/<id>/attestation, in plain words, safely", () => {
  const pj = readFileSync(new URL("../../test-console/console/paid-jobs.html", import.meta.url), "utf8");
  assert.match(pj, /function attestPanel\(jobId\)/);
  assert.match(pj, /fetch\(`\/jobs\/\$\{jobId\}\/attestation`\)/);
  assert.match(pj, /if \(!config \|\| !config\.attest \|\| !\/\^\[0-9a-f\]\{32\}\$\/\.test\(jobId\)\) return;/, "only with --attest-url, only a job id");
  assert.match(pj, /if \(n < config\.attest\.pollMax\) setTimeout\(ask, config\.attest\.pollMs\)/, "polling is bounded by the console's flags");
  assert.ok(!/innerHTML/.test(pj), "every value is set as text");
  assert.match(pj, /attestPanel\(job\.jobId\)/, "manual payment");
  assert.match(pj, /if \(result !== undefined && settled && ranJob\) attestPanel\(ranJob\)/, "agent payment");
  assert.match(pj, /Covers what the gateway sent after masking; correctness is the figure check above/, "says what it does not cover");
});

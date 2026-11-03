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

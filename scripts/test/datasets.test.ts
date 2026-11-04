/** config/datasets.json (DESIGN/xrplh-29): the datasets tab 03 offers. Names and folders only, never data; folders stay inside their root. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reg = JSON.parse(readFileSync(new URL("../../config/datasets.json", import.meta.url), "utf8"));
const sources = JSON.parse(readFileSync(new URL("../../config/data-sources.example.json", import.meta.url), "utf8"));

test("every dataset has an id, a label, a 1-2 sentence description, a relative folder and a known engine", () => {
  assert.equal(reg.version, 1);
  const ids = new Set<string>();
  for (const d of reg.datasets) {
    assert.match(d.id, /^[a-z0-9][a-z0-9-]*$/); assert.ok(!ids.has(d.id), `duplicate ${d.id}`); ids.add(d.id);
    assert.ok(d.label && d.description, `${d.id}: label and description`);
    const sentences = d.description.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.ok(sentences >= 1 && sentences <= 2, `${d.id}: description should be 1-2 sentences, has ${sentences}`);
    assert.ok(!/^([a-z]:|[\\/])/i.test(d.folder) && !d.folder.split(/[\\/]/).includes(".."), `${d.id}: folder must be relative and stay inside its root`);
    assert.ok(["crossask", "domain-pack"].includes(d.engine), `${d.id}: engine`);
    if (d.engine === "domain-pack") { assert.match(d.pack, /^[a-z0-9-]+(\/[a-z0-9-]+)*$/); assert.deepEqual(d.templates, { from: "pack" }); }
    else assert.ok(Array.isArray(d.templates) && d.templates.every((t: { label: string; q: string }) => t.label && t.q));
  }
});

test("the two roots: samples inside the repository (git-ignored), private outside it; both are allowed data roots", () => {
  assert.equal(reg.roots.samples, "sample-data");
  assert.match(reg.roots.private, /^[A-Za-z]:\\/);
  for (const r of Object.values(reg.roots)) assert.ok(sources.allowedRoots.includes(r), `${r} is not in data-sources allowedRoots`);
  assert.equal(sources.allowedRoots[0], "sample-data");
});

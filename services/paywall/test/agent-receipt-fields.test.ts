/**
 * privateAI-design-32 ARCH-613: tab 03's agent mode passes the receipt's datasetId and templateLabel through the agent
 * service to the console's /jobs/crossask (scripts/agent-jobs-core.ts parseRunRequest + runAndPay). Before 2026-11-10 the
 * agent kept a fixed field list and dropped them, so agent-paid receipts carried a folder hash and no template label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRunRequest } from "../scripts/agent-jobs-core.ts";

const tenants = new Set(["t01"]);
const base = { tenant: "t01", folder: "/app/sample-data/smb-fin-1", question: "How much cash came in?" };

test("ARCH-613 parseRunRequest keeps a well-formed datasetId and templateLabel (label trimmed); absent stays absent", () => {
  const r = parseRunRequest({ ...base, datasetId: "smb-fin-1", templateLabel: "  Cash flow vs installment " }, tenants);
  assert.ok(!("error" in r));
  assert.equal(r.datasetId, "smb-fin-1");
  assert.equal(r.templateLabel, "Cash flow vs installment");
  const plain = parseRunRequest(base, tenants);
  assert.ok(!("error" in plain));
  assert.equal("datasetId" in plain, false);
  assert.equal("templateLabel" in plain, false);
});

test("ARCH-613 parseRunRequest refuses a datasetId or templateLabel the console would not accept (same shapes as receipt.ts)", () => {
  for (const datasetId of ["", "a/b", "../x", "x".repeat(65), 7, null]) {
    const r = parseRunRequest({ ...base, datasetId }, tenants);
    assert.ok("error" in r && /datasetId/.test(r.error), String(datasetId));
  }
  for (const templateLabel of ["", "   ", "line\nbreak", "é non-ascii", "x".repeat(121), 3]) {
    const r = parseRunRequest({ ...base, templateLabel }, tenants);
    assert.ok("error" in r && /templateLabel/.test(r.error), JSON.stringify(templateLabel));
  }
});

test("ARCH-613 runAndPay posts datasetId and templateLabel to the console's /jobs/crossask with the run's other fields", () => {
  const src = readFileSync(new URL("../scripts/agent-jobs-core.ts", import.meta.url), "utf8");
  const call = src.slice(src.indexOf("fetch(`${deps.console}/jobs/crossask`"), src.indexOf("signal,", src.indexOf("fetch(`${deps.console}/jobs/crossask`")));
  assert.ok(call.length > 0);
  assert.match(call, /datasetId: req\.datasetId, templateLabel: req\.templateLabel/);
  assert.match(call, /folder: req\.folder, question: req\.question/);
});

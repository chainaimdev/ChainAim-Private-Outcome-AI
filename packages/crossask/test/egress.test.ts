/**
 * privateAI-design-41 ARCH-697: the console reads the gateway's x-chainaim-egress header with an allowlist. A good header
 * becomes ChatReply.egress; an unknown member, a missing one or a bad value is refused by name (the call then has no
 * egress entry and the console logs why); no header = nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEgressHeader } from "../src/index.ts";

const GOOD = { v: 1, destination: "cloud-api.near.ai", zone: "private-cloud", sentSha256: "a".repeat(64), sentBytes: 812, masked: { PERSON: 2, EMAIL_ADDRESS: 0 }, residual: "pass", dataClass: "PII" };

test("ARCH-697 a well-formed header becomes the call's egress (v dropped); no header gives nothing", () => {
  assert.deepEqual(parseEgressHeader(JSON.stringify(GOOD)), { egress: { destination: "cloud-api.near.ai", zone: "private-cloud", sentSha256: "a".repeat(64), sentBytes: 812, masked: { PERSON: 2, EMAIL_ADDRESS: 0 }, residual: "pass", dataClass: "PII" } });
  assert.deepEqual(parseEgressHeader(JSON.stringify({ ...GOOD, destination: "127.0.0.1:11434", zone: "local", residual: "off", dataClass: "none", masked: {} })).egress?.destination, "127.0.0.1:11434");
  assert.deepEqual(parseEgressHeader(null), {});
});

test("ARCH-697 refused by name: an unknown member, a missing one, a bad value, not JSON, too long", () => {
  const cases: [string, RegExp][] = [
    [JSON.stringify({ ...GOOD, prompt: "x" }), /unknown member prompt/],
    [JSON.stringify({ ...GOOD, sentBytes: undefined }), /member sentBytes is missing/],
    [JSON.stringify({ ...GOOD, v: 2 }), /v must be 1/],
    [JSON.stringify({ ...GOOD, destination: "https://cloud-api.near.ai/v1?key=abc" }), /destination must be a host name/],
    [JSON.stringify({ ...GOOD, sentSha256: "A".repeat(64) }), /sentSha256 must be 64 lowercase hex/],
    [JSON.stringify({ ...GOOD, sentBytes: -1 }), /sentBytes must be a whole number/],
    [JSON.stringify({ ...GOOD, masked: { "Jane Roe": 1 } }), /masked must map entity kinds/],
    [JSON.stringify({ ...GOOD, residual: "refused" }), /residual must be pass or off/],
    [JSON.stringify({ ...GOOD, dataClass: "secret" }), /dataClass must be PHI, PCI, PII or none/],
    ["not json", /not JSON/],
    [JSON.stringify([GOOD]), /not a JSON object/],
    [JSON.stringify({ ...GOOD, zone: "x".repeat(3000) }), /longer than 2048/],
  ];
  for (const [h, re] of cases) {
    const r = parseEgressHeader(h);
    assert.equal(r.egress, undefined, re.source);
    assert.match(r.refused ?? "", re);
  }
});

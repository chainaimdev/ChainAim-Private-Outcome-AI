/**
 * privateAI-design-41 ARCH-695: with --expose-egress on, EVERY deployment (not only attested ones) encodes the request
 * once, sends exactly those bytes and hashes them; the chat reply carries one header x-chainaim-egress (compact JSON: the
 * destination host, zone, sentSha256, sentBytes, masked kind -> count, residual, dataClass) and the ledger line records the
 * same fields. Off (the default) adds nothing. Real gateway over real sockets, the stand-in Presidio of the other tests, and
 * a loopback OpenAI-compatible model that records every byte it receives.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { validateCatalog, type Catalog } from "../src/catalog.ts";
import { EGRESS_HEADER } from "../src/server.ts";
import { closeServer, ledgerText, listen, post, startTestGateway, type TestGateway } from "./helpers.ts";

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** local/small: plain deployment. local/large: attest "nearai". */
function catalogAt(url: string): Catalog {
  const dep = (id: string, extra: Record<string, unknown> = {}) => ({ id, adapter: "openai", baseUrl: `${url}/v1`, servedModel: "provider/model-1", healthUrl: `${url}/health`, ...extra });
  return validateCatalog({
    version: "test",
    models: [
      { id: "local/small", zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 }, deployments: [dep("small@0")] },
      { id: "local/large", zone: "private-cloud", capabilities: caps, pricing: { inputPerM: 0.3, outputPerM: 1.2 }, deployments: [dep("large@0", { attest: "nearai" })] },
    ],
    profiles: { auto: chains(["local/small", "local/large"]), eco: chains(["local/small", "local/large"]), premium: chains(["local/small", "local/large"]) },
  });
}

const PROMPT = "Summarise: Jane Roe wrote from jane.roe@example.com about the invoice.";
const MARKERS = ["Jane Roe", "jane.roe@example.com", "Summarise", "invoice"];

describe("privateAI-design-41 ARCH-695 --expose-egress", () => {
  let presidio: StubPresidio;
  let model: { server: Server; url: string };
  let seen: Buffer[] = [];
  let on: TestGateway;
  let off: TestGateway;

  before(async () => {
    presidio = await startStubPresidio();
    const server = createServer(async (req, res) => {
      if (req.url === "/health") return void res.writeHead(200).end("{}");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      seen.push(body);
      const reply = { id: "chatcmpl-egress-0001", object: "chat.completion", model: JSON.parse(body.toString("utf8")).model, choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } };
      const sent = Buffer.from(JSON.stringify(reply), "utf8");
      res.writeHead(200, { "content-type": "application/json", "content-length": sent.length });
      res.end(sent);
    });
    model = { server, url: await listen(server) };
    on = await startTestGateway({ presidioUrl: presidio.url, catalog: catalogAt(model.url), exposeEgress: true });
    off = await startTestGateway({ presidioUrl: presidio.url, catalog: catalogAt(model.url) });
  });
  beforeEach(() => { seen = []; });
  after(async () => {
    await on.close();
    await off.close();
    await closeServer(model.server);
    await presidio.close();
  });
  const ask = (g: TestGateway, modelId: string) => post(`${g.url}/v1/chat/completions`, { model: modelId, messages: [{ role: "user", content: PROMPT }] });
  const host = () => new URL(model.url).host;

  for (const [modelId, zone] of [["local/small", "local"], ["local/large", "private-cloud"]] as const) {
    it(`ARCH-695: ${modelId} (${zone === "local" ? "not attested" : "attested"}): the header's sentSha256 / sentBytes are of the exact bytes the model received; masked counts equal the ledger's`, async () => {
      const r = await ask(on, modelId);
      assert.equal(r.status, 200);
      await r.json();
      assert.equal(seen.length, 1);
      const raw = r.headers.get(EGRESS_HEADER);
      assert.ok(raw, "the header is present");
      assert.ok(raw!.length <= 2048, "compact, at most 2 KB");
      const e = JSON.parse(raw!);
      assert.deepEqual(Object.keys(e).sort(), ["dataClass", "destination", "masked", "residual", "sentBytes", "sentSha256", "v", "zone"]);
      assert.equal(e.v, 1);
      assert.equal(e.destination, host(), "the host of baseUrl only: no path, key or query");
      assert.equal(e.zone, zone);
      assert.equal(e.sentSha256, sha(seen[0]));
      assert.equal(e.sentBytes, seen[0].length);
      assert.equal(e.residual, "pass");
      assert.equal(e.masked.PERSON, 1);
      assert.equal(e.masked.EMAIL_ADDRESS, 1);
      if (zone === "private-cloud") assert.equal(e.sentSha256, r.headers.get("x-chainaim-req-sha256"), "attested: the same bytes the enclave's request hash covers");
      const id = r.headers.get("x-chainaim-decision-id");
      const lineRaw = ledgerText(on.ledgerDir).trim().split("\n").find((l) => JSON.parse(l).decisionId === id)!;
      const line = JSON.parse(lineRaw);
      assert.deepEqual(line.egress, e, "the ledger records the same fields");
      assert.deepEqual(line.egress.masked, line.entityCounts);
      assert.equal(line.egress.dataClass, line.dataClass ?? "none");
      for (const m of MARKERS) {
        assert.ok(!raw!.includes(m), `header leaks ${m}`);
        assert.ok(!lineRaw.includes(m), `ledger leaks ${m}`);
      }
      assert.doesNotMatch(raw!, /<\s*[A-Z_]+_\d+\s*>/, "no placeholder");
    });
  }

  it("ARCH-699: GET /internal/egress/<sentSha256> answers the exact bytes sent (memory only); off, or an unknown hash, is 404", async () => {
    const r = await ask(on, "local/large");
    await r.json();
    const e = JSON.parse(r.headers.get(EGRESS_HEADER)!);
    const got = await fetch(`${on.url}/internal/egress/${e.sentSha256}`);
    assert.equal(got.status, 200);
    const bytes = Buffer.from(await got.arrayBuffer());
    assert.ok(bytes.equals(seen[0]), "byte for byte what the model received");
    assert.equal(sha(bytes), e.sentSha256);
    assert.ok(!ledgerText(on.ledgerDir).includes(bytes.toString("utf8")), "the bytes are never in the ledger");
    assert.equal((await fetch(`${on.url}/internal/egress/${"0".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${off.url}/internal/egress/${e.sentSha256}`)).status, 404, "no such route with the flag off");
  });

  it("ARCH-695: off (the default): no header, no egress in the ledger, and the request bytes are the ones sent with it on", async () => {
    const r = await ask(off, "local/small");
    assert.equal(r.status, 200);
    await r.json();
    assert.equal(r.headers.get(EGRESS_HEADER), null);
    const id = r.headers.get("x-chainaim-decision-id");
    const line = JSON.parse(ledgerText(off.ledgerDir).trim().split("\n").find((l) => JSON.parse(l).decisionId === id)!);
    assert.equal(line.egress, undefined);
    const r2 = await ask(on, "local/small");
    await r2.json();
    assert.equal(seen.length, 2);
    assert.ok(seen[0].equals(seen[1]), "with the flag on the same bytes go out: only a hash is added on this side");
  });
});

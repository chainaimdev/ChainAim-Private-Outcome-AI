/**
 * PLAN-private-ai-nearai-attestation.md ARCH-407 / ARCH-408: for a deployment with attest: "nearai" the gateway sends the
 * request bytes it hashes, hashes the exact response bytes, asks for no compression and no model aliasing, and returns
 * the provider's chat id, served model and both hashes as x-chainaim-* headers and in the ledger line (never text). A
 * deployment without attest is called exactly as before. Real gateway over real sockets, the stand-in Presidio of the
 * other tests, and a loopback OpenAI-compatible model that records every byte it receives and sends.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { CatalogError, validateCatalog, type Catalog } from "../src/catalog.ts";
import { ATTEST_HEADERS } from "../src/server.ts";
import { closeServer, ledgerText, listen, post, startTestGateway, type TestGateway } from "./helpers.ts";

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** local/small: plain deployment. local/large: attest "nearai". Both serve the same upstream model name, so the bodies can be compared byte for byte. */
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

type Seen = { headers: IncomingHttpHeaders; body: Buffer; sent: Buffer };
/** Non-ASCII on purpose: a hash over a re-encoded string instead of the received bytes would still differ from these. */
const ANSWER = "Café ✓ — done.";
const PROMPT = "Summarise: Jane Roe wrote from jane.roe@example.com about the invoice.";
const MARKERS = ["Jane Roe", "jane.roe@example.com", "Summarise", "invoice", ANSWER];

describe("ARCH-407/408: exact-byte hashes for attested deployments", () => {
  let presidio: StubPresidio;
  let model: { server: Server; url: string };
  let seen: Seen[] = [];
  /** The id the loopback model puts in its reply; undefined = no id field. */
  let replyId: string | undefined = "chatcmpl-test-0001";
  let gateway: TestGateway;

  before(async () => {
    presidio = await startStubPresidio();
    const server = createServer(async (req, res) => {
      if (req.url === "/health") return void res.writeHead(200).end("{}");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const reply = { ...(replyId === undefined ? {} : { id: replyId }), object: "chat.completion", model: JSON.parse(body.toString("utf8")).model, choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } };
      // Two spaces of indentation: bytes no re-serialisation by the gateway would reproduce.
      const sent = Buffer.from(JSON.stringify(reply, null, 2), "utf8");
      seen.push({ headers: req.headers, body, sent });
      res.writeHead(200, { "content-type": "application/json", "content-length": sent.length });
      res.end(sent);
    });
    model = { server, url: await listen(server) };
    gateway = await startTestGateway({ presidioUrl: presidio.url, catalog: catalogAt(model.url) });
  });
  beforeEach(() => {
    seen = [];
    replyId = "chatcmpl-test-0001";
  });
  after(async () => {
    await gateway.close();
    await closeServer(model.server);
    await presidio.close();
  });
  const ask = (modelId: string) => post(`${gateway.url}/v1/chat/completions`, { model: modelId, messages: [{ role: "user", content: PROMPT }] });

  it("ARCH-407: header hashes equal SHA-256 of the exact bytes the model received and sent", async () => {
    const r = await ask("local/large");
    assert.equal(r.status, 200);
    const reply = await r.json();
    assert.equal(seen.length, 1);
    assert.equal(r.headers.get("x-chainaim-req-sha256"), sha(seen[0].body));
    assert.equal(r.headers.get("x-chainaim-resp-sha256"), sha(seen[0].sent));
    assert.equal(r.headers.get("x-chainaim-provider-id"), "chatcmpl-test-0001");
    assert.equal(r.headers.get("x-chainaim-served-model"), "provider/model-1");
    assert.equal(reply.choices[0].message.content, ANSWER, "the reply itself is unchanged");
  });

  it("ARCH-407: the attested request asks for no compression and no model aliasing", async () => {
    await (await ask("local/large")).json();
    assert.equal(seen[0].headers["accept-encoding"], "identity");
    assert.equal(seen[0].headers["x-no-aliasing"], "true");
  });

  it("ARCH-407: a non-attested deployment's request body is byte-identical, without the attestation headers", async () => {
    const plain = await ask("local/small");
    await plain.json();
    const attested = await ask("local/large");
    await attested.json();
    assert.equal(seen.length, 2);
    assert.ok(seen[0].body.equals(seen[1].body), "same body bytes: attestation changes headers only");
    assert.equal(JSON.stringify(JSON.parse(seen[0].body.toString("utf8"))), seen[0].body.toString("utf8"), "the body is JSON.stringify output, as before");
    assert.equal(seen[0].headers["x-no-aliasing"], undefined);
    assert.notEqual(seen[0].headers["accept-encoding"], "identity");
    for (const h of ATTEST_HEADERS) assert.equal(plain.headers.get(h), null, `${h} absent for a non-attested deployment`);
  });

  it("ARCH-408: the ledger line holds the chat id, served model and hashes, and no text", async () => {
    const r = await ask("local/large");
    await r.json();
    const id = r.headers.get("x-chainaim-decision-id");
    const raw = ledgerText(gateway.ledgerDir).trim().split("\n").find((l) => JSON.parse(l).decisionId === id);
    assert.ok(raw, "a ledger line for this decision");
    const line = JSON.parse(raw);
    assert.deepEqual(line.attest, { kind: "nearai", providerId: "chatcmpl-test-0001", servedModel: "provider/model-1", requestSha256: sha(seen[0].body), responseSha256: sha(seen[0].sent) });
    for (const m of MARKERS) assert.ok(!raw.includes(m), `ledger line leaks ${m}`);
  });

  it("ARCH-408: no attestation header carries text, a value or a placeholder", async () => {
    const r = await ask("local/large");
    await r.json();
    const all = ATTEST_HEADERS.map((h) => `${h}: ${r.headers.get(h) ?? ""}`).join("\n");
    for (const m of MARKERS) assert.ok(!all.includes(m), `header leaks ${m}`);
    assert.doesNotMatch(all, /<\s*[A-Z_]+_\d+\s*>/);
    assert.match(r.headers.get("x-chainaim-req-sha256") ?? "", /^[0-9a-f]{64}$/);
    assert.match(r.headers.get("x-chainaim-resp-sha256") ?? "", /^[0-9a-f]{64}$/);
  });

  it("ARCH-408: a reply without a usable chat id still carries the hashes, and no provider id", async () => {
    for (const id of [undefined, "bad id with spaces"]) {
      replyId = id;
      seen = [];
      const r = await ask("local/large");
      assert.equal(r.status, 200);
      await r.json();
      assert.equal(r.headers.get("x-chainaim-provider-id"), null);
      assert.equal(r.headers.get("x-chainaim-req-sha256"), sha(seen[0].body));
    }
  });
});

describe("ARCH-407: catalog field", () => {
  const base = (attest: unknown) => ({
    version: "test",
    models: [{ id: "local/small", zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 }, deployments: [{ id: "a", adapter: "openai", baseUrl: "http://127.0.0.1:1/v1", servedModel: "m", attest }] }],
    profiles: { auto: chains(["local/small"]), eco: chains(["local/small"]), premium: chains(["local/small"]) },
  });
  it("ARCH-407: attest accepts nearai only", () => {
    assert.equal(validateCatalog(base("nearai")).models[0].deployments[0].attest, "nearai");
    assert.throws(() => validateCatalog(base("phala")), CatalogError);
    assert.throws(() => validateCatalog(base(true)), CatalogError);
  });
});

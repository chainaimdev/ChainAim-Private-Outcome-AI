/**
 * --expose-entity-counts (adminUI architecture-adminui-jobs.md ARCH-201/202): with the flag on, a chat reply carries
 * x-chainaim-entity-counts (kind -> count, equal to the ledger line of the same decisionId) and x-chainaim-residual;
 * with it off, the reply's headers are exactly today's. Real gateway over real sockets, the stand-in Presidio of the
 * other tests, and a loopback OpenAI-compatible model.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { validateCatalog, type Catalog } from "../src/catalog.ts";
import { parseFlags } from "../src/main.ts";
import { closeServer, ledgerText, listen, post, startTestGateway, type TestGateway } from "./helpers.ts";

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });

function catalogAt(url: string): Catalog {
  return validateCatalog({
    version: "test",
    models: [{ id: "local/small", zone: "local", capabilities: caps, pricing: { inputPerM: 0.01, outputPerM: 0.02 }, deployments: [{ id: "small@0", adapter: "openai", baseUrl: `${url}/v1`, servedModel: "small", healthUrl: `${url}/health` }] }],
    profiles: { auto: chains(["local/small"]), eco: chains(["local/small"]), premium: chains(["local/small"]) },
  });
}

/** Two persons and one email from the synthetic corpus: the stand-in Presidio finds exactly these. */
const PROMPT = "Summarise: Jane Roe and Arjun Mehta wrote from jane.roe@example.com about the invoice.";
const MARKERS = ["Jane Roe", "Arjun Mehta", "jane.roe@example.com"];
/** Today's x-chainaim-* headers on a served, restored chat reply (gateway server.ts chat()). */
const TODAY = ["x-chainaim-attempts", "x-chainaim-classifier", "x-chainaim-data-class", "x-chainaim-decision-id", "x-chainaim-model", "x-chainaim-restored", "x-chainaim-unresolved", "x-chainaim-zone"];

const chainaimHeaders = (r: Response): string[] => [...r.headers.keys()].filter((k) => k.startsWith("x-chainaim-")).sort();

describe("ARCH-202: --expose-entity-counts", () => {
  let presidio: StubPresidio;
  let model: { server: Server; url: string };
  const gateways: TestGateway[] = [];
  before(async () => {
    presidio = await startStubPresidio();
    const server = createServer(async (req, res) => {
      if (req.url === "/health") return void res.writeHead(200).end("{}");
      let raw = "";
      for await (const c of req) raw += c;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: JSON.parse(raw).model, choices: [{ message: { role: "assistant", content: "Done." } }] }));
    });
    model = { server, url: await listen(server) };
  });
  after(async () => {
    await Promise.all(gateways.map((g) => g.close()));
    await closeServer(model.server);
    await presidio.close();
  });
  const start = async (exposeEntityCounts?: boolean) => {
    const g = await startTestGateway({ presidioUrl: presidio.url, catalog: catalogAt(model.url), ...(exposeEntityCounts === undefined ? {} : { exposeEntityCounts }) });
    gateways.push(g);
    return g;
  };
  const ask = (g: TestGateway, content: string) => post(`${g.url}/v1/chat/completions`, { messages: [{ role: "user", content }] });

  it("ARCH-202: headers present and equal to the ledger line's counts for the same decisionId", async () => {
    const g = await start(true);
    const r = await ask(g, PROMPT);
    assert.equal(r.status, 200);
    await r.json();
    const counts = JSON.parse(r.headers.get("x-chainaim-entity-counts") ?? "null");
    assert.deepEqual(counts, { EMAIL_ADDRESS: 1, PERSON: 2 });
    assert.equal(r.headers.get("x-chainaim-residual"), "pass");
    const id = r.headers.get("x-chainaim-decision-id");
    const line = ledgerText(g.ledgerDir).trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.decisionId === id);
    assert.ok(line, "the ledger has the same decisionId");
    assert.deepEqual(counts, line.entityCounts);
  });

  it("ARCH-202: {} when nothing was found", async () => {
    const g = await start(true);
    const r = await ask(g, "What is 2+2?");
    await r.json();
    assert.equal(r.headers.get("x-chainaim-entity-counts"), "{}");
    assert.equal(r.headers.get("x-chainaim-residual"), "pass");
  });

  it("ARCH-202: a residual refusal carries x-chainaim-residual: refused", async () => {
    const g = await start(true);
    const r = await ask(g, "Account 991200345678 is overdue.");
    assert.equal(r.status, 422);
    await r.json();
    assert.equal(r.headers.get("x-chainaim-residual"), "refused");
  });

  it("ARCH-202: a synthetic marker value in the prompt never appears in any header", async () => {
    const g = await start(true);
    const r = await ask(g, PROMPT);
    await r.json();
    const all = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    for (const v of [...MARKERS, ...KNOWN_VALUES.map((k) => k.value)]) assert.ok(!all.includes(v), `header leaks ${v}`);
    assert.doesNotMatch(all, /<\s*[A-Z_]+_\d+\s*>/, "no placeholder in any header");
  });

  it("ARCH-201: gateway reply headers unchanged without --expose-entity-counts", async () => {
    for (const g of [await start(), await start(false)]) {
      const r = await ask(g, PROMPT);
      assert.equal(r.status, 200);
      await r.json();
      assert.deepEqual(chainaimHeaders(r), TODAY);
      const refused = await ask(g, "Account 991200345678 is overdue.");
      assert.equal(refused.status, 422);
      await refused.json();
      assert.equal(refused.headers.get("x-chainaim-residual"), null);
    }
  });

  it("ARCH-202: the flag defaults off and takes on|off only", () => {
    assert.equal(parseFlags([]).exposeEntityCounts, false);
    assert.equal(parseFlags(["--expose-entity-counts", "on"]).exposeEntityCounts, true);
    assert.throws(() => parseFlags(["--expose-entity-counts", "yes"]), /expose-entity-counts/);
  });
});

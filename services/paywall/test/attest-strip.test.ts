/**
 * PLAN-private-ai-nearai-attestation.md ARCH-408: the gateway's provider attestation headers (x-chainaim-provider-id,
 * -served-model, -req-sha256, -resp-sha256) are for the operator's console and its attestation service only. The paywall
 * drops all four from every response it proxies; every other x-chainaim-* header passes back as before. Real paywall over
 * real sockets, the facilitator double of the other tests, and a gateway double that sends the four headers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { NEVER_PASS_BACK } from "../src/app.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator } from "./stubs.ts";

type PaymentRequired = { accepts: Record<string, any>[]; resource: { url: string } };
const decode = (header: string | null): PaymentRequired => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
let n = 0;
const paymentFor = (required: PaymentRequired): string =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: { signedTxBlob: Buffer.from(`attest strip payment ${++n}`).toString("hex").toUpperCase() }, resource: required.resource })).toString("base64");

const ATTEST = ["x-chainaim-provider-id", "x-chainaim-served-model", "x-chainaim-req-sha256", "x-chainaim-resp-sha256"];

describe("ARCH-408: the paywall never forwards attestation evidence", () => {
  const facilitator = stubFacilitator();
  const gateway = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/capacity") return void res.end(JSON.stringify({ chatAvailable: true }));
    res.setHeader("x-chainaim-decision-id", "decision-attest-strip");
    res.setHeader("x-chainaim-model", "nearai/deepseek-v4.1-flash");
    res.setHeader("x-chainaim-zone", "private-cloud");
    res.setHeader("x-chainaim-provider-id", "chatcmpl-strip-0001");
    res.setHeader("x-chainaim-served-model", "deepseek-ai/DeepSeek-V4.1-Flash-1017");
    res.setHeader("x-chainaim-req-sha256", "a".repeat(64));
    res.setHeader("x-chainaim-resp-sha256", "b".repeat(64));
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
  });
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({ XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: await listen(gateway), CHAINAIM_GATEWAY_KEY: "test-gateway-key", FACILITATOR_URL_TESTNET: await listen(facilitator.server), PUBLIC_BASE_URL: "https://pay.example.com" });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway);
    // Same pause as entity-counts-strip.test.ts: a fetch socket still closing aborts Node on Windows under --test-force-exit.
    await new Promise((r) => setTimeout(r, 300));
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${paywall.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("ARCH-408: the strip list names all four attestation headers and keeps the two masking headers", () => {
    for (const h of [...ATTEST, "x-chainaim-entity-counts", "x-chainaim-residual"]) assert.ok(NEVER_PASS_BACK.has(h), h);
  });

  it("ARCH-408: the paid chat response lacks all four and still carries x-chainaim-model", async () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const offer = await post("/v1/chat/completions", body);
    await offer.text();
    const r = await post("/v1/chat/completions", body, { "payment-signature": paymentFor(decode(offer.headers.get("payment-required"))) });
    assert.equal(r.status, 200);
    await r.json();
    for (const h of ATTEST) assert.equal(r.headers.get(h), null, h);
    assert.equal(r.headers.get("x-chainaim-model"), "nearai/deepseek-v4.1-flash");
    assert.equal(r.headers.get("x-chainaim-zone"), "private-cloud");
    assert.equal(r.headers.get("x-chainaim-decision-id"), "decision-attest-strip");
  });
});

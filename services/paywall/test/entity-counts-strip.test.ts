/**
 * adminUI architecture-adminui-jobs.md ARCH-203: the gateway's masking-count headers (--expose-entity-counts) are for
 * the operator's console only. The paywall drops x-chainaim-entity-counts and x-chainaim-residual from every response
 * it proxies; every other x-chainaim-* header passes back as before. Real paywall over real sockets, the facilitator
 * double of the other tests, and a gateway double that sends both headers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { close, listen, PAY_TO, startPaywall, stubFacilitator } from "./stubs.ts";

type PaymentRequired = { accepts: Record<string, any>[]; resource: { url: string } };
const decode = (header: string | null): PaymentRequired => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
let n = 0;
const paymentFor = (required: PaymentRequired): string =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: { signedTxBlob: Buffer.from(`strip test payment ${++n}`).toString("hex").toUpperCase() }, resource: required.resource })).toString("base64");

describe("ARCH-203: the paywall never forwards masking counts", () => {
  const facilitator = stubFacilitator();
  const gateway = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/capacity") return void res.end(JSON.stringify({ chatAvailable: true }));
    res.setHeader("x-chainaim-decision-id", "decision-strip");
    res.setHeader("x-chainaim-model", "local/small");
    res.setHeader("x-chainaim-zone", "local");
    res.setHeader("x-chainaim-entity-counts", JSON.stringify({ PERSON: 2, EMAIL_ADDRESS: 1 }));
    res.setHeader("x-chainaim-residual", "pass");
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
    // Let the fetch client sockets finish closing: under --test-force-exit a socket still closing aborts Node on Windows
    // (libuv "UV_HANDLE_CLOSING", BUILD_LOG 2026-11-04/05); seen here on every run of this short file without it.
    await new Promise((r) => setTimeout(r, 300));
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${paywall.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("ARCH-203: the paid response lacks both headers and still carries x-chainaim-model", async () => {
    for (const [path, body] of [["/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }], ["/v1/privacy/scan", { text: "hi" }]] as const) {
      const offer = await post(path, body);
      await offer.text();
      const required = decode(offer.headers.get("payment-required"));
      const r = await post(path, body, { "payment-signature": paymentFor(required) });
      assert.equal(r.status, 200, path);
      await r.json();
      assert.equal(r.headers.get("x-chainaim-entity-counts"), null, path);
      assert.equal(r.headers.get("x-chainaim-residual"), null, path);
      assert.equal(r.headers.get("x-chainaim-model"), "local/small", path);
      assert.equal(r.headers.get("x-chainaim-zone"), "local", path);
      assert.equal(r.headers.get("x-chainaim-decision-id"), "decision-strip", path);
    }
  });
});

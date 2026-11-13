/**
 * privateAI-design-41 ARCH-696: the gateway's x-chainaim-egress header (--expose-egress on: the destination host, zone,
 * sent-bytes hash and masked counts of a call) is for the operator and the buyer's own console only. The paywall's
 * PASS_BACK pattern would forward any x-chainaim-* header, so NEVER_PASS_BACK names it, and a public caller never receives
 * it. Real paywall over real sockets, the facilitator double of the other tests, and a gateway double that sends it.
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
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: { signedTxBlob: Buffer.from(`egress strip payment ${++n}`).toString("hex").toUpperCase() }, resource: required.resource })).toString("base64");

const EGRESS = JSON.stringify({ v: 1, destination: "cloud-api.near.ai", zone: "private-cloud", sentSha256: "c".repeat(64), sentBytes: 812, masked: { PERSON: 1 }, residual: "pass", dataClass: "PII" });

describe("privateAI-design-41 ARCH-696: the paywall never forwards x-chainaim-egress", () => {
  const facilitator = stubFacilitator();
  const gateway = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/capacity") return void res.end(JSON.stringify({ chatAvailable: true }));
    res.setHeader("x-chainaim-decision-id", "decision-egress-strip");
    res.setHeader("x-chainaim-model", "nearai/deepseek-v4.1-flash");
    res.setHeader("x-chainaim-egress", EGRESS);
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
    // Same pause as attest-strip.test.ts: a fetch socket still closing aborts Node on Windows under --test-force-exit.
    await new Promise((r) => setTimeout(r, 300));
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${paywall.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("ARCH-696: the strip list names x-chainaim-egress and keeps the earlier six", () => {
    for (const h of ["x-chainaim-egress", "x-chainaim-entity-counts", "x-chainaim-residual", "x-chainaim-provider-id", "x-chainaim-served-model", "x-chainaim-req-sha256", "x-chainaim-resp-sha256"]) assert.ok(NEVER_PASS_BACK.has(h), h);
  });

  it("ARCH-696: a paid chat answer to a public caller lacks x-chainaim-egress and still carries x-chainaim-model", async () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const offer = await post("/v1/chat/completions", body);
    await offer.text();
    const r = await post("/v1/chat/completions", body, { "payment-signature": paymentFor(decode(offer.headers.get("payment-required"))) });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.equal(r.headers.get("x-chainaim-egress"), null);
    assert.ok(![...r.headers.values()].some((v) => v.includes("cloud-api.near.ai") || v.includes("c".repeat(64))), "no header value carries it");
    assert.ok(!text.includes("cloud-api.near.ai"), "nor the body");
    assert.equal(r.headers.get("x-chainaim-model"), "nearai/deepseek-v4.1-flash");
    assert.equal(r.headers.get("x-chainaim-decision-id"), "decision-egress-strip");
  });
});

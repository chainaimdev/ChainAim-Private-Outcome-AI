/**
 * ARCH-409 / ARCH-410: the requests ca-attest sends to NEAR AI (src/nearai.ts) and the signature retry rule, against a
 * loopback HTTP server that answers the way docs.near.ai describes (404 or error_code = not available yet). Node built-ins.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { fetchReport, fetchSignature, freshNonce, type NearAiOptions } from "../src/nearai.ts";

const KEY = "nearai-test-key-0123456789";
type Seen = { url: string; headers: IncomingMessage["headers"] };
let seen: Seen[] = [];
/** Answers queued per path prefix; each request takes the next one. */
let queue: { status: number; body: unknown }[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const next = queue.shift() ?? { status: 500, body: { error: "nothing queued" } };
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
beforeEach(() => { seen = []; queue = []; });

const opts = (): NearAiOptions => ({ baseUrl: base, apiKey: KEY, signingAlgo: "ecdsa", timeoutMs: 5000 });
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const GOOD = { text: `${MODEL}:${"a".repeat(64)}:${"b".repeat(64)}`, signature: "0x" + "c".repeat(130), signing_address: "0xfe0071895500a9755c18044948ab4f4e1a7f337e", signing_algo: "ecdsa", signature_kind: "provider_tee" };

describe("ARCH-409 fetchReport", () => {
  it("ARCH-409: model, provider=near, signing_algo, the fresh nonce, x-no-aliasing and the key as Bearer", async () => {
    queue.push({ status: 200, body: { model_attestations: [{ signing_address: GOOD.signing_address }] } });
    const nonce = freshNonce();
    assert.match(nonce, /^[0-9a-f]{64}$/);
    const r = await fetchReport(opts(), MODEL, nonce);
    assert.equal((r.model_attestations ?? []).length, 1);
    const u = new URL(seen[0].url, "http://x");
    assert.equal(u.pathname, "/v1/attestation/report");
    assert.deepEqual([u.searchParams.get("model"), u.searchParams.get("provider"), u.searchParams.get("signing_algo"), u.searchParams.get("nonce")], [MODEL, "near", "ecdsa", nonce]);
    assert.equal(seen[0].headers["x-no-aliasing"], "true");
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  });

  it("ARCH-409: two nonces are never the same", () => {
    assert.notEqual(freshNonce(), freshNonce());
  });

  it("ARCH-409: an HTTP error is thrown with the status and never the key", async () => {
    queue.push({ status: 401, body: { error: "bad key" } });
    await assert.rejects(fetchReport(opts(), MODEL, freshNonce()), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes(KEY));
  });
});

describe("ARCH-410 fetchSignature", () => {
  const retry = { windowMs: 2000, intervalMs: 100 };

  it("ARCH-410: 404 and a 2xx with error_code are 'not yet': retried until the signature arrives", async () => {
    queue.push({ status: 404, body: { detail: "not found" } }, { status: 200, body: { error_code: "signature_not_ready" } }, { status: 200, body: GOOD });
    const s = await fetchSignature(opts(), "chatcmpl-1", MODEL, retry);
    assert.equal(s.available, true);
    if (s.available) assert.deepEqual([s.text, s.signingAddress, s.signingAlgo, s.signatureKind], [GOOD.text, GOOD.signing_address, "ecdsa", "provider_tee"]);
    assert.equal(seen.length, 3);
    const u = new URL(seen[0].url, "http://x");
    assert.equal(u.pathname, "/v1/signature/chatcmpl-1");
    assert.deepEqual([u.searchParams.get("model"), u.searchParams.get("signing_algo")], [MODEL, "ecdsa"]);
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  });

  it("ARCH-410: still not available when the window ends -> unavailable with the last answer", async () => {
    for (let i = 0; i < 40; i++) queue.push({ status: 404, body: {} });
    const s = await fetchSignature(opts(), "chatcmpl-2", MODEL, { windowMs: 350, intervalMs: 100 });
    assert.equal(s.available, false);
    if (!s.available) assert.match(s.reason, /signature not available after 0 s \(HTTP 404\)/);
    assert.ok(seen.length >= 2 && seen.length <= 5, `bounded: ${seen.length} attempts`);
  });

  it("ARCH-410: any other HTTP error stops at once, never retried, never the key", async () => {
    queue.push({ status: 500, body: { error: "boom" } }, { status: 200, body: GOOD });
    const s = await fetchSignature(opts(), "chatcmpl-3", MODEL, retry);
    assert.equal(s.available, false);
    if (!s.available) { assert.match(s.reason, /HTTP 500/); assert.ok(!s.reason.includes(KEY)); }
    assert.equal(seen.length, 1);
  });

  it("ARCH-410: an absent signature_kind is kept absent (null), not guessed", async () => {
    const { signature_kind: _k, ...noKind } = GOOD;
    queue.push({ status: 200, body: noKind });
    const s = await fetchSignature(opts(), "chatcmpl-4", MODEL, retry);
    assert.equal(s.available && s.signatureKind, null);
  });
});

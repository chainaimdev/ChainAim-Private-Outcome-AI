/**
 * PLAN-private-ai-nearai-attestation.md ARCH-411, console side: (1) packages/crossask gatewayChat turns the gateway's four
 * ARCH-408 headers into ChatReply.attest, with calledAt taken before the request; (2) test-console/console/attest.ts asks
 * ca-attest (POST /verify, its real contract: services/attest/src/main.ts) about a quoted job's attested calls, in the
 * background, sending ids and hashes only; ca-attest down never throws and gives "unavailable". Loopback servers stand in
 * for the gateway and for ca-attest; the recorded real ca-attest run is in services/attest (test:official).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { gatewayChat, parseAttestHeaders, type ChatReply } from "../../packages/crossask/src/index.ts";
import { AttestClient, attestConfig, summarize, type JobAttestation } from "../console/attest.ts";

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const H1 = "1".repeat(64), H2 = "2".repeat(64);
const HDRS: Record<string, string> = { "x-chainaim-provider-id": "chatcmpl-abc", "x-chainaim-served-model": MODEL, "x-chainaim-req-sha256": H1, "x-chainaim-resp-sha256": H2 };
const MARKER = "Jane Roe owes 991200345678";
/** Fix 4: the signature evidence ca-attest returns per call (judge.ts evidenceOf). */
const EV_TEXT = `${MODEL}:${H1}:${H2}`;
const EV_SIG = "0x" + "44".repeat(64) + "1b";

const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r())); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
const close = (s: Server) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });

describe("ARCH-411 ChatReply.attest from the gateway's headers", () => {
  it("ARCH-411: all four headers -> evidence; chat id kept only when well-formed", () => {
    const get = (h: Record<string, string>) => (n: string) => h[n] ?? null;
    assert.deepEqual(parseAttestHeaders(get(HDRS), "2026-11-06T14:00:00.000Z"), { chatId: "chatcmpl-abc", servedModel: MODEL, requestSha256: H1, responseSha256: H2, calledAt: "2026-11-06T14:00:00.000Z" });
    const noId = parseAttestHeaders(get({ ...HDRS, "x-chainaim-provider-id": "has spaces" }), "t");
    assert.equal(noId?.chatId, undefined);
    assert.equal(noId?.requestSha256, H1);
  });

  it("ARCH-411: a missing or malformed header -> no evidence at all", () => {
    for (const drop of ["x-chainaim-served-model", "x-chainaim-req-sha256", "x-chainaim-resp-sha256"]) {
      const h = { ...HDRS };
      delete h[drop];
      assert.equal(parseAttestHeaders((n) => h[n] ?? null, "t"), undefined, drop);
    }
    assert.equal(parseAttestHeaders((n) => ({ ...HDRS, "x-chainaim-req-sha256": "ABC" })[n] ?? null, "t"), undefined);
  });

  describe("gatewayChat against a loopback gateway", () => {
    let gw: Server;
    let url = "";
    let withHeaders = true;
    before(async () => {
      gw = createServer(async (req, res) => {
        for await (const _ of req);
        const extra = withHeaders ? HDRS : {};
        res.writeHead(200, { "content-type": "application/json", "x-chainaim-model": "nearai/deepseek-v4.1-flash", "x-chainaim-zone": "private-cloud", ...extra });
        res.end(JSON.stringify({ choices: [{ message: { content: "SELECT 1" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
      });
      url = await listen(gw);
    });
    after(() => close(gw));

    it("ARCH-411: an attested reply carries attest, calledAt taken before the request", async () => {
      withHeaders = true;
      const before = Date.now();
      const r = await gatewayChat({ url, key: "k".repeat(24), timeoutMs: 5000 })([{ role: "user", content: "q" }], "nearai/deepseek-v4.1-flash");
      assert.equal(r.attest?.servedModel, MODEL);
      assert.equal(r.attest?.chatId, "chatcmpl-abc");
      const t = Date.parse(r.attest!.calledAt);
      assert.ok(t >= before - 1 && t <= Date.now());
    });

    it("ARCH-401: a reply without the headers is exactly as before (no attest field)", async () => {
      withHeaders = false;
      const r = await gatewayChat({ url, key: "k".repeat(24), timeoutMs: 5000 })([{ role: "user", content: "q" }], "local/qwen2.5-3b");
      assert.equal("attest" in r, false);
      assert.deepEqual(r.usage, { promptTokens: 10, completionTokens: 3 });
    });
  });
});

describe("ARCH-411 --attest-url", () => {
  it("ARCH-411: off by default; needs --paid-jobs on; checked URL and numbers", () => {
    assert.equal(attestConfig({}, true), undefined);
    assert.equal(attestConfig({ "attest-url": "" }, true), undefined);
    assert.deepEqual(attestConfig({ "attest-url": "http://attest:8770/" }, true), { url: "http://attest:8770", timeoutMs: 20000, keep: 500 });
    assert.throws(() => attestConfig({ "attest-url": "http://attest:8770" }, false), /needs --paid-jobs on/);
    assert.throws(() => attestConfig({ "attest-url": "attest" }, true), /must be a URL/);
    assert.throws(() => attestConfig({ "attest-url": "ftp://x" }, true), /http or https/);
    assert.throws(() => attestConfig({ "attest-url": "http://a", "attest-timeout-ms": "5" }, true), /--attest-timeout-ms/);
  });
});

describe("ARCH-411 AttestClient against a loopback ca-attest", () => {
  let svc: Server;
  let url = "";
  let bodies: string[] = [];
  /** What the loopback ca-attest answers for each call, in order; or an HTTP status to fail with. */
  let answer: { status: "verified" | "unverified" | "unavailable"; reason: string | null }[] | number = [];
  before(async () => {
    svc = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      bodies.push(raw);
      if (typeof answer === "number") { res.writeHead(answer, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "boom" })); }
      const calls = (JSON.parse(raw) as { calls: { chatId?: string; servedModel: string }[] }).calls;
      const list = answer;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: calls.map((c, i) => ({ chatId: c.chatId ?? null, servedModel: c.servedModel, status: list[i].status, reason: list[i].reason, signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: "0xfe0071895500a9755c18044948ab4f4e1a7f337e", reportFetchedAt: "2026-11-06T13:50:00.000Z", tdx: true, gpu: true, signature: true, hashes: true, signedText: EV_TEXT, signatureHex: EV_SIG })) }));
    });
    url = await listen(svc);
  });
  after(() => close(svc));
  beforeEach(() => { bodies = []; answer = []; });

  const attested = (i: number): ChatReply => ({ text: `${MARKER} reply ${i}`, model: "nearai/deepseek-v4.1-flash", attest: { chatId: `chatcmpl-${i}`, servedModel: MODEL, requestSha256: H1, responseSha256: H2, calledAt: "2026-11-06T14:00:00.000Z" } });
  const local: ChatReply = { text: `${MARKER} local`, model: "local/qwen2.5-3b" };
  const client = (u = url, onDone?: (a: JobAttestation) => void, keep = 500) => new AttestClient({ url: u, timeoutMs: 3000, keep }, () => undefined, onDone);

  it("ARCH-411: a NEAR AI job: pending at once, then verified; the posted body holds ids and hashes only", async () => {
    answer = [{ status: "verified", reason: null }, { status: "verified", reason: null }];
    const done: JobAttestation[] = [];
    const c = client(url, (a) => done.push(a));
    c.start("job1", [attested(0), attested(1)]);
    assert.equal(c.get("job1")?.summary, "pending");
    await c.idle();
    const a = c.get("job1")!;
    assert.equal(a.summary, "verified");
    assert.deepEqual(a.calls.map((x) => [x.index, x.status, x.chatId]), [[0, "verified", "chatcmpl-0"], [1, "verified", "chatcmpl-1"]]);
    assert.deepEqual(a.calls.map((x) => [x.signedText, x.signatureHex]), [[EV_TEXT, EV_SIG], [EV_TEXT, EV_SIG]], "fix 4: ca-attest's evidence is kept");
    assert.equal(done.length, 1);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0].includes("Jane Roe") && !bodies[0].includes("991200345678"), "no text reaches ca-attest");
    assert.deepEqual(Object.keys(JSON.parse(bodies[0]).calls[0]).sort(), ["calledAt", "chatId", "requestSha256", "responseSha256", "servedModel"]);
  });

  it("ARCH-411: calls without evidence are not_applicable and never sent; a job with none sends nothing", async () => {
    answer = [{ status: "verified", reason: null }];
    const c = client();
    c.start("job2", [local, attested(1)]);
    await c.idle();
    assert.deepEqual(c.get("job2")!.calls.map((x) => x.status), ["not_applicable", "verified"]);
    assert.equal(JSON.parse(bodies[0]).calls.length, 1);
    bodies = [];
    c.start("job3", [local]);
    await c.idle();
    assert.equal(c.get("job3")!.summary, "not_applicable");
    assert.equal(bodies.length, 0);
  });

  it("ARCH-411: ca-attest down, or answering an error, never throws: the attested calls are unavailable with the reason", async () => {
    const down = client("http://127.0.0.1:1");
    down.start("job4", [attested(0), local]);
    await down.idle();
    const a = down.get("job4")!;
    assert.equal(a.summary, "unavailable");
    assert.deepEqual(a.calls.map((x) => [x.status, x.reason]), [["unavailable", "attest service: unreachable"], ["not_applicable", null]]);
    assert.deepEqual([a.calls[0].signedText, a.calls[0].signatureHex], [null, null], "fix 4: no evidence without an answer");
    answer = 500;
    const c = client();
    c.start("job5", [attested(0)]);
    await c.idle();
    assert.equal(c.get("job5")!.calls[0].reason, "attest service: HTTP 500");
  });

  it("ARCH-411: summary rules: all verified / some / none, unverified beats unavailable", () => {
    const call = (status: "verified" | "unverified" | "unavailable" | "not_applicable") => ({ index: 0, model: null, status, reason: null, servedModel: null, chatId: null, signatureKind: null, signingAlgo: null, signingAddress: null, reportFetchedAt: null, tdx: null, gpu: null, signature: null, hashes: null, signedText: null, signatureHex: null });
    assert.equal(summarize([call("verified"), call("not_applicable")]), "verified");
    assert.equal(summarize([call("verified"), call("unavailable")]), "partly");
    assert.equal(summarize([call("unavailable"), call("unverified")]), "unverified");
    assert.equal(summarize([call("unavailable")]), "unavailable");
    assert.equal(summarize([call("not_applicable")]), "not_applicable");
  });

  it("ARCH-411: results are kept in memory up to --attest-keep, oldest dropped first", async () => {
    answer = [{ status: "verified", reason: null }];
    const c = client(url, undefined, 2);
    for (const id of ["a", "b", "c"]) { c.start(id, [attested(0)]); await c.idle(); }
    assert.equal(c.get("a"), undefined);
    assert.equal(c.get("c")?.summary, "verified");
  });
});

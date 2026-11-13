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
import { AttestClient, attestConfig, payOnlyAttestedConfig, privacyProven, summarize, type JobAttestation } from "../console/attest.ts";

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

describe("privateAI-design-39 ARCH-685 --pay-only-attested", () => {
  it("ARCH-685: evidence by default; off / verified accepted; verified needs --attest-url; deadline 1000..240000", () => {
    assert.deepEqual(payOnlyAttestedConfig({}, false), { mode: "evidence", deadlineMs: 30000 });
    assert.deepEqual(payOnlyAttestedConfig({ "pay-only-attested": "off" }, false), { mode: "off", deadlineMs: 30000 });
    assert.deepEqual(payOnlyAttestedConfig({ "pay-only-attested": "verified", "pay-only-attested-deadline-ms": "1000" }, true), { mode: "verified", deadlineMs: 1000 });
    assert.throws(() => payOnlyAttestedConfig({ "pay-only-attested": "verified" }, false), /--pay-only-attested verified needs --attest-url/);
    assert.throws(() => payOnlyAttestedConfig({ "pay-only-attested": "strict" }, true), /must be off, evidence or verified, got strict/);
    for (const bad of ["999", "240001", "1.5", "x"]) assert.throws(() => payOnlyAttestedConfig({ "pay-only-attested-deadline-ms": bad }, true), /--pay-only-attested-deadline-ms must be a whole number from 1000 to 240000/, bad);
  });
});

describe("privateAI-design-39 ARCH-686 AttestClient.verifyNow against a loopback ca-attest", () => {
  let svc: Server;
  let url = "";
  let delayMs = 0;
  let status: "verified" | "unverified" = "verified";
  before(async () => {
    svc = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const calls = (JSON.parse(raw) as { calls: { chatId?: string; servedModel: string }[] }).calls;
      await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: calls.map((c) => ({ chatId: c.chatId ?? null, servedModel: c.servedModel, status, reason: status === "verified" ? null : "signature mismatch", signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: "0xfe0071895500a9755c18044948ab4f4e1a7f337e", reportFetchedAt: "2026-11-13T10:00:00.000Z", tdx: true, gpu: true, signature: status === "verified", hashes: true, signedText: EV_TEXT, signatureHex: EV_SIG })) }));
    });
    url = await listen(svc);
  });
  after(() => close(svc));
  beforeEach(() => { delayMs = 0; status = "verified"; });

  const attested = (i: number): ChatReply => ({ text: `${MARKER} reply ${i}`, model: "nearai/deepseek-v4.1-flash", attest: { chatId: `chatcmpl-${i}`, servedModel: MODEL, requestSha256: H1, responseSha256: H2, calledAt: "2026-11-13T10:00:00.000Z" } });
  const local: ChatReply = { text: `${MARKER} local`, model: "local/qwen2.5-3b" };

  it("ARCH-686: verifyNow resolves the verdict, stores it and logs job_attested; onDone waits for announce()", async () => {
    const lines: string[] = [];
    const done: JobAttestation[] = [];
    const c = new AttestClient({ url, timeoutMs: 3000, keep: 500 }, (l) => lines.push(l), (a) => done.push(a));
    const a = await c.verifyNow("v1", [attested(0), attested(1)], 5000);
    assert.equal(a.summary, "verified");
    assert.equal(c.get("v1")?.summary, "verified", "stored: the receipt and GET /jobs/<id>/attestation read it");
    assert.equal(lines.filter((l) => l.includes('"event":"job_attested"') && l.includes('"jobId":"v1"')).length, 1);
    assert.equal(done.length, 0, "the job feed is told only once the job is quoted");
    c.announce("v1");
    assert.deepEqual(done.map((d) => [d.jobId, d.summary]), [["v1", "verified"]]);
    status = "unverified";
    assert.equal((await c.verifyNow("v2", [attested(0)], 5000)).summary, "unverified");
  });

  it("ARCH-686: job_attested logs durationMs, from asking ca-attest to its verdict (verifyNow and start)", async () => {
    let clock = 1_000;
    const lines: string[] = [];
    const c = new AttestClient({ url, timeoutMs: 3000, keep: 500 }, (l) => lines.push(l), undefined, () => (clock += 250));
    await c.verifyNow("d1", [attested(0)], 5000);
    c.start("d2", [attested(1)]);
    await c.idle();
    const dur = (id: string) => JSON.parse(lines.find((l) => l.includes(`"jobId":"${id}"`) && l.includes('"event":"job_attested"'))!).durationMs;
    // The injected clock moves 250 ms per read: the start read, the verdict's "at", then the log's own read.
    assert.equal(dur("d1"), 500);
    assert.equal(dur("d2"), 500);
  });

  it("ARCH-686: past the deadline verifyNow resolves pending without throwing; the late verdict is still stored and logged", async () => {
    delayMs = 600;
    const lines: string[] = [];
    const c = new AttestClient({ url, timeoutMs: 3000, keep: 500 }, (l) => lines.push(l));
    const t0 = Date.now();
    const a = await c.verifyNow("late", [attested(0)], 100);
    assert.ok(Date.now() - t0 < 500, "answered at the deadline, not when ca-attest did");
    assert.equal(a.summary, "pending");
    c.announce("late");
    await c.idle();
    assert.equal(c.get("late")?.summary, "verified", "the real verdict replaces pending (the job feed shows it)");
    assert.ok(lines.some((l) => l.includes('"jobId":"late"') && l.includes('"summary":"verified"')));
  });

  it("ARCH-686: ca-attest down -> unavailable; start() is unchanged (still never awaited, onDone still called)", async () => {
    const down = new AttestClient({ url: "http://127.0.0.1:1", timeoutMs: 3000, keep: 500 }, () => undefined);
    assert.equal((await down.verifyNow("d1", [attested(0)], 5000)).summary, "unavailable");
    const done: JobAttestation[] = [];
    const c = new AttestClient({ url, timeoutMs: 3000, keep: 500 }, () => undefined, (x) => done.push(x));
    c.start("s1", [attested(0)]);
    assert.equal(c.get("s1")?.summary, "pending");
    await c.idle();
    assert.deepEqual(done.map((d) => d.summary), ["verified"]);
  });

  it("ARCH-687: privacyProven needs a verified verdict and evidence on every call (a mixed or empty job is not proven)", async () => {
    const c = new AttestClient({ url, timeoutMs: 3000, keep: 500 }, () => undefined);
    const all = [attested(0), attested(1)];
    assert.equal(privacyProven(await c.verifyNow("p1", all, 5000), all), true);
    const mixed = [local, attested(1)];
    const m = await c.verifyNow("p2", mixed, 5000);
    assert.equal(m.summary, "verified", "summarize ignores the local call");
    assert.equal(privacyProven(m, mixed), false, "but a local call in the job means privacy is not proven");
    assert.equal(privacyProven(await c.verifyNow("p3", [], 5000), []), false);
    status = "unverified";
    assert.equal(privacyProven(await c.verifyNow("p4", all, 5000), all), false);
  });
});

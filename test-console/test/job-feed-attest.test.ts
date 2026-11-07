/**
 * job_attested from the console to near-watch (test-console/console/job-feed.ts attestedEvent / JobFeed.attested;
 * PLAN-private-ai-nearai-attestation.md ARCH-411, chainaim-adminUI-NEAR ARCH-501..503). The builder is checked on its own,
 * then against the REAL near-watch parser and store (near-watch-server.ts): the event must be accepted (near-watch refuses
 * unknown fields and out-of-bound values) and stored with the summary near-watch names.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { JobFeed, SUMMARY_TO_WATCH, attestMetaOf, attestedEvent, watchReason, type AttestMeta } from "../console/job-feed.ts";
import type { CallAttestation, JobAttestation } from "../console/attest.ts";
import { quoteJob, type Fees } from "../../packages/crossask/src/cost.ts";
import type { CrossAskResult } from "../../packages/crossask/src/index.ts";
import { INGEST_KEY, nearWatchSkip, startNearWatch, type NearWatch } from "./near-watch-server.ts";

const MODEL = "nearai/deepseek-v4.1-flash";
const SERVED = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const FEES: Fees = { perModelCallUsd: "0.001", analystUsd: "0.002", nearGasUsd: "0.0005", marginPct: "20", minPriceUsd: "0.01" };
const PRICES = { [MODEL]: { inputPerM: 0.3, outputPerM: 1.2 } };
const RESULT: CrossAskResult = {
  question: "q", schema: "s", relations: [], attempts: [{ sql: "SELECT 1" }], sql: "SELECT 1",
  result: { columns: ["n"], rows: [{ n: 1 }], truncated: false }, answer: "1", unverified: [], warnings: [], derivations: {},
  served: [
    { text: "```sql\nSELECT 1\n```", model: MODEL, zone: "private-cloud", usage: { promptTokens: 654, completionTokens: 772 } },
    { text: "1", model: MODEL, zone: "private-cloud", usage: { promptTokens: 187, completionTokens: 195 } },
  ],
  sentToModel: [], timings: { relationsMs: 586, queryMs: 17700, sqlMs: 370, answerMs: 4600, callsMs: [17700, 4600], files: 3 },
};
const quote = quoteJob(RESULT.served.map((s) => ({ model: s.model!, promptTokens: s.usage!.promptTokens, completionTokens: s.usage!.completionTokens })), PRICES, FEES);
const ID = (n: number) => n.toString(16).padStart(32, "b");
const NETWORK = "near:testnet";
const SIGNER = "0x" + "ab".repeat(20);
const TS = "2026-11-07T02:19:00.000Z";

const verifiedCall = (index: number): CallAttestation => ({
  index, model: MODEL, status: "verified", reason: null, servedModel: SERVED, chatId: `chatcmpl-${index}abc`, signatureKind: "provider_tee",
  signingAlgo: "ecdsa", signingAddress: SIGNER, reportFetchedAt: "2026-11-07T02:10:00.000Z", tdx: true, gpu: true, signature: true, hashes: true,
});
const att = (jobId: string, summary: JobAttestation["summary"], calls: CallAttestation[]): JobAttestation => ({ jobId, summary, at: TS, calls });
const meta: AttestMeta = attestMetaOf(NETWORK, RESULT, quote);

describe("ARCH-411/501: job_attested is built in near-watch's shape", () => {
  test("the call list comes from the quoted job's steps: query then answer, priced model ids", () => {
    assert.deepEqual(meta, { network: NETWORK, calls: [{ step: "query", model: MODEL }, { step: "answer", model: MODEL }] });
  });
  test("every console summary maps to near-watch's name; pending is not sent", () => {
    assert.deepEqual(SUMMARY_TO_WATCH, { verified: "attested", partly: "partial", unverified: "unverified", unavailable: "unavailable", not_applicable: "not_applicable" });
    assert.equal(attestedEvent(att(ID(1), "pending", [verifiedCall(0), verifiedCall(1)]), meta), null);
  });
  test("a verified job: summary attested, each call field for field, the report time as ISO", () => {
    const e = attestedEvent(att(ID(2), "verified", [verifiedCall(0), verifiedCall(1)]), meta, Date.parse(TS));
    assert.ok(e && e.event === "job_attested");
    if (!e || e.event !== "job_attested") return;
    assert.deepEqual([e.v, e.ts, e.jobId, e.network, e.summary], [1, TS, ID(2), NETWORK, "attested"]);
    assert.deepEqual(Object.keys(e.calls[0]).sort(), ["gpu", "hashes", "model", "providerId", "reason", "reportFetchedAt", "servedModel", "signature", "signatureKind", "signingAddress", "signingAlgo", "status", "step", "tdx"]);
    assert.deepEqual(e.calls.map((c) => c.step), ["query", "answer"]);
    assert.deepEqual(e.calls[1], { step: "answer", model: MODEL, servedModel: SERVED, providerId: "chatcmpl-1abc", signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: SIGNER, reportFetchedAt: "2026-11-07T02:10:00.000Z", tdx: true, gpu: true, signature: true, hashes: true, status: "verified", reason: null });
  });
  test("values near-watch would refuse are sent as null, never dropping the event; reasons become one printable line of at most 200", () => {
    const odd: CallAttestation = { ...verifiedCall(0), status: "unverified", chatId: "x".repeat(150), signatureKind: "weird", signingAlgo: "rsa", signingAddress: "nope", reportFetchedAt: "not a time", reason: "bad\nlineé " + "r".repeat(300) };
    const e = attestedEvent(att(ID(3), "partly", [odd, verifiedCall(1)]), meta);
    assert.ok(e && e.event === "job_attested");
    if (!e || e.event !== "job_attested") return;
    assert.equal(e.summary, "partial");
    assert.deepEqual([e.calls[0].providerId, e.calls[0].signatureKind, e.calls[0].signingAlgo, e.calls[0].signingAddress, e.calls[0].reportFetchedAt], [null, null, null, null, null]);
    assert.match(e.calls[0].reason!, /^[\x20-\x7E]{1,200}$/);
    assert.equal(watchReason("   "), null);
    assert.equal(watchReason(null), null);
  });
  test("an attestation whose call count differs from the job is refused (a console bug, never sent)", () => {
    assert.throws(() => attestedEvent(att(ID(4), "verified", [verifiedCall(0)]), meta), /1 call\(s\), the job 2/);
  });
});

describe("ARCH-501..503: the REAL near-watch accepts and stores what the console sends", { skip: nearWatchSkip() }, () => {
  let nw: NearWatch;
  before(async () => { nw = await startNearWatch(); });
  after(async () => { await nw?.close(); });
  const feedOn = (logs: string[], at = "2026-11-07T02:20:00Z") => new JobFeed({ url: nw.ingestUrl, key: INGEST_KEY, keyEnv: "X", timeoutMs: 5000, maxInflight: 10, expiryCheckSec: 30 }, (l) => logs.push(l), () => Date.parse(at));
  const job = (jobId: string) => ({ jobId, network: NETWORK, expiresAt: Date.parse("2026-11-07T02:33:52Z"), out: RESULT, quote });
  const stored = (jobId: string) => (nw.store as unknown as { getAttestation(id: string): { summary: string; calls: { step: string; status: string; providerId: string | null }[] } | undefined }).getAttestation(jobId);

  test("quoted then attested (verified): stored as attested with both calls, nothing refused", async () => {
    const logs: string[] = [];
    const feed = feedOn(logs);
    feed.quoted(job(ID(10)));
    feed.attested(att(ID(10), "verified", [verifiedCall(0), verifiedCall(1)]));
    await feed.idle();
    assert.deepEqual(logs, []);
    assert.equal(nw.liveOps.counters.refused, 0);
    const a = stored(ID(10));
    assert.equal(a?.summary, "attested");
    assert.deepEqual(a?.calls.map((c) => [c.step, c.status, c.providerId]), [["query", "verified", "chatcmpl-0abc"], ["answer", "verified", "chatcmpl-1abc"]]);
  });
  test("unavailable (signature not ready) is accepted as its own summary, then a later verified result replaces it", async () => {
    const feed = feedOn([]);
    const waiting: CallAttestation = { ...verifiedCall(0), status: "unavailable", reason: "signature not available after 30 s (HTTP 404)", signature: null, hashes: null, tdx: null, gpu: null, reportFetchedAt: null, signingAddress: null, signingAlgo: null, signatureKind: null };
    feed.quoted(job(ID(11)));
    feed.attested({ ...att(ID(11), "unavailable", [waiting, { ...waiting, index: 1, chatId: "chatcmpl-1abc" }]), at: TS });
    await feed.idle();
    assert.equal(stored(ID(11))?.summary, "unavailable");
    assert.equal(nw.liveOps.counters.refused, 0);
    // The re-check (later timestamp) replaces it; near-watch keeps the newest per job.
    const later = feedOn([], "2026-11-07T02:25:00Z");
    later.quoted(job(ID(11)));
    later.attested(att(ID(11), "verified", [verifiedCall(0), verifiedCall(1)]));
    await later.idle();
    assert.equal(stored(ID(11))?.summary, "attested");
  });
  test("an attestation for a job this console never quoted is not sent, and the reason is logged without text", async () => {
    const logs: string[] = [];
    const feed = feedOn(logs);
    feed.attested(att(ID(12), "verified", [verifiedCall(0), verifiedCall(1)]));
    await feed.idle();
    assert.equal(stored(ID(12)), undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /"event":"job_feed_failed".*no job_quoted for this job/);
  });
});

/**
 * ARCH-409 / ARCH-410 on RECORDED REAL data: test/fixtures/nearai-recorded.json, written by scripts/record-fixture.ts from
 * one live NEAR AI call (report fetched before the call, the call's byte hashes, its signature). Uses the official verifier
 * as the image builds it (NEARAI_VERIFIER_DIR, default /opt/nearai-cloud-verifier), so run it inside the ca-attest image:
 *   docker compose run --rm --entrypoint npm attest run test:official
 * The TDX check fetches Intel PCS collateral (network). The GPU check is not replayed here (NRAS judges live evidence);
 * the live run (ARCH-414) covers it with --gpu-check on.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { judgeCall, type ReportFetch } from "../src/judge.ts";
import { Attestor, createAttestServer, type AttestConfig } from "../src/main.ts";
import { freshNonce } from "../src/nearai.ts";
import { checkAttestation, loadOfficial, recover, type Official } from "../src/official.ts";

const FIXTURE = new URL("./fixtures/nearai-recorded.json", import.meta.url);
const DIR = process.env.NEARAI_VERIFIER_DIR ?? "/opt/nearai-cloud-verifier";

type Fixture = {
  model: string;
  report: { nonce: string; fetchedAt: string; raw: { model_attestations: Record<string, unknown>[] } };
  call: { chatId: string; servedModel: string; requestSha256: string; responseSha256: string; calledAt: string };
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind: string | null };
};

let fx: Fixture;
let official: Official;
let recordedFetch: ReportFetch;
const OPTS = () => ({ signingAlgo: "ecdsa", attestedModels: [fx.model] });
const sigOf = (f: Fixture) => ({ available: true as const, text: f.signature.text, signature: f.signature.signature, signingAddress: f.signature.signing_address, signingAlgo: f.signature.signing_algo, signatureKind: f.signature.signature_kind });

before(async () => {
  assert.ok(existsSync(FIXTURE), "test/fixtures/nearai-recorded.json is missing: record it once (MANUAL_SETUP.md, NEAR AI attestation, step 'record the fixture')");
  fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  official = await loadOfficial(DIR);
  const attestations = [];
  for (const a of fx.report.raw.model_attestations) attestations.push(await checkAttestation(official, a, fx.model, fx.report.nonce, false));
  recordedFetch = { model: fx.model, nonce: fx.report.nonce, fetchedAt: fx.report.fetchedAt, attestations };
});

describe("ARCH-409 the recorded report through the official verifier", () => {
  it("ARCH-409: the fixture is a provider_tee call recorded after its report, with no text in it", () => {
    assert.equal(fx.signature.signature_kind, "provider_tee");
    assert.ok(Date.parse(fx.report.fetchedAt) < Date.parse(fx.call.calledAt));
    const raw = readFileSync(FIXTURE, "utf8");
    assert.ok(!raw.includes("Reply with the single word"), "the prompt is not in the fixture");
    assert.ok(!/"choices"\s*:/.test(raw), "the completion is not in the fixture");
  });

  it("ARCH-409: the signer's attestation verifies: TDX quote, report_data binds signer and nonce, compose hash in mr_config", () => {
    const signer = fx.signature.signing_address.toLowerCase();
    const mine = recordedFetch.attestations.filter((a) => a.signingAddress === signer);
    assert.equal(mine.length, 1, "exactly one attestation carries the reply's signer");
    const a = mine[0];
    assert.deepEqual(a.reasons, []);
    assert.equal(a.verified, true);
    assert.deepEqual([a.checks.tdxVerified, a.checks.bindsAddress, a.checks.embedsNonce, a.checks.composeMatchesMrConfig, a.checks.modelNameMatches], [true, true, true, true, true]);
  });

  it("ARCH-409: the same report against another nonce fails the nonce binding (the nonce is really checked)", async () => {
    const signer = fx.signature.signing_address.toLowerCase();
    const att = fx.report.raw.model_attestations.find((a) => String(a.signing_address).toLowerCase() === signer)!;
    const r = await checkAttestation(official, att, fx.model, freshNonce(), false);
    assert.equal(r.checks.embedsNonce, false);
    assert.equal(r.verified, false);
    assert.match(r.reasons.join("; "), /does not hold the request nonce/);
  });
});

describe("ARCH-410 the recorded call", () => {
  it("ARCH-410: EIP-191 recovery (official recoverSigner) gives the signing address", () => {
    assert.equal(recover(official, fx.signature.text, fx.signature.signature)?.toLowerCase(), fx.signature.signing_address.toLowerCase());
  });

  it("ARCH-410: the recorded call is verified against the report that arrived before it", () => {
    const r = judgeCall(fx.call, sigOf(fx), recover(official, fx.signature.text, fx.signature.signature), [recordedFetch], OPTS());
    assert.equal(r.status, "verified", r.reason ?? "");
    assert.deepEqual([r.hashes, r.signature, r.tdx], [true, true, true]);
    assert.equal(r.reportFetchedAt, fx.report.fetchedAt);
  });

  it("ARCH-410: one changed byte -> unverified: hash mismatch", () => {
    const flip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);
    const r = judgeCall({ ...fx.call, responseSha256: flip(fx.call.responseSha256) }, sigOf(fx), recover(official, fx.signature.text, fx.signature.signature), [recordedFetch], OPTS());
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /^hash mismatch/);
  });

  it("ARCH-410: the same report, had it arrived after the call, is not used", () => {
    const late = { ...recordedFetch, fetchedAt: new Date(Date.parse(fx.call.calledAt) + 1000).toISOString() };
    const r = judgeCall(fx.call, sigOf(fx), recover(official, fx.signature.text, fx.signature.signature), [late], OPTS());
    assert.equal(r.status, "unavailable");
  });

  it("ARCH-410: a signature with one changed character does not recover to the signer", () => {
    const s = fx.signature.signature;
    const changed = s.slice(0, 10) + (s[10] === "a" ? "b" : "a") + s.slice(11);
    const r = judgeCall(fx.call, sigOf(fx), recover(official, fx.signature.text, changed), [recordedFetch], OPTS());
    assert.equal(r.status, "unverified");
    assert.match(r.reason!, /does not recover|could not be recovered/);
  });
});

describe("ARCH-409 / ARCH-410 the service routes, replaying the recorded signature", () => {
  let replay: Server;
  let attest: Server;
  let url = "";
  const port = (s: Server) => (s.address() as AddressInfo).port;
  before(async () => {
    // Answers GET /v1/signature/<recorded chat id> with the recorded payload, as NEAR AI did.
    replay = createServer((req, res) => {
      const ok = (req.url ?? "").startsWith(`/v1/signature/${encodeURIComponent(fx.call.chatId)}`);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? fx.signature : { detail: "not found" }));
    });
    await new Promise<void>((r) => replay.listen(0, "127.0.0.1", () => r()));
    const cfg: AttestConfig = {
      host: "127.0.0.1", port: 0, allowedHosts: null,
      nearai: { baseUrl: `http://127.0.0.1:${port(replay)}/v1`, apiKey: "replay-key-not-sent-anywhere-else", signingAlgo: "ecdsa", timeoutMs: 5000 },
      models: [fx.model], refreshMs: 900_000, historyKeep: 8, signatureWindowMs: 500, signatureIntervalMs: 100, gpuRequired: false, maxCalls: 4, verifierDir: DIR, verifierLog: false,
    };
    const attestor = new Attestor(cfg, official);
    attestor.addFetch(recordedFetch);
    attest = createAttestServer(cfg, attestor);
    await new Promise<void>((r) => attest.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${port(attest)}`;
  });
  after(async () => {
    for (const s of [attest, replay]) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  });
  const post = (body: unknown) => fetch(`${url}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("ARCH-410: POST /verify returns verified for the recorded call and unavailable for an unknown chat id", async () => {
    const r = await post({ calls: [fx.call, { ...fx.call, chatId: "chatcmpl-unknown" }] });
    assert.equal(r.status, 200);
    const { results } = (await r.json()) as { results: { status: string; chatId: string; reason: string | null }[] };
    assert.equal(results[0].status, "verified", results[0].reason ?? "");
    assert.equal(results[1].status, "unavailable");
    assert.match(results[1].reason!, /signature not available/);
  });

  it("ARCH-410: a malformed body is 400 and names the field; too many calls is 400", async () => {
    const bad = await post({ calls: [{ ...fx.call, requestSha256: "x" }] });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /requestSha256/);
    const many = await post({ calls: Array.from({ length: 5 }, () => fx.call) });
    assert.equal(many.status, 400);
    assert.match(((await many.json()) as { error: string }).error, /at most 4/);
  });

  it("ARCH-409: /healthz and /reports answer; /reports holds checks and reasons, not the quotes", async () => {
    const h = (await (await fetch(`${url}/healthz`)).json()) as { ok: boolean; ready: boolean; models: string[] };
    assert.deepEqual([h.ok, h.ready, h.models], [true, true, [fx.model]]);
    const text = await (await fetch(`${url}/reports`)).text();
    const intelQuote = String(fx.report.raw.model_attestations[0].intel_quote ?? "");
    assert.ok(intelQuote.length > 100 && !text.includes(intelQuote.slice(0, 100)), "no quote in /reports");
    assert.match(text, new RegExp(fx.signature.signing_address.toLowerCase()));
  });
});

describe("ARCH-409 the Host check", () => {
  it("ARCH-409: with --allowed-hosts, another Host gets 403 before anything else", async () => {
    const cfg: AttestConfig = {
      host: "127.0.0.1", port: 0, allowedHosts: ["attest:8770"],
      nearai: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused-key-for-host-check-only", signingAlgo: "ecdsa", timeoutMs: 1000 },
      models: [fx.model], refreshMs: 900_000, historyKeep: 8, signatureWindowMs: 0, signatureIntervalMs: 100, gpuRequired: true, maxCalls: 4, verifierDir: DIR, verifierLog: false,
    };
    const s = createAttestServer(cfg, new Attestor(cfg, official));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/healthz`);
      assert.equal(r.status, 403);
    } finally {
      await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
    }
  });
});

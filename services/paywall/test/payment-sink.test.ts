/**
 * The payment log sink (live ops, Phase 2): off by default with the
 * payment_settled line unchanged; when on, the line gains the invoice id and is
 * handed on without holding up the paid response, by HTTP (with the ingest key)
 * and/or a file. No ARCH-ID yet: named LW2-SINK.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Wallet } from "xrpl";
import type { LedgerRequest } from "../../web/src/balance.ts";
import { runTenant, type CallRecord, type Tenant } from "../scripts/rig-core.ts";
import { seedBuyer } from "../scripts/xrpl.ts";
import { loadConfig } from "../src/config.ts";
import { createSink, type PaymentSink } from "../src/sink.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const KEY = "ingest-key-0123456789abcdef";
const BASE_ENV = { XRPL_PAY_TO_TESTNET: PAY_TO, CHAINAIM_GATEWAY_KEY: "test-key" };

const ledger: LedgerRequest = async (command) =>
  ({
    server_info: { info: { network_id: 1 } },
    account_info: { account_data: { Sequence: 41, Balance: "25000000" } },
    fee: { drops: { open_ledger_fee: "12" } },
    ledger: { ledger_index: 9_000_000 },
  })[command] as Record<string, unknown>;

const tenant: Tenant = { id: "t01", name: "Test", seedPrefix: "X", queries: ["Invoice overdue. Contact: priya.vq@loomtest.example"] };
const buyer = () => seedBuyer({ networkName: "testnet", network: "xrpl:1", wsUrl: "wss://unused.example", wallet: Wallet.generate() });

/** A stand-in for ledger-watch's /ingest/claim: records what arrives; can hang. */
function ingestStub(): { server: Server; got: { key: string | undefined; body: string }[]; hang: { on: boolean } } {
  const got: { key: string | undefined; body: string }[] = [];
  const hang = { on: false };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    got.push({ key: req.headers["x-ingest-key"] as string | undefined, body });
    if (hang.on) return; // never answers
    res.writeHead(202, { "content-type": "application/json" });
    res.end('{"accepted":1}');
  });
  return { server, got, hang };
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("payment log sink", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let env: Record<string, string>;
  before(async () => {
    env = { ...BASE_ENV, GATEWAY_URL: await listen(gateway.server), FACILITATOR_URL_TESTNET: await listen(facilitator.server) };
  });
  after(async () => {
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("LW2-SINK off by default: the payment_settled line is exactly as before (no invoiceId)", async () => {
    assert.equal(loadConfig(env).paymentLog, undefined);
    const lines: string[] = [];
    const paywall = await startPaywall(env, (l) => lines.push(l));
    try {
      await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: 1, intervalMs: 0, maxSpend: "0.2", maxTokens: 256 }, { write: () => {}, ledger });
    } finally {
      await paywall.close();
    }
    const settled = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "payment_settled");
    assert.equal(settled.length, 1);
    assert.deepEqual(Object.keys(settled[0]), ["ts", "event", "route", "amount", "asset", "network", "payer", "transaction"]);
  });

  it("LW2-SINK on: the line carries the call's invoiceId and the same line goes to the sink", async () => {
    const lines: string[] = [];
    const sent: string[] = [];
    const sink: PaymentSink = { send: (l) => void sent.push(l), stats: () => ({ sent: 0, failed: 0, dropped: 0, written: 0, writeErrors: 0 }), close: async () => {} };
    const paywall = await startPaywall(env, (l) => lines.push(l), { sink });
    const records: CallRecord[] = [];
    try {
      await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: 2, intervalMs: 0, maxSpend: "0.2", maxTokens: 256 }, { write: (r) => records.push(r), ledger });
    } finally {
      await paywall.close();
    }
    assert.equal(sent.length, 2);
    const logged = lines.filter((l) => l.includes('"payment_settled"'));
    assert.deepEqual(sent, logged, "stdout and the sink get the same line");
    const parsed = sent.map((l) => JSON.parse(l) as { invoiceId?: string; transaction: string });
    assert.match(parsed[0].invoiceId ?? "", /^[0-9A-F]{32}$/);
    assert.notEqual(parsed[0].invoiceId, parsed[1].invoiceId, "one invoice per call");
    assert.deepEqual(parsed.map((p) => p.invoiceId), records.map((r) => r.invoiceId), "the buyer's record and the paywall's line name the same invoice");
    assert.ok(!sent.join("").includes("priya") && !sent.join("").includes("Invoice overdue"), "no request text");
  });

  it("LW2-SINK posts with the ingest key and appends to the file; a hung receiver never delays the paid call", async () => {
    const stub = ingestStub();
    const ingestUrl = `${await listen(stub.server)}/ingest/claim`;
    const file = join(mkdtempSync(join(tmpdir(), "pw-sink-")), "logs", "payments.jsonl");
    const cfg = loadConfig({ ...env, PAYMENT_LOG_URL: ingestUrl, PAYMENT_LOG_KEY: KEY, PAYMENT_LOG_FILE: file, PAYMENT_LOG_TIMEOUT_MS: "300" });
    assert.deepEqual(cfg.paymentLog, { url: ingestUrl, key: KEY, file, timeoutMs: 300, maxInflight: 32 });
    const paywall = await startPaywall({ ...env, PAYMENT_LOG_URL: ingestUrl, PAYMENT_LOG_KEY: KEY, PAYMENT_LOG_FILE: file, PAYMENT_LOG_TIMEOUT_MS: "300" });
    try {
      await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: 1, intervalMs: 0, maxSpend: "0.2", maxTokens: 256 }, { write: () => {}, ledger });
      await until(() => stub.got.length === 1);
      assert.equal(stub.got[0].key, KEY);
      assert.equal((JSON.parse(stub.got[0].body) as { event: string }).event, "payment_settled");
      await until(() => readFileSync(file, "utf8").endsWith("\n"));
      assert.equal(readFileSync(file, "utf8").trim(), stub.got[0].body);

      stub.hang.on = true;
      const records: CallRecord[] = [];
      const t0 = Date.now();
      await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: 1, intervalMs: 0, maxSpend: "0.2", maxTokens: 256 }, { write: (r) => records.push(r), ledger });
      assert.equal(records[0].result, "settled");
      assert.ok(Date.now() - t0 < 2000, "the paid call did not wait for the hung receiver");
    } finally {
      await paywall.close();
      await close(stub.server);
    }
  });

  it("LW2-SINK bounded: drops beyond maxInflight, counts timeouts, reports without the key", async () => {
    const stub = ingestStub();
    stub.hang.on = true;
    const reports: string[] = [];
    const sink = createSink({ url: `${await listen(stub.server)}/ingest/claim`, key: KEY, timeoutMs: 200, maxInflight: 1 }, { log: (l) => reports.push(l) });
    sink.send('{"event":"payment_settled","n":1}');
    sink.send('{"event":"payment_settled","n":2}');
    sink.send('{"event":"payment_settled","n":3}');
    assert.equal(sink.stats().dropped, 2);
    await sink.close();
    assert.equal(sink.stats().failed, 1);
    assert.ok(reports.length >= 1 && !reports.join("").includes(KEY), reports.join("\n"));
    await close(stub.server);
  });

  it("LW2-SINK config: URL needs a long key; file alone is fine; bad numbers refused", () => {
    assert.throws(() => loadConfig({ ...env, PAYMENT_LOG_URL: "http://127.0.0.1:8790/ingest/claim" }), /PAYMENT_LOG_KEY is required/);
    assert.throws(() => loadConfig({ ...env, PAYMENT_LOG_URL: "http://127.0.0.1:8790/ingest/claim", PAYMENT_LOG_KEY: "short" }), /PAYMENT_LOG_KEY/);
    assert.throws(() => loadConfig({ ...env, PAYMENT_LOG_URL: "ftp://x" , PAYMENT_LOG_KEY: KEY }), /PAYMENT_LOG_URL must be an http/);
    assert.deepEqual(loadConfig({ ...env, PAYMENT_LOG_FILE: "payments.jsonl" }).paymentLog, { file: "payments.jsonl", timeoutMs: 1500, maxInflight: 32 });
    assert.throws(() => loadConfig({ ...env, PAYMENT_LOG_FILE: "p.jsonl", PAYMENT_LOG_TIMEOUT_MS: "50" }), /PAYMENT_LOG_TIMEOUT_MS/);
  });
});

/**
 * The rig's loop mode and traces (live ops, Phase 2): pacing, deadline,
 * Ctrl+C, the spending ceiling in loop mode, trace steps per invoice, a dead
 * trace receiver, and the command line's flag rules. Named LW2-RIG.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Wallet } from "xrpl";
import type { LedgerRequest } from "../../web/src/balance.ts";
import { pauseBeforeNext, runTenant, type CallRecord, type Tenant } from "../scripts/rig-core.ts";
import { traceEvent, Tracer, type TraceEvent } from "../scripts/trace.ts";
import { seedBuyer } from "../scripts/xrpl.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));

const ledger: LedgerRequest = async (command) =>
  ({
    server_info: { info: { network_id: 1 } },
    account_info: { account_data: { Sequence: 41, Balance: "25000000" } },
    fee: { drops: { open_ledger_fee: "12" } },
    ledger: { ledger_index: 9_000_000 },
  })[command] as Record<string, unknown>;

const tenant: Tenant = { id: "t01", name: "Test", seedPrefix: "X", queries: ["Invoice overdue. Contact: priya.vq@loomtest.example"] };
const buyer = () => seedBuyer({ networkName: "testnet", network: "xrpl:1", wsUrl: "wss://unused.example", wallet: Wallet.generate() });

/** A clock that only moves when the rig sleeps. */
function fakeClock(start = 1_000_000) {
  const c = { t: start, sleeps: [] as number[] };
  return { c, now: () => c.t, sleep: async (ms: number) => void (c.sleeps.push(ms), (c.t += ms)) };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/rig.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("rig pacing", () => {
  it("LW2-RIG interval after the call, rate start to start, jitter within its bounds", () => {
    assert.equal(pauseBeforeNext({ intervalMs: 2000 }, 700, () => 0.5), 2000);
    assert.equal(pauseBeforeNext({ intervalMs: 2000, ratePerMin: 60 }, 400, () => 0.5), 600);
    assert.equal(pauseBeforeNext({ intervalMs: 0, ratePerMin: 60 }, 1500, () => 0.5), 0, "a slow call is not made up for");
    assert.equal(pauseBeforeNext({ intervalMs: 1000, jitter: 0.2 }, 0, () => 0), 800);
    assert.equal(pauseBeforeNext({ intervalMs: 1000, jitter: 0.2 }, 0, () => 0.999999), 1200);
    assert.equal(pauseBeforeNext({ intervalMs: 1000, jitter: 0 }, 0, () => 0), 1000, "no jitter: random unused");
  });
});

describe("rig loop against a stub paywall", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({ XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: await listen(gateway.server), CHAINAIM_GATEWAY_KEY: "test-key", FACILITATOR_URL_TESTNET: await listen(facilitator.server) });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("LW2-RIG no call limit, steady rate, stops at the deadline", async () => {
    const { c, now, sleep } = fakeClock();
    const records: CallRecord[] = [];
    const summary = await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: null, intervalMs: 0, ratePerMin: 60, deadline: c.t + 5000, maxSpend: "1", maxTokens: 256 }, { write: (r) => records.push(r), ledger, now, sleep });
    assert.equal(summary.ended, "deadline");
    assert.equal(summary.settled, 5, "calls at 0, 1, 2, 3 and 4 s; none at 5 s");
    assert.deepEqual(c.sleeps, [1000, 1000, 1000, 1000, 1000]);
    assert.ok(records.every((r) => /^[0-9A-F]{32}$/.test(r.invoiceId ?? "")), "every record names its invoice");
  });

  it("LW2-RIG the spending ceiling still ends a call-unlimited run", async () => {
    const records: CallRecord[] = [];
    const summary = await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: null, intervalMs: 0, maxSpend: "0.03", maxTokens: 256 }, { write: (r) => records.push(r), ledger });
    assert.deepEqual(records.map((r) => r.result), ["settled", "settled", "settled", "stopped"]);
    assert.match(summary.stoppedBy ?? "", /above the most this buyer may pay now/);
    assert.equal(summary.ended, undefined);
  });

  it("LW2-RIG Ctrl+C (the signal) lets the call in progress finish and starts no new one", async () => {
    const stop = new AbortController();
    const records: CallRecord[] = [];
    const summary = await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: null, intervalMs: 50, maxSpend: "1", maxTokens: 256 }, {
      write: (r) => {
        records.push(r);
        if (records.length === 2) stop.abort();
      },
      ledger,
      signal: stop.signal,
    });
    assert.equal(summary.ended, "interrupted");
    assert.equal(records.length, 2);
    assert.equal(summary.settled, 2);
  });

  it("LW2-RIG traces steps 1, 2, 3, 5 per invoice with no text; a non-hash transaction is left out", async () => {
    const events: TraceEvent[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      events.push(JSON.parse(String(init?.body)) as TraceEvent);
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const tracer = new Tracer({ url: "http://ledger-watch.test/ingest/trace", key: "k".repeat(30), timeoutMs: 1500, maxInflight: 64 }, fakeFetch);
    const records: CallRecord[] = [];
    await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: 2, intervalMs: 0, maxSpend: "1", maxTokens: 256 }, { write: (r) => records.push(r), ledger, tracer });
    await tracer.drain();
    assert.equal(tracer.stats.sent, 8);
    for (const r of records) {
      const mine = events.filter((e) => e.invoiceId === r.invoiceId);
      assert.deepEqual(mine.map((e) => [e.step, e.name]), [[1, "quoted"], [2, "signed"], [3, "sent"], [5, "answered"]]);
      assert.equal(mine[3].status, 200);
      assert.equal(mine[3].transaction, undefined, "TX-STUB-1 is not a ledger hash");
      assert.ok(mine.every((e) => e.tenant === "t01" && e.network === "xrpl:1" && e.payer === r.payer));
    }
    assert.ok(!JSON.stringify(events).includes("priya") && !JSON.stringify(events).includes("Invoice"), "no text in traces");
  });

  it("LW2-RIG a dead trace receiver changes nothing about the calls", async () => {
    // Port 1 on loopback: nothing listens there, so every trace POST fails or times out.
    const tracer = new Tracer({ url: "http://127.0.0.1:1/ingest/trace", key: "k".repeat(30), timeoutMs: 300, maxInflight: 64 });
    const records: CallRecord[] = [];
    const summary = await runTenant(tenant, buyer(), { url: paywall.url, endpoint: "scan", calls: 2, intervalMs: 0, maxSpend: "1", maxTokens: 256 }, { write: (r) => records.push(r), ledger, tracer });
    assert.equal(summary.settled, 2);
    await tracer.drain();
    assert.equal(tracer.stats.sent, 0);
    assert.equal(tracer.stats.failed + tracer.stats.dropped, 8);
  });

  it("LW2-RIG traceEvent rounds times and keeps only a 64-hex transaction", () => {
    const at = new Date("2026-10-27T12:00:00.000Z");
    const e = traceEvent("answered", { invoiceId: "ABC", amount: "0.01", network: "xrpl:1", status: 200, transaction: "a".repeat(64) }, { tenant: "t01", payer: "rP" }, 12.6, at);
    assert.deepEqual(e, { v: 1, invoiceId: "ABC", step: 5, name: "answered", ts: "2026-10-27T12:00:00.000Z", network: "xrpl:1", tenant: "t01", payer: "rP", ms: 13, status: 200, transaction: "a".repeat(64) });
  });
});

describe("rig command line: loop and trace flags", () => {
  const url = "http://127.0.0.1:9";
  const cases: [string[], RegExp][] = [
    [["--forever", "--calls", "5"], /--forever and --calls/],
    [["--forever", "--duration-sec", "60"], /--forever and --duration-sec/],
    [["--rate-per-min", "4", "--interval-ms", "100"], /--rate-per-min and --interval-ms/],
    [["--duration-sec", "0"], /--duration-sec must be/],
    [["--rate-per-min", "0"], /--rate-per-min must be/],
    [["--jitter", "1.5"], /--jitter must be/],
    [["--trace-url", "ftp://x"], /--trace-url must be/],
    [["--trace-url", "http://127.0.0.1:8790/ingest/trace", "--trace-key-env", "RIGTEST_NO_SUCH_INGEST_KEY"], /RIGTEST_NO_SUCH_INGEST_KEY is required with --trace-url/],
  ];
  for (const [args, why] of cases) {
    it(`LW2-RIG refuses ${args.join(" ")} before reading any seed`, async () => {
      const r = await run(["--url", url, ...args], { RIGTEST_NO_SUCH_INGEST_KEY: "" });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, why);
    });
  }
});

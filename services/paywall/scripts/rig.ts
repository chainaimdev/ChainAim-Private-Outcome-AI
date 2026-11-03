/**
 * The test rig: several tenants, each with its own TestNet wallet, pay a
 * paywall route in RLUSD over and over, so the paywall's payment log fills
 * the way it would with many agents. Logic in scripts/rig-core.ts.
 *
 *   node scripts/rig.ts --url http://127.0.0.1:8080 --dry-run
 *   node scripts/rig.ts --url http://127.0.0.1:8080 --calls 10
 *   node scripts/rig.ts --url http://127.0.0.1:8080 --duration-sec 600 --rate-per-min 4 --jitter 0.2 \
 *        --trace-url http://127.0.0.1:8790/ingest/trace
 *
 * --url               the paywall's http(s) address (required)
 * --tenants           folder of tenant folders (default: rig/tenants at the repository root)
 * --only              comma-separated tenant ids to run (default: all)
 * --endpoint          scan (default), mask or chat
 * --calls             calls per tenant, 1 to 1000 (default 10); with --duration-sec an extra cap, up to 1000000
 * --interval-ms       pause after each of a tenant's calls (default 2000)
 * --max-spend         the most RLUSD one tenant may spend in this run (default 0.2); ends every mode
 * --max-tokens        longest chat answer, 1 to 1024 (default 256)
 * --out               folder for the run's records (default: rig/out at the repository root)
 * --dry-run           check every tenant's seed and masking, show the price, pay nothing
 * Loop mode (live ops):
 * --forever           no call limit: run until Ctrl+C or --max-spend (not with --calls or --duration-sec)
 * --duration-sec N    start no new call after N seconds (1 to 604800)
 * --rate-per-min R    calls per minute per tenant, start to start (0.1 to 600; not with --interval-ms)
 * --jitter J          0 to 1: each pause varies randomly by up to J of itself (default 0)
 * Traces (live ops; off unless --trace-url is given):
 * --trace-url URL     ledger-watch's /ingest/trace; each step of each paid call is sent there
 * --trace-key-env N   variable holding ledger-watch's ingest key (default LEDGER_WATCH_INGEST_KEY)
 * --trace-timeout-ms  how long one trace POST may take (default 1500)
 * --trace-max-inflight  most trace POSTs open at once; beyond that steps are dropped (default 64)
 *
 * Each tenant's seed is read from the variable its tenant.json names
 * (seedPrefix + _TESTNET or _MAINNET), from the shell or the repository's
 * .env, and is never printed or written; so is the trace key. Exit code: 0
 * when every call made settled (or the dry run passed), 1 when any did not or
 * a tenant was stopped (for example by --max-spend), 2 for a set-up problem
 * found before anything was paid. Ctrl+C in a run lets each tenant finish the
 * call in progress and writes the summary; a second Ctrl+C exits at once.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENDPOINTS, checkDistinct, loadTenants, prepareRequest, runTenant, type CallRecord, type Endpoint, type RunOptions, type TenantSummary } from "./rig-core.ts";
import { Tracer } from "./trace.ts";
import { account, decimalUnits, SetupError, seedBuyer, withLedger } from "./xrpl.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    tenants: { type: "string", default: join(REPO, "rig", "tenants") },
    only: { type: "string" },
    endpoint: { type: "string", default: "scan" },
    calls: { type: "string" },
    "interval-ms": { type: "string" },
    "max-spend": { type: "string", default: "0.2" },
    "max-tokens": { type: "string", default: "256" },
    out: { type: "string", default: join(REPO, "rig", "out") },
    "dry-run": { type: "boolean", default: false },
    forever: { type: "boolean", default: false },
    "duration-sec": { type: "string" },
    "rate-per-min": { type: "string" },
    jitter: { type: "string", default: "0" },
    "trace-url": { type: "string" },
    "trace-key-env": { type: "string", default: "LEDGER_WATCH_INGEST_KEY" },
    "trace-timeout-ms": { type: "string", default: "1500" },
    "trace-max-inflight": { type: "string", default: "64" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function whole(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function decimal(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || n < min || n > max) fail(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

const base = values.url?.replace(/\/+$/, "");
if (!base || !/^https?:\/\//.test(base) || !URL.canParse(base)) fail("--url is required and must be the paywall's http(s) address, e.g. http://127.0.0.1:8080");
const endpoint = values.endpoint as Endpoint;
if (!Object.hasOwn(ENDPOINTS, endpoint)) fail("--endpoint must be scan, mask or chat");

// Loop mode: which flags may go together.
if (values.forever && values.calls !== undefined) fail("--forever and --calls cannot be used together: --forever has no call limit");
if (values.forever && values["duration-sec"] !== undefined) fail("--forever and --duration-sec cannot be used together: pick one");
if (values["rate-per-min"] !== undefined && values["interval-ms"] !== undefined) fail("--rate-per-min and --interval-ms cannot be used together: pick one way to pace calls");
const durationSec = values["duration-sec"] === undefined ? undefined : whole("duration-sec", values["duration-sec"], 1, 604_800);
const loop = values.forever || durationSec !== undefined;
const calls = values.calls !== undefined ? whole("calls", values.calls, 1, durationSec !== undefined ? 1_000_000 : 1000) : loop ? null : 10;
const ratePerMin = values["rate-per-min"] === undefined ? undefined : decimal("rate-per-min", values["rate-per-min"], 0.1, 600);
const jitter = decimal("jitter", values.jitter, 0, 1);

const options: RunOptions = {
  url: base,
  endpoint,
  calls,
  intervalMs: values["interval-ms"] === undefined ? 2000 : whole("interval-ms", values["interval-ms"], 0, 600_000),
  ...(ratePerMin !== undefined ? { ratePerMin } : {}),
  jitter,
  maxSpend: values["max-spend"],
  maxTokens: whole("max-tokens", values["max-tokens"], 1, 1024),
};

// Traces: the key comes from the environment (the .env is read when xrpl.ts loads), never from the command line.
let tracer: Tracer | undefined;
if (values["trace-url"] !== undefined) {
  const traceUrl = values["trace-url"];
  if (!/^https?:\/\//.test(traceUrl) || !URL.canParse(traceUrl)) fail("--trace-url must be ledger-watch's http(s) /ingest/trace address");
  const keyEnv = values["trace-key-env"];
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) fail("--trace-key-env must be an environment variable name (capitals, digits, _)");
  const key = process.env[keyEnv]?.trim();
  if (!key || key.length < 24) fail(`${keyEnv} is required with --trace-url: ledger-watch's ingest key, at least 24 characters`);
  tracer = new Tracer({ url: traceUrl, key, timeoutMs: whole("trace-timeout-ms", values["trace-timeout-ms"], 100, 30_000), maxInflight: whole("trace-max-inflight", values["trace-max-inflight"], 1, 1000) });
}

let prepared;
try {
  if (decimalUnits(options.maxSpend) <= 0n) throw new SetupError("--max-spend must be above 0");
  const tenants = loadTenants(values.tenants, values.only?.split(",").map((s) => s.trim()).filter(Boolean));
  prepared = tenants.map((tenant) => ({ tenant, buyer: seedBuyer(account(process.env, { seedPrefix: tenant.seedPrefix })) }));
  checkDistinct(prepared);
  // Every text is masked and checked now, so a bad query file stops the run before anything is paid.
  for (const { tenant } of prepared) {
    tenant.queries.forEach((q, i) => {
      try {
        prepareRequest(endpoint, q, options.maxTokens);
      } catch (e) {
        if (!(e instanceof SetupError)) throw e;
        throw new SetupError(`${tenant.id}/queries.json item ${i + 1}: ${e.message}`);
      }
    });
  }
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  fail(e.message);
}

const url = `${base}${ENDPOINTS[endpoint]}`;
for (const { tenant, buyer } of prepared) console.log(`tenant ${tenant.id} (${tenant.name}): payer ${buyer.signer.classicAddress} on ${buyer.network}, ${tenant.queries.length} queries`);
const pacing = ratePerMin !== undefined ? `${ratePerMin} calls/min per tenant` : `${options.intervalMs} ms between calls`;
const limit = values.forever ? "until Ctrl+C or --max-spend" : `${calls === null ? "no call limit" : `${calls} calls`}${durationSec !== undefined ? `, at most ${durationSec} s` : ""}`;
console.log(`mode: ${limit}; ${pacing}${jitter > 0 ? `, jitter ${jitter}` : ""}; traces ${tracer ? `to ${values["trace-url"]}` : "off"}`);

// process.exitCode, not process.exit(), after a network call: exiting right after one crashes Node on Windows.
if (values["dry-run"]) {
  // One unpaid call shows the price every tenant would pay; nothing is signed.
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: prepareRequest(endpoint, prepared[0].tenant.queries[0], options.maxTokens).bodyText });
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) {
    console.error(`HTTP ${r.status} from ${url}: no price was asked: ${(await r.text()).slice(0, 300)}`);
    process.exitCode = 1;
  } else {
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: { amount: string; network: string; payTo: string }[] };
    for (const a of required.accepts) console.log(`price ${a.amount} RLUSD on ${a.network} to ${a.payTo}`);
    console.log(`dry run: ${prepared.length} tenants x ${calls === null ? "unlimited" : calls} calls would spend at most ${options.maxSpend} RLUSD each; nothing was paid`);
    process.exitCode = 0;
  }
} else {
  await run();
}

async function run(): Promise<void> {
  mkdirSync(values.out, { recursive: true });
  const file = join(values.out, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(`records: ${file}`);

  // Ctrl+C: stop starting calls, let the ones in progress finish, write the summary. A second Ctrl+C exits at once.
  const stop = new AbortController();
  const onSigint = (): void => {
    if (stop.signal.aborted) process.exit(130);
    console.log("stopping: each tenant finishes its call in progress (Ctrl+C again to exit now)");
    stop.abort();
  };
  process.on("SIGINT", onSigint);
  const runOptions: RunOptions = durationSec !== undefined ? { ...options, deadline: Date.now() + durationSec * 1000 } : options;

  const write = (record: CallRecord): void => {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    console.log(`${record.tenant} #${record.call} ${record.result}${record.status ? ` HTTP ${record.status}` : ""}${record.transaction ? ` tx ${record.transaction}` : ""}${record.error ? `: ${record.error}` : ""}`);
  };
  // One ledger connection per tenant for the whole run, closed when the tenant is done.
  const summaries: TenantSummary[] = await Promise.all(
    prepared.map(({ tenant, buyer }) =>
      withLedger(buyer.wsUrl, (ledger) => runTenant(tenant, buyer, runOptions, { write, ledger, signal: stop.signal, ...(tracer ? { tracer } : {}) })).catch((e: unknown): TenantSummary => {
        const message = e instanceof Error ? e.message : String(e);
        write({ ts: new Date().toISOString(), tenant: tenant.id, payer: buyer.signer.classicAddress, call: 0, endpoint, result: "stopped", latencyMs: 0, error: message });
        return { tenant: tenant.id, payer: buyer.signer.classicAddress, settled: 0, notSettled: 0, refused: 0, errors: 0, spent: "0", stoppedBy: message };
      }),
    ),
  );
  process.off("SIGINT", onSigint);

  for (const s of summaries) {
    console.log(`${s.tenant} ${s.payer}: settled ${s.settled}, not settled ${s.notSettled}, refused ${s.refused}, errors ${s.errors}, spent ${s.spent} RLUSD${s.stoppedBy ? `; stopped: ${s.stoppedBy}` : s.ended ? `; ended: ${s.ended}` : ""}`);
  }
  const total = summaries.reduce((n, s) => n + s.settled, 0);
  const attempted = summaries.reduce((n, s) => n + s.settled + s.notSettled + s.refused + s.errors, 0);
  console.log(calls !== null && !loop ? `settled ${total} of ${prepared.length * calls}` : `settled ${total} of ${attempted} attempted`);
  if (tracer) {
    await tracer.drain();
    console.log(`traces: sent ${tracer.stats.sent}, failed ${tracer.stats.failed}, dropped ${tracer.stats.dropped}`);
  }
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), summary: summaries, ...(tracer ? { traces: tracer.stats } : {}) })}\n`);
  const allSettled = summaries.every((s) => s.stoppedBy === undefined && s.notSettled === 0 && s.refused === 0 && s.errors === 0);
  process.exitCode = calls !== null && !loop ? (total === prepared.length * calls ? 0 : 1) : allSettled ? 0 : 1;
}

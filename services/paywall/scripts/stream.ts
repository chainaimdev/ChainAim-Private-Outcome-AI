/**
 * Continuous live payments for Live Ops (SW3). The logic is scripts/stream-core.ts; this file reads the
 * environment, builds the lanes and writes the records.
 *
 *   node --env-file=<ledger-watch.env> --env-file=<rig-testnet.env> --env-file=<lending-devnet.env> \
 *        --env-file=<rig-devnet.env> scripts/stream.ts run [flags]          (test-console/start-live.ps1 does this)
 *   node --env-file=<rig-testnet.env> --env-file=<lending-devnet.env> scripts/stream.ts setup-devnet --secrets-out <file>
 *
 * Environment (names only; values are never printed):
 *   <seedPrefix>_TESTNET          each tenant's Testnet seed (RLUSD lane), seedPrefix from rig/tenants/<id>/tenant.json
 *   <seedPrefix>_DEVNET           each tenant's Devnet seed (TUSD lane), written by setup-devnet
 *   XRPL_PAY_TO_TESTNET           the paywall's pay-to (--pay-to-env), paid by direct RLUSD payments
 *   LENDING_ISSUER_SEED_DEVNET    the TUSD issuer, for TUSD top-ups and setup-devnet
 *   LENDING_CHAINAIM_SEED_DEVNET  ChainAim's Devnet account (only its address is used), paid by the TUSD lane
 *   LEDGER_WATCH_INGEST_KEY       ledger-watch's ingest key, for x402 traces (--trace-key-env)
 *   XRPL_WS_URL_TESTNET / XRPL_WS_URL_DEVNET   ledger servers (flags --testnet-ws / --devnet-ws win)
 * Exit: 0 finished or stopped, 1 a lane failed to start, 2 setup problem.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidClassicAddress } from "ripple-address-codec";
import { Wallet } from "xrpl";
import { DEFAULT_RLUSD_CURRENCY_CODE, DEFAULT_RLUSD_ISSUER_TESTNET } from "../src/config.ts";
import { loadTenants, type Tenant } from "./rig-core.ts";
import {
  DEFAULT_WS,
  deliveredExactly,
  Minter,
  parseRunArgs,
  parseSetupArgs,
  readAsset,
  RUN_USAGE,
  runLane,
  SETUP_USAGE,
  tokenPayment,
  trustSet,
  units,
  XrplLedger,
  type LaneOptions,
  type LaneSummary,
  type StreamNetwork,
  type StreamRecord,
  type TokenSpec,
} from "./stream-core.ts";
import { Tracer } from "./trace.ts";
import { SetupError } from "./xrpl.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const env = process.env;
const stamp = (): string => new Date().toISOString().slice(11, 19);
const say = (line: string): void => console.log(`[${stamp()}] ${line}`);

function walletFrom(variable: string): Wallet {
  const seed = env[variable]?.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!seed) throw new SetupError(`${variable} is not set (pass the secrets file with --env-file)`);
  try {
    return Wallet.fromSeed(seed);
  } catch {
    throw new SetupError(`${variable} is not a valid family seed`); // the cause can quote the seed
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SetupError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

function tenantJson(dir: string, id: string): { path: string; data: Record<string, unknown> } {
  const path = join(dir, id, "tenant.json");
  return { path, data: readJsonFile(path) as Record<string, unknown> };
}

function wsFor(network: StreamNetwork, flag: string | null): string {
  const fromEnv = env[`XRPL_WS_URL_${network.toUpperCase()}`]?.trim();
  return flag ?? (fromEnv || DEFAULT_WS[network]);
}

function shortHash(h: string | undefined): string {
  return h ? `${h.slice(0, 8)}...${h.slice(-4)}` : "-";
}

function printRecord(r: StreamRecord): void {
  const what = r.kind ? `${r.kind} ` : "";
  const money = r.amount ? `${r.amount} ${r.token} ` : "";
  const tail = r.hash ? `tx ${shortHash(r.hash)}${r.ledgerIndex ? ` ledger ${r.ledgerIndex}` : ""}` : "";
  say(`${r.tenant} ${r.lane} ${what}${r.result} ${money}${tail}${r.error ? ` | ${r.error}` : ""}`);
}

async function run(argv: string[]): Promise<number> {
  const a = parseRunArgs(argv);
  const tenantsDir = a.tenantsDir ? resolve(a.tenantsDir) : join(REPO, "rig", "tenants");
  const tenants: Tenant[] = loadTenants(tenantsDir, a.only ?? undefined);
  const deadline = a.durationSec > 0 ? Date.now() + a.durationSec * 1000 : undefined;
  const controller = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    say("stopping: payments in progress finish, no new one starts (Ctrl+C again to quit at once)");
    controller.abort();
  });

  const outPath = a.out ? resolve(a.out) : join(REPO, "rig", "out", `stream-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  const write = (r: StreamRecord): void => {
    appendFileSync(outPath, `${JSON.stringify(r)}\n`);
    printRecord(r);
  };
  const connect = { timeoutMs: a.connectTimeoutMs, retries: a.connectRetries, backoffMs: a.connectBackoffMs, faucetHost: a.faucetHost };
  const ledgers: XrplLedger[] = [];
  // Every lane is checked (seeds, addresses, token) before the first one starts paying.
  const starts: (() => Promise<LaneSummary>)[] = [];
  const common = { ratePerMin: a.ratePerMin, jitter: a.jitter, deadline, fallbackMs: a.fallbackSec * 1000, pauseMs: a.pauseSec * 1000 };

  let tracer: Tracer | undefined;
  if (a.traceUrl) {
    const key = env[a.traceKeyEnv]?.trim();
    if (key) tracer = new Tracer({ url: a.traceUrl, key, timeoutMs: a.traceTimeoutMs, maxInflight: a.traceMaxInflight });
    else say(`traces off: ${a.traceKeyEnv} is not set (x402 steps are not sent to ledger-watch; payments are unaffected)`);
  }

  if (a.lanes.includes("rlusd")) {
    const payTo = env[a.payToEnv]?.trim();
    if (!payTo || !isValidClassicAddress(payTo)) throw new SetupError(`${a.payToEnv} must hold the paywall's pay-to address (pass ledger-watch.env with --env-file)`);
    const token: TokenSpec = { code: "RLUSD", currency: env.RLUSD_CURRENCY_CODE?.trim() || DEFAULT_RLUSD_CURRENCY_CODE, issuer: env.RLUSD_ISSUER_TESTNET?.trim() || DEFAULT_RLUSD_ISSUER_TESTNET };
    const ledger = new XrplLedger("testnet", wsFor("testnet", a.testnetWs), connect, say);
    ledgers.push(ledger);
    say(`RLUSD lane: Testnet ${ledger.wsUrl}, mode ${a.mode}, pays ${payTo}, ${a.ratePerMin}/min per tenant, budget ${a.maxSpend} RLUSD per tenant`);
    tenants.forEach((t, i) => {
      const wallet = walletFrom(`${t.seedPrefix}_TESTNET`);
      const o: LaneOptions = {
        ...common,
        lane: "rlusd",
        token,
        to: payTo,
        amount: a.amount,
        maxSpend: a.maxSpend,
        mode: a.mode,
        startDelayMs: i * a.staggerMs,
        topup: a.topup ? { below: a.topupBelow, amount: a.topupRlusd, maxCount: a.maxTopups } : null,
        buy: { maxXrp: a.maxTopupXrp, slippagePct: a.slippagePct, keepXrp: a.keepXrp },
        faucet: null,
        x402: { url: a.url, endpoint: a.endpoint, queries: t.queries, maxTokens: a.maxTokens },
      };
      say(`  ${t.id} RLUSD payer ${wallet.classicAddress}`);
      starts.push(() => runLane(o, { ledger, wallet, tenant: t.id, write, log: say, tracer, signal: controller.signal }));
    });
  }

  if (a.lanes.includes("tusd")) {
    const assetFile = a.assetFile ? resolve(a.assetFile) : join(REPO, "data", "lending", "devnet-run.json");
    const token = readAsset(readJsonFile(assetFile), assetFile);
    const to = a.tusdTo ?? walletFrom("LENDING_CHAINAIM_SEED_DEVNET").classicAddress;
    const ledger = new XrplLedger("devnet", wsFor("devnet", a.devnetWs), connect, say);
    ledgers.push(ledger);
    const minter = a.topup && env.LENDING_ISSUER_SEED_DEVNET?.trim() ? new Minter({ issuer: walletFrom("LENDING_ISSUER_SEED_DEVNET"), ledger, token, maxMint: a.maxMint }) : undefined;
    if (a.topup && !minter) say("TUSD top-ups off: LENDING_ISSUER_SEED_DEVNET is not set");
    say(`TUSD lane: Devnet ${ledger.wsUrl}, ${token.code} from ${token.issuer}, pays ${to}, ${a.ratePerMin}/min per tenant, budget ${a.tusdMaxSpend} ${token.code} per tenant`);
    tenants.forEach((t, i) => {
      const wallet = walletFrom(`${t.seedPrefix}_DEVNET`);
      const listed = tenantJson(tenantsDir, t.id).data.devnetAddress;
      if (listed !== undefined && listed !== wallet.classicAddress) {
        throw new SetupError(`${t.id}: ${t.seedPrefix}_DEVNET is for ${wallet.classicAddress}, but tenant.json "devnetAddress" is ${String(listed)} (ledger-watch watches that one)`);
      }
      if (listed === undefined) say(`  ${t.id}: tenant.json has no "devnetAddress", so ledger-watch will not count this tenant's TUSD (run setup-devnet)`);
      const o: LaneOptions = {
        ...common,
        lane: "tusd",
        token,
        to,
        amount: a.tusdAmount,
        maxSpend: a.tusdMaxSpend,
        mode: "direct",
        startDelayMs: i * a.staggerMs + Math.round(a.staggerMs / 2),
        topup: a.topup ? { below: a.topupBelow, amount: a.mint, maxCount: a.maxTopups } : null,
        faucet: a.faucet === "devnet" ? { minXrp: a.minXrp } : null,
      };
      say(`  ${t.id} TUSD payer ${wallet.classicAddress}`);
      starts.push(() => runLane(o, { ledger, wallet, tenant: t.id, write, log: say, minter, signal: controller.signal }));
    });
  }

  say(`records: ${outPath}${deadline ? `; stops at ${new Date(deadline).toISOString()}` : "; runs until Ctrl+C"}`);
  const results = await Promise.allSettled(starts.map((start) => start()));
  await tracer?.drain();
  for (const l of ledgers) await l.close();
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      const s = r.value;
      say(`${s.tenant} ${s.lane}: paid ${s.paid} (x402 ${s.x402}, direct ${s.direct}), failed ${s.failed}, spent ${s.spent} ${s.token}; ended: ${s.ended}`);
    } else {
      failed += 1;
      say(`a lane failed: ${(r.reason as Error).message}`);
    }
  }
  if (tracer) say(`traces sent ${tracer.stats.sent}, failed ${tracer.stats.failed}, dropped ${tracer.stats.dropped}`);
  return failed > 0 ? 1 : 0;
}

async function setupDevnet(argv: string[]): Promise<number> {
  const a = parseSetupArgs(argv);
  const secretsOut = resolve(a.secretsOut);
  const rel = relative(REPO, secretsOut);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new SetupError(`--secrets-out ${secretsOut} is inside the repository; keep seeds outside it (e.g. C:\\PRIV-AI-SECRETS\\rig-devnet.env)`);
  const tenantsDir = a.tenantsDir ? resolve(a.tenantsDir) : join(REPO, "rig", "tenants");
  const tenants = loadTenants(tenantsDir, a.only ?? undefined);
  const assetFile = a.assetFile ? resolve(a.assetFile) : join(REPO, "data", "lending", "devnet-run.json");
  const token = readAsset(readJsonFile(assetFile), assetFile);
  const issuer = walletFrom("LENDING_ISSUER_SEED_DEVNET");
  if (issuer.classicAddress !== token.issuer) throw new SetupError(`LENDING_ISSUER_SEED_DEVNET is for ${issuer.classicAddress}, but ${token.code} is issued by ${token.issuer}`);
  const ledger = new XrplLedger("devnet", wsFor("devnet", a.devnetWs), { timeoutMs: a.connectTimeoutMs, retries: a.connectRetries, backoffMs: a.connectBackoffMs, faucetHost: a.faucetHost }, say);
  say(`setup-devnet: ${ledger.wsUrl}, ${token.code} from ${token.issuer}; new seeds go to ${secretsOut} (never printed)`);
  const existing = existsSync(secretsOut) ? readFileSync(secretsOut, "utf8") : "";
  try {
    for (const t of tenants) {
      const variable = `${t.seedPrefix}_DEVNET`;
      const tj = tenantJson(tenantsDir, t.id);
      let wallet: Wallet;
      if (env[variable]?.trim()) {
        wallet = walletFrom(variable);
        say(`${t.id}: reusing ${variable} (${wallet.classicAddress})`);
      } else {
        if (new RegExp(`^${variable}=`, "m").test(existing)) throw new SetupError(`${variable} is already in ${secretsOut}: pass that file with --env-file so it is reused`);
        if (tj.data.devnetAddress !== undefined) throw new SetupError(`${t.id}: tenant.json already has "devnetAddress" ${String(tj.data.devnetAddress)} but ${variable} is not set: pass the secrets file holding it`);
        wallet = Wallet.generate();
        mkdirSync(dirname(secretsOut), { recursive: true });
        appendFileSync(secretsOut, `${variable}=${wallet.seed}\n`, { mode: 0o600 });
        say(`${t.id}: new Devnet wallet ${wallet.classicAddress}; seed appended to ${secretsOut} as ${variable}`);
      }
      if (tj.data.devnetAddress !== undefined && tj.data.devnetAddress !== wallet.classicAddress) {
        throw new SetupError(`${t.id}: ${variable} is for ${wallet.classicAddress}, but tenant.json "devnetAddress" is ${String(tj.data.devnetAddress)}`);
      }
      let h = await ledger.holding(wallet.classicAddress, token);
      if (!h.exists) {
        await ledger.fund(wallet);
        h = await ledger.holding(wallet.classicAddress, token);
        say(`${t.id}: funded from the Devnet faucet, ${h.xrp} XRP`);
      }
      if (!h.trustLine) {
        const r = await ledger.pay(wallet, trustSet(wallet.classicAddress, token, a.trustLimit));
        if (!(r.validated && r.result === "tesSUCCESS")) throw new SetupError(`${t.id}: the ${token.code} trust line was not opened: ${r.result}`);
        say(`${t.id}: ${token.code} trust line open, tx ${r.hash}`);
        h = await ledger.holding(wallet.classicAddress, token);
      }
      if (units(a.mintAmount) > 0n && units(h.token) < units(a.mintAmount)) {
        const r = await ledger.pay(issuer, tokenPayment(issuer.classicAddress, wallet.classicAddress, token, a.mintAmount, `setup:${t.id}`));
        if (!deliveredExactly(r, token, a.mintAmount)) throw new SetupError(`${t.id}: the issuer's ${a.mintAmount} ${token.code} did not arrive: ${r.result}`);
        say(`${t.id}: received ${a.mintAmount} ${token.code} from the issuer, tx ${r.hash}`);
      }
      if (tj.data.devnetAddress === undefined) {
        writeFileSync(tj.path, `${JSON.stringify({ ...tj.data, devnetAddress: wallet.classicAddress }, null, 2)}\n`);
        say(`${t.id}: "devnetAddress" written to ${tj.path}`);
      }
    }
  } finally {
    await ledger.close();
  }
  say("setup-devnet done. Restart ledger-watch so it watches the new Devnet buyers.");
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const usage = `${RUN_USAGE}\n\n${SETUP_USAGE}`;
try {
  if (command === "run") process.exitCode = await run(rest);
  else if (command === "setup-devnet") process.exitCode = await setupDevnet(rest);
  else {
    console.error(command ? `unknown command ${command}\n\n${usage}` : usage);
    process.exitCode = 2;
  }
} catch (e) {
  if (e instanceof SetupError) {
    console.error(e.message);
    process.exitCode = 2;
  } else {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  }
}

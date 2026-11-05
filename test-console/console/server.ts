/**
 * Local test console for the ChainAim stack running in Docker on this PC.
 * Serves one page and forwards its calls: scan, mask and chat to the gateway
 * (adding the local test key), unpaid calls to the paywall (to show the 402),
 * the spy stand-in's record of what left, the last ledger lines, and the
 * gateway's model list with this console's default model (the page's pick list).
 *
 *   node server.ts [--default-model ID] [--models-file PATH] [--port N] [--gateway URL] [--paywall URL] [--spy URL]
 *
 *   --default-model ID  model the pick list starts on until you pick another
 *                       (default: defaultModel in --models-file; chainaim/auto = let the gateway rank)
 *   --models-file PATH  local model registry       (default ../../config/local-models.json, from this folder)
 *   --generated-summary PATH  output budget of the last local-model switch (default ../../config/generated/summary.json)
 *   --port N            console port                (default 8730)
 *   --gateway URL       gateway                     (default http://127.0.0.1:8720)
 *   --paywall URL       paywall                     (default http://127.0.0.1:8080)
 *   --spy URL           stand-in's record           (default http://127.0.0.1:5004)
 *   --view-max N        HTML pages from answers kept in memory for "Open page" links (default 20; oldest dropped first)
 *   --view-ttl-min N    minutes a page link stays valid  (default 60)
 *   --view-max-bytes N  largest page accepted         (default 1000000)
 *   --view-script-src S space-separated https origins a page may load scripts and styles from
 *                       (default "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com")
 *
 *   --data-config PATH  data folders the page may browse and read (default ../../config/data-sources.json):
 *                       allowedRoots, defaultFolder, defaultMode (whole|pick), extensions, maxBytes, exclude, maxFiles,
 *                       hideFolders (folder-name patterns never listed; default ["_*"], which hides the analyst's
 *                       work folder). Re-read on every call.
 *   --chain-query URL   chain-query for the "Blockchain queries" twisty (default http://127.0.0.1:8750; services/chain-query,
 *                       started by start-chain-query.cmd; read-only, no keys). GET /chain/<chains|vaults|loan-terms|export> only.
 *   --analyst URL       the analyst for "03 Private chat + analysis" (default http://127.0.0.1:8740; services/analyst,
 *                       started by start-analyst.cmd). Only its known routes are forwarded, as JSON.
 *   Ask across files ("Ask across files" box on the chat tab): POST /crossask {folder, question, model?, answerModel?, phrase?, sql?}
 *   runs packages/crossask here: the analyst finds how the folder's CSV/TSV files relate, the model
 *   (through the gateway, with the local key) writes one SELECT from the headers only, the analyst runs it, and with
 *   phrase "llm" the model words the answer from the result (masked by the gateway).
 *   --crossask-timeout-sec N   per call to the analyst or the gateway (default 300)
 *   --crossask-sql-retries N   times the model may fix a failed query (default 1)
 *   --crossask-answer-rows N   result rows sent for the worded answer (default 50)
 *   Run log (privateAI-design-31 §3): one JSON line per question in <dir>/crossask-YYYY-MM-DD.jsonl (run-log.ts).
 *   --run-log off|meta|full    meta (default): no data values; full: also result rows, the answer and model replies
 *                              (synthetic data only); off: nothing written
 *   --run-log-dir PATH         default test-console/runs (git-ignored)
 *   --run-log-max-rows N       result rows kept per run in full mode (default 50)
 *   --run-log-keep-days N      older run files are removed (default 14)
 *
 *   Paid chat ("Pay with Crossmark" box on the chat tab): the browser pays the paywall's chat price from its own
 *   Crossmark wallet with the web page's bundle (services/web, payAndChat). This server serves the bundle and
 *   relays /paid/chat to the PAYWALL with the payment header; it never adds the gateway key there and logs
 *   neither the text nor the payment.
 *   --wallet-bundle PATH  the browser payment bundle (default ../../services/web/public/wallet.js;
 *                         build it with npm --prefix services/web run build:wallet)
 *   --paid-timeout-sec N  how long a paid chat may take, quote, settle and answer together (default 240)
 *   Paid chat in USDC on NEAR ("Pay with USDC · NEAR" box, shown only with --near-wallet): the same, with the web
 *   page's NEAR bundle (services/web, nearPayAndChat) and the visitor's NEAR wallet; it goes through the same /paid/chat.
 *   --near-wallet ID      the NEAR wallet the page may run (only intear-wallet; services/web/src/near-wallets.ts).
 *                         Unset: no NEAR box and no /near-wallet.js. This page sends no CSP of its own either way.
 *   --near-wallet-bundle PATH  the NEAR browser bundle (default ../../services/web/public/near-wallet.js;
 *                         build it with npm --prefix services/web run build:near-wallet)
 *
 *   Paid jobs on tab 03 (architecture.md ARCH-104/105/112/114; off unless --paid-jobs on, which also needs --near-wallet):
 *   POST /jobs/crossask runs the same job as /crossask, meters each model call (gateway usage), prices it with
 *   packages/crossask cost.ts, holds the result here, registers {jobId, amount, expiresAt} with the paywall, and
 *   answers only the cost. POST /paid/jobs/<id>/release relays the NEAR payment to the paywall (no gateway key); the
 *   paywall reads the held result from the internal listener while it settles.
 *   --paid-jobs on|off         default off: no new route, listener or page change
 *   --jobs-internal-host H     the internal listener's address (default 127.0.0.1; see MANUAL_SETUP.md M2)
 *   --jobs-internal-port N     its port (default 8731): GET /internal/jobs/<id>, POST /internal/jobs/<id>/released
 *   --paid-jobs-key-env NAME   environment variable holding the key shared with the paywall (default PAID_JOBS_KEY, >= 24 chars)
 *   --job-ttl-min N            minutes a quoted job stays payable (default 15; at most the paywall's PAID_JOBS_TTL_SEC)
 *   --job-max N                open jobs held at once (default 100; beyond it /jobs/crossask answers 503)
 *   --pricing-catalog PATH     model prices (pricing.inputPerM / outputPerM), e.g. ../../config/catalog.bedrock.json
 *   --fee-per-model-call-usd D, --fee-analyst-usd D, --near-gas-fee-usd D, --margin-pct D, --min-price-usd D
 *                              required with --paid-jobs on, non-negative decimals, never defaulted (MANUAL_SETUP.md)
 *   Paid-job feed to near-watch (chainaim-adminUI-NEAR architecture-adminui-jobs.md ARCH-205; off unless --job-feed-url,
 *   which needs --paid-jobs on): job_quoted / job_released / job_expired, ids, times, amounts, models and counts only
 *   (job-feed.ts), never awaited by a request.
 *   --job-feed-url URL          near-watch's ingest route, e.g. http://127.0.0.1:8790/ingest/job (default unset = off)
 *   --job-feed-key-env NAME     environment variable holding near-watch's ingest key (default NEAR_WATCH_INGEST_KEY, >= 24 chars)
 *   --job-feed-timeout-ms N     one post (default 5000)
 *   --job-feed-max-inflight N   posts at once; beyond it an event is dropped and logged (default 20)
 *   --job-expiry-check-sec N    how often held jobs are checked for expiry (default 30)
 *
 *   Docker split (DOCKERIZE-PLAN 4.1, C1-C7; every default is today's single process on 127.0.0.1):
 *   --mode all|ui|api          all (default): page and backend in one process, as before. api: the same backend, meant to
 *                              run in a container (with --bind 0.0.0.0). ui: serves only /, /wallet.js and /near-wallet.js
 *                              and forwards every other request, byte for byte, to --api; it holds no key and reads no
 *                              data, config or ledger.
 *   --bind HOST                the address this console listens on (default 127.0.0.1)
 *   --api URL                  ui mode only, required there: the console API, e.g. http://127.0.0.1:8735
 *   --forward-timeout-sec N    ui mode: one forwarded request (default the longer of --paid-timeout-sec and --crossask-timeout-sec)
 *   --allowed-hosts LIST       Host headers the guarded routes accept, comma-separated host:port
 *                              (default 127.0.0.1:<port>,localhost:<port>). In ui mode every forwarded request needs one.
 *   --ledger-source S          the ledger twisty: docker-exec (default: docker exec ca-gateway tail ...), dir:<path> (the
 *                              gateway's ledger folder mounted read-only, e.g. dir:/gateway-data/ledger) or off
 *   --gateway-key-file PATH    the gateway key (default test-console/local-gateway-key.txt; not read in ui mode)
 *   --paid-jobs-page on|off    ui mode: add the tab 03 pay box to the page (default off; jobs themselves run in the api)
 *   --dataset-root NAME=PATH   replace one root of config/datasets.json (repeatable), e.g. private=/data/priv-ai-data/chainaim3003
 *                              when the data is mounted at another path; default none = the file's own roots
 *
 *   Pages are served at /view/<id> with a sandbox Content-Security-Policy: their scripts run in an opaque
 *   origin and connect-src is 'none', so model-written HTML cannot call this console, the gateway or any
 *   other address. Pages live in memory only (they can hold statement data) and vanish on restart.
 *
 *   node server.ts  ->  http://127.0.0.1:8730
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NETWORKS } from "../../services/web/src/balance.ts";
import { NEAR_WALLETS, isNearWalletId } from "../../services/web/src/near-wallets.ts";
import { analystClient, crossAsk, gatewayChat } from "../../packages/crossask/src/index.ts";
import { RUN_LOG_MODES, RunLog, type RunLogMode } from "./run-log.ts";
import { quoteJob } from "../../packages/crossask/src/cost.ts";
import { JobStore, internalHandler, meterOf, paidJobsConfig, registerJob } from "./jobs.ts";
import { JobFeed, jobFeedConfig } from "./job-feed.ts";

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    "default-model": { type: "string" },
    "models-file": { type: "string", default: fileURLToPath(new URL("../../config/local-models.json", import.meta.url)) },
    "generated-summary": { type: "string", default: fileURLToPath(new URL("../../config/generated/summary.json", import.meta.url)) },
    port: { type: "string", default: "8730" },
    gateway: { type: "string", default: "http://127.0.0.1:8720" },
    paywall: { type: "string", default: "http://127.0.0.1:8080" },
    spy: { type: "string", default: "http://127.0.0.1:5004" },
    "data-config": { type: "string", default: fileURLToPath(new URL("../../config/data-sources.json", import.meta.url)) },
    analyst: { type: "string", default: "http://127.0.0.1:8740" },
    "chain-query": { type: "string", default: "http://127.0.0.1:8750" },
    "view-max": { type: "string", default: "20" },
    "view-ttl-min": { type: "string", default: "60" },
    "view-max-bytes": { type: "string", default: "1000000" },
    "view-script-src": { type: "string", default: "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com" },
    "wallet-bundle": { type: "string", default: fileURLToPath(new URL("../../services/web/public/wallet.js", import.meta.url)) },
    "paid-timeout-sec": { type: "string", default: "240" },
    "near-wallet": { type: "string" },
    "near-wallet-bundle": { type: "string", default: fileURLToPath(new URL("../../services/web/public/near-wallet.js", import.meta.url)) },
    "crossask-timeout-sec": { type: "string", default: "300" },
    "crossask-sql-retries": { type: "string", default: "1" },
    "crossask-answer-rows": { type: "string", default: "50" },
    "run-log": { type: "string", default: "meta" },
    "run-log-dir": { type: "string", default: fileURLToPath(new URL("../runs", import.meta.url)) },
    "run-log-max-rows": { type: "string", default: "50" },
    "run-log-keep-days": { type: "string", default: "14" },
    "paid-jobs": { type: "string" },
    "jobs-internal-host": { type: "string" },
    "jobs-internal-port": { type: "string" },
    "paid-jobs-key-env": { type: "string" },
    "job-ttl-min": { type: "string" },
    "job-max": { type: "string" },
    "pricing-catalog": { type: "string" },
    "fee-per-model-call-usd": { type: "string" },
    "fee-analyst-usd": { type: "string" },
    "near-gas-fee-usd": { type: "string" },
    "margin-pct": { type: "string" },
    "min-price-usd": { type: "string" },
    "job-feed-url": { type: "string" },
    "job-feed-key-env": { type: "string" },
    "job-feed-timeout-ms": { type: "string" },
    "job-feed-max-inflight": { type: "string" },
    "job-expiry-check-sec": { type: "string" },
    mode: { type: "string", default: "all" },
    bind: { type: "string", default: "127.0.0.1" },
    api: { type: "string" },
    "forward-timeout-sec": { type: "string" },
    "allowed-hosts": { type: "string" },
    "ledger-source": { type: "string", default: "docker-exec" },
    "gateway-key-file": { type: "string", default: fileURLToPath(new URL("../local-gateway-key.txt", import.meta.url)) },
    "paid-jobs-page": { type: "string" },
    "dataset-root": { type: "string", multiple: true },
  },
});
/** DOCKERIZE-PLAN C1: all (today), ui (page + forwarding) or api (backend in a container). */
const MODE = flags.mode as "all" | "ui" | "api";
if (!["all", "ui", "api"].includes(MODE)) throw new Error(`--mode must be all, ui or api, got ${flags.mode}`);
if (MODE === "ui") {
  // The ui process runs nothing of the backend; a backend flag here would be silently unused, so it is refused.
  for (const name of ["paid-jobs", "job-feed-url", "pricing-catalog", "dataset-root"] as const) {
    if (flags[name] !== undefined) throw new Error(`--${name} belongs to the api process, not --mode ui (use --paid-jobs-page on for the tab 03 pay box)`);
  }
  if (!flags.api) throw new Error("--mode ui needs --api URL: the console API, e.g. http://127.0.0.1:8735");
  if (!URL.canParse(flags.api) || !/^https?:$/.test(new URL(flags.api).protocol)) throw new Error(`--api must be an http(s) URL, got ${flags.api}`);
} else {
  if (flags.api !== undefined) throw new Error("--api is for --mode ui only");
  if (flags["paid-jobs-page"] !== undefined) throw new Error("--paid-jobs-page is for --mode ui only (in this mode the page follows --paid-jobs)");
}
if (flags["paid-jobs-page"] !== undefined && !["on", "off"].includes(flags["paid-jobs-page"])) throw new Error(`--paid-jobs-page must be on or off, got ${flags["paid-jobs-page"]}`);
if (!/^[0-9a-fA-F.:]+$|^localhost$/.test(flags.bind!)) throw new Error(`--bind must be an IP address such as 127.0.0.1 or 0.0.0.0, got ${flags.bind}`);
/** C5: where the ledger twisty reads the gateway's last ledger lines. */
const LEDGER_SOURCE = flags["ledger-source"]!;
if (!(LEDGER_SOURCE === "docker-exec" || LEDGER_SOURCE === "off" || /^dir:.+/.test(LEDGER_SOURCE))) throw new Error(`--ledger-source must be docker-exec, dir:<path> or off, got ${LEDGER_SOURCE}`);
/** --dataset-root NAME=PATH: roots of config/datasets.json replaced for this process (e.g. inside a container). */
const DATASET_ROOTS: Record<string, string> = {};
for (const pair of flags["dataset-root"] ?? []) {
  const m = /^([A-Za-z0-9_-]+)=(.+)$/.exec(pair);
  if (!m) throw new Error(`--dataset-root must be NAME=PATH, got ${pair}`);
  DATASET_ROOTS[m[1]] = m[2];
}
function positiveInt(name: "view-max" | "view-ttl-min" | "view-max-bytes" | "paid-timeout-sec" | "crossask-timeout-sec" | "crossask-sql-retries" | "crossask-answer-rows", min = 1): number {
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a positive integer, got ${flags[name]}`);
  return n;
}
const VIEW_MAX = positiveInt("view-max");
const VIEW_TTL_MS = positiveInt("view-ttl-min") * 60_000;
const VIEW_MAX_BYTES = positiveInt("view-max-bytes");
const VIEW_SOURCES = flags["view-script-src"]!.split(/\s+/).filter(Boolean);
const PAID_TIMEOUT_MS = positiveInt("paid-timeout-sec") * 1000;
const WALLET_BUNDLE = flags["wallet-bundle"]!;
const NEAR_WALLET = flags["near-wallet"];
if (NEAR_WALLET !== undefined && !isNearWalletId(NEAR_WALLET)) throw new Error(`--near-wallet must be one of ${Object.keys(NEAR_WALLETS).join(", ")}, got ${NEAR_WALLET}`);
const NEAR_WALLET_BUNDLE = flags["near-wallet-bundle"]!;
/** Paid jobs on tab 03 (ARCH-104/105/114): undefined unless --paid-jobs on; start-up stops here naming any missing flag. Never in ui mode. */
const PAID_JOBS = MODE === "ui" ? undefined : paidJobsConfig(flags, process.env);
if (PAID_JOBS && !NEAR_WALLET) throw new Error("--paid-jobs on needs --near-wallet intear-wallet: paid jobs are paid in USDC on NEAR from the page");
/** The paid-job feed to near-watch (adminUI ARCH-205): undefined unless --job-feed-url; start-up stops here on a bad flag or key. */
const JOB_FEED_CONFIG = MODE === "ui" ? undefined : jobFeedConfig(flags, process.env, PAID_JOBS !== undefined);
const JOB_FEED = JOB_FEED_CONFIG ? new JobFeed(JOB_FEED_CONFIG) : undefined;
const JOBS = PAID_JOBS ? new JobStore(PAID_JOBS.max, PAID_JOBS.ttlMs, Date.now, JOB_FEED ? (j) => JOB_FEED.expired(j.jobId) : undefined) : undefined;
/** The tab 03 pay box and its script, added to the page only with --paid-jobs on (the page is otherwise served as it is). */
const PAID_JOBS_FRAGMENT = fileURLToPath(new URL("./paid-jobs.html", import.meta.url));
/** C7: whether the page gets the pay box: --paid-jobs in all/api mode, --paid-jobs-page in ui mode. */
const PAGE_PAID = MODE === "ui" ? flags["paid-jobs-page"] === "on" : PAID_JOBS !== undefined;
if (MODE === "ui" && PAGE_PAID && !NEAR_WALLET) throw new Error("--paid-jobs-page on needs --near-wallet intear-wallet: the pay box pays with the NEAR bundle");
const CROSSASK_TIMEOUT_MS = positiveInt("crossask-timeout-sec") * 1000;
const CROSSASK_RETRIES = positiveInt("crossask-sql-retries", 0);
const CROSSASK_ROWS = positiveInt("crossask-answer-rows");
if (!(RUN_LOG_MODES as readonly string[]).includes(flags["run-log"]!)) throw new Error(`--run-log must be one of ${RUN_LOG_MODES.join(", ")}, got ${flags["run-log"]}`);
const RUN_LOG = new RunLog({ mode: flags["run-log"] as RunLogMode, dir: resolve(flags["run-log-dir"]!), maxRows: Number(flags["run-log-max-rows"]), keepDays: Number(flags["run-log-keep-days"]) });
/** Paywall response headers the paid chat passes back: the price, the receipt, retry advice and the gateway's own. */
const PAID_PASS_BACK = /^(payment-required|payment-response|retry-after|x-chainaim-[a-z-]+)$/;
for (const s of VIEW_SOURCES) {
  if (!URL.canParse(s) || new URL(s).protocol !== "https:" || new URL(s).origin !== s.replace(/\/+$/, "")) throw new Error(`--view-script-src entries must be https origins like https://cdn.jsdelivr.net, got ${s}`);
}
for (const name of ["gateway", "paywall", "spy", "analyst", "chain-query"] as const) {
  if (!URL.canParse(flags[name]!)) throw new Error(`--${name} must be a URL, got ${flags[name]}`);
}
const PORT = Number(flags.port);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`--port must be 1 to 65535, got ${flags.port}`);
/** C4: the Host headers the guarded routes accept; by default exactly today's two. */
const ALLOWED_HOSTS = flags["allowed-hosts"] === undefined ? [`127.0.0.1:${PORT}`, `localhost:${PORT}`] : flags["allowed-hosts"].split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
for (const h of ALLOWED_HOSTS) if (!/^[a-z0-9.-]+:\d{1,5}$/.test(h)) throw new Error(`--allowed-hosts entries must be host:port, got ${h}`);
if (!ALLOWED_HOSTS.length) throw new Error("--allowed-hosts must list at least one host:port");
const API = MODE === "ui" ? flags.api!.replace(/\/+$/, "") : "";
const FORWARD_TIMEOUT_MS = flags["forward-timeout-sec"] === undefined ? Math.max(positiveInt("paid-timeout-sec"), positiveInt("crossask-timeout-sec")) * 1000 : (() => {
  const n = Number(flags["forward-timeout-sec"]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--forward-timeout-sec must be a positive integer, got ${flags["forward-timeout-sec"]}`);
  return n * 1000;
})();
/** Request headers the ui forwards (the api needs nothing else), and the response headers it passes back: those this server sets. */
const FORWARD_IN = ["content-type", "payment-signature", "accept"];
const FORWARD_BACK = /^(content-type|cache-control|content-disposition|content-security-policy|x-content-type-options|referrer-policy|payment-required|payment-response|retry-after|x-chainaim-[a-z-]+)$/;
/** The registry's defaultModel, so the pick list follows config/local-models.json; chainaim/auto when it cannot be read. */
function registryDefault(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const id = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).defaultModel;
    return typeof id === "string" && id ? id : "chainaim/auto";
  } catch {
    return "chainaim/auto";
  }
}
const DEFAULT_MODEL = (flags["default-model"] ?? registryDefault(flags["models-file"]!)).trim();
/** The output budget the last switch gave the gateway (config/generated/summary.json), or null outside the local-model mode. Read per call, so a switch needs no console restart. */
function generatedMaxOutput(): number | null {
  try {
    const text = readFileSync(flags["generated-summary"]!, "utf8");
    const n = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).maxOutputTokens;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** C6: the gateway key file; the ui process holds no key. */
const KEY = MODE === "ui" ? "" : readFileSync(flags["gateway-key-file"]!, "utf8").trim();
const GATEWAY = flags.gateway!.replace(/\/+$/, "");
const PAYWALL = flags.paywall!.replace(/\/+$/, "");
const SPY = flags.spy!.replace(/\/+$/, "");
const PAGE = new URL("./index.html", import.meta.url);

const ANALYST = flags.analyst!.replace(/\/+$/, "");
const CHAIN_QUERY = flags["chain-query"]!.replace(/\/+$/, "");
const CHAIN_ROUTES = new Set(["healthz", "chains", "vaults", "loan-terms", "export"]);
const ANALYST_ROUTES = new Set(["profile", "recipe", "analyze", "status", "evidence", "verify", "relations", "sql", "pack-queries", "pack-run"]);
const ROUTES: Record<string, string> = { scan: "/v1/privacy/scan", mask: "/v1/privacy/mask", chat: "/v1/chat/completions" };

// "Open page" links: HTML pages found in model answers, kept in memory only, served sandboxed.
const views = new Map<string, { html: string; at: number }>();
function pruneViews(now = Date.now()): void {
  for (const [id, v] of views) if (now - v.at > VIEW_TTL_MS) views.delete(id);
  while (views.size > VIEW_MAX) views.delete(views.keys().next().value as string);
}
const VIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEW_CSP = [
  "sandbox allow-scripts", // opaque origin: no access to this console's origin, storage or cookies
  "default-src 'none'",
  `script-src 'unsafe-inline' ${VIEW_SOURCES.join(" ")}`,
  `style-src 'unsafe-inline' ${VIEW_SOURCES.join(" ")} https://fonts.googleapis.com`,
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "connect-src 'none'", // no fetch/XHR/WebSocket: the page cannot reach the console, the gateway or the internet
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
const viewHeaders = { "content-security-policy": VIEW_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

// ---- From data folder ------------------------------------------------------------------------------
// The page only NAMES a folder or file; this server decides. Only paths inside allowedRoots (the data config, re-read on
// every call so edits need no restart) are listed or read, after resolving links. Read-only; nothing is created.
/** The repository root: relative paths in the data config and in config/datasets.json are resolved against it. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
type DataConfig = { allowedRoots: string[]; defaultFolder: string; extensions: string[]; maxBytes: Record<string, number>; exclude: RegExp[]; excludeText: string[]; maxFiles: number; defaultMode: "whole" | "pick"; hideFolders: RegExp[] };
const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
function within(child: string, root: string): boolean {
  const r = relative(fold(root), fold(child));
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
function readDataConfig(): { config?: DataConfig; error?: string } {
  let raw: Record<string, any>;
  try {
    const text = readFileSync(flags["data-config"]!, "utf8");
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { error: `Data folders are off: cannot read ${flags["data-config"]} (${(e as Error).message}). Copy config/data-sources.example.json to config/data-sources.json.` };
  }
  // A relative path is relative to the repository (e.g. "sample-data"), so one config works on every PC (DESIGN/xrplh-29).
  const roots: string[] = Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter((r: unknown) => typeof r === "string" && r.trim()).map((r: string) => resolve(REPO, r)) : [];
  if (!roots.length) return { error: "Data folders are off: allowedRoots must list at least one folder." };
  const defaultFolder = typeof raw.defaultFolder === "string" && raw.defaultFolder.trim() ? resolve(REPO, raw.defaultFolder) : roots[0];
  if (!roots.some((r) => within(defaultFolder, r))) return { error: `Data folders are off: defaultFolder ${defaultFolder} is not inside allowedRoots.` };
  const extensions: string[] = (Array.isArray(raw.extensions) ? raw.extensions : [".csv", ".tsv", ".txt", ".pdf"]).map((e: unknown) => String(e).toLowerCase());
  const maxBytes: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.maxBytes ?? {})) if (Number.isInteger(v) && (v as number) > 0) maxBytes[k.toLowerCase()] = v as number;
  maxBytes["*"] ??= 2_000_000;
  const excludeText: string[] = Array.isArray(raw.exclude) ? raw.exclude.map(String) : [];
  const maxFiles = Number.isInteger(raw.maxFiles) && raw.maxFiles > 0 ? raw.maxFiles : 500;
  const defaultMode = raw.defaultMode === "pick" ? "pick" : "whole"; // whole: every file in the folder goes with each question
  const hideFolders = (Array.isArray(raw.hideFolders) ? raw.hideFolders.map(String) : ["_*"]).map(globToRe); // e.g. the analyst's _analyst work folder
  return { config: { allowedRoots: roots, defaultFolder, extensions, maxBytes, exclude: excludeText.map(globToRe), excludeText, maxFiles, defaultMode, hideFolders } };
}
class DataError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** The real location of a requested path, which must be inside an allowed root. The lexical check runs first, so a path outside the roots is refused without touching the disk; the real-path check then catches links that lead out. */
async function insideRoots(p: string, cfg: DataConfig): Promise<string> {
  if (!p || !isAbsolute(p)) throw new DataError(400, "path must be an absolute path");
  const asked = resolve(p);
  if (!cfg.allowedRoots.some((r) => within(asked, r))) throw new DataError(403, "outside the allowed data folders (allowedRoots in the data config)");
  let real: string;
  try { real = await realpath(asked); } catch { throw new DataError(404, `not found: ${asked}`); }
  for (const r of cfg.allowedRoots) {
    let rootReal: string;
    try { rootReal = await realpath(r); } catch { continue; }
    if (within(real, rootReal)) return real;
  }
  throw new DataError(403, "this path leads outside the allowed data folders (a link?)");
}
const usableName = (file: string, cfg: DataConfig): boolean => cfg.extensions.includes(extname(file).toLowerCase()) && !cfg.exclude.some((re) => re.test(basename(file)));
const capFor = (file: string, cfg: DataConfig): number => cfg.maxBytes[extname(file).toLowerCase()] ?? cfg.maxBytes["*"];
/** Only this console's own address may use the data routes, so a site reached through DNS rebinding cannot read files. */
const hostOk = (req: IncomingMessage): boolean => ALLOWED_HOSTS.includes((req.headers.host ?? "").toLowerCase());
const dataHeaders = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
function dataJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...dataHeaders });
  res.end(JSON.stringify(body));
}
async function isFolder(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory(); } catch { return false; } }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://console");
    const [, api, name] = url.pathname.split("/");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (!PAGE_PAID) { res.end(readFileSync(PAGE)); return; }
      const page = readFileSync(PAGE, "utf8");
      const at = page.lastIndexOf("</body>");
      res.end(at === -1 ? page + readFileSync(PAID_JOBS_FRAGMENT, "utf8") : page.slice(0, at) + readFileSync(PAID_JOBS_FRAGMENT, "utf8") + page.slice(at));
      return;
    }
    // ui mode (C1/C3): the page and the two browser bundles are served below; every other request goes to the api, byte for byte.
    if (MODE === "ui" && !(req.method === "GET" && (api === "wallet.js" || api === "near-wallet.js") && !name)) return forward(req, res, url);
    // The pick list: every model the gateway serves now, plus this console's default.
    if (api === "gateway" && name === "models" && req.method === "GET") {
      const r = await fetch(GATEWAY + "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
      const body = (await r.json().catch(() => null)) as { data?: { id?: unknown; context_length?: unknown }[] } | null;
      const data = body?.data ?? [];
      const models = data.map((m) => m.id).filter((id): id is string => typeof id === "string");
      // Context length per model and the gateway's output budget let the page warn before a prompt is too big.
      const limits = Object.fromEntries(data.filter((m) => typeof m.id === "string" && typeof m.context_length === "number").map((m) => [m.id, m.context_length]));
      json(res, 200, { status: r.status, defaultModel: DEFAULT_MODEL, models, limits, maxOutputTokens: generatedMaxOutput() });
      return;
    }
    if (api === "gateway" && req.method === "POST" && ROUTES[name]) {
      const r = await fetch(GATEWAY + ROUTES[name], {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: await readBody(req),
      });
      const headers = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-chainaim")));
      json(res, 200, { status: r.status, headers, body: await r.json().catch(() => null) });
      return;
    }
    if (api === "paywall" && ROUTES[name]) {
      const body = name === "chat" ? { messages: [{ role: "user", content: "hi" }] } : { text: "hi" };
      const r = await fetch(PAYWALL + ROUTES[name], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const header = r.headers.get("payment-required");
      const required = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
      json(res, 200, {
        status: r.status,
        accepts: required?.accepts?.map((a: Record<string, any>) => ({ price: Number(a.amount), network: a.network, asset: a.asset, issuer: a.extra?.issuer, payTo: a.payTo, invoiceId: a.extra?.invoiceId })) ?? [],
        bazaar: Boolean(required?.extensions?.bazaar),
        body: header ? null : await r.json().catch(() => null),
      });
      return;
    }
    // Store one HTML page from an answer. JSON only, so a cross-site page cannot post here without a CORS preflight (which this server never grants).
    if (api === "view" && !name && req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "send application/json" });
      const raw = await readBody(req);
      if (Buffer.byteLength(raw) > VIEW_MAX_BYTES + 1024) return json(res, 413, { error: `page over --view-max-bytes (${VIEW_MAX_BYTES})` });
      let html: unknown;
      try { html = JSON.parse(raw).html; } catch { return json(res, 400, { error: 'body must be JSON {"html": "..."}' }); }
      if (typeof html !== "string" || !html.includes("<")) return json(res, 400, { error: "html must be a string of HTML" });
      if (Buffer.byteLength(html) > VIEW_MAX_BYTES) return json(res, 413, { error: `page over --view-max-bytes (${VIEW_MAX_BYTES})` });
      pruneViews();
      const id = randomUUID();
      views.set(id, { html, at: Date.now() });
      pruneViews();
      json(res, 200, { url: `/view/${id}`, expiresInMin: VIEW_TTL_MS / 60_000 });
      return;
    }
    if (api === "view" && name && req.method === "GET") {
      pruneViews();
      const page = VIEW_ID.test(name) ? views.get(name) : undefined;
      if (!page) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...viewHeaders });
        res.end("This page has expired or the test console was restarted. Ask the question again to get a new link.");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...viewHeaders });
      res.end(page.html);
      return;
    }
    // From data folder: config, sub-folders, files, one file. GET only, read-only, confined to allowedRoots.
    if (api === "data" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const { config, error } = readDataConfig();
      if (name === "config") {
        return dataJson(res, 200, config
          ? { enabled: true, allowedRoots: config.allowedRoots, defaultFolder: config.defaultFolder, defaultExists: await isFolder(config.defaultFolder), extensions: config.extensions, maxBytes: config.maxBytes, exclude: config.excludeText, maxFiles: config.maxFiles, defaultMode: config.defaultMode }
          : { enabled: false, error });
      }
      if (!config) return dataJson(res, 503, { error });
      try {
        const p = url.searchParams.get("path") ?? "";
        if (name === "folders") {
          if (!p) return dataJson(res, 200, { path: "", parent: null, folders: config.allowedRoots.map((r) => ({ name: r, path: r })) });
          const dir = await insideRoots(p, config);
          if (!(await isFolder(dir))) throw new DataError(400, "not a folder");
          const folders = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !config.hideFolders.some((re) => re.test(e.name)))
            .map((e) => ({ name: e.name, path: join(dir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          const up = dirname(dir);
          return dataJson(res, 200, { path: dir, parent: up !== dir && config.allowedRoots.some((r) => within(up, r)) ? up : "", folders });
        }
        if (name === "files") {
          const dir = await insideRoots(p, config);
          if (!(await isFolder(dir))) throw new DataError(400, "not a folder");
          const entries = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isFile() && usableName(e.name, config))
            .sort((a, b) => a.name.localeCompare(b.name));
          const files = [];
          for (const e of entries.slice(0, config.maxFiles)) {
            const full = join(dir, e.name);
            const st = await stat(full);
            files.push({ name: e.name, path: full, ext: extname(e.name).toLowerCase(), size: st.size, modified: st.mtime.toISOString(), tooBig: st.size > capFor(e.name, config) });
          }
          return dataJson(res, 200, { path: dir, files, truncated: entries.length > config.maxFiles, maxFiles: config.maxFiles });
        }
        if (name === "file") {
          const file = await insideRoots(p, config);
          const st = await stat(file);
          if (!st.isFile()) throw new DataError(400, "not a file");
          if (!usableName(file, config)) throw new DataError(403, `not an allowed file type (${config.extensions.join(", ")}) or excluded`);
          if (st.size > capFor(file, config)) throw new DataError(413, `larger than the ${extname(file)} limit (${capFor(file, config)} bytes)`);
          res.writeHead(200, { "content-type": extname(file).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8", ...dataHeaders });
          res.end(await readFile(file));
          return;
        }
        return dataJson(res, 404, { error: "unknown data route" });
      } catch (e) {
        if (e instanceof DataError) return dataJson(res, e.status, { error: e.message });
        throw e;
      }
    }
    // 03 Private chat + analysis: forwarded to the analyst (compute only, 127.0.0.1, no model calls). Known routes only, JSON only.
    if (api === "analyst") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const route = name ?? "";
      if (!(req.method === "GET" ? route === "healthz" : req.method === "POST" && ANALYST_ROUTES.has(route))) return dataJson(res, 404, { error: "unknown analyst route" });
      if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return dataJson(res, 415, { error: "send application/json" });
      let r: Response;
      try {
        r = await fetch(`${ANALYST}/${route}`, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: await readBody(req) } : {});
      } catch {
        return dataJson(res, 503, { error: `the analyst is not running at ${ANALYST}: start test-console\\start-analyst.cmd and keep its window open` });
      }
      res.writeHead(r.status, { "content-type": "application/json", ...dataHeaders });
      res.end(await r.text());
      return;
    }
    // Blockchain queries twisty: forwarded to chain-query (read-only, 127.0.0.1, holds no keys). Known routes only, GET only.
    if (api === "chain") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const route = name ?? "";
      if (req.method !== "GET" || !CHAIN_ROUTES.has(route)) return dataJson(res, 404, { error: "unknown chain route" });
      let r: Response;
      try { r = await fetch(`${CHAIN_QUERY}/${route}${url.search}`, { signal: AbortSignal.timeout(60_000) }); }
      catch { return dataJson(res, 503, { error: `chain-query is not running at ${CHAIN_QUERY}: start test-console\\start-chain-query.cmd (start-ui.ps1 starts it) and keep its window open` }); }
      const disposition = r.headers.get("content-disposition");
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", ...(disposition ? { "content-disposition": disposition } : {}), ...dataHeaders });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    // Datasets for tab 03 (config/datasets.json, DESIGN/xrplh-29): each dataset's folder under the chosen root, whether it exists,
    // its data files and (for subfolders) the sets inside. Only folders inside allowedRoots are listed. GET only, read-only.
    if (api === "datasets" && !name && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const { config, error } = readDataConfig();
      if (!config) return dataJson(res, 503, { error });
      let reg: { roots: Record<string, string>; datasets: Record<string, any>[] };
      try { const t = readFileSync(join(REPO, "config", "datasets.json"), "utf8"); reg = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); }
      catch (e) { return dataJson(res, 503, { error: `cannot read config/datasets.json: ${(e as Error).message}` }); }
      const rootId = url.searchParams.get("root") ?? "samples";
      if (!reg.roots?.[rootId]) return dataJson(res, 400, { error: `unknown root ${rootId} (known: ${Object.keys(reg.roots ?? {}).join(", ")})` });
      const root = resolve(REPO, DATASET_ROOTS[rootId] ?? reg.roots[rootId]);
      const allowed = config.allowedRoots.some((r) => within(root, r));
      const isData = (n: string) => config.extensions.includes(extname(n).toLowerCase()) && !config.exclude.some((re) => re.test(n));
      const filesIn = async (dir: string) => { try { return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && isData(e.name)).map((e) => e.name).sort(); } catch { return null; } };
      const out = [];
      for (const d of reg.datasets ?? []) {
        const folder = resolve(root, d.folder);
        const ok = allowed && within(folder, root);
        const files = ok ? await filesIn(folder) : null;
        let sets: { name: string; files: string[] }[] = [];
        if (ok && d.subfolders && files !== null) {
          const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
            let ents; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents.filter((x) => x.isDirectory() && !x.isSymbolicLink() && !config.hideFolders.some((re) => re.test(x.name))).sort((a, b) => a.name.localeCompare(b.name))) {
              const sub = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name, f = await filesIn(sub);
              if (f && f.length) sets.push({ name: r, files: f });
              if (depth < 2) await walk(sub, r, depth + 1);
            }
          };
          await walk(folder, "", 1);
        }
        out.push({ id: d.id, label: d.label, description: d.description, engine: d.engine, pack: d.pack ?? null, templates: Array.isArray(d.templates) ? d.templates : [],
          templatesFrom: d.templates && !Array.isArray(d.templates) ? d.templates.from : null, defaultSubfolder: d.defaultSubfolder ?? null, setLabels: d.setLabels ?? {}, fileKinds: d.fileKinds ?? {},
          folder, exists: files !== null, allowed: ok, files: files ?? [], sets });
      }
      return dataJson(res, 200, { root: rootId, rootPath: root, rootAllowed: allowed, roots: Object.keys(reg.roots), datasets: out });
    }
    // Domain-pack question (DESIGN/xrplh-29): the analyst builds the fact sheet, the model rewords it through the gateway (masked),
    // the analyst checks every figure; a failed check shows the computed facts instead of the answer.
    if (api === "packask" && !name && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.id !== "string") return dataJson(res, 400, { error: "folder and id are required" });
      const post = async (route: string, body: unknown) => {
        let r: Response;
        try { r = await fetch(`${ANALYST}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CROSSASK_TIMEOUT_MS) }); }
        catch { throw new Error(`the analyst is not running at ${ANALYST}: start test-console\\start-analyst.cmd and keep its window open`); }
        const j = await r.json() as Record<string, any>;
        if (!r.ok) throw new Error(j.error ?? `analyst HTTP ${r.status}`);
        return j;
      };
      try {
        const run = await post("pack-run", { folder: b.folder, pack: b.pack, ids: [b.id] });
        const q = run.questions?.[0];
        if (!q) return dataJson(res, 400, { error: `${b.id} is not a model question in the pack's query bank` });
        const t0 = Date.now();
        const reply = await gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS })([{ role: "system", content: run.system }, { role: "user", content: `${q.question}\n\n${q.sheet}` }], model);
        const seconds = Math.round((Date.now() - t0) / 100) / 10;
        const answer = reply.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        const check = await post("pack-verify", { runId: run.runId, id: b.id, answer: reply.text });
        return dataJson(res, 200, { id: q.id, title: q.title, question: q.question, files: run.files, facts: q.facts, sheetChars: q.sheet.length,
          served: { model: reply.model ?? null, zone: reply.zone ?? null, seconds }, answer, check: { ok: check.ok, checked: check.checked, problems: check.problems }, computed: check.computed });
      } catch (e) {
        return dataJson(res, 502, { error: (e as Error).message });
      }
    }
    // Ask across files: relations and query on this PC (analyst), the model through the gateway (headers first, the result only with phrase llm).
    if (api === "crossask" && !name && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
      const phrase = b.phrase === "none" ? "none" : "llm";
      const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
      if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
      const userSql = typeof b.sql === "string" && b.sql.trim() ? b.sql : undefined;
      const runIn = { folder: b.folder, question: b.question, model, answerModel, phrase, userSql: userSql !== undefined };
      const started = Date.now();
      try {
        const out = await crossAsk({ folder: b.folder, question: b.question, model, answerModel, phrase, sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS, sql: userSql },
          { analyst: analystClient(ANALYST, CROSSASK_TIMEOUT_MS), chat: gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS }) });
        return dataJson(res, 200, { ...out, runLog: RUN_LOG.write(runIn, out, undefined, Date.now() - started) });
      } catch (e) {
        return dataJson(res, 502, { error: (e as Error).message, runLog: RUN_LOG.write(runIn, null, (e as Error).message, Date.now() - started) });
      }
    }
    // ---- Paid jobs on tab 03 (ARCH-104, ARCH-112): only with --paid-jobs on -----------------------------------------
    if (PAID_JOBS && JOBS && api === "jobs" && name === "config" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      return dataJson(res, 200, { wallet: NEAR_WALLET, walletName: NEAR_WALLETS[NEAR_WALLET!].name, ttlMin: PAID_JOBS.ttlMs / 60_000 });
    }
    // Run, meter, quote, hold, register: the page gets the cost and the job id, never the result.
    if (PAID_JOBS && JOBS && api === "jobs" && name === "crossask" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
      const phrase = b.phrase === "none" ? "none" : "llm";
      const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
      if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
      if (JOBS.full()) return dataJson(res, 503, { error: `${PAID_JOBS.max} paid jobs are open (--job-max); pay or let one expire first` });
      let out;
      try {
        out = await crossAsk({ folder: b.folder, question: b.question, model, answerModel, phrase, sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS, sql: typeof b.sql === "string" && b.sql.trim() ? b.sql : undefined },
          { analyst: analystClient(ANALYST, CROSSASK_TIMEOUT_MS), chat: gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS }), ...(JOB_FEED ? { clock: () => performance.now() } : {}) });
      } catch (e) {
        return dataJson(res, 502, { error: `the job did not run, so nothing can be paid: ${(e as Error).message}` });
      }
      // A job that did not produce a result is not sold (the free /crossask shows why).
      if (out.error || !out.result) return dataJson(res, 422, { error: "the job did not produce a result, so nothing can be paid; run it unpaid to see why" });
      let quote;
      try { quote = quoteJob(meterOf(out.served), PAID_JOBS.prices, PAID_JOBS.fees); }
      catch (e) { return dataJson(res, 422, { error: `no price for this job, so nothing can be paid: ${(e as Error).message}` }); }
      const jobId = JOBS.newJobId();
      const expiresAt = JOBS.expiryFromNow();
      let offer;
      try { offer = await registerJob(PAYWALL, PAID_JOBS.key, { jobId, amount: quote.amount, expiresAt }); }
      catch (e) { return dataJson(res, 502, { error: (e as Error).message }); }
      // The held (and later released) result is what it was before the job feed: the step timings are the feed's only.
      const { timings: _timings, ...result } = out;
      JOBS.hold({ jobId, result, amount: quote.amount, breakdown: quote.breakdown, expiresAt });
      JOB_FEED?.quoted({ jobId, network: offer.network, expiresAt, out, quote });
      // Ids and amounts only.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job", event: "job_quoted", jobId, amount: quote.amount, calls: quote.breakdown.calls.length }));
      return dataJson(res, 200, { jobId, totalUsd: quote.totalUsd, amount: quote.amount, network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt });
    }
    // The NEAR payment for one job, relayed to the paywall (never the gateway, and without the gateway key).
    if (PAID_JOBS && api === "paid" && name === "jobs" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const parts = url.pathname.split("/");
      const jobId = parts[3] ?? "";
      if (parts.length !== 5 || parts[4] !== "release" || !/^[0-9a-f]{32}$/.test(jobId)) return json(res, 404, { error: { message: "not found" } });
      const signature = req.headers["payment-signature"];
      if (Array.isArray(signature)) return json(res, 400, { error: { message: "send one payment-signature header" } });
      await readBody(req);
      const started = Date.now();
      let r: Response;
      try {
        r = await fetch(`${PAYWALL}/v1/jobs/${jobId}/release`, { method: "POST", headers: { ...(signature ? { "payment-signature": signature } : {}) }, signal: AbortSignal.timeout(PAID_TIMEOUT_MS) });
      } catch {
        return json(res, 502, { error: { message: signature ? "The connection to the paywall failed after your payment was sent. Check your wallet's recent transactions before trying again." : "Could not reach the paywall. You were not charged." } });
      }
      const headers: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      r.headers.forEach((value, key) => { if (PAID_PASS_BACK.test(key)) headers[key] = value; });
      let out: Buffer;
      try {
        out = Buffer.from(await r.arrayBuffer());
      } catch {
        const receipt = headers["payment-response"];
        res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
        res.end(JSON.stringify({ error: { message: signature ? "The result was lost after your payment went through. Check your wallet's recent transactions." : "Could not read the paywall's answer. You were not charged." } }));
        return;
      }
      // Status, job id and timing only: never the result, the payment header or the receipt.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job-release", jobId, status: r.status, withPayment: signature !== undefined, ms: Date.now() - started }));
      res.writeHead(r.status, headers);
      res.end(out);
      return;
    }
    // ---- Paid chat ---------------------------------------------------------------------------------------------
    // The browser bundle that pays from the visitor's Crossmark wallet (services/web/public/wallet.js).
    if (api === "wallet.js" && req.method === "GET") {
      let js: Buffer;
      try { js = readFileSync(WALLET_BUNDLE); } catch { return json(res, 404, { error: `the wallet bundle is not at ${WALLET_BUNDLE}: run npm --prefix services/web run build:wallet` }); }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(js);
      return;
    }
    // The web page's NEAR bundle (services/web/public/near-wallet.js), only when the console was started with --near-wallet.
    if (api === "near-wallet.js" && req.method === "GET") {
      if (!NEAR_WALLET) return json(res, 404, { error: "the NEAR wallet is off: start the console with --near-wallet intear-wallet" });
      let js: Buffer;
      try { js = readFileSync(NEAR_WALLET_BUNDLE); } catch { return json(res, 404, { error: `the NEAR wallet bundle is not at ${NEAR_WALLET_BUNDLE}: run npm --prefix services/web run build:near-wallet` }); }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(js);
      return;
    }
    // What a NEAR paid chat pays, from the paywall's own chat quote: its near: offer, and the dollar price from its xrpl: offer when it has one.
    if (api === "paid" && name === "near" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!NEAR_WALLET) return json(res, 404, { error: "the NEAR wallet is off: start the console with --near-wallet intear-wallet" });
      const r = await fetch(PAYWALL + ROUTES.chat, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(8000) });
      const header = r.headers.get("payment-required");
      if (r.status !== 402 || !header) return json(res, 503, { error: `the paywall did not quote a chat price (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` });
      const accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts ?? []) as Record<string, any>[];
      const n = accepts.find((a) => a?.scheme === "exact" && (a.network === "near:testnet" || a.network === "near:mainnet"));
      if (!n || typeof n.asset !== "string" || typeof n.payTo !== "string" || typeof n.amount !== "string" || !/^[1-9]\d*$/.test(n.amount)) {
        return json(res, 503, { error: "the paywall does not offer USDC on NEAR: start it with PAY_RAILS=xrpl,near (or near)" });
      }
      const x = accepts.find((a) => typeof a?.network === "string" && a.network.startsWith("xrpl:"));
      json(res, 200, { network: n.network, asset: n.asset, payTo: n.payTo, amount: n.amount, price: x && Number.isFinite(Number(x.amount)) ? Number(x.amount) : null, wallet: NEAR_WALLET, walletName: NEAR_WALLETS[NEAR_WALLET].name });
      return;
    }
    // What the paid chat pays on, from the paywall's own chat quote, with the public ledger server for that network.
    if (api === "paid" && name === "network" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const r = await fetch(PAYWALL + ROUTES.chat, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(8000) });
      const header = r.headers.get("payment-required");
      if (r.status !== 402 || !header) return json(res, 503, { error: `the paywall did not quote a chat price (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` });
      const a = JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts?.[0] as Record<string, any> | undefined;
      const known = Object.entries(NETWORKS).find(([, n]) => n.caip2 === a?.network);
      if (!a || !known || typeof a.extra?.issuer !== "string" || typeof a.asset !== "string") return json(res, 502, { error: `the paywall quotes a network or shape this console does not know (${a?.network ?? "none"})` });
      json(res, 200, { name: known[0], caip2: known[1].caip2, wsUrl: known[1].wsUrl, asset: a.asset, issuer: a.extra.issuer, payTo: a.payTo, price: Number(a.amount) });
      return;
    }
    // The paid chat itself, relayed to the paywall (not the gateway, and without the gateway key) with the payment header.
    if (api === "paid" && name === "chat" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: { message: "send application/json" } });
      const signature = req.headers["payment-signature"];
      if (Array.isArray(signature)) return json(res, 400, { error: { message: "send one payment-signature header" } });
      const body = await readBody(req);
      const started = Date.now();
      let r: Response;
      try {
        r = await fetch(PAYWALL + ROUTES.chat, {
          method: "POST",
          headers: { "content-type": "application/json", ...(signature ? { "payment-signature": signature } : {}) },
          body,
          signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
        });
      } catch {
        // Once a payment was forwarded, the paywall may have settled it before the connection failed.
        return json(res, 502, { error: { message: signature ? "The connection to the paywall failed after your payment was sent. Check your wallet's recent transactions before trying again." : "Could not reach the paywall. You were not charged." } });
      }
      const headers: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      r.headers.forEach((value, key) => { if (PAID_PASS_BACK.test(key)) headers[key] = value; });
      let out: Buffer;
      try {
        out = Buffer.from(await r.arrayBuffer());
      } catch {
        // The paywall settles before it streams the answer, so a paid body lost here may already be paid for.
        const receipt = headers["payment-response"];
        res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
        res.end(JSON.stringify({ error: { message: signature ? "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again." : "Could not read the paywall's answer. You were not charged." } }));
        return;
      }
      // Status and timing only: never the text, the payment header or the receipt.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-chat", status: r.status, withPayment: signature !== undefined, ms: Date.now() - started }));
      res.writeHead(r.status, headers);
      res.end(out);
      return;
    }
    if (api === "leaving") {
      json(res, 200, await (await fetch(SPY)).json());
      return;
    }
    if (api === "ledger") {
      const send = (out: string | null) => {
        const lines = out === null ? [] : out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
        json(res, 200, { lines });
      };
      if (LEDGER_SOURCE === "off") return send(null);
      if (LEDGER_SOURCE.startsWith("dir:")) return send(await tailLedgerDir(LEDGER_SOURCE.slice(4), 6));
      execFile("docker", ["exec", "ca-gateway", "sh", "-c", "tail -n 6 /data/ledger/*.jsonl"], (err, out) => send(err ? null : out));
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 502, { error: (e as Error).message });
  }
}).listen(PORT, flags.bind, async () => {
  if (MODE === "ui") {
    console.log(`[test-console] http://127.0.0.1:${PORT}  ui mode: page and browser bundles here, everything else forwarded to ${API}${PAGE_PAID ? "  (tab 03 pay box on)" : ""}${NEAR_WALLET ? `  NEAR wallet: ${NEAR_WALLET}` : ""}`);
    return;
  }
  if (MODE === "api") console.log(`[test-console] api mode: listening on ${flags.bind}:${PORT}; hosts ${ALLOWED_HOSTS.join(",")}; ledger ${LEDGER_SOURCE}`);
  console.log(`[test-console] run log: ${RUN_LOG.opt.mode}${RUN_LOG.opt.mode === "off" ? "" : ` -> ${RUN_LOG.opt.dir} (keep ${RUN_LOG.opt.keepDays} days${RUN_LOG.opt.mode === "full" ? `, up to ${RUN_LOG.opt.maxRows} rows per run` : ""})`}`);
  console.log(`[test-console] http://127.0.0.1:${PORT}  default model: ${DEFAULT_MODEL}${NEAR_WALLET ? `  NEAR wallet: ${NEAR_WALLET}` : ""}`);
  // The internal listener for the paywall (ARCH-105), only with --paid-jobs on; the key is never shown.
  if (PAID_JOBS && JOBS) {
    createServer(internalHandler(JOBS, PAID_JOBS.key, JOB_FEED ? (id) => JOB_FEED.released(id) : undefined)).listen(PAID_JOBS.internalPort, PAID_JOBS.internalHost, () => {
      console.log(`[test-console] paid jobs on: internal listener http://${PAID_JOBS.internalHost}:${PAID_JOBS.internalPort}  key from ${PAID_JOBS.keyEnv}  ttl ${PAID_JOBS.ttlMs / 60_000} min  max ${PAID_JOBS.max}`);
      if (JOB_FEED_CONFIG) {
        const u = new URL(JOB_FEED_CONFIG.url);
        console.log(`[test-console] job feed on: ${u.origin}${u.pathname}  key from ${JOB_FEED_CONFIG.keyEnv}  expiry check every ${JOB_FEED_CONFIG.expiryCheckSec} s`);
        // Expiry is noticed when the store is read; this read makes it happen on time even when nobody asks.
        setInterval(() => JOBS.size(), JOB_FEED_CONFIG.expiryCheckSec * 1000).unref();
      }
    }).on("error", (e) => { console.error(`[test-console] the paid jobs internal listener cannot start on ${PAID_JOBS.internalHost}:${PAID_JOBS.internalPort}: ${e.message}`); process.exit(1); });
  }
  const { config, error } = readDataConfig();
  if (!config) console.log(`[test-console] ${error}`);
  else console.log(`[test-console] data folders: ${config.allowedRoots.join(", ")}; default ${config.defaultFolder}${(await isFolder(config.defaultFolder)) ? "" : "  (NOT FOUND: create it)"}`);
});

/** tail -n <n> <dir>/*.jsonl, in name order, for --ledger-source dir:<path>; null when nothing can be read (as a failed docker exec). */
async function tailLedgerDir(dir: string, n: number): Promise<string | null> {
  let names: string[];
  try { names = (await readdir(dir)).filter((x) => x.endsWith(".jsonl")).sort(); } catch { return null; }
  if (!names.length) return null;
  const parts: string[] = [];
  for (const name of names) {
    let text: string;
    try { text = await readFile(join(dir, name), "utf8"); } catch { return null; }
    const lines = text.replace(/\n$/, "").split("\n");
    const last = lines.slice(-n).join("\n");
    parts.push(names.length > 1 ? `==> ${join(dir, name)} <==\n${last}` : last);
  }
  return parts.join("\n\n") + "\n";
}

/** ui mode: one request forwarded to the api unchanged, after this process's own Host check (C4). */
async function forward(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
  const headers: Record<string, string> = {};
  for (const name of FORWARD_IN) { const v = req.headers[name]; if (typeof v === "string") headers[name] = v; }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBodyBytes(req);
  let r: Response;
  try {
    r = await fetch(API + url.pathname + url.search, { method: req.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS), redirect: "manual" });
  } catch {
    // A paid call may have been settled before the connection failed: never say "not charged" when a payment was attached.
    return json(res, 502, { error: { message: headers["payment-signature"] ? "The connection to the console API failed after your payment was sent. Check your wallet's recent transactions before trying again." : `The console API is not answering at ${API}: start it (up.ps1) and try again.` } });
  }
  const back: Record<string, string> = {};
  r.headers.forEach((value, name) => { if (FORWARD_BACK.test(name)) back[name] = value; });
  let out: Buffer;
  try { out = Buffer.from(await r.arrayBuffer()); }
  catch {
    const receipt = back["payment-response"];
    res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
    res.end(JSON.stringify({ error: { message: headers["payment-signature"] ? "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again." : "Could not read the console API's answer." } }));
    return;
  }
  res.writeHead(r.status, back);
  res.end(out);
}

/** The request body's bytes, as a Uint8Array over its own ArrayBuffer (what fetch's body type takes). */
function readBodyBytes(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

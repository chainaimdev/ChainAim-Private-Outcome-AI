/**
 * The agent service for tab 03 "agent mode" (architecture-tab03-agent-mode.md ARCH-302 to ARCH-306, ARCH-310,
 * ARCH-311). Logic in scripts/agent-jobs-core.ts. In Docker it runs as ca-agent (compose profile "agent"); on a PC:
 *
 *   node --env-file=C:\PRIV-AI-SECRETS\agent-tenants.env services/paywall/scripts/agent-jobs.ts --console http://127.0.0.1:8735
 *
 *   GET  /healthz    {ok, tenants, presidio}: 200 once listening
 *   GET  /tenants    [{id, name, accountId}]: no key, no variable value
 *   GET  /policy     {on, tenants: [{id, autoApproveMaxUsd, maxPerJobUsd, dailyCapUsd, requireAttestedRoute, counter,
 *                    spentTodayUsd}]} (ARCH-620): the limits from tenant.json and today's spend; {on: false} when off
 *   POST /run        {tenant, folder, question, model?, answerModel?, phrase?, sql?} -> text/event-stream:
 *                    masked, tool_called, job_ran, quoted, policy, signed, settled, released, receipt_verified or
 *                    receipt_failed, done (or refused / error)
 *
 * --host H                 listen address (default 127.0.0.1; 0.0.0.0 in the container)
 * --port N                 (default 8760)
 * --allowed-hosts LIST     Host headers accepted, comma-separated host:port (default 127.0.0.1:<port>,localhost:<port>)
 * --console URL            the console API that runs and quotes the job (default http://127.0.0.1:8730)
 * --paywall URL            the paywall that releases it (default http://127.0.0.1:8080)
 * --tenants DIR            tenant folders (default rig/tenants at the repository root)
 * --agent-tenants LIST     the tenants this agent pays for (default t01,t02,t03)
 * --region R / --model-id M  Bedrock region and model (default ap-southeast-2 / nvidia.nemotron-nano-3-30b, as scripts/agent.ts)
 * --aws-auth bearer|chain  bearer: AWS_BEARER_TOKEN_BEDROCK must be set (a Bedrock API key; up.ps1 passes it by name);
 *                          chain: the AWS SDK's usual credential chain (default chain)
 * --prompt-mask on|off     mask the question before Bedrock sees it (default on)
 * --prompt-scanner S       client|presidio|both (default both); with Presidio in use and not answering, nothing is sent
 * --presidio-url URL       (default http://127.0.0.1:5002; http://presidio.railway.internal:3000 in compose)
 * --presidio-threshold, --presidio-timeout-ms, --presidio-wait-ms, --presidio-extra-entities, --prompt-residual
 *                          as scripts/agent.ts (defaults 0.4, 5000, 10000, default, on)
 * --tenant-label TEXT      how the agent's instructions name the tenant (default "the user's organisation")
 * --max-turns N            most model calls per run, 1 to 20 (default 6)
 * --agent-max-tokens N     longest reply from the agent's model, 1 to 8192 (default 1024)
 * --agent-max-amount D     the most USDC one payment may be; unset (default) = no limit
 * --agent-policy on|off    each tenant's spending policy, the "policy" block of its tenant.json (privateAI-design-32
 *                          ARCH-620; packages/agent-policy): checked between "quoted" and "signed"; anything but "pay"
 *                          ends the run with nothing signed or paid (default on). On: start-up refuses a listed tenant
 *                          without a valid policy block, naming the tenant and the field
 * --spend-dir DIR          the daily spend ledger, <DIR>/<tenant>/spend-YYYY-MM-DD.jsonl (UTC; job ids, amounts and
 *                          transactions only), checked writable at start-up (default runtime/agent-spend at the
 *                          repository root; /data/spend on the volume chainaim-agent-spend in compose)
 * --receipt-verify on|off  after a paid release, fetch the job's signed receipt from the console and verify it with the
 *                          PINNED key (privateAI-design-32 step B, scripts/agent-receipt.ts); a failed check is the step
 *                          receipt_failed, never a refusal, since the payment already went through (default on). On: start-up
 *                          refuses a missing or non-Ed25519 key file, naming the path
 * --receipt-public-key PATH  the pinned console public key (default config/receipt-public-key.pem at the repository root,
 *                          committed; exported by desk.ps1 -ReceiptKey). The publicKeyPem the console sends is never used
 * --receipt-poll-ms N / --receipt-poll-max N  how often and how many times to ask for the receipt, which the console makes
 *                          just after the release (defaults 1000 and 15, as tab 03)
 * --refund-poll-ms N / --refund-poll-max N  privateAI-design-37: how often and how many times to ask the paywall for a
 *                          pending refund of an upfront payment whose run was refused (defaults 3000 and 40)
 * --ap2-verify on|off      privateAI-design-33 ARCH-630: verify ChainAim's signed quote (the console's --ap2 on answer) with
 *                          the PINNED AP2 key and bind it to the quote before the policy; a failure refuses the run with the
 *                          AP2 error code, nothing signed or paid (default off). On: start-up refuses a missing or bad key file
 * --ap2-public-key PATH    the pinned JWK Set (default config/ap2-public-key.jwk.json at the repository root, committed;
 *                          exported by desk.ps1 -Ap2Key). A key the console sends or publishes is never used
 * --ap2-skew-sec N         clock skew allowed on the signed quote's expiry (default 30)
 * --ap2-mandate on|off     privateAI-design-36 ARCH-666: sign a closed AP2 Checkout Mandate for each estimate-first quote
 *                          ChainAim signed, with the tenant's mandate key (AP2_MANDATE_KEY_<TENANT> in the env file;
 *                          desk.ps1 -MandateKey), nonce = the payment's invoice id; it goes with the paid release and
 *                          ChainAim's signer verifies it before the run (default off; needs --ap2-verify on). A tenant with
 *                          no key cannot pay such a job (refused, nothing signed)
 * --re-estimate on|off     privateAI-design-42 ARCH-712: right before paying an estimate-first job, ask the console to
 *                          re-size its folder by the paid run's own rule (GET /offers/<id>/recheck); grown past the
 *                          estimate's tolerance, gained files, or not checkable = refused before anything is signed or paid
 *                          (default off: no re-check, as before)
 * --mandate-audience ID    the business id the mandate is addressed to (default chainaim; the signer's --mandate-audience)
 * --mandate-lifetime-sec N how long a mandate is valid (default 300; the signer accepts at most its --mandate-max-lifetime-sec)
 * --run-timeout-sec N      a run is cancelled if not signed by then (default 300)
 * --body-max-bytes N       largest POST /run body (default 65536)
 *
 * Keys never come from flags: each tenant's key is read from the variable its tenant.json names
 * (near.keyEnv + _TESTNET or _MAINNET), from the environment Node's --env-file loaded. Start-up refuses a listed
 * tenant whose key is missing, naming the variable only, and refuses an environment holding the relayer key.
 * Exit code 2 for a set-up problem found before listening.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BedrockModel } from "@strands-agents/sdk";
import { SpendLedger } from "../../../packages/agent-policy/src/index.ts";
import { loadPinnedKey, type ReceiptCheck } from "./agent-receipt.ts";
import { loadPinnedJwks, type Ap2Check } from "./agent-ap2.ts";
import { loadMandateKeys, mandateKeyVariable, type MandateSigner } from "./agent-mandate.ts";
import { AccountQueue, OFFER_MODES, loadAgentTenants, loadPolicies, parseRunRequest, payingNetwork, policyViews, publicTenants, runAgentJob, SetupError, sseFrame, type AgentPolicy, type AgentTenant, type OfferMode } from "./agent-jobs-core.ts";
import { presidioClient, PROMPT_SCANNERS, PromptScan, type PromptScanner } from "./prompt-scan.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const { values } = parseArgs({
  strict: true,
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8760" },
    "allowed-hosts": { type: "string" },
    console: { type: "string", default: "http://127.0.0.1:8730" },
    paywall: { type: "string", default: "http://127.0.0.1:8080" },
    tenants: { type: "string", default: join(REPO, "rig", "tenants") },
    "agent-tenants": { type: "string", default: "t01,t02,t03" },
    region: { type: "string", default: "ap-southeast-2" },
    "model-id": { type: "string", default: "nvidia.nemotron-nano-3-30b" },
    "aws-auth": { type: "string", default: "chain" },
    "prompt-mask": { type: "string", default: "on" },
    "prompt-scanner": { type: "string", default: "both" },
    "presidio-url": { type: "string", default: "http://127.0.0.1:5002" },
    "presidio-threshold": { type: "string", default: "0.4" },
    "presidio-timeout-ms": { type: "string", default: "5000" },
    "presidio-wait-ms": { type: "string", default: "10000" },
    "presidio-extra-entities": { type: "string", default: "default" },
    "prompt-residual": { type: "string", default: "on" },
    "tenant-label": { type: "string", default: "the user's organisation" },
    "max-turns": { type: "string", default: "6" },
    "agent-max-tokens": { type: "string", default: "1024" },
    "agent-max-amount": { type: "string" },
    "agent-policy": { type: "string", default: "on" },
    "spend-dir": { type: "string", default: join(REPO, "runtime", "agent-spend") },
    "receipt-verify": { type: "string", default: "on" },
    "receipt-public-key": { type: "string", default: join(REPO, "config", "receipt-public-key.pem") },
    "ap2-verify": { type: "string", default: "off" },
    // privateAI-design-34 D5: the mode of a run that names none (POST /run body offerMode overrides it).
    "offer-mode": { type: "string", default: "estimate-first" },
    "ap2-public-key": { type: "string", default: join(REPO, "config", "ap2-public-key.jwk.json") },
    "ap2-skew-sec": { type: "string", default: "30" },
    "ap2-mandate": { type: "string", default: "off" },
    "re-estimate": { type: "string", default: "off" },
    "mandate-audience": { type: "string", default: "chainaim" },
    "mandate-lifetime-sec": { type: "string", default: "300" },
    "receipt-poll-ms": { type: "string", default: "1000" },
    "receipt-poll-max": { type: "string", default: "15" },
    "refund-poll-ms": { type: "string", default: "3000" },
    "refund-poll-max": { type: "string", default: "40" },
    "run-timeout-sec": { type: "string", default: "300" },
    "body-max-bytes": { type: "string", default: "65536" },
  },
});

function fail(message: string): never {
  console.error(`[agent] ${message}`);
  process.exit(2);
}
function whole(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}
function onOff(name: string, raw: string): boolean {
  if (raw !== "on" && raw !== "off") fail(`--${name} must be on or off`);
  return raw === "on";
}
function httpUrl(name: string, raw: string): string {
  const u = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u) || !URL.canParse(u)) fail(`--${name} must be an http(s) URL, got ${raw}`);
  return u;
}

const host = values.host;
if (!/^[0-9a-fA-F.:]+$|^localhost$/.test(host)) fail(`--host must be an IP address such as 127.0.0.1 or 0.0.0.0, got ${host}`);
const port = whole("port", values.port, 1, 65535);
const allowedHosts = values["allowed-hosts"] === undefined ? [`127.0.0.1:${port}`, `localhost:${port}`] : values["allowed-hosts"].split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
for (const h of allowedHosts) if (!/^[a-z0-9.-]+:\d{1,5}$/.test(h)) fail(`--allowed-hosts entries must be host:port, got ${h}`);
if (allowedHosts.length === 0) fail("--allowed-hosts must list at least one host:port");
const consoleUrl = httpUrl("console", values.console);
const paywallUrl = httpUrl("paywall", values.paywall);
const awsAuth = values["aws-auth"];
if (awsAuth !== "bearer" && awsAuth !== "chain") fail("--aws-auth must be bearer or chain");
if (awsAuth === "bearer" && !(process.env.AWS_BEARER_TOKEN_BEDROCK ?? "").trim()) fail("--aws-auth bearer needs the environment variable AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key; up.ps1 -Agent on passes BEDROCK_API_KEY under that name)");
const promptMask = onOff("prompt-mask", values["prompt-mask"]);
const scanner = values["prompt-scanner"] as PromptScanner;
if (!(PROMPT_SCANNERS as readonly string[]).includes(scanner)) fail(`--prompt-scanner must be one of ${PROMPT_SCANNERS.join(", ")}`);
const presidioUrl = httpUrl("presidio-url", values["presidio-url"]);
const threshold = Number(values["presidio-threshold"]);
if (values["presidio-threshold"].trim() === "" || !(threshold >= 0 && threshold <= 1)) fail("--presidio-threshold must be a number from 0 to 1");
const presidioTimeoutMs = whole("presidio-timeout-ms", values["presidio-timeout-ms"], 100, 120000);
const presidioWaitMs = whole("presidio-wait-ms", values["presidio-wait-ms"], 0, 600000);
const residual = onOff("prompt-residual", values["prompt-residual"]);
const tenantLabel = values["tenant-label"].trim();
if (tenantLabel === "") fail("--tenant-label must not be empty");
const maxTurns = whole("max-turns", values["max-turns"], 1, 20);
const agentMaxTokens = whole("agent-max-tokens", values["agent-max-tokens"], 1, 8192);
const maxAmount = values["agent-max-amount"];
if (maxAmount !== undefined && !/^(0|[1-9]\d*)(\.\d+)?$/.test(maxAmount)) fail(`--agent-max-amount must be a decimal USDC amount such as 0.05, got ${maxAmount}`);
const runTimeoutMs = whole("run-timeout-sec", values["run-timeout-sec"], 1, 3600) * 1000;
const bodyMax = whole("body-max-bytes", values["body-max-bytes"], 1024, 10_000_000);
const tenantIds = values["agent-tenants"].split(",").map((s) => s.trim()).filter(Boolean);
const policyOn = onOff("agent-policy", values["agent-policy"]);
const spendDir = values["spend-dir"].trim();
if (policyOn && spendDir === "") fail("--spend-dir must not be empty with --agent-policy on");
const receiptOn = onOff("receipt-verify", values["receipt-verify"]);
const receiptPollMs = whole("receipt-poll-ms", values["receipt-poll-ms"], 100, 60000);
const receiptPollMax = whole("receipt-poll-max", values["receipt-poll-max"], 1, 120);
const refundPollMs = whole("refund-poll-ms", values["refund-poll-ms"], 100, 60000);
const refundPollMax = whole("refund-poll-max", values["refund-poll-max"], 1, 600);
let receiptCheck: ReceiptCheck | undefined;
if (receiptOn) {
  const keyPath = values["receipt-public-key"].trim();
  try {
    receiptCheck = { ...loadPinnedKey(keyPath), keyPath, pollMs: receiptPollMs, pollMax: receiptPollMax, fetchTimeoutMs: 5000 };
  } catch (e) {
    fail(`--receipt-public-key: ${(e as Error).message} (or start with --receipt-verify off)`);
  }
}
const ap2On = onOff("ap2-verify", values["ap2-verify"]);
const defaultOfferMode = values["offer-mode"] as OfferMode;
if (!OFFER_MODES.includes(defaultOfferMode)) fail(`--offer-mode must be ${OFFER_MODES.join(" or ")}, got ${values["offer-mode"]}`);
const ap2SkewSec = whole("ap2-skew-sec", values["ap2-skew-sec"], 0, 600);
let ap2Check: Ap2Check | undefined;
if (ap2On) {
  const keyPath = values["ap2-public-key"].trim();
  try {
    ap2Check = { ...loadPinnedJwks(keyPath), keyPath, skewSec: ap2SkewSec };
  } catch (e) {
    fail(`--ap2-public-key: ${(e as Error).message} (or start with --ap2-verify off)`);
  }
}

// ARCH-666: the tenants' checkout mandate keys, read once from this environment (the mounted env file).
const mandateOn = onOff("ap2-mandate", values["ap2-mandate"]);
// privateAI-design-42 ARCH-712: the pre-payment size re-check of estimate-first jobs.
const reEstimate = onOff("re-estimate", values["re-estimate"]);
if (mandateOn && !ap2Check) fail("--ap2-mandate on needs --ap2-verify on: the mandate permits a quote the agent has verified");
const mandateAud = values["mandate-audience"];
if (!/^[\x21-\x7E]{1,200}$/.test(mandateAud)) fail("--mandate-audience must be 1 to 200 printable characters");
const mandateLifetimeSec = whole("mandate-lifetime-sec", values["mandate-lifetime-sec"], 30, 3600);
let mandates: MandateSigner | undefined;
if (mandateOn) {
  try { mandates = { keys: loadMandateKeys(values["agent-tenants"].split(",").map((t) => t.trim()).filter(Boolean), process.env), aud: mandateAud, lifetimeSec: mandateLifetimeSec }; }
  catch (e) { fail(`--ap2-mandate on: ${(e as Error).message} (desk.ps1 -MandateKey -MandateTenant <id> makes one)`); }
}

let tenants: AgentTenant[];
let network: string;
let scan: PromptScan | undefined;
let policy: AgentPolicy | undefined;
try {
  tenants = loadAgentTenants(values.tenants, tenantIds, process.env);
  network = payingNetwork(process.env);
  if (policyOn) policy = { policies: loadPolicies(values.tenants, tenants.map((t) => t.id)), ledger: new SpendLedger(spendDir) };
} catch (e) {
  if (e instanceof SetupError) fail(e.message);
  throw e;
}
if (policy) {
  try { policy.ledger.ensureWritable(); } catch (e) { fail(`--spend-dir: ${(e as Error).message}`); }
}
if (promptMask) {
  try {
    scan = new PromptScan({
      scanner,
      names: true,
      residual,
      presidio: scanner === "client" ? undefined : presidioClient({ url: presidioUrl, threshold, timeoutMs: presidioTimeoutMs, extraEntities: values["presidio-extra-entities"] }),
    });
  } catch (e) {
    fail(`--presidio-extra-entities: ${(e as Error).message}`);
  }
}
const byId = new Map(tenants.map((t) => [t.id, t]));
const ids = new Set(byId.keys());
const queue = new AccountQueue();
const log = (line: string) => console.log(line);
const makeModel = () => new BedrockModel({ region: values.region, modelId: values["model-id"], maxTokens: agentMaxTokens });

// The scanner's start-up check (Presidio answers and finds the test sentence). A failure is reported, not fatal:
// every run masks again and refuses when Presidio does not answer (fail closed).
let presidioState = scan?.usesPresidio ? "checking" : promptMask ? "not used (client patterns only)" : "not used (prompt masking off)";
if (scan?.usesPresidio) {
  scan.ready(presidioWaitMs).then(
    () => { presidioState = "ready"; console.log(`[agent] Presidio ready at ${presidioUrl}`); },
    (e: unknown) => { presidioState = `not ready: ${e instanceof Error ? e.message : String(e)}`; console.error(`[agent] Presidio is not ready at ${presidioUrl} (${presidioState}); runs are refused until it answers`); },
  );
}

const hostOk = (req: IncomingMessage) => allowedHosts.includes((req.headers.host ?? "").toLowerCase());
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://agent").pathname;
    if (!hostOk(req)) return json(res, 403, { error: "this Host is not in --allowed-hosts" });
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, tenants: tenants.length, network, presidio: presidioState });
    if (req.method === "GET" && path === "/tenants") return json(res, 200, { network, tenants: publicTenants(tenants) });
    if (req.method === "GET" && path === "/policy") return json(res, 200, policy ? { on: true, tenants: policyViews(tenants, policy) } : { on: false });
    if (req.method === "POST" && path === "/run") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "send application/json" });
      const raw = await readBody(req, bodyMax);
      if (raw === null) return json(res, 413, { error: `body over --body-max-bytes (${bodyMax})` });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "body must be JSON" }); }
      const run = parseRunRequest(body, ids);
      if ("error" in run) return json(res, 400, { error: run.error });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
      res.flushHeaders();
      // A hang-up or the run's timeout cancels until the payment is signed (runAgentJob ignores it after).
      const stop = new AbortController();
      let finished = false;
      res.on("close", () => { if (!finished) stop.abort(); });
      const timer = setTimeout(() => stop.abort(), runTimeoutMs);
      try {
        await runAgentJob(run, { tenants: byId, console: consoleUrl, paywall: paywallUrl, scan, promptMask, makeModel, maxTurns, ...(maxAmount ? { maxAmount } : {}), ...(policy ? { policy } : {}), ...(receiptCheck ? { receiptCheck } : {}), refundPollMs, refundPollMax, ...(ap2Check ? { ap2Check } : {}), ...(mandates ? { mandates } : {}), ...(reEstimate ? { reEstimate } : {}), queue, tenantLabel, log, defaultOfferMode },
          (e) => { if (!res.writableEnded && !res.destroyed) res.write(sseFrame(e)); }, stop.signal);
      } catch (e) {
        if (!res.writableEnded && !res.destroyed) res.write(sseFrame({ type: "error", reason: `the agent service failed: ${e instanceof Error ? e.message : String(e)}` }));
        console.error(`[agent] run failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        finished = true;
        clearTimeout(timer);
        if (!res.writableEnded) res.end();
      }
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    else res.end();
  }
}).listen(port, host, () => {
  console.log(`[agent] listening on ${host}:${port}; hosts ${allowedHosts.join(",")}`);
  console.log(`[agent] tenants ${tenants.map((t) => `${t.id}=${t.accountId}`).join(", ")} on ${network}; keys from ${tenants.map((t) => t.keyVariable).join(", ")} (values not shown)`);
  console.log(`[agent] Bedrock ${values["model-id"]} in ${values.region}; auth ${awsAuth === "bearer" ? "bearer token from AWS_BEARER_TOKEN_BEDROCK" : "AWS credential chain"}; prompt masking ${promptMask ? `${scan!.describe()}${residual ? ", residual check" : ""}` : "off"}`);
  console.log(`[agent] console ${consoleUrl}; paywall ${paywallUrl}; per-payment limit ${maxAmount ? `${maxAmount} USDC` : "none (--agent-max-amount unset)"}; run timeout ${runTimeoutMs / 1000} s`);
  console.log(policy
    ? `[agent] spending policy on (tenant.json "policy"): ${policyViews(tenants, policy).map((v) => ("error" in v ? `${v.id} ${v.error}` : `${v.id} auto-pay <= ${v.autoApproveMaxUsd}, max ${v.maxPerJobUsd}/job, ${v.dailyCapUsd}/day (spent ${v.spentTodayUsd})${v.requireAttestedRoute ? ", attested route only" : ""}`)).join("; ")}; ledger ${spendDir}`
    : "[agent] spending policy off (--agent-policy off): every quote within --agent-max-amount is paid");
  console.log(ap2Check
    ? `[agent] signed-quote check on: each quote is verified with the pinned AP2 key ${ap2Check.kids.join(", ")} from ${ap2Check.keyPath} before the policy (skew ${ap2Check.skewSec} s)`
    : "[agent] signed-quote check off (--ap2-verify off)");
  console.log(mandates
    ? `[agent] checkout mandates on: audience ${mandates.aud}, ${mandates.lifetimeSec} s; tenants with a mandate key: ${[...mandates.keys].map(([t, k]) => `${t} (${k.kid})`).join(", ") || "none"}${tenantIds.filter((t) => !mandates!.keys.has(t)).length ? `; without (cannot pay such a job): ${tenantIds.filter((t) => !mandates!.keys.has(t)).map((t) => `${t} ${mandateKeyVariable(t)}`).join(", ")}` : ""}`
    : "[agent] checkout mandates off (--ap2-mandate off)");
  console.log(reEstimate
    ? "[agent] re-estimate on: each estimate-first job's folder is re-sized right before paying; grown or not checkable = refused, nothing signed or paid"
    : "[agent] re-estimate off (--re-estimate off)");
  console.log(receiptCheck
    ? `[agent] receipt check on: each paid job's receipt is verified with the pinned key ${receiptCheck.keyId} from ${receiptCheck.keyPath} (asked ${receiptPollMax} times, ${receiptPollMs} ms apart)`
    : "[agent] receipt check off (--receipt-verify off)");
});

/**
 * quote-agents: Jupiter's private data plane for Signatory's quote flow (privateAI-design-44).
 *
 *   node services/quote-agents/src/main.ts [flags]          (paths are relative to the working directory: the repo root)
 *
 *   --host 127.0.0.1           listen address; a non-loopback address needs --allow-non-loopback (inside a container)
 *   --port 8785
 *   --allow-non-loopback
 *   --data-root sample-data/quote          one folder per tenant (dataDir in the registry)
 *   --tenants config/quote-tenants.json    tenant registry: LEI, token variable NAME, agent aliases -> paths
 *   --as-of 2026-11-16         fixed "today" so runs repeat
 *   --ai off|nearai|bedrock    off = rules only (default)
 *   --model ID                 gateway model id (default nearai/deepseek-v4.1-flash; bedrock/nemotron-nano-3-30b with --ai bedrock)
 *   --gateway-url URL          default http://127.0.0.1:8720 (compose: http://gateway:8700)
 *   --gateway-key-env NAME     variable holding the gateway key (default CHAINAIM_GATEWAY_KEY); never printed
 *   --gateway-key-file PATH    or read the key from this file (compose: the gateway-key secret); wins over the variable
 *   --attest on|off            verify each AI call with ca-attest (default on with --ai nearai, else off)
 *   --attest-url URL           default http://127.0.0.1:8770 (compose: http://attest:8770)
 *   --attest-wait-ms 5000      wait this long for the verdict, else "pending"
 *   --timeout-ms 60000         per model call (and per attest call)
 *   --temperature 0.2
 *   --prompts-dir config/quote-prompts     seller-round.md, ceo-brief.md
 *   --probe-ms 3000            /healthz probe timeout for the gateway and ca-attest
 *
 *   GET  /healthz                                   {ok, asOf, ai, model, gateway:{ok}, attest:{ok}, tenants}
 *   POST /v1/tenants/{t}/agents/inventory           design §4
 *   POST /v1/tenants/{t}/agents/logistics
 *   POST /v1/tenants/{t}/agents/treasury
 *   POST /v1/tenants/{t}/seller/synthesize
 *   buyer tenants (buyer-policy.json in their data folder, e.g. tommy-hilfiger-europe; src/buyer.ts):
 *   POST /v1/tenants/{t}/agents/treasury   (buyer treasury: within budget, approver, cash)
 *   POST /v1/tenants/{t}/buyer/synthesize  (accept or counter the seller's ask, rules)
 * Agent-call feed (src/feed.ts): --feed-url http://near-watch:8790 [--feed-key-env NEAR_WATCH_INGEST_KEY] [--feed-timeout-ms 2000]
 *   sends one {v:1, event:"agent_call", ...} record per answered or refused call to <feed-url>/ingest/agent (ids only).
 * Every POST: Authorization: Bearer <tenant token>, X-Agent-Alias, X-Agent-LEI; tokens come from the variables named by
 * the registry (QUOTE_TOKEN_JUPITER, QUOTE_TOKEN_TOMMY). Errors: {error:{code, message}}.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ApiError, isIsoDate, loadTenantData, type TenantData } from "./data.ts";
import { agentCallRecord, createFeed, type FeedConfig } from "./feed.ts";
import { buyerSynthesize, buyerTreasury, isBuyerDir, loadBuyerData, parseBuyerSynthesizeRequest, parseBuyerTreasuryRequest, type BuyerData } from "./buyer.ts";
import { inventory, parseInventoryRequest } from "./inventory.ts";
import { logistics, parseLogisticsRequest } from "./logistics.ts";
import { parseSynthesizeRequest } from "./rules.ts";
import { loadPrompts, synthesize, type AiConfig, type Fetch } from "./synthesize.ts";
import { authorize, loadTenants, type Registry } from "./tenants.ts";
import { parseTreasuryRequest, treasury } from "./treasury.ts";

export type QuoteConfig = {
  host: string;
  port: number;
  asOf: string;
  dataRoot: string;
  tenantsPath: string;
  probeMs: number;
  ai: AiConfig;
  /** Agent-call feed to the admin UI's near-watch (src/feed.ts); null = off. */
  feed: FeedConfig | null;
};

const whole = (name: string, v: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number ${min}-${max}, got ${v}`);
  return n;
};
const httpUrl = (name: string, v: string): string => {
  if (!/^https?:\/\//.test(v) || !URL.canParse(v)) throw new Error(`--${name} must be an http(s) URL, got ${v}`);
  return v.replace(/\/+$/, "");
};

/** Parse and check every flag. Throws an Error naming the flag (never a key value). */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): QuoteConfig {
  const { values: f } = parseArgs({
    args: argv,
    strict: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8785" },
      "allow-non-loopback": { type: "boolean", default: false },
      "data-root": { type: "string", default: "sample-data/quote" },
      tenants: { type: "string", default: "config/quote-tenants.json" },
      "as-of": { type: "string", default: "2026-11-16" },
      ai: { type: "string", default: "off" },
      model: { type: "string" },
      "gateway-url": { type: "string", default: "http://127.0.0.1:8720" },
      "gateway-key-env": { type: "string", default: "CHAINAIM_GATEWAY_KEY" },
      "gateway-key-file": { type: "string" },
      attest: { type: "string" },
      "attest-url": { type: "string", default: "http://127.0.0.1:8770" },
      "attest-wait-ms": { type: "string", default: "5000" },
      "timeout-ms": { type: "string", default: "60000" },
      temperature: { type: "string", default: "0.2" },
      "prompts-dir": { type: "string", default: "config/quote-prompts" },
      "probe-ms": { type: "string", default: "3000" },
      "feed-url": { type: "string" },
      "feed-key-env": { type: "string", default: "NEAR_WATCH_INGEST_KEY" },
      "feed-timeout-ms": { type: "string", default: "2000" },
    },
  });
  if (!f["allow-non-loopback"] && !["127.0.0.1", "::1", "localhost"].includes(f.host!)) throw new Error("--host must be a loopback address (inside a container, add --allow-non-loopback)");
  if (f["allow-non-loopback"] && !/^[0-9a-fA-F.:]+$/.test(f.host!)) throw new Error(`--host must be an IP address such as 0.0.0.0, got ${f.host}`);
  if (!isIsoDate(f["as-of"])) throw new Error(`--as-of must be a YYYY-MM-DD date, got ${f["as-of"]}`);
  const ai = f.ai!;
  if (ai !== "off" && ai !== "nearai" && ai !== "bedrock") throw new Error(`--ai must be off, nearai or bedrock, got ${ai}`);
  const model = f.model ?? (ai === "bedrock" ? "bedrock/nemotron-nano-3-30b" : "nearai/deepseek-v4.1-flash");
  if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) throw new Error(`--model must be a gateway model id like nearai/deepseek-v4.1-flash, got ${model}`);
  const attestFlag = f.attest ?? (ai === "nearai" ? "on" : "off");
  if (attestFlag !== "on" && attestFlag !== "off") throw new Error(`--attest must be on or off, got ${attestFlag}`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(f["gateway-key-env"]!)) throw new Error("--gateway-key-env must be an environment variable NAME, not a key");
  let gatewayKey: string | undefined;
  if (f["gateway-key-file"] !== undefined) {
    try {
      gatewayKey = readFileSync(f["gateway-key-file"], "utf8").trim() || undefined;
    } catch (e) {
      throw new Error(`--gateway-key-file: cannot read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    if (!gatewayKey) throw new Error("--gateway-key-file is empty");
  } else gatewayKey = env[f["gateway-key-env"]!]?.trim() || undefined;
  const temperature = Number(f.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error(`--temperature must be 0-2, got ${f.temperature}`);
  const port = whole("port", f.port!, 1, 65535);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(f["feed-key-env"]!)) throw new Error("--feed-key-env must be an environment variable NAME, not a key");
  const feedKey = env[f["feed-key-env"]!]?.trim() || undefined;
  // a feed URL without its key is not an error: the answers do not depend on the feed (main() warns once)
  const feed = f["feed-url"] !== undefined && feedKey ? { url: httpUrl("feed-url", f["feed-url"]), key: feedKey, timeoutMs: whole("feed-timeout-ms", f["feed-timeout-ms"]!, 100, 60000) } : null;
  if (f["feed-url"] !== undefined) httpUrl("feed-url", f["feed-url"]);
  return {
    host: f.host!,
    port,
    asOf: f["as-of"]!,
    dataRoot: resolve(f["data-root"]!),
    tenantsPath: resolve(f.tenants!),
    probeMs: whole("probe-ms", f["probe-ms"]!, 100, 60000),
    feed,
    ai: {
      ai,
      model,
      gatewayUrl: httpUrl("gateway-url", f["gateway-url"]!),
      gatewayKey,
      attestUrl: httpUrl("attest-url", f["attest-url"]!),
      attest: attestFlag === "on",
      timeoutMs: whole("timeout-ms", f["timeout-ms"]!, 1000, 600000),
      attestWaitMs: whole("attest-wait-ms", f["attest-wait-ms"]!, 0, 600000),
      temperature,
      prompts: loadPrompts(resolve(f["prompts-dir"]!)),
    },
  };
}

export type Loaded = { registry: Registry; data: Map<string, TenantData>; buyers: Map<string, BuyerData> };

/** Load the registry and each tenant's data folder that has one (a tenant without data answers 404 on every path). */
export function loadAll(cfg: Pick<QuoteConfig, "dataRoot" | "tenantsPath">): Loaded {
  const registry = loadTenants(cfg.tenantsPath);
  const data = new Map<string, TenantData>();
  const buyers = new Map<string, BuyerData>();
  for (const t of Object.values(registry)) {
    const dir = join(cfg.dataRoot, t.dataDir);
    try {
      if (isBuyerDir(dir)) buyers.set(t.id, loadBuyerData(dir));
      else if (existsSync(join(dir, "products.json"))) data.set(t.id, loadTenantData(dir));
    } catch (e) {
      throw new Error(`tenant ${t.id} (${dir}): ${(e as Error).message}`);
    }
  }
  return { registry, data, buyers };
}

const log = (event: string, fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");

const MAX_BODY = 256 * 1024;
const send = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
};
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(400, "body_too_large", `body over ${MAX_BODY} bytes`);
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "the body is not JSON");
  }
}

async function probe(f: Fetch, url: string, ms: number): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(ms) });
    await res.arrayBuffer();
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "TimeoutError" ? `no answer within ${ms} ms` : (e as Error).message };
  }
}

const ROUTE = /^\/v1\/tenants\/([^/]+)\/((?:agents|seller|buyer)\/[a-z-]+)$/;
const PATHS = new Set(["agents/inventory", "agents/logistics", "agents/treasury", "seller/synthesize"]);
/** Paths a buyer tenant (buyer-policy.json in its data folder) answers. */
const BUYER_PATHS = new Set(["agents/treasury", "buyer/synthesize"]);

export function createQuoteServer(cfg: QuoteConfig, loaded: Loaded, env: NodeJS.ProcessEnv, f: Fetch = fetch) {
  const feed = createFeed(cfg.feed, f, (message) => log("feed_error", { message }));
  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://local");
    let callTenant: string | null = null;
    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") throw new ApiError(404, "unknown_route", "GET /healthz");
        const ai = cfg.ai.ai !== "off";
        const [gateway, attest] = await Promise.all([
          ai ? probe(f, `${cfg.ai.gatewayUrl}/healthz`, cfg.probeMs) : Promise.resolve({ ok: false, error: "not used (--ai off)" }),
          ai && cfg.ai.attest ? probe(f, `${cfg.ai.attestUrl}/healthz`, cfg.probeMs) : Promise.resolve({ ok: false, error: "not used (--attest off)" }),
        ]);
        return send(res, 200, { ok: true, service: "quote-agents", asOf: cfg.asOf, ai: cfg.ai.ai, model: ai ? cfg.ai.model : null, gateway, attest, tenants: Object.keys(loaded.registry) });
      }
      const m = ROUTE.exec(url.pathname);
      if (!m) throw new ApiError(404, "unknown_route", `no route ${url.pathname}`);
      const tenantId = decodeURIComponent(m[1]!);
      callTenant = tenantId;
      const path = m[2]!;
      const caller = authorize(loaded.registry, env, tenantId, path, req.headers);
      const data = loaded.data.get(tenantId);
      const buyer = loaded.buyers.get(tenantId);
      if (req.method !== "POST" || !(data ? PATHS.has(path) : buyer ? BUYER_PATHS.has(path) : false)) throw new ApiError(404, "unknown_path", `${tenantId} has no POST ${path}`);
      const raw = await readBody(req);
      const requestId = (raw as { requestId?: unknown })?.requestId;
      let out: object;
      if (buyer) out = path === "agents/treasury" ? buyerTreasury(buyer, parseBuyerTreasuryRequest(raw)) : buyerSynthesize(buyer, parseBuyerSynthesizeRequest(raw));
      else if (!data) throw new ApiError(404, "unknown_path", `${tenantId} has no POST ${path}`);
      else if (path === "agents/inventory") out = inventory(data, cfg.asOf, parseInventoryRequest(raw));
      else if (path === "agents/logistics") out = logistics(data, parseLogisticsRequest(raw));
      else if (path === "agents/treasury") out = treasury(data, cfg.asOf, parseTreasuryRequest(raw));
      else out = await synthesize(cfg.ai, data.policy, parseSynthesizeRequest(raw), f);
      const source = "source" in out ? (out as { source: string }).source : undefined;
      log("answer", { tenant: tenantId, alias: caller.alias, path, requestId, status: 200, ms: Date.now() - started, ...(source ? { source } : {}) });
      feed?.send(agentCallRecord({ tenant: tenantId, alias: caller.alias, path, status: 200, ms: Date.now() - started, source, requestId }));
      return send(res, 200, { requestId, ...out });
    } catch (e) {
      if (e instanceof ApiError) {
        log("refused", { path: url.pathname, status: e.status, code: e.code, ms: Date.now() - started });
        if (url.pathname !== "/healthz") feed?.send(agentCallRecord({ tenant: callTenant, alias: req.headers["x-agent-alias"], path: url.pathname, status: e.status, ms: Date.now() - started, code: e.code }));
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      log("error", { path: url.pathname, message: (e as Error).message });
      feed?.send(agentCallRecord({ tenant: callTenant, alias: req.headers["x-agent-alias"], path: url.pathname, status: 500, ms: Date.now() - started, code: "internal" }));
      return send(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cfg: QuoteConfig;
  let loaded: Loaded;
  try {
    cfg = parseConfig(process.argv.slice(2), process.env);
    loaded = loadAll(cfg);
  } catch (e) {
    process.stderr.write(`[quote-agents] ${(e as Error).message}\n`);
    process.exit(2);
  }
  for (const t of Object.values(loaded.registry)) if (!process.env[t.tokenEnv]?.trim()) process.stdout.write(`[quote-agents] ${t.tokenEnv} is not set: every call to ${t.id} answers 401\n`);
  createQuoteServer(cfg, loaded, process.env).listen(cfg.port, cfg.host, () => {
    process.stdout.write(`quote-agents on http://${cfg.host}:${cfg.port}; as-of ${cfg.asOf}; ai ${cfg.ai.ai}${cfg.ai.ai !== "off" ? ` (${cfg.ai.model} via ${cfg.ai.gatewayUrl}, attest ${cfg.ai.attest ? cfg.ai.attestUrl : "off"})` : ""}; tenants with data: ${[...loaded.data.keys(), ...[...loaded.buyers.keys()].map((k) => `${k} (buyer)`)].join(", ")}; agent-call feed ${cfg.feed ? cfg.feed.url : "off"}\n`);
  });
  if (!cfg.feed && process.argv.some((a) => a === "--feed-url" || a.startsWith("--feed-url="))) process.stdout.write("[quote-agents] --feed-url is set but its key variable (--feed-key-env) is empty: the agent-call feed is off\n");
}

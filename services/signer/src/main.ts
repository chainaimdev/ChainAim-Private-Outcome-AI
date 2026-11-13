/**
 * ca-control-signer: ChainAim's signer as its own service (privateAI-design-36 ARCH-660). The control plane of a paid job:
 * it holds ChainAim's two signing keys (AP2 quote ES256, receipt Ed25519) and nothing of the buyer's. The data plane
 * (test-console, on the buyer's machine) calls it over HTTP with sizes, ids, hashes and amounts only; packages/signer
 * refuses anything else by field name (ARCH-661).
 *
 * Portable by design: zero npm dependencies, every setting a flag (or the platform's environment for the keys), keys only
 * from the environment, stateless except the in-memory set of accepted mandate nonces. The same image runs in its own
 * compose project on the PC (services/signer/compose.yml), on Railway or on AWS behind the platform's HTTPS.
 *
 *   node services/signer/src/main.ts --pricing-catalog FILE --fee-per-model-call-usd D --fee-analyst-usd D
 *        --near-gas-fee-usd D --margin-pct D --min-price-usd D --terms-url URL [options]
 *
 *   --host H                       listen address (default 127.0.0.1; 0.0.0.0 in a container)
 *   --port N                       default 8780 (a platform's PORT environment variable wins when --port is not given)
 *   --request-key-env NAME         the shared request key the data plane sends as X-Signer-Key (default SIGNER_REQUEST_KEY,
 *                                  at least 32 characters)
 *   --ap2-key-env NAME             PKCS#8 PEM EC P-256 key (default AP2_SIGNING_KEY)
 *   --receipt-key-env NAME         PKCS#8 PEM Ed25519 key (default RECEIPT_SIGNING_KEY)
 *   --pricing-catalog FILE         the model catalog the console prices with (inputPerM / outputPerM)
 *   --fee-* / --margin-pct / --min-price-usd   the fee settings (the console's paid-job flags, same names)
 *   --cost-model FILE              config/cost-model.json (desk.ps1 -Calibrate); none = no estimate-first offers
 *   --terms-url URL                the checkout's terms_of_service link
 *   --mandate-keys FILE            config/ap2-mandate-keys.json (tenants' PUBLIC mandate keys); none = no mandate checks
 *   --mandate-audience ID          the business id a mandate must be addressed to (default chainaim)
 *   --mandate-skew-sec N           clock skew allowed on mandate times (default 30)
 *   --mandate-max-lifetime-sec N   the longest mandate accepted (default 900)
 *   --max-body-bytes N             largest request body (default 1048576)
 *
 * Routes: GET /healthz, GET /.well-known/keys, GET /.well-known/ucp (public); POST /v1/price, /v1/quotes, /v1/receipts,
 * /v1/receipts/settle, /v1/mandates/verify (X-Signer-Key). 400 = a field the allowlist refuses, 409 = a request that does
 * not match what this signer signed, 422 = a refused mandate {ok:false, code, reason}. Logs: route, status, ms and the
 * job id; never a body, a key or a token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMandateRegistry, signerFromEnv as ap2SignerFromEnv } from "../../../packages/ap2/src/index.ts";
import { signerFromEnv as receiptSignerFromEnv } from "../../../packages/receipt/src/index.ts";
import { parseCostModel } from "../../../packages/offer/src/index.ts";
import { parseDecimal, pricesFromCatalog, type Fees } from "../../../packages/crossask/src/cost.ts";
import {
  parseMandateRequest,
  parsePriceRequest,
  parseQuoteRequest,
  parseReceiptRequest,
  parseSettleRequest,
  SellerSigner,
  SignerInputError,
  SignerScopeError,
  ucpProfile,
  type MandateSettings,
} from "../../../packages/signer/src/index.ts";

const FEE_FLAGS = ["fee-per-model-call-usd", "fee-analyst-usd", "near-gas-fee-usd", "margin-pct", "min-price-usd"] as const;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export class SignerSetupError extends Error {}

export type SignerFlags = Record<string, string | undefined>;
export type SignerServerConfig = { host: string; port: number; requestKey: string; maxBodyBytes: number; signer: SellerSigner };

const readJson = (path: string, what: string): unknown => {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { throw new SignerSetupError(`${what} ${path} cannot be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"})`); }
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { throw new SignerSetupError(`${what} ${path} is not JSON`); }
};
const whole = (raw: string | undefined, fallback: number, name: string, lo: number, hi: number): number => {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new SignerSetupError(`--${name} must be a whole number from ${lo} to ${hi}, got ${raw}`);
  return n;
};
const envName = (v: string | undefined, fallback: string, flag: string): string => {
  const n = v ?? fallback;
  if (!ENV_NAME.test(n)) throw new SignerSetupError(`--${flag} must be an environment variable name, got ${n}`);
  return n;
};

/** The checked configuration, or a SignerSetupError naming the flag or the variable (never a value). */
export function signerServerConfig(flags: SignerFlags, env: Record<string, string | undefined>): SignerServerConfig {
  const requestKeyEnv = envName(flags["request-key-env"], "SIGNER_REQUEST_KEY", "request-key-env");
  const requestKey = env[requestKeyEnv]?.trim() ?? "";
  if (requestKey.length < 32) throw new SignerSetupError(`${requestKeyEnv} must hold the request key the data plane sends (at least 32 characters; desk.ps1 -SignerKeys makes one)`);
  let ap2, receipt;
  try { ap2 = ap2SignerFromEnv(env, envName(flags["ap2-key-env"], "AP2_SIGNING_KEY", "ap2-key-env")); } catch (e) { throw new SignerSetupError((e as Error).message); }
  try { receipt = receiptSignerFromEnv(env, envName(flags["receipt-key-env"], "RECEIPT_SIGNING_KEY", "receipt-key-env")); } catch (e) { throw new SignerSetupError((e as Error).message); }
  if (!flags["pricing-catalog"]) throw new SignerSetupError("--pricing-catalog FILE is required: the signer prices every job itself");
  let prices;
  try { prices = pricesFromCatalog(readJson(flags["pricing-catalog"], "--pricing-catalog")); } catch (e) { throw e instanceof SignerSetupError ? e : new SignerSetupError(`--pricing-catalog: ${(e as Error).message}`); }
  for (const f of FEE_FLAGS) {
    const v = flags[f];
    if (v === undefined || v === "") throw new SignerSetupError(`--${f} is required (a non-negative decimal, the same value the console's paid jobs use)`);
    try { parseDecimal(v, `--${f}`); } catch (e) { throw new SignerSetupError((e as Error).message); }
  }
  const fees: Fees = { perModelCallUsd: flags["fee-per-model-call-usd"]!, analystUsd: flags["fee-analyst-usd"]!, nearGasUsd: flags["near-gas-fee-usd"]!, marginPct: flags["margin-pct"]!, minPriceUsd: flags["min-price-usd"]! };
  const cmFile = flags["cost-model"] ?? "none";
  let costModel;
  if (cmFile !== "none") {
    try { costModel = parseCostModel(readJson(cmFile, "--cost-model")); } catch (e) { throw e instanceof SignerSetupError ? e : new SignerSetupError(`--cost-model ${cmFile}: ${(e as Error).message}`); }
  }
  const termsUrl = flags["terms-url"];
  if (!termsUrl || !URL.canParse(termsUrl) || !/^https?:$/.test(new URL(termsUrl).protocol)) throw new SignerSetupError("--terms-url URL is required: the checkout's terms_of_service link (http or https)");
  const mkFile = flags["mandate-keys"] ?? "none";
  let mandates: MandateSettings | undefined;
  if (mkFile !== "none") {
    let registry;
    try { registry = parseMandateRegistry(readJson(mkFile, "--mandate-keys")); } catch (e) { throw e instanceof SignerSetupError ? e : new SignerSetupError(`--mandate-keys ${mkFile}: ${(e as Error).message}`); }
    const aud = flags["mandate-audience"] ?? "chainaim";
    if (!/^[\x21-\x7E]{1,200}$/.test(aud)) throw new SignerSetupError("--mandate-audience must be 1 to 200 printable characters");
    mandates = { registry, aud, skewSec: whole(flags["mandate-skew-sec"], 30, "mandate-skew-sec", 0, 600), maxLifetimeSec: whole(flags["mandate-max-lifetime-sec"], 900, "mandate-max-lifetime-sec", 30, 86_400) };
  } else {
    for (const f of ["mandate-audience", "mandate-skew-sec", "mandate-max-lifetime-sec"]) if (flags[f] !== undefined) throw new SignerSetupError(`--${f} needs --mandate-keys FILE`);
  }
  const portRaw = flags.port ?? env.PORT;
  return {
    host: flags.host ?? "127.0.0.1",
    port: whole(portRaw, 8780, "port", 0, 65535),
    requestKey,
    maxBodyBytes: whole(flags["max-body-bytes"], 1_048_576, "max-body-bytes", 1024, 16_777_216),
    signer: new SellerSigner({ ap2, receipt, pricing: { prices, fees, round: "cent", ...(costModel ? { costModel } : {}) }, termsUrl, ...(mandates ? { mandates } : {}) }),
  };
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage, max: number): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) over = true; else chunks.push(c); });
    req.on("error", () => resolve({ ok: false, status: 400, error: "the request body could not be read" }));
    req.on("end", () => {
      if (over) return resolve({ ok: false, status: 413, error: `the request body is larger than ${max} bytes` });
      try { resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { resolve({ ok: false, status: 400, error: "the request body must be JSON" }); }
    });
  });
}

/** The request handler (exported for the tests, which run it on a loopback port). */
export function signerHandler(cfg: SignerServerConfig, log: (line: string) => void = (l) => console.log(l)): (req: IncomingMessage, res: ServerResponse) => void {
  const want = Buffer.from(cfg.requestKey, "utf8");
  const s = cfg.signer;
  const routes: Record<string, (body: unknown) => { status: number; body: unknown; jobId?: string }> = {
    "/v1/price": (b) => ({ status: 200, body: s.price(parsePriceRequest(b)) }),
    "/v1/quotes": (b) => { const r = parseQuoteRequest(b); return { status: 200, body: s.signQuote(r), jobId: r.jobId }; },
    "/v1/receipts": (b) => { const r = parseReceiptRequest(b); return { status: 200, body: s.signReceipt(r), jobId: r.body.jobId }; },
    "/v1/receipts/settle": (b) => { const r = parseSettleRequest(b); return { status: 200, body: s.settle(r), jobId: r.receipt.body.jobId }; },
    "/v1/mandates/verify": (b) => { const r = parseMandateRequest(b); const v = s.verifyMandate(r); return { status: v.ok ? 200 : 422, body: v, jobId: r.jobId }; },
  };
  return (req, res) => {
    const t0 = performance.now();
    const path = new URL(req.url ?? "/", "http://signer").pathname;
    const done = (status: number, body: unknown, jobId?: string): void => {
      send(res, status, body);
      log(JSON.stringify({ ts: new Date().toISOString(), route: path, status, ms: Math.round(performance.now() - t0), ...(jobId ? { jobId } : {}) }));
    };
    if (req.method === "GET") {
      req.resume();
      if (path === "/healthz") { const k = s.keys(); return done(200, { ok: true, ap2Kid: k.ap2!.keys[0].kid, receiptKeyId: k.receipt!.keyId, mandates: k.mandateAudience !== undefined }); }
      if (path === "/.well-known/keys") return done(200, s.keys());
      if (path === "/.well-known/ucp") return done(200, ucpProfile(s.keys().ap2!.keys[0]));
      return done(404, { error: "not found" });
    }
    const route = req.method === "POST" ? routes[path] : undefined;
    if (!route) { req.resume(); return done(404, { error: "not found" }); }
    const given = Buffer.from(String(req.headers["x-signer-key"] ?? ""), "utf8");
    if (given.length !== want.length || !timingSafeEqual(given, want)) { req.resume(); return done(401, { error: "X-Signer-Key is missing or wrong" }); }
    void readBody(req, cfg.maxBodyBytes).then((b) => {
      if (!b.ok) return done(b.status, { error: b.error });
      try {
        const out = route(b.value);
        done(out.status, out.body, out.jobId);
      } catch (e) {
        if (e instanceof SignerInputError) return done(400, { error: e.message });
        if (e instanceof SignerScopeError) return done(409, { error: e.message });
        // An unexpected failure: the reason is logged without any value (messages here never carry one) and nothing is signed.
        log(JSON.stringify({ ts: new Date().toISOString(), route: path, event: "signer_error", reason: String((e as Error).message ?? e).slice(0, 200) }));
        done(500, { error: "the signer could not complete this request; nothing was signed" });
      }
    });
  };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const options = Object.fromEntries(
    ["host", "port", "request-key-env", "ap2-key-env", "receipt-key-env", "pricing-catalog", ...FEE_FLAGS, "cost-model", "terms-url", "mandate-keys", "mandate-audience", "mandate-skew-sec", "mandate-max-lifetime-sec", "max-body-bytes"].map((n) => [n, { type: "string" as const }]),
  );
  let cfg: SignerServerConfig;
  try {
    cfg = signerServerConfig(parseArgs({ strict: true, options }).values as SignerFlags, process.env);
  } catch (e) {
    process.stderr.write(`[ca-control-signer] ${(e as Error).message}\n`);
    process.exit(2);
  }
  const server = createServer(signerHandler(cfg));
  server.listen(cfg.port, cfg.host, () => {
    const a = server.address();
    const k = cfg.signer.keys();
    console.log(`[ca-control-signer] listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : cfg.port}  AP2 key ${k.ap2!.keys[0].kid}  receipt key ${k.receipt!.keyId}  mandates ${k.mandateAudience !== undefined ? `on (audience ${k.mandateAudience}, tenants ${k.mandateTenants!.join(",")})` : "off"}`);
  });
}

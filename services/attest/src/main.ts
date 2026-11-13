/**
 * ca-attest: checks NEAR AI Cloud's evidence for each model call (PLAN-private-ai-nearai-attestation.md ARCH-409 / ARCH-410).
 *
 *   node src/main.ts [flags]
 *
 *   --host 127.0.0.1            listen address; any non-loopback address needs --allow-non-loopback (inside a container)
 *   --port 8770
 *   --allow-non-loopback        allow --host 0.0.0.0 (container)
 *   --allowed-hosts LIST        accept only these Host headers, host:port comma-separated (default unset: no Host check)
 *   --nearai-base URL           NEAR AI API root (default https://cloud-api.near.ai/v1)
 *   --key-env NAME              environment variable holding the NEAR AI key (default NEARAI_API_KEY); never printed
 *   --signing-algo ecdsa        the only algorithm the EIP-191 recovery covers
 *   --models LIST               served model ids to attest, comma-separated; or
 *   --catalog PATH              the gateway's generated catalog: every deployment with "attest": "nearai" (used when --models is unset)
 *   --report-refresh-sec 900    fetch and verify each model's report this often (and once at start)
 *   --report-history 8          report fetches kept per model
 *   --signature-retry-sec 30    how long to wait for a reply's signature to become available
 *   --signature-retry-ms 2000   wait between signature attempts
 *   --gpu-check on|off          require NVIDIA NRAS's GPU verdict (default on)
 *   --timeout-ms 20000          per request to NEAR AI
 *   --max-calls 16              calls per POST /verify
 *   --verifier-dir DIR          the official verifier, built (default /opt/nearai-cloud-verifier, as the image builds it)
 *   --verifier-log off|on       let the official verifier's own console output through (default off: it prints whole quotes)
 *
 *   GET  /healthz   { ok, service, ready, models }; ready = every model has a report fetch without error
 *   GET  /reports   per model, the latest fetch: fetchedAt, each attestation's signer, verdict, reasons and checks
 *   POST /verify    { calls: [{ chatId, servedModel, requestSha256, responseSha256, calledAt }] } -> { results: [...] }
 *
 * Holds the NEAR AI key (report and signature calls) and nothing else; receives ids and hashes, never text.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { judgeCall, pruneHistory, type CallEvidence, type CallResult, type ReportFetch } from "./judge.ts";
import { fetchReport, fetchSignature, freshNonce, type NearAiOptions } from "./nearai.ts";
import { checkAttestation, loadOfficial, recover, type Official } from "./official.ts";

export type AttestConfig = {
  host: string;
  port: number;
  allowedHosts: string[] | null;
  nearai: NearAiOptions;
  models: string[];
  refreshMs: number;
  historyKeep: number;
  signatureWindowMs: number;
  signatureIntervalMs: number;
  gpuRequired: boolean;
  maxCalls: number;
  verifierDir: string;
  verifierLog: boolean;
};

const onOff = (name: string, v: string): boolean => {
  if (v === "on") return true;
  if (v === "off") return false;
  throw new Error(`--${name} must be on or off, got ${v}`);
};
const whole = (name: string, v: string, min: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a whole number >= ${min}, got ${v}`);
  return n;
};

/** Models whose catalog deployment carries attest "nearai": their served ids. */
export function attestedModelsFromCatalog(path: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`--catalog ${path}: ${(e as Error).message}`);
  }
  const models = (raw as { models?: { deployments?: { attest?: unknown; servedModel?: unknown }[] }[] }).models;
  if (!Array.isArray(models)) throw new Error(`--catalog ${path}: no models array`);
  const ids = models.flatMap((m) => (m.deployments ?? []).filter((d) => d.attest === "nearai" && typeof d.servedModel === "string").map((d) => d.servedModel as string));
  return [...new Set(ids)];
}

/** Parse and check every flag; the key is read from the named variable. Throws Error naming the flag, never a value of the key. */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): AttestConfig {
  const { values: f } = parseArgs({
    args: argv,
    strict: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8770" },
      "allow-non-loopback": { type: "boolean", default: false },
      "allowed-hosts": { type: "string" },
      "nearai-base": { type: "string", default: "https://cloud-api.near.ai/v1" },
      "key-env": { type: "string", default: "NEARAI_API_KEY" },
      "signing-algo": { type: "string", default: "ecdsa" },
      models: { type: "string" },
      catalog: { type: "string" },
      "report-refresh-sec": { type: "string", default: "900" },
      "report-history": { type: "string", default: "8" },
      "signature-retry-sec": { type: "string", default: "30" },
      "signature-retry-ms": { type: "string", default: "2000" },
      "gpu-check": { type: "string", default: "on" },
      "timeout-ms": { type: "string", default: "20000" },
      "max-calls": { type: "string", default: "16" },
      "verifier-dir": { type: "string", default: "/opt/nearai-cloud-verifier" },
      "verifier-log": { type: "string", default: "off" },
    },
  });
  const port = whole("port", f.port!, 1);
  if (port > 65535) throw new Error(`--port must be 1-65535, got ${f.port}`);
  if (!f["allow-non-loopback"] && !["127.0.0.1", "::1", "localhost"].includes(f.host!)) throw new Error("--host must be a loopback address (inside a container, add --allow-non-loopback)");
  if (f["allow-non-loopback"] && !/^[0-9a-fA-F.:]+$/.test(f.host!)) throw new Error(`--host must be an IP address such as 0.0.0.0, got ${f.host}`);
  const allowedHosts = f["allowed-hosts"] === undefined ? null : f["allowed-hosts"].split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowedHosts) {
    if (!allowedHosts.length) throw new Error("--allowed-hosts must list at least one host:port");
    for (const h of allowedHosts) if (!/^[a-z0-9.-]+:\d{1,5}$/.test(h)) throw new Error(`--allowed-hosts entries must be host:port, got ${h}`);
  }
  if (!/^https?:\/\//.test(f["nearai-base"]!) || !URL.canParse(f["nearai-base"]!)) throw new Error(`--nearai-base must be an http(s) URL, got ${f["nearai-base"]}`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(f["key-env"]!)) throw new Error(`--key-env must be an environment variable NAME, not a key`);
  if (f["signing-algo"] !== "ecdsa") throw new Error(`--signing-algo must be ecdsa (the only algorithm EIP-191 recovery covers), got ${f["signing-algo"]}`);
  const apiKey = env[f["key-env"]!]?.trim();
  if (!apiKey) throw new Error(`${f["key-env"]} is not set: ca-attest needs the NEAR AI key for report and signature calls`);
  let models: string[];
  if (f.models !== undefined) models = f.models.split(",").map((m) => m.trim()).filter(Boolean);
  else if (f.catalog !== undefined) models = attestedModelsFromCatalog(f.catalog);
  else throw new Error("give --models or --catalog: which models to attest");
  if (!models.length) throw new Error("no model to attest (--models is empty, or no catalog deployment has attest nearai)");
  for (const m of models) if (!/^[\w.-]+\/[\w.:-]+$/.test(m)) throw new Error(`--models entries must be provider ids like deepseek-ai/DeepSeek-V4.1-Flash-1017, got ${m}`);
  return {
    host: f.host!,
    port,
    allowedHosts,
    nearai: { baseUrl: f["nearai-base"]!, apiKey, signingAlgo: f["signing-algo"]!, timeoutMs: whole("timeout-ms", f["timeout-ms"]!, 1000) },
    models,
    refreshMs: whole("report-refresh-sec", f["report-refresh-sec"]!, 30) * 1000,
    historyKeep: whole("report-history", f["report-history"]!, 2),
    signatureWindowMs: whole("signature-retry-sec", f["signature-retry-sec"]!, 0) * 1000,
    signatureIntervalMs: whole("signature-retry-ms", f["signature-retry-ms"]!, 100),
    gpuRequired: onOff("gpu-check", f["gpu-check"]!),
    maxCalls: whole("max-calls", f["max-calls"]!, 1),
    verifierDir: f["verifier-dir"]!,
    verifierLog: onOff("verifier-log", f["verifier-log"]!),
  };
}

const log = (event: string, fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");

/** Run fn with console.log/console.error silenced (the official verifier prints whole quotes); restored even when fn throws. */
async function quietly<T>(quiet: boolean, fn: () => Promise<T>): Promise<T> {
  if (!quiet) return fn();
  const saved = { log: console.log, error: console.error };
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

export class Attestor {
  private history: ReportFetch[] = [];
  private refreshing = false;
  // Plain fields, not constructor parameter properties: Node's type stripping does not support those.
  private readonly cfg: AttestConfig;
  private readonly official: Official;
  constructor(cfg: AttestConfig, official: Official) {
    this.cfg = cfg;
    this.official = official;
  }

  /** ARCH-409: fetch each model's report with a fresh nonce and run the official checks on every model attestation. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const model of this.cfg.models) {
        const nonce = freshNonce();
        let fetch: ReportFetch;
        try {
          const raw = await fetchReport(this.cfg.nearai, model, nonce);
          const fetchedAt = new Date().toISOString();
          const list = Array.isArray(raw.model_attestations) ? raw.model_attestations : [];
          if (!list.length) fetch = { model, nonce, fetchedAt, attestations: [], error: "the report has no model_attestations" };
          else {
            const attestations = [];
            for (const a of list) attestations.push(await quietly(!this.cfg.verifierLog, () => checkAttestation(this.official, a, model, nonce, this.cfg.gpuRequired)));
            fetch = { model, nonce, fetchedAt, attestations };
          }
        } catch (e) {
          fetch = { model, nonce, fetchedAt: new Date().toISOString(), attestations: [], error: (e as Error).message };
        }
        this.history = pruneHistory([...this.history, fetch], this.cfg.historyKeep);
        log("report", { model, fetchedAt: fetch.fetchedAt, error: fetch.error ?? null, attestations: fetch.attestations.map((a) => ({ signer: a.signingAddress, verified: a.verified, reasons: a.reasons })) });
      }
    } finally {
      this.refreshing = false;
    }
  }

  latest(model: string): ReportFetch | undefined {
    return this.history.filter((r) => r.model === model).sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
  }

  ready(): boolean {
    return this.cfg.models.every((m) => this.history.some((r) => r.model === m && !r.error));
  }

  /** ARCH-410: one call: its signature (bounded retry), EIP-191 recovery, then the rules in judge.ts. */
  async verify(call: CallEvidence): Promise<CallResult> {
    const opts = { signingAlgo: this.cfg.nearai.signingAlgo, attestedModels: this.cfg.models };
    if (!call.chatId || !this.cfg.models.includes(call.servedModel)) return judgeCall(call, { available: false, reason: "not fetched" }, undefined, this.history, opts);
    const sig = await fetchSignature(this.cfg.nearai, call.chatId, call.servedModel, { windowMs: this.cfg.signatureWindowMs, intervalMs: this.cfg.signatureIntervalMs });
    const recovered = sig.available ? recover(this.official, sig.text, sig.signature) : undefined;
    return judgeCall(call, sig, recovered, this.history, opts);
  }

  /** Add a fetch made elsewhere, e.g. the recorded one in test/fixtures (ARCH-410 replay tests), to the history. */
  addFetch(fetch: ReportFetch): void {
    this.history = pruneHistory([...this.history, fetch], this.cfg.historyKeep);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Validate one call of a POST /verify body; returns an error string or the call. */
export function parseCall(v: unknown, i: number): CallEvidence | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `calls[${i}]: an object is required`;
  const c = v as Record<string, unknown>;
  if (c.chatId !== undefined && c.chatId !== null && (typeof c.chatId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(c.chatId))) return `calls[${i}].chatId: an id string`;
  if (typeof c.servedModel !== "string" || !c.servedModel) return `calls[${i}].servedModel: required`;
  for (const k of ["requestSha256", "responseSha256"]) if (typeof c[k] !== "string" || !HEX64.test(c[k] as string)) return `calls[${i}].${k}: 64 lowercase hex characters`;
  if (typeof c.calledAt !== "string" || Number.isNaN(Date.parse(c.calledAt))) return `calls[${i}].calledAt: an ISO time`;
  return { ...(typeof c.chatId === "string" ? { chatId: c.chatId } : {}), servedModel: c.servedModel, requestSha256: c.requestSha256 as string, responseSha256: c.responseSha256 as string, calledAt: c.calledAt };
}

const MAX_BODY = 64 * 1024;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
};
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error(`body over ${MAX_BODY} bytes`), { status: 413 });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("body is not JSON"), { status: 400 });
  }
}

export function createAttestServer(cfg: AttestConfig, attestor: Attestor) {
  return createServer(async (req, res) => {
    try {
      if (cfg.allowedHosts && !cfg.allowedHosts.includes((req.headers.host ?? "").toLowerCase())) return json(res, 403, { error: "this Host is not in --allowed-hosts" });
      const path = new URL(req.url ?? "/", "http://local").pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, service: "attest", ready: attestor.ready(), models: cfg.models, gpuCheck: cfg.gpuRequired });
      if (req.method === "GET" && path === "/reports") {
        return json(res, 200, { models: cfg.models.map((m) => ({ model: m, latest: attestor.latest(m) ?? null })) });
      }
      if (req.method === "POST" && path === "/verify") {
        const body = (await readBody(req)) as { calls?: unknown };
        if (!Array.isArray(body?.calls) || body.calls.length === 0) return json(res, 400, { error: "calls: a non-empty array is required" });
        if (body.calls.length > cfg.maxCalls) return json(res, 400, { error: `calls: at most ${cfg.maxCalls} (--max-calls)` });
        const calls: CallEvidence[] = [];
        for (const [i, c] of body.calls.entries()) {
          const p = parseCall(c, i);
          if (typeof p === "string") return json(res, 400, { error: p });
          calls.push(p);
        }
        const results = await Promise.all(calls.map((c) => attestor.verify(c)));
        log("verify", { results: results.map((r) => ({ chatId: r.chatId, status: r.status, reason: r.reason, detail: r.detail })) });
        return json(res, 200, { results });
      }
      return json(res, 404, { error: "unknown route" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return json(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cfg: AttestConfig;
  try {
    cfg = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`[attest] ${(e as Error).message}\n`);
    process.exit(2);
  }
  const official = await loadOfficial(cfg.verifierDir).catch((e: Error) => {
    process.stderr.write(`[attest] ${e.message}\n`);
    process.exit(2);
  });
  const attestor = new Attestor(cfg, official);
  createAttestServer(cfg, attestor).listen(cfg.port, cfg.host, () => {
    process.stdout.write(`attest on http://${cfg.host}:${cfg.port}; models ${cfg.models.join(", ")}; gpu-check ${cfg.gpuRequired ? "on" : "off"}; key from ${process.argv.includes("--key-env") ? "--key-env" : "NEARAI_API_KEY"}\n`);
  });
  await attestor.refresh();
  setInterval(() => void attestor.refresh(), cfg.refreshMs);
}

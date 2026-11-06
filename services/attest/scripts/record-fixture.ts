/**
 * Records ONE real NEAR AI call as the ca-attest test fixture (PLAN-private-ai-nearai-attestation.md ARCH-409 / ARCH-410:
 * "tests on a recorded real report and signature"). Node built-ins only; the key comes from the environment and is never
 * printed or written. Same requests as gate V2 (scripts/nearai-v2-probe.ts): report first (fresh nonce, provider=near,
 * x-no-aliasing), then one completion in the gateway's exact body shape (provider.data_collection deny, stream false,
 * Accept-Encoding identity, x-no-aliasing), then its signature (bounded retry).
 *
 * Written: the report as NEAR AI returned it (quotes, addresses, compose manifest: public evidence), the nonce and arrival
 * time, the call's chat id, served model, SHA-256 of the request and response bytes and the time before it was sent, and
 * the signature payload. NOT written: the prompt, the answer, the key.
 *
 *   node --env-file=C:\PRIV-AI-SECRETS\chainaim.env services/attest/scripts/record-fixture.ts [flags]
 *   --model ID        default deepseek-ai/DeepSeek-V4.1-Flash-1017
 *   --base URL        default https://cloud-api.near.ai/v1
 *   --out PATH        default services/attest/test/fixtures/nearai-recorded.json
 *   --max-tokens N    default 64
 *   --retries N       signature attempts (default 15)   --retry-ms N   between attempts (default 2000)
 *   --key-env NAME    default NEARAI_API_KEY
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    model: { type: "string", default: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
    base: { type: "string", default: "https://cloud-api.near.ai/v1" },
    out: { type: "string", default: "services/attest/test/fixtures/nearai-recorded.json" },
    "max-tokens": { type: "string", default: "64" },
    retries: { type: "string", default: "15" },
    "retry-ms": { type: "string", default: "2000" },
    "key-env": { type: "string", default: "NEARAI_API_KEY" },
  },
});
const stop = (m: string): never => {
  process.stderr.write(`STOP: ${m}\n`);
  process.exit(2);
};
if (!/^[A-Z_][A-Z0-9_]*$/.test(f["key-env"]!)) stop("--key-env must be a variable NAME");
const key = process.env[f["key-env"]!]?.trim();
if (!key) stop(`${f["key-env"]} is not set (run with --env-file=C:\\PRIV-AI-SECRETS\\chainaim.env)`);
const base = f.base!.replace(/\/+$/, "");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const auth = { authorization: `Bearer ${key}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. the report, before the call
const nonce = randomBytes(32).toString("hex");
const rep = await fetch(`${base}/attestation/report?model=${encodeURIComponent(f.model!)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`, { headers: { ...auth, accept: "application/json", "x-no-aliasing": "true" } });
if (!rep.ok) stop(`report HTTP ${rep.status}`);
const report = (await rep.json()) as Record<string, unknown>;
const fetchedAt = new Date().toISOString();
if (!Array.isArray(report.model_attestations) || report.model_attestations.length === 0) stop("the report has no model_attestations");

// 2. one completion, gateway body shape, bytes sent and hashed as-is
await sleep(1100); // calledAt strictly after fetchedAt
const body = { model: f.model, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: Number(f["max-tokens"]), stream: false, provider: { data_collection: "deny" } };
const reqBytes = new TextEncoder().encode(JSON.stringify(body));
const calledAt = new Date().toISOString();
const res = await fetch(`${base}/chat/completions`, { method: "POST", body: reqBytes, headers: { ...auth, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "x-no-aliasing": "true" } });
const resBytes = new Uint8Array(await res.arrayBuffer());
if (!res.ok) stop(`completion HTTP ${res.status}`);
let chatId: unknown;
try {
  chatId = (JSON.parse(new TextDecoder().decode(resBytes)) as { id?: unknown }).id;
} catch {
  stop("the completion is not JSON");
}
if (typeof chatId !== "string" || !chatId) stop("the completion has no id");

// 3. its signature
let signature: Record<string, unknown> | null = null;
let last = "";
for (let i = 0; i < Number(f.retries); i++) {
  const s = await fetch(`${base}/signature/${encodeURIComponent(chatId as string)}?model=${encodeURIComponent(f.model!)}&signing_algo=ecdsa`, { headers: { ...auth, accept: "application/json" } });
  const j = s.ok ? ((await s.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (j && typeof j.signature === "string" && !j.error_code) {
    signature = j;
    break;
  }
  last = `HTTP ${s.status}${j && typeof j.error_code === "string" ? ` ${j.error_code}` : ""}`;
  await sleep(Number(f["retry-ms"]));
}
if (!signature) stop(`no signature after ${f.retries} attempts (${last})`);

const fixture = {
  recordedWith: "services/attest/scripts/record-fixture.ts",
  recordedAt: new Date().toISOString(),
  model: f.model,
  report: { nonce, fetchedAt, raw: report },
  call: { chatId, servedModel: f.model, requestSha256: sha(reqBytes), responseSha256: sha(resBytes), calledAt },
  signature: {
    text: signature!.text,
    signature: signature!.signature,
    signing_address: signature!.signing_address,
    signing_algo: signature!.signing_algo,
    signature_kind: signature!.signature_kind ?? null,
  },
};
const out = resolve(f.out!);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
process.stdout.write(`recorded ${out}\n  chat id ${chatId}\n  signature_kind ${fixture.signature.signature_kind}\n  signer ${String(fixture.signature.signing_address)}\n  report attestations ${(report.model_attestations as unknown[]).length}\n`);

/**
 * PLAN-private-ai-nearai-attestation.md §4, gate V2 (+ V5): does NEAR AI's per-reply signature cover the EXACT bytes we
 * send and receive? Node built-ins only; reads NEARAI_API_KEY from the environment and never prints it.
 * Follows docs.near.ai/cloud/verification/cloud-api/response-signatures (read 2026-11-06):
 *   request_hash = SHA-256(exact request-body bytes), response_hash = SHA-256(exact response-body bytes),
 *   Accept-Encoding: identity, x-no-aliasing: true, canonical model id;
 *   GET /v1/signature/<chat id>?signing_algo=ecdsa (404 / error_code = not available yet: bounded retry);
 *   signature_kind provider_tee: text = "<MODEL_ID>:<request_hash>:<response_hash>" (the model's TEE signed it);
 *                  gateway:      text = "<request_hash>:<response_hash>"            (NEAR's gateway signed it).
 * Also fetches the model's attestation report BEFORE the call (fresh nonce, provider=near) and checks that the reply's
 * signing_address equals exactly one report candidate's signing_address. It does NOT verify the report (TDX/GPU quotes)
 * or recover the EIP-191 signer: that is gate V3 (NEAR's official verifier). Exit 0 = V2 passed.
 *
 *   node --env-file=C:\PRIV-AI-SECRETS\chainaim.env scripts\nearai-v2-probe.ts [flags]
 *   --model ID          canonical model id (default deepseek-ai/DeepSeek-V4.1-Flash-1017)
 *   --base URL          default https://cloud-api.near.ai/v1
 *   --max-tokens N      default 2048 (the gateway's shared budget)
 *   --prompt TEXT       default "Reply with the single word: ready"
 *   --provider-field X  deny | allow | omit: the gateway's provider.data_collection field in the body (default deny)
 *   --retries N         signature fetch attempts (default 10)   --retry-ms N  wait between them (default 2000)
 *   --json              print the result as JSON
 */
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    model: { type: "string", default: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
    base: { type: "string", default: "https://cloud-api.near.ai/v1" },
    "max-tokens": { type: "string", default: "2048" },
    prompt: { type: "string", default: "Reply with the single word: ready" },
    "provider-field": { type: "string", default: "deny" },
    retries: { type: "string", default: "10" },
    "retry-ms": { type: "string", default: "2000" },
    json: { type: "boolean", default: false },
  },
});
const key = process.env.NEARAI_API_KEY?.trim();
if (!key) { console.error("STOP: NEARAI_API_KEY is not set (run with --env-file=C:\\PRIV-AI-SECRETS\\chainaim.env)"); process.exit(2); }
if (!["deny", "allow", "omit"].includes(f["provider-field"]!)) { console.error("STOP: --provider-field must be deny, allow or omit"); process.exit(2); }
const base = f.base!.replace(/\/+$/, "");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const auth = { authorization: `Bearer ${key}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = { model: f.model, base };
const checks: [string, boolean, string][] = [];

// 1. preflight: the model's attestation report, fetched BEFORE the call (fresh nonce)
const nonce = randomBytes(32).toString("hex");
const rep = await fetch(`${base}/attestation/report?model=${encodeURIComponent(f.model!)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`,
  { headers: { ...auth, accept: "application/json", "x-no-aliasing": "true" } });
const repJson = rep.ok ? await rep.json() as Record<string, unknown> : null;
const candidates = (Array.isArray(repJson?.model_attestations) ? repJson!.model_attestations as Record<string, unknown>[] : []);
const reportSigners = candidates.map((c) => String(c.signing_address ?? "").toLowerCase()).filter(Boolean);
checks.push(["preflight report fetched with model candidates", rep.ok && reportSigners.length > 0, `HTTP ${rep.status}, ${reportSigners.length} candidate signer(s)`]);

// 2. the completion: body bytes built once, sent and hashed as-is
const body: Record<string, unknown> = { model: f.model, messages: [{ role: "user", content: f.prompt }], max_tokens: Number(f["max-tokens"]), stream: false };
if (f["provider-field"] !== "omit") body.provider = { data_collection: f["provider-field"] };
const reqBytes = new TextEncoder().encode(JSON.stringify(body));
const calledAt = new Date().toISOString();
const res = await fetch(`${base}/chat/completions`, {
  method: "POST", body: reqBytes,
  headers: { ...auth, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "x-no-aliasing": "true" },
});
const resBytes = new Uint8Array(await res.arrayBuffer());
const reqHash = sha(reqBytes), resHash = sha(resBytes);
let chat: Record<string, any> = {};
try { chat = JSON.parse(new TextDecoder().decode(resBytes)); } catch { /* reported below */ }
const content = String(chat?.choices?.[0]?.message?.content ?? "").trim();
Object.assign(out, { calledAt, httpStatus: res.status, chatId: chat?.id ?? null, contentChars: content.length, usage: chat?.usage ?? null, requestSha256: reqHash, responseSha256: resHash });
checks.push(["V1 completion answered (HTTP 200, non-empty content, usage present)", res.ok && content.length > 0 && !!chat?.usage, `HTTP ${res.status}, ${content.length} chars${chat?.error ? `, error: ${JSON.stringify(chat.error).slice(0, 200)}` : ""}`]);

// 3. the signature for that reply (bounded retry)
let sig: Record<string, any> | null = null, lastNote = "";
if (chat?.id) {
  for (let i = 0; i < Number(f.retries); i++) {
    const s = await fetch(`${base}/signature/${encodeURIComponent(chat.id)}?signing_algo=ecdsa&model=${encodeURIComponent(f.model!)}`, { headers: { ...auth, accept: "application/json" } });
    const j = s.ok ? await s.json().catch(() => null) as Record<string, any> | null : null;
    if (j && j.signature && !j.error_code) { sig = j; break; }
    lastNote = `HTTP ${s.status}${j?.error_code ? ` ${j.error_code}` : ""}`;
    await sleep(Number(f["retry-ms"]));
  }
}
checks.push(["signature available", !!sig, sig ? `kind ${sig.signature_kind ?? "(absent)"}, algo ${sig.signing_algo}` : `not available (${lastNote || "no chat id"})`]);
if (sig) {
  const kind = String(sig.signature_kind ?? "");
  const expected = kind === "provider_tee" ? `${f.model}:${reqHash}:${resHash}` : kind === "gateway" ? `${reqHash}:${resHash}` : null;
  Object.assign(out, { signatureKind: kind || null, signingAlgo: sig.signing_algo, signingAddress: sig.signing_address, signedText: sig.text, expectedText: expected });
  checks.push(["V2 the signed text equals our hashes of the exact bytes", expected !== null && sig.text === expected,
    expected === null ? `unknown signature_kind "${kind}": not inferred (NEAR docs)` : sig.text === expected ? "match" : "DIFFERENT: the signature does not cover the bytes we sent/received"]);
  checks.push(["V5 provider_tee (the model's TEE signed it, not NEAR's gateway)", kind === "provider_tee", kind || "(absent)"]);
  const matches = reportSigners.filter((a) => a === String(sig!.signing_address).toLowerCase()).length;
  checks.push(["signer equals exactly one preflight report candidate", kind === "provider_tee" ? matches === 1 : false,
    kind === "provider_tee" ? `${matches} match(es)` : "only checked for provider_tee"]);
}

out.checks = checks.map(([name, ok, detail]) => ({ name, ok, detail }));
if (f.json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`NEAR AI V2 probe: ${f.model} via ${base} (chat id ${out.chatId ?? "-"})`);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "OK  " : "FAIL"}  ${name}: ${detail}`);
  console.log("Not checked here (gate V3, NEAR's official verifier): the report's TDX/GPU quotes and the EIP-191 signer recovery.");
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

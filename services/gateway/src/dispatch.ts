/**
 * Dispatch: one attempt of one model (spec section 7). The chat pipeline
 * (chat.ts) walks the chain, applying the quota and the deny-unavailable
 * cache between attempts.
 */
import { createHash } from "node:crypto";
import type { HealthEffect, Pool } from "./pool.ts";
import { categorize, REQUEST_FAULTS, type DataCollection, type Outcome } from "./openrouter.ts";

/** One try of one model, as the ledger records it (never an error body). */
export type ModelAttempt = { model: string; outcome: Outcome; status?: number; ms: number };

/**
 * What an attested deployment's answered call yields (ARCH-407/408): the provider's chat id and SHA-256 of the exact
 * request and response bytes. Ids and hashes only, never text. `providerId` is absent when the reply carried no usable
 * id (the attestation service then reports the call unverified).
 */
export type AttestEvidence = { kind: "nearai"; providerId?: string; servedModel: string; requestSha256: string; responseSha256: string };

/**
 * privateAI-design-41 ARCH-695 (--expose-egress on): where the request went and the SHA-256 and length of the exact bytes
 * sent. destination is the host of the deployment's baseUrl only (no path, key or query).
 */
export type SentEvidence = { destination: string; sentSha256: string; sentBytes: number; bytes: Uint8Array };
export type AttemptResult = { attempt: ModelAttempt; completion?: Record<string, unknown>; accountScope?: "minute" | "day"; attest?: AttestEvidence; sent?: SentEvidence };

/**
 * Request headers NEAR AI's response signatures require (docs.near.ai/cloud/verification/cloud-api/response-signatures,
 * read 2026-11-06; gate V2 passed with exactly these): no compression, so the hashed bytes are the bytes on the wire, and
 * no model aliasing, so the signed model id is the one requested.
 */
export const NEARAI_ATTEST_REQUEST_HEADERS: Readonly<Record<string, string>> = { "accept-encoding": "identity", "x-no-aliasing": "true" };

/** A provider chat id that is safe in a response header and a URL path segment. */
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * What an outcome says about the deployment's health (spec section 7 and plan
 * refinement 4). Of the upstream errors, only a refusal caused by the request
 * leaves the model alone: 400, 413 and 422, and a 403. If it did not, a
 * caller whose payment is verified but never settled could cool every model
 * down for free. A 404 "No endpoints found", any other 4xx, a 5xx and an
 * empty or malformed 2xx answer cool the model down.
 */
function healthEffect(outcome: Outcome, status: number | undefined): HealthEffect {
  if (outcome === "ok") return "ok";
  if (outcome === "rate_limited_provider" || outcome === "model_restricted") return "cooldown"; // a gated model refuses every caller, so skip it for a while
  if (outcome === "upstream_error") {
    // categorize sends 401 and every 403 without moderation or routing metadata to key_rejected, so a 403 here is a moderation refusal: about the request, not the model.
    return status !== undefined && (REQUEST_FAULTS.has(status) || status === 403) ? "neutral" : "cooldown";
  }
  if (outcome === "timeout" || outcome === "network_error") return "fail";
  return "neutral"; // account limits, a rejected key, the data policy, a client abort: not this model's health
}

/**
 * A 2xx body counts only when it is a chat completion whose first choice
 * holds an answer: text content that is not blank, or at least one tool call.
 * A reasoning model that spends the whole token cap answers with no content,
 * and the caller must not pay for that.
 */
export function parseCompletion(text: string): Record<string, unknown> | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined; // not JSON
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined;
  const choices = (j as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown; tool_calls?: unknown } } | null | undefined) : undefined;
  const content = first?.message?.content;
  const calls = first?.message?.tool_calls;
  const answered = (typeof content === "string" && content.trim() !== "") || (Array.isArray(calls) && calls.length > 0);
  return answered ? (j as Record<string, unknown>) : undefined;
}

/**
 * One attempt: send the masked body to one model's deployment with the data
 * policy, wait for the whole answer (upstream calls are never streamed), and
 * sort the result into an outcome. Health is updated here; the quota and the
 * deny-unavailable cache belong to the caller.
 */
export async function attemptChat(
  model: string,
  body: Record<string, unknown>,
  dataCollection: DataCollection,
  pool: Pool,
  timeoutMs: number,
  clientSignal: AbortSignal,
  exposeEgress = false,
): Promise<AttemptResult> {
  const lease = pool.acquire(model);
  if (!lease) return { attempt: { model, outcome: "no_deployment", ms: 0 } };
  const { deployment, release } = lease;
  const started = performance.now();
  const finish = (outcome: Outcome, status?: number, extra: Partial<AttemptResult> = {}): AttemptResult => {
    release(healthEffect(outcome, status), status === undefined ? outcome : `${outcome} (HTTP ${status})`);
    const attempt: ModelAttempt = { model, outcome, ...(status === undefined ? {} : { status }), ms: Math.round(performance.now() - started) };
    return { attempt, ...extra };
  };

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const key = pool.apiKeyFor(deployment);
  if (key) headers.authorization = `Bearer ${key}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const payload = JSON.stringify({ ...body, model: deployment.servedModel, stream: false, provider: { data_collection: dataCollection } });
  // Attested deployments only: the request is encoded once and those same bytes are sent and hashed; the response is
  // read as bytes and hashed before decoding. Every other deployment is called exactly as before.
  const attested = deployment.attest === "nearai";
  if (attested) Object.assign(headers, NEARAI_ATTEST_REQUEST_HEADERS);
  // privateAI-design-41 ARCH-695: with --expose-egress on, EVERY deployment encodes once and sends exactly those bytes,
  // so the egress hash is of what left; off, only attested deployments do (as before).
  const requestBytes = attested || exposeEgress ? new TextEncoder().encode(payload) : undefined;
  let status: number;
  let text: string;
  let responseBytes: Uint8Array | undefined;
  try {
    const res = await fetch(`${deployment.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: requestBytes ?? payload,
      signal: AbortSignal.any([clientSignal, timeout]),
    });
    status = res.status;
    if (attested) {
      responseBytes = new Uint8Array(await res.arrayBuffer());
      text = new TextDecoder().decode(responseBytes);
    } else text = await res.text();
  } catch {
    if (clientSignal.aborted) return finish("client_abort");
    return finish(timeout.aborted ? "timeout" : "network_error");
  }

  const { outcome, accountScope } = categorize(status, text, dataCollection);
  if (outcome !== "ok") return finish(outcome, status, accountScope ? { accountScope } : {});
  const completion = parseCompletion(text);
  if (!completion) return finish("upstream_error", status);
  const sent: SentEvidence | undefined = exposeEgress && requestBytes ? { destination: new URL(deployment.baseUrl).host, sentSha256: sha256Hex(requestBytes), sentBytes: requestBytes.length, bytes: requestBytes } : undefined;
  if (!attested || !requestBytes || !responseBytes) return finish("ok", status, { completion, ...(sent ? { sent } : {}) });
  const id = completion.id;
  const attest: AttestEvidence = {
    kind: "nearai",
    ...(typeof id === "string" && PROVIDER_ID.test(id) ? { providerId: id } : {}),
    servedModel: deployment.servedModel,
    requestSha256: sha256Hex(requestBytes),
    responseSha256: sha256Hex(responseBytes),
  };
  return finish("ok", status, { completion, attest, ...(sent ? { sent } : {}) });
}

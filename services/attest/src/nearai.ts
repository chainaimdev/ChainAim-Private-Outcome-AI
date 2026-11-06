/**
 * NEAR AI Cloud calls ca-attest makes (PLAN-private-ai-nearai-attestation.md ARCH-409 / ARCH-410). Node fetch only; the
 * API key is passed in and never logged or put in an error message.
 *
 * Sources (read 2026-11-06): docs.near.ai/api-reference/attestation/get-attestation-report (GET /v1/attestation/report,
 * model, provider, signing_algo, nonce; header x-no-aliasing: true so the model is not rewritten) and
 * docs.near.ai/cloud/verification/cloud-api/response-signatures (GET /v1/signature/{chat id}; 404, or a 2xx with an
 * error_code, means "not available yet": retry for a short bounded time, then unverified). Gate V2 (scripts/nearai-v2-probe.ts)
 * used exactly these requests.
 */
import { randomBytes } from "node:crypto";
import type { SignatureOutcome } from "./judge.ts";

export type NearAiOptions = {
  /** API root, e.g. https://cloud-api.near.ai/v1 (no trailing slash needed). */
  baseUrl: string;
  apiKey: string;
  signingAlgo: string;
  /** Per-request timeout. */
  timeoutMs: number;
};

export type RawReport = {
  gateway_attestation?: Record<string, unknown>;
  model_attestations?: Record<string, unknown>[];
  [key: string]: unknown;
};

/** A fresh 32-byte nonce, hex, as the report endpoint and the official verifier expect. */
export const freshNonce = (): string => randomBytes(32).toString("hex");

const root = (u: string) => u.replace(/\/+$/, "");

/** GET the attestation report for one model with the given nonce. Throws Error(reason) without the key in it. */
export async function fetchReport(o: NearAiOptions, model: string, nonce: string): Promise<RawReport> {
  const url = `${root(o.baseUrl)}/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=${encodeURIComponent(o.signingAlgo)}&nonce=${nonce}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${o.apiKey}`, accept: "application/json", "x-no-aliasing": "true" }, signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (e) {
    throw new Error(`attestation report request failed: ${(e as Error).name}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`attestation report: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as RawReport | null;
  if (!body || typeof body !== "object") throw new Error("attestation report: not JSON");
  return body;
}

export type SignatureRetry = { windowMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> };

/**
 * GET the signature for one chat id, retrying while NEAR AI says it is not available yet (404, or a 2xx without a
 * signature or with an error_code), for at most windowMs. Any other HTTP status stops at once.
 */
export async function fetchSignature(o: NearAiOptions, chatId: string, model: string, retry: SignatureRetry): Promise<SignatureOutcome> {
  const url = `${root(o.baseUrl)}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=${encodeURIComponent(o.signingAlgo)}`;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + retry.windowMs;
  let last = "";
  for (;;) {
    let res: Response | undefined;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${o.apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (e) {
      last = `request failed: ${(e as Error).name}`;
    }
    if (res) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && body && typeof body.signature === "string" && typeof body.text === "string" && typeof body.signing_address === "string" && !body.error_code) {
        return {
          available: true,
          text: body.text,
          signature: body.signature,
          signingAddress: body.signing_address,
          signingAlgo: typeof body.signing_algo === "string" ? body.signing_algo : o.signingAlgo,
          signatureKind: typeof body.signature_kind === "string" ? body.signature_kind : null,
        };
      }
      const notYet = res.status === 404 || (res.ok && (!body || typeof body.signature !== "string" || !!body.error_code));
      last = `HTTP ${res.status}${body && typeof body.error_code === "string" ? ` ${body.error_code}` : ""}`;
      if (!notYet) return { available: false, reason: `signature: ${last}` };
    }
    if (Date.now() + retry.intervalMs > deadline) return { available: false, reason: `signature not available after ${Math.round(retry.windowMs / 1000)} s (${last})` };
    await sleep(retry.intervalMs);
  }
}

/**
 * ca-attest decision rules (PLAN-private-ai-nearai-attestation.md ARCH-409 / ARCH-410). Pure functions, Node built-ins
 * only: everything that talks to NEAR AI, Intel or NVIDIA lives in nearai.ts and official.ts and hands its results here.
 *
 * Sources (read 2026-11-06): docs.near.ai/cloud/verification/cloud-api/response-signatures (signed text, kinds, hashes,
 * EIP-191, "evidence fetched before the call"); nearai/nearai-cloud-verifier @ 94554726 ts/model_verifier.ts (the checks
 * a model attestation must pass: TDX quote, report_data binds signer + nonce, GPU via NRAS, sha256(app_compose) in
 * mr_config) and ts/chat_verifier.ts (signature text "<model>:<req>:<resp>" or "<req>:<resp>", EIP-191 recovery).
 * The official verifier has no RTMR3 event-log replay; owner decision 2026-11-06 (option a): none is added here.
 */

/** What the official verifier's checks said about one model attestation in one report. */
export type AttestationChecks = {
  /** checkTdxQuote: quote verified (status UpToDate or OutOfDate, as the official verifier accepts). */
  tdxVerified: boolean;
  /** The quote's status string, when the verifier reported one (UpToDate, OutOfDate, ...). */
  tdxStatus?: string;
  /** The error the TDX check threw, if it threw. */
  tdxError?: string;
  /** checkReportData: report_data[0..32] = the padded signing address. */
  bindsAddress: boolean;
  /** checkReportData: report_data[32..64] = the nonce ca-attest sent. */
  embedsNonce: boolean;
  /** sha256(app_compose) is in mr_config ("01" + hash prefix, the official verifier's showCompose formula); null = no app_compose. */
  composeMatchesMrConfig: boolean | null;
  /** The attestation names the model ca-attest asked for (model_name), or names none. */
  modelNameMatches: boolean;
  /** NVIDIA NRAS (checkGpu): skipped with --gpu-check off, or failed to run (reason). */
  gpu: { checked: false; reason: string } | { checked: true; nonceMatches: boolean; verdict: boolean };
};

export type AttestationResult = {
  signingAddress: string;
  signingAlgo: string;
  verified: boolean;
  reasons: string[];
  checks: AttestationChecks;
};

/** One fetch of the report for one model: the fresh nonce sent, when the report arrived, and each model attestation. */
export type ReportFetch = {
  model: string;
  nonce: string;
  /** ISO time the report ARRIVED (a call is checked only against a report that arrived before it). */
  fetchedAt: string;
  attestations: AttestationResult[];
  /** Set when the fetch itself failed (HTTP error, no model_attestations); attestations is then empty. */
  error?: string;
};

/**
 * ARCH-409: one attestation is verified only when every check that ran passed. The GPU check is required when
 * gpuRequired (--gpu-check on); with it off the attestation can be verified, and the result says the GPU was not checked.
 */
export function judgeAttestation(signingAddress: string, signingAlgo: string, checks: AttestationChecks, gpuRequired: boolean): AttestationResult {
  const reasons: string[] = [];
  if (!checks.tdxVerified) reasons.push(checks.tdxError ? `TDX quote not verified: ${checks.tdxError}` : `TDX quote not verified${checks.tdxStatus ? ` (status ${checks.tdxStatus})` : ""}`);
  if (!checks.bindsAddress) reasons.push("report_data does not bind the signing address");
  if (!checks.embedsNonce) reasons.push("report_data does not hold the request nonce");
  if (checks.composeMatchesMrConfig === null) reasons.push("no app_compose in the attestation");
  else if (!checks.composeMatchesMrConfig) reasons.push("sha256(app_compose) is not in mr_config");
  if (!checks.modelNameMatches) reasons.push("the attestation names another model");
  if (gpuRequired) {
    if (!checks.gpu.checked) reasons.push(`GPU not checked: ${checks.gpu.reason}`);
    else {
      if (!checks.gpu.nonceMatches) reasons.push("GPU evidence nonce differs from the request nonce");
      if (!checks.gpu.verdict) reasons.push("NVIDIA attestation verdict is not true");
    }
  }
  return { signingAddress: signingAddress.toLowerCase(), signingAlgo: signingAlgo.toLowerCase(), verified: reasons.length === 0, reasons, checks };
}

/** What the gateway exported for one call (ARCH-408 headers), plus when the console made it. */
export type CallEvidence = {
  /** NEAR AI's chat id (x-chainaim-provider-id); absent when the reply carried none. */
  chatId?: string;
  /** The model id NEAR AI served (x-chainaim-served-model). */
  servedModel: string;
  requestSha256: string;
  responseSha256: string;
  /** ISO time before the console sent the call; only a report that arrived earlier is used. */
  calledAt: string;
};

/** NEAR AI's GET /v1/signature/{chat id} answer, or why there is none. */
export type SignatureOutcome =
  | { available: true; text: string; signature: string; signingAddress: string; signingAlgo: string; signatureKind: string | null }
  | { available: false; reason: string };

export type CallStatus = "verified" | "unverified" | "unavailable";

/**
 * ARCH-410 / ARCH-412: ids, addresses, booleans and reasons only; never text. Fix 4 (owner decision 2026-11-06): plus the
 * signature evidence, so anyone can re-check it: signedText ("<servedModel>:<sha256 req>:<sha256 resp>" or "<req>:<resp>",
 * a model id and two hashes) and signatureHex. Each is kept only when it has exactly that shape (see evidenceOf); anything
 * else from NEAR AI is null, so no free text can pass through.
 */
export type CallResult = {
  chatId: string | null;
  servedModel: string;
  status: CallStatus;
  reason: string | null;
  signatureKind: string | null;
  signingAlgo: string | null;
  signingAddress: string | null;
  /** The report the signer was matched against (arrived before calledAt), or null. */
  reportFetchedAt: string | null;
  /** The matched attestation's TDX-side checks all passed; null when no attestation was matched. */
  tdx: boolean | null;
  /** The matched attestation's GPU check passed; null when it was not checked or not reached. */
  gpu: boolean | null;
  /** EIP-191 recovery gave the signing address. null = not reached. */
  signature: boolean | null;
  /** The signed hashes equal the gateway's. null = not reached. */
  hashes: boolean | null;
  /** The text NEAR AI signed, when NEAR AI returned a signature and the text has the signed-text shape; else null. */
  signedText: string | null;
  /** The signature in hex (ecdsa 65 bytes, ed25519 64 bytes), when well-formed for its algorithm; else null. */
  signatureHex: string | null;
};

/** NEAR AI's signed text: an optional model id, then two lowercase SHA-256 hex hashes (near-watch accepts the same). */
export const SIGNED_TEXT = /^(?:[A-Za-z0-9._:\/@-]{1,128}:)?[0-9a-f]{64}:[0-9a-f]{64}$/;
const SIG_HEX: Record<string, RegExp> = { ecdsa: /^(0x)?[0-9a-fA-F]{130}$/, ed25519: /^(0x)?[0-9a-fA-F]{128}$/ };

/** The evidence worth passing on from one signature answer: each value only when it has its exact shape. */
export function evidenceOf(text: string, signature: string, signingAlgo: string): { signedText: string | null; signatureHex: string | null } {
  const re = SIG_HEX[signingAlgo.toLowerCase()];
  return { signedText: text.length <= 258 && SIGNED_TEXT.test(text) ? text : null, signatureHex: re && re.test(signature) ? signature : null };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * ARCH-410. `recovered` is the EIP-191 signer of the signed text (official verifier recoverSigner), or undefined when
 * recovery threw or was not run. `history` holds this model's report fetches, any order.
 */
export function judgeCall(
  call: CallEvidence,
  sig: SignatureOutcome,
  recovered: string | undefined,
  history: readonly ReportFetch[],
  opts: { signingAlgo: string; attestedModels: readonly string[] },
): CallResult {
  const base: CallResult = {
    chatId: call.chatId ?? null, servedModel: call.servedModel, status: "unverified", reason: null,
    signatureKind: null, signingAlgo: null, signingAddress: null, reportFetchedAt: null, tdx: null, gpu: null, signature: null, hashes: null,
    signedText: null, signatureHex: null,
  };
  const out = (status: CallStatus, reason: string | null, extra: Partial<CallResult> = {}): CallResult => ({ ...base, ...extra, status, reason });

  if (!opts.attestedModels.includes(call.servedModel)) return out("unverified", "this model is not attested by ca-attest (--models)");
  if (!HEX64.test(call.requestSha256) || !HEX64.test(call.responseSha256)) return out("unverified", "the gateway's hashes are not SHA-256 hex");
  if (!call.chatId) return out("unverified", "no provider chat id: the reply cannot be matched to a signature");
  if (!sig.available) return out("unavailable", sig.reason);

  const kind = sig.signatureKind;
  const signer = sig.signingAddress.toLowerCase();
  const algo = sig.signingAlgo.toLowerCase();
  // Fix 4: the evidence travels with every result past this point (verified or not), so a failure can be re-checked too.
  const seen = { signatureKind: kind, signingAlgo: algo, signingAddress: signer, ...evidenceOf(sig.text, sig.signature, algo) };
  // NEAR docs: never infer the kind from the text's shape.
  if (kind === "gateway") return out("unverified", "signed by NEAR AI's gateway, not by the model's TEE: model not attested", seen);
  if (kind !== "provider_tee") return out("unverified", `unknown signature kind ${kind === null ? "(absent)" : JSON.stringify(kind)}`, seen);
  if (algo !== opts.signingAlgo.toLowerCase()) return out("unverified", `signing algorithm ${algo} is not ${opts.signingAlgo}`, seen);

  const expected = `${call.servedModel}:${call.requestSha256}:${call.responseSha256}`;
  if (sig.text !== expected) {
    const tail = sig.text.split(":").slice(-2);
    const hashesEqual = tail.length === 2 && tail[0] === call.requestSha256 && tail[1] === call.responseSha256;
    return out("unverified", hashesEqual ? "the signed model id differs from the served model" : "hash mismatch: the signature does not cover the bytes the gateway sent and received", { ...seen, hashes: hashesEqual });
  }
  const signatureOk = recovered !== undefined && recovered.toLowerCase() === signer;
  if (!signatureOk) return out("unverified", recovered === undefined ? "the signature could not be recovered" : "the signature does not recover to signing_address", { ...seen, hashes: true, signature: false });

  const calledAt = Date.parse(call.calledAt);
  if (Number.isNaN(calledAt)) return out("unverified", "calledAt is not an ISO time", { ...seen, hashes: true, signature: true });
  const before = history
    .filter((r) => r.model === call.servedModel && !r.error && Date.parse(r.fetchedAt) < calledAt)
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
  const report = before[0];
  if (!report) return out("unavailable", "no report for this model arrived before the call", { ...seen, hashes: true, signature: true });
  const matched = report.attestations.filter((a) => a.signingAddress === signer && a.signingAlgo === algo);
  const at = { ...seen, hashes: true, signature: true, reportFetchedAt: report.fetchedAt };
  if (matched.length === 0) return out("unverified", "the signer is not in the report that arrived before the call", at);
  if (matched.length > 1) return out("unverified", "the signer matches more than one attestation in the report", at);
  const a = matched[0];
  const tdx = a.checks.tdxVerified && a.checks.bindsAddress && a.checks.embedsNonce && a.checks.composeMatchesMrConfig === true && a.checks.modelNameMatches;
  const gpu = a.checks.gpu.checked ? a.checks.gpu.nonceMatches && a.checks.gpu.verdict : null;
  if (!a.verified) return out("unverified", `the signer's attestation failed: ${a.reasons.join("; ")}`, { ...at, tdx, gpu });
  return out("verified", null, { ...at, tdx, gpu });
}

/** Keep the newest `keep` fetches per model (the history the judge needs: the last report before any recent call). */
export function pruneHistory(history: readonly ReportFetch[], keep: number): ReportFetch[] {
  const byModel = new Map<string, ReportFetch[]>();
  for (const r of history) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  return [...byModel.values()].flatMap((list) => list.sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt)).slice(0, keep));
}

/**
 * The official NEAR AI verifier (github.com/nearai/nearai-cloud-verifier @ 94554726, Apache-2.0), used as built by its own
 * `npm run build` (tsconfig: module commonjs, outDir dist, rootDir ./ -> dist/ts/*.js). The image builds it at that
 * commit with our committed package-lock (services/attest/Dockerfile); --verifier-dir points at it.
 *
 * Used unchanged (ts/model_verifier.ts, ts/chat_verifier.ts at that commit, read 2026-11-06):
 *   checkTdxQuote(attestation)                 Intel TDX quote via dcap-qvl and Intel PCS collateral
 *   checkReportData(attestation, nonce, intel) report_data[0..32] = padded signer, [32..64] = nonce
 *   checkGpu(attestation, nonce)               NVIDIA NRAS verdict + GPU payload nonce
 *   recoverSigner(text, signature)             ethers v5 verifyMessage (EIP-191)
 * Not exported as a boolean there (showCompose only logs it), so computed here with its exact formula:
 *   mr_config starts with "01" + sha256(app_compose).
 * Their fetchReport is not used: it sends neither provider=near nor x-no-aliasing (nearai.ts does).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { judgeAttestation, type AttestationChecks, type AttestationResult } from "./judge.ts";

type IntelResult = { quote: { body: { reportdata: string; mrconfig: string }; verified: boolean; message?: string }; message?: string };
type Official = {
  checkTdxQuote: (a: Record<string, unknown>) => Promise<IntelResult>;
  checkReportData: (a: Record<string, unknown>, nonce: string, intel: IntelResult) => { binds_address: boolean; embeds_nonce: boolean };
  checkGpu: (a: Record<string, unknown>, nonce: string) => Promise<{ nonce_matches: boolean; verdict: unknown }>;
  recoverSigner: (text: string, signature: string) => string;
};

export class VerifierLoadError extends Error {}

/** Load the built verifier from `dir` (dist/ts/model_verifier.js and chat_verifier.js). Throws VerifierLoadError naming what is missing. */
export async function loadOfficial(dir: string): Promise<Official> {
  const files = { model: join(dir, "dist", "ts", "model_verifier.js"), chat: join(dir, "dist", "ts", "chat_verifier.js") };
  for (const f of Object.values(files)) if (!existsSync(f)) throw new VerifierLoadError(`the official verifier is not built: ${f} is missing (build the ca-attest image, or set --verifier-dir)`);
  // CommonJS modules: `default` is their module.exports.
  const m = (await import(pathToFileURL(files.model).href)) as { default?: Record<string, unknown> } & Record<string, unknown>;
  const c = (await import(pathToFileURL(files.chat).href)) as { default?: Record<string, unknown> } & Record<string, unknown>;
  const mv = (m.default ?? m) as Record<string, unknown>;
  const cv = (c.default ?? c) as Record<string, unknown>;
  const need = { checkTdxQuote: mv.checkTdxQuote, checkReportData: mv.checkReportData, checkGpu: mv.checkGpu, recoverSigner: cv.recoverSigner };
  for (const [name, fn] of Object.entries(need)) if (typeof fn !== "function") throw new VerifierLoadError(`the official verifier does not export ${name} (wrong commit?)`);
  return need as Official;
}

/** sha256(app_compose) in mr_config, the official showCompose formula; null when the attestation has no app_compose. */
export function composeMatches(attestation: Record<string, unknown>, mrConfig: string): boolean | null {
  const info = attestation.info as { tcb_info?: unknown } | undefined;
  const raw = info?.tcb_info;
  if (raw === undefined || raw === null) return null;
  let tcb: Record<string, unknown>;
  try {
    tcb = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  } catch {
    return null;
  }
  const appCompose = tcb.app_compose;
  if (typeof appCompose !== "string" || appCompose === "") return null;
  const hash = createHash("sha256").update(appCompose).digest("hex");
  return mrConfig.toLowerCase().startsWith(`01${hash}`);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** ARCH-409: run every official check on one model attestation and judge it. Never throws: a check that throws is a failed check with its reason. */
export async function checkAttestation(official: Official, attestation: Record<string, unknown>, model: string, nonce: string, gpuRequired: boolean): Promise<AttestationResult> {
  const signingAddress = typeof attestation.signing_address === "string" ? attestation.signing_address : "";
  const signingAlgo = typeof attestation.signing_algo === "string" ? attestation.signing_algo : "";
  const checks: AttestationChecks = {
    tdxVerified: false,
    bindsAddress: false,
    embedsNonce: false,
    composeMatchesMrConfig: null,
    modelNameMatches: attestation.model_name === undefined || attestation.model_name === model,
    gpu: { checked: false, reason: gpuRequired ? "not run" : "--gpu-check off" },
  };
  let intel: IntelResult | undefined;
  try {
    intel = await official.checkTdxQuote(attestation);
    checks.tdxVerified = intel.quote.verified === true;
    if (intel.message) checks.tdxStatus = intel.message;
  } catch (e) {
    checks.tdxError = errText(e);
  }
  if (intel) {
    try {
      const rd = official.checkReportData(attestation, nonce, intel);
      checks.bindsAddress = rd.binds_address === true;
      checks.embedsNonce = rd.embeds_nonce === true;
    } catch (e) {
      checks.tdxError = checks.tdxError ?? `report data: ${errText(e)}`;
    }
    checks.composeMatchesMrConfig = composeMatches(attestation, intel.quote.body.mrconfig ?? "");
  }
  if (gpuRequired) {
    try {
      const g = await official.checkGpu(attestation, nonce);
      checks.gpu = { checked: true, nonceMatches: g.nonce_matches === true, verdict: g.verdict === true || g.verdict === "true" };
    } catch (e) {
      checks.gpu = { checked: false, reason: errText(e) };
    }
  }
  if (!signingAddress) return { ...judgeAttestation("", signingAlgo, checks, gpuRequired), verified: false, reasons: ["the attestation has no signing_address"] };
  return judgeAttestation(signingAddress, signingAlgo, checks, gpuRequired);
}

/** EIP-191 recovery through the official verifier; undefined when it throws (malformed signature). */
export function recover(official: Official, text: string, signature: string): string | undefined {
  try {
    return official.recoverSigner(text, signature);
  } catch {
    return undefined;
  }
}

export type { Official };

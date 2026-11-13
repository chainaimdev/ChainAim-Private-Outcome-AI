/**
 * The agent checks ChainAim's signed quote before its spending policy (privateAI-design-33 ARCH-630, Phase 1).
 *
 * With the console on --ap2 on, POST /jobs/crossask answers `ap2: {checkout, merchant_authorization}`: the job as a UCP
 * checkout and an AP2 merchant authorization (detached JWS, ES256) over it. The agent verifies it with packages/ap2
 * verifyMerchantAuthorization and the PINNED public key (--ap2-public-key, default config/ap2-public-key.jwk.json, a JWK
 * Set committed to the repository, exported by desk.ps1 -Ap2Key), never a key the console sends or publishes. Then it
 * binds the signed checkout to the quote it is about to pay: the job id, USD whole cents equal to the amount in USDC base
 * units, the network, asset and payee (`dev.chainaim.job`), and an expiry that has not passed (with --ap2-skew-sec of
 * clock skew; lesson 7: the console and the agent are two processes on two clocks).
 *
 * Any failure is a refusal carrying the UCP AP2 error code (merchant_authorization_missing, merchant_authorization_invalid,
 * mandate_scope_mismatch): nothing is signed or paid. The paywall's 402 offer is bound to the same payee, asset and amount
 * right before signing (near.ts payAndFetchNear requireOffer). Nothing here logs or throws to the caller.
 */
import { readFileSync } from "node:fs";
import { keyFromJwk, verifyMerchantAuthorization, type Ap2ErrorCode } from "../../../packages/ap2/src/index.ts";
import { parseLimits, type CheckoutLimits } from "../../../packages/offer/src/index.ts";

/** The agent's quote check, from the --ap2-* flags of agent-jobs.ts. */
export type Ap2Check = {
  /** The pinned public JWKs (keys[] of the file). */
  keys: unknown[];
  /** Their key ids, shown at start-up. */
  kids: string[];
  keyPath: string;
  /** Clock skew allowed on expires_at, seconds (default 30). */
  skewSec: number;
  now?: () => number;
};

/** limits (privateAI-design-38 ARCH-683): the signed limits' sizes and model ids, shown under the quote; absent when the quote has none. */
export type QuoteSignedEvent = { type: "quote_signed"; jobId: string; kid: string; cents: number; limits?: SignedLimitsView };
export type SignedLimitsView = { models: string[]; modelCalls: number; maxTokens: number; files: number; totalBytes: number; attestation?: string };

/** What the agent itself was quoted (the console's answer, outside the signed part). */
export type QuotedJob = { jobId: string; amount: string; network: string; asset: string; payTo: string; expiresAt: number };

/**
 * The pinned JWK Set from `path` ({keys: [...]}, each an EC P-256 ES256 key). Throws an Error naming the path and what
 * to run; never a key value (public keys only in this file anyway).
 */
export function loadPinnedJwks(path: string): { keys: unknown[]; kids: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`the pinned AP2 public key ${path} could not be read (${code ?? "not JSON"}): export it with .\\test-console\\desk.ps1 -Ap2Key`);
  }
  const keys = (raw as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`${path} must be a JWK Set {"keys": [...]} with at least one key`);
  const kids = keys.map((k, i) => {
    try {
      return keyFromJwk(k).kid;
    } catch (e) {
      throw new Error(`${path} keys[${i}]: ${(e as Error).message}`);
    }
  });
  return { keys, kids };
}

type Verdict = { ok: true; event: QuoteSignedEvent } | { ok: false; code: Ap2ErrorCode; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Verifies the console's `ap2` answer member against the pinned keys and binds it to the quote. */
export function checkSignedQuote(check: Ap2Check, ap2: unknown, job: QuotedJob): Verdict {
  const scope = (reason: string): Verdict => ({ ok: false, code: "mandate_scope_mismatch", reason });
  if (!isObj(ap2) || !isObj(ap2.checkout)) {
    return { ok: false, code: "merchant_authorization_missing", reason: "the console's quote carries no signed checkout (is the console on --ap2 on?)" };
  }
  const checkout = ap2.checkout;
  const v = verifyMerchantAuthorization(ap2.merchant_authorization, checkout, check.keys);
  if (!v.ok) return { ok: false, code: v.code, reason: v.reason };
  if (checkout.id !== job.jobId) return scope("the signed checkout is for another job");
  if (checkout.currency !== "USD") return scope("the signed checkout is not in USD");
  const totals = Array.isArray(checkout.totals) ? checkout.totals.filter(isObj) : [];
  const total = totals.filter((t) => t.type === "total");
  if (total.length !== 1 || !Number.isInteger(total[0].amount) || (total[0].amount as number) <= 0) return scope("the signed checkout has no single whole-cent total");
  const cents = total[0].amount as number;
  const ext = checkout["dev.chainaim.job"];
  if (!isObj(ext)) return scope("the signed checkout does not say where the money goes (dev.chainaim.job)");
  const dec = ext.usdcDecimals;
  if (!Number.isInteger(dec) || (dec as number) < 2) return scope("the signed checkout's usdcDecimals is not a whole number of at least 2");
  if (ext.amountUnits !== job.amount) return scope(`the signed amount (${String(ext.amountUnits)} units) is not the quoted amount (${job.amount} units)`);
  if (BigInt(cents) * 10n ** BigInt((dec as number) - 2) !== BigInt(job.amount)) return scope(`the signed total (${cents} cents) is not the quoted amount (${job.amount} units)`);
  if (ext.network !== job.network) return scope("the signed network is not the quoted network");
  if (ext.asset !== job.asset) return scope("the signed asset is not the quoted asset");
  if (ext.payTo !== job.payTo) return scope("the signed payee is not the quoted payee");
  if (typeof checkout.expires_at !== "string" || Number.isNaN(Date.parse(checkout.expires_at))) return scope("the signed checkout has no expires_at time");
  const exp = Date.parse(checkout.expires_at);
  if (exp !== job.expiresAt) return scope("the signed expiry is not the quoted expiry");
  if ((check.now ?? Date.now)() > exp + check.skewSec * 1000) return { ok: false, code: "merchant_authorization_invalid", reason: "the signed quote has expired" };
  return { ok: true, event: { type: "quote_signed", jobId: job.jobId, kid: v.kid, cents } };
}

/** The members of the console's estimate answer (`basis`) that the signed limits must equal (privateAI-design-38 ARCH-683). */
export const ANSWER_LIMIT_FIELDS = ["files", "totalBytes", "maxPromptChars", "answerMaxPromptChars", "maxTokens", "sqlRetries", "modelCalls"] as const;
const NO_MODEL_ROUTE = "analyst-only";

export type LimitsVerdict = { ok: true; limits?: CheckoutLimits; view?: SignedLimitsView } | { ok: false; code: "limits_mismatch"; reason: string };

/**
 * privateAI-design-38 ARCH-683, after checkSignedQuote accepted the signature: the limits in the SIGNED checkout against
 * what the console's estimate told the agent (answer `basis`) and the route it named. Any difference is `limits_mismatch`
 * and nothing is signed. A quote without limits (a signer before v2.1.0) passes here with no view: the console's run step
 * refuses it (--offer-limits-check on), so it never runs or settles.
 */
export function checkSignedLimits(ap2: unknown, answerBasis: unknown, route: string | undefined): LimitsVerdict {
  const mismatch = (reason: string): LimitsVerdict => ({ ok: false, code: "limits_mismatch", reason });
  const checkout = isObj(ap2) && isObj(ap2.checkout) ? ap2.checkout : undefined;
  const ext = checkout && isObj(checkout["dev.chainaim.job"]) ? (checkout["dev.chainaim.job"] as Record<string, unknown>) : undefined;
  if (ext?.limits === undefined) return { ok: true };
  let l: CheckoutLimits;
  try { l = parseLimits(ext.limits); } catch (e) { return mismatch(`the signed limits cannot be read (${(e as Error).message})`); }
  if (!isObj(answerBasis)) return mismatch("the console's estimate shows no basis to compare with the signed limits");
  for (const f of ANSWER_LIMIT_FIELDS) {
    if (answerBasis[f] !== l[f]) return mismatch(`the signed ${f} (${l[f]}) is not the estimate's (${String(answerBasis[f])})`);
  }
  if (typeof route !== "string") return mismatch("the console's estimate names no route to compare with the signed models");
  const models = new Set([l.model, l.answerModel]);
  for (const m of route.split("+")) if (m !== NO_MODEL_ROUTE && !models.has(m)) return mismatch(`the route names ${m}, which the signed limits do not allow`);
  return { ok: true, limits: l, view: { models: [...models], modelCalls: l.modelCalls, maxTokens: l.maxTokens, files: l.files, totalBytes: l.totalBytes, ...(l.attestation ? { attestation: l.attestation } : {}) } };
}

/**
 * The buyer side of the AP2 deal (privateAI-design-36 ARCH-666): the tenant's agent signs a closed Checkout Mandate for
 * the one checkout ChainAim signed, bound to the one payment it is about to make.
 *
 * Order (estimate-first, the default): ChainAim's signer prices and signs the checkout -> the agent verifies it with the
 * pinned key (agent-ap2.ts) -> the tenant's policy says pay (packages/agent-policy) -> the paywall's 402 names the invoice
 * -> HERE the agent signs the mandate with nonce = that invoice id, aud = ChainAim's business id -> the agent signs the
 * NEAR payment -> the paywall verifies the payment and forwards the mandate -> ChainAim's signer verifies it before the
 * job runs -> settle only after a good run -> the receipt records the mandate (agent-receipt.ts compares its hash).
 *
 * The tenant's mandate key is read once from the agent's environment (AP2_MANDATE_KEY_<TENANT>, desk.ps1 -MandateKey);
 * it never leaves this process except as a signature. Nothing here logs.
 */
import { attachedJws, buildCheckoutMandate, mandateKeyFromEnv, mandateKeyVariable, mandateSha256 } from "../../../packages/ap2/src/index.ts";
import type { KeyObject } from "node:crypto";

export type MandateSigner = {
  /** Tenant id -> its mandate key; a tenant without one cannot pay a mandate-checked job (refused, nothing signed). */
  keys: ReadonlyMap<string, { key: KeyObject; kid: string }>;
  /** The business id the mandate is addressed to (ca-control-signer --mandate-audience). */
  aud: string;
  lifetimeSec: number;
  now?: () => number;
};

export type MandateSignedEvent = { type: "mandate_signed"; jobId: string; kid: string; sha256: string; nonce: string };
/** From the receipt ChainAim's signer signed: it records the mandate it verified before the run (same hash) or not. */
export type MandateVerifiedEvent = { type: "mandate_verified"; jobId: string; sha256: string; by: "ChainAim's signer"; ok: boolean; reason?: string };

/** The mandate keys of `tenants` from the environment: a tenant with none is left out (reported at start-up), a bad one stops it. */
export function loadMandateKeys(tenants: readonly string[], env: Record<string, string | undefined>): Map<string, { key: KeyObject; kid: string }> {
  const out = new Map<string, { key: KeyObject; kid: string }>();
  for (const t of tenants) {
    const k = mandateKeyFromEnv(env, t);
    if (k) out.set(t, k);
  }
  return out;
}

export { mandateKeyVariable };

/** Signs the closed checkout mandate for this job's signed quote and this payment's invoice id. Throws naming what is missing. */
export function signMandateFor(m: MandateSigner, tenant: string, jobId: string, ap2: { checkout: Record<string, unknown>; merchant_authorization: string }, invoiceId: string | undefined): { presentation: string; event: MandateSignedEvent } {
  const k = m.keys.get(tenant);
  if (!k) throw new Error(`tenant ${tenant} has no checkout mandate key (${mandateKeyVariable(tenant)}; desk.ps1 -MandateKey -MandateTenant ${tenant}); nothing was signed or paid`);
  if (!invoiceId) throw new Error("the paywall's offer names no invoice, so no checkout mandate can be bound to this payment; nothing was signed or paid");
  const iat = Math.floor((m.now ?? Date.now)() / 1000);
  const presentation = buildCheckoutMandate({ checkoutJwt: attachedJws(ap2.merchant_authorization, ap2.checkout), key: k.key, kid: k.kid, aud: m.aud, nonce: invoiceId, iat, exp: iat + m.lifetimeSec });
  return { presentation, event: { type: "mandate_signed", jobId, kid: k.kid, sha256: mandateSha256(presentation), nonce: invoiceId } };
}

/** The header the paid release carries the mandate in (the paywall passes it to the console's run step, ARCH-667). */
export const MANDATE_HEADER = "x-ap2-checkout-mandate";

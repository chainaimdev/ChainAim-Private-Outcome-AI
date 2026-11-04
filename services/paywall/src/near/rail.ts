/**
 * The NEAR rail's pieces, loaded only when PAY_RAILS includes near. Nothing
 * here, nor @x402/near or @near-js, is loaded by an XRPL-only paywall: app.ts
 * takes the loaded rail through PaywallDeps, and main.ts (or a test) loads it
 * with loadNearRail before building the app.
 */
import type { FacilitatorClient } from "@x402/core/server";
import type { SchemeNetworkServer } from "@x402/core/types";
import type { NearConfig } from "../config.ts";

export type NearRail = {
  /** @x402/near's exact server scheme, registered for near.network. */
  scheme: SchemeNetworkServer;
  /** Verifies and settles NEAR payments (src/near/facilitator.ts). */
  facilitator: FacilitatorClient;
  isNearNetwork: (network: string) => boolean;
  /** The SHA-256 key of a NEAR exact payload's signed delegate (spec section 10), or undefined for any other payload. */
  delegateKey: (payload: unknown) => string | undefined;
};

export async function loadNearRail(near: NearConfig): Promise<NearRail> {
  const [{ isNearNetwork, settlementCacheKey }, { ExactNearScheme }, { nearFacilitatorClient }] = await Promise.all([
    import("@x402/near"),
    import("@x402/near/exact/server"),
    import("./facilitator.ts"),
  ]);
  return {
    scheme: new ExactNearScheme(),
    facilitator: nearFacilitatorClient(near),
    isNearNetwork,
    delegateKey(payload) {
      const v = (payload as { signedDelegateAction?: unknown } | null | undefined)?.signedDelegateAction;
      return typeof v === "string" && v !== "" ? settlementCacheKey(v) : undefined;
    },
  };
}

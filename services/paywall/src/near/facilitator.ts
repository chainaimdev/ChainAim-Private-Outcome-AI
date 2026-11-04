/**
 * Who verifies and settles NEAR USDC payments (docs/NEAR-GATES.md, G1).
 *
 * The x402 NEAR exact scheme is the official @x402/near package: the buyer
 * signs a NEP-366 SignedDelegate holding exactly one NEP-141 ft_transfer, and
 * a relayer wraps it in a transaction it pays the gas for, so the buyer holds
 * no NEAR. Two ways to run that side, chosen by the configuration:
 *
 *   remote  NEAR_FACILITATOR_URL_<NETWORK>: an x402 facilitator over HTTP, used
 *           exactly as the XRPL rail uses t54.
 *   local   NEAR_RELAYER_ACCOUNT_<NETWORK> + NEAR_RELAYER_KEY_<NETWORK>: the
 *           paywall is its own facilitator. @x402/core's x402Facilitator runs
 *           @x402/near's facilitator scheme in this process against the live
 *           NEAR RPC, with this paywall's relayer account submitting.
 *
 * Every check the scheme makes (signature, one ft_transfer to payTo for the
 * exact amount with 1 yoctoNEAR, sponsored gas cap, max_block_height window,
 * access-key nonce, full-access key, payer balance, payTo storage
 * registration) and its settlement (submit, wait for FINAL, success only when
 * the inner ft_transfer receipt succeeded) is the package's; nothing is
 * re-implemented here.
 */
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { createFacilitatorNearSigner, type FacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import type { KeyPairString } from "@near-js/crypto";
import type { NearConfig } from "../config.ts";

/**
 * Reads go to the primary RPC and, when it throws, once to the fallback.
 * "Not found" is an answer (null), not a failure, so it is never retried.
 * Submitting is never repeated on the fallback: a submit that timed out may
 * still land, and the delegate nonce would only make the second one fail.
 */
export function failoverSigner(primary: FacilitatorNearSigner, fallback?: FacilitatorNearSigner): FacilitatorNearSigner {
  if (!fallback) return primary;
  const read =
    <A extends unknown[], R>(pick: (s: FacilitatorNearSigner) => (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await pick(primary)(...args);
      } catch {
        return pick(fallback)(...args);
      }
    };
  return {
    getRelayerIds: () => primary.getRelayerIds(),
    getCurrentBlockHeight: read((s) => s.getCurrentBlockHeight.bind(s)),
    viewAccount: read((s) => s.viewAccount.bind(s)),
    viewAccessKey: read((s) => s.viewAccessKey.bind(s)),
    ftBalanceOf: read((s) => s.ftBalanceOf.bind(s)),
    storageBalanceOf: read((s) => s.storageBalanceOf.bind(s)),
    submitSignedDelegateAction: (input) => primary.submitSignedDelegateAction(input),
  };
}

/** The facilitator client the resource server uses for the NEAR rail. */
export function nearFacilitatorClient(near: NearConfig): FacilitatorClient {
  if (near.facilitator.kind === "remote") return new HTTPFacilitatorClient({ url: near.facilitator.url });
  const relayers = [{ accountId: near.facilitator.relayerId, secretKey: near.facilitator.relayerKey as KeyPairString }];
  const signerFor = (url: string): FacilitatorNearSigner => createFacilitatorNearSigner({ relayers, rpcUrls: { [near.network]: url } });
  const signer = failoverSigner(signerFor(near.rpcUrl), near.rpcFallbackUrl ? signerFor(near.rpcFallbackUrl) : undefined);
  const facilitator = new x402Facilitator().register(near.network, new ExactNearScheme(signer, undefined, { maxSponsoredGas: near.maxGas }));
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // x402Facilitator types each kind's network as a plain string; the only one registered here is near.network.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

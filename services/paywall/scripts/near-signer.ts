/**
 * Who signs a buyer's NEAR payment. A NearSigner is an account id, its public
 * key, and createSignedDelegateAction: @x402/near's ClientNearSigner, which
 * reads the key's nonce and the block height, sets max_block_height from the
 * offer's maxTimeoutSeconds, builds the one ft_transfer and signs the NEP-366
 * SignedDelegate. payAndFetchNear (scripts/near.ts) decodes and checks what
 * comes back before anything is sent, so another kind of signer (a TEE-held
 * key, a KMS) plugs in here with no change to the payment code.
 *
 * keySigner signs with a full-access key read from the environment, for
 * development and the test rig. A function-call access key cannot be used: it
 * cannot attach the 1 yoctoNEAR ft_transfer needs
 * (docs.near.org/protocol/accounts-contracts/access-keys), and @x402/near's
 * verify refuses it. The returned object carries no key: the secret is never
 * printed, logged or exposed on it.
 */
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { createClientNearSigner, type ClientNearSigner } from "@x402/near";

export type NearSigner = ClientNearSigner & {
  accountId: string;
  /** ed25519:<base58> */
  publicKey: string;
};

export function keySigner(options: { accountId: string; secretKey: string; network: string; rpcUrl: string }): NearSigner {
  const keyPair = KeyPair.fromString(options.secretKey as KeyPairString);
  const inner = createClientNearSigner({ accountId: options.accountId, secretKey: options.secretKey as KeyPairString, rpcUrls: { [options.network]: options.rpcUrl } });
  return {
    accountId: options.accountId,
    publicKey: keyPair.getPublicKey().toString(),
    createSignedDelegateAction: (input) => inner.createSignedDelegateAction(input),
  };
}

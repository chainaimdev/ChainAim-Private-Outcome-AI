/**
 * The route table as plain JSON, for ARCH-101: each route's offers with their price evaluated for a request without
 * payment, plus description, mime type, resource and extensions. test/fixtures/routes-before-paid-jobs.json holds this
 * for the route table as it was before paid jobs were added (generated from that routes.ts, 2026-11-05).
 */
import type { RouteEntry } from "../src/routes.ts";

const XRPL_ENV = { XRPL_PAY_TO_TESTNET: "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd", GATEWAY_URL: "http://gateway.railway.internal:8700", CHAINAIM_GATEWAY_KEY: "test-key" };
const NEAR_ENV = {
  NEAR_PAY_TO_TESTNET: "merchant.chainaim-test.testnet",
  NEAR_USDC_CONTRACT_TESTNET: "usdc.chainaim-test.testnet",
  NEAR_USDC_DECIMALS_TESTNET: "6",
  NEAR_RELAYER_ACCOUNT_TESTNET: "relayer.chainaim-test.testnet",
  NEAR_RELAYER_KEY_TESTNET: "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr",
};
/** The three configurations the snapshot covers: XRPL only, NEAR only, both (synthetic values; the relayer key is a throwaway test key). */
export const SNAPSHOT_ENVS: Record<string, Record<string, string>> = {
  xrpl: XRPL_ENV,
  near: { ...XRPL_ENV, PAY_RAILS: "near", ...NEAR_ENV },
  "xrpl,near": { ...XRPL_ENV, PAY_RAILS: "xrpl,near", ...NEAR_ENV, PUBLIC_BASE_URL: "https://pay.example.com" },
};

export function snapshotRoutes(table: Record<string, RouteEntry>): unknown {
  return Object.fromEntries(
    Object.entries(table).map(([key, r]) => [
      key,
      { ...r, accepts: r.accepts.map((a) => ({ ...a, price: a.price({}) })) },
    ]),
  );
}

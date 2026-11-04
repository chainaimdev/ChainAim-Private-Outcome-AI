/**
 * Configuration from the environment. The server holds no wallet key: visitors
 * pay from their own Crossmark wallet in the browser.
 */
import { NEAR_WALLETS, isNearWalletId, type NearWalletId } from "./near-wallets.ts";

export type WebConfig = {
  port: number;
  host: string;
  paywallUrl: string;
  /**
   * NEAR_WALLET: the NEAR browser wallet the page may run, so visitors can pay
   * in USDC on NEAR when the paywall offers it. Unset: no NEAR button, and the
   * CSP stays as it is for Crossmark alone.
   */
  nearWallet?: NearWalletId;
};

/** NEAR_WALLET, checked against the wallets src/near-wallets.ts allows; unset or empty means none. */
export function nearWalletFrom(env: NodeJS.ProcessEnv): NearWalletId | undefined {
  const raw = env.NEAR_WALLET?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!isNearWalletId(raw)) throw new Error(`NEAR_WALLET must be one of ${Object.keys(NEAR_WALLETS).join(", ")}, got ${raw.slice(0, 60)}`);
  return raw;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${raw}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): WebConfig {
  const paywallUrl = (env.PAYWALL_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(paywallUrl) || !URL.canParse(paywallUrl)) {
    throw new Error("PAYWALL_URL must be the paywall's http(s) address, for example http://127.0.0.1:8080");
  }
  const nearWallet = nearWalletFrom(env);
  return {
    port: integer(env, "PORT", 8740, 1, 65535),
    host: env.HOST?.trim() || "127.0.0.1",
    paywallUrl,
    ...(nearWallet ? { nearWallet } : {}),
  };
}

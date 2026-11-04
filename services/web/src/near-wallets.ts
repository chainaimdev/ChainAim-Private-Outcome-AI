/**
 * The NEAR browser wallets this page may run, and the exact hosts each needs.
 * The page connects through @hot-labs/near-connect, which runs a wallet's own
 * code (its "executor") in a sandboxed iframe that inherits this page's CSP.
 * So a wallet is allowed only by listing it here with the hosts read from its
 * code, and app.ts widens the CSP by exactly these hosts, only when NEAR_WALLET
 * names the wallet. docs/NEAR-GATES.md records each host and why.
 *
 * No dependency of its own: the server (CSP, config) and the browser bundle
 * (checking the manifest before the connector runs anything) share it.
 */

/**
 * near-connect's wallet list (NearConnector.js defaultManifests[0] in
 * @hot-labs/near-connect 0.12.0). The page fetches it itself, keeps only the
 * chosen wallet's entry, and hands that one entry to the connector, so no
 * other wallet's code can load. The second default, cdn.jsdelivr.net, served
 * an older copy (version 1.0.3 against 1.0.4 on 2026-11-04) and is not used.
 */
export const NEAR_WALLET_MANIFEST = "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json";

export type NearWalletHosts = {
  /** The wallet's name, as the page shows it. */
  name: string;
  /** The executor URL the manifest must name; any other is refused before it loads. */
  executorUrl: string;
  /** connect-src: the manifest fetch and the executor fetch, both made by this page. */
  connectSrc: readonly string[];
  /** frame-src: what the executor loads in a nested iframe (inherited CSP). */
  frameSrc: readonly string[];
};

/**
 * Intear Wallet: a web wallet, so no extension to install. Its executor
 * (https://wallet.intear.tech/near-selector.js, 13.8 KB, read 2026-11-04) in
 * its default "iframe:" mode loads https://wallet.intear.tech/hot-wallet-connector-iframe.html
 * and talks to it by postMessage; it makes no fetch. Its other host,
 * wss://logout-bridge-service.intear.tech, is used only with walletUrl
 * "intear://" (the native app), which this page does not use. Popups it opens
 * go through near-connect's window.open, which the CSP does not govern.
 */
export const NEAR_WALLETS = {
  "intear-wallet": {
    name: "Intear Wallet",
    executorUrl: "https://wallet.intear.tech/near-selector.js",
    connectSrc: ["https://raw.githubusercontent.com", "https://wallet.intear.tech"],
    frameSrc: ["https://wallet.intear.tech"],
  },
} as const satisfies Record<string, NearWalletHosts>;

export type NearWalletId = keyof typeof NEAR_WALLETS;

export function isNearWalletId(value: unknown): value is NearWalletId {
  return typeof value === "string" && Object.hasOwn(NEAR_WALLETS, value);
}

/** The fields of a near-connect manifest entry this page relies on. */
export type NearWalletManifestEntry = {
  id: string;
  type: string;
  executor: string;
  features: Record<string, unknown>;
  permissions: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * The chosen wallet's entry from near-connect's manifest, refused unless it is
 * a sandboxed wallet whose executor is exactly the one this page allows and
 * that declares delegate signing (and testnet, when paying on testnet).
 */
export function pickNearWallet(manifest: unknown, id: NearWalletId, network: "testnet" | "mainnet"): NearWalletManifestEntry {
  const wallets = (manifest as { wallets?: unknown } | null)?.wallets;
  if (!Array.isArray(wallets)) throw new Error("The NEAR wallet list is not in the expected shape. Nothing was shared.");
  const entry = wallets.find((w) => (w as { id?: unknown } | null)?.id === id) as NearWalletManifestEntry | undefined;
  const name = NEAR_WALLETS[id].name;
  if (!entry) throw new Error(`${name} is no longer in the NEAR wallet list. Nothing was shared.`);
  if (entry.type !== "sandbox" || typeof entry.features !== "object" || entry.features === null || typeof entry.permissions !== "object" || entry.permissions === null) {
    throw new Error(`${name}'s entry in the NEAR wallet list is not in the expected shape. Nothing was shared.`);
  }
  if (entry.executor !== NEAR_WALLETS[id].executorUrl) {
    throw new Error(`${name}'s wallet code moved to ${String(entry.executor).slice(0, 120)}, which this page does not allow. Nothing was shared.`);
  }
  if (entry.features.signDelegateActions !== true) throw new Error(`${name} no longer says it can sign a payment without sending it. Nothing was shared.`);
  if (network === "testnet" && entry.features.testnet !== true) throw new Error(`${name} no longer says it works on NEAR TestNet. Nothing was shared.`);
  return entry;
}

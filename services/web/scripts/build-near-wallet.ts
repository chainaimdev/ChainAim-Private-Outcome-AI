/**
 * Builds public/near-wallet.js, the browser bundle of src/near-wallet-entry.ts
 * (near-connect, @x402/near's decoder and the NEAR payment). It is a bundle of
 * its own, so public/wallet.js (Crossmark and RLUSD) stays exactly as it was and
 * an RLUSD-only page never loads NEAR code. Committed like wallet.js: its first
 * line carries a hash of the sources, and test/near-wallet-bundle.test.ts fails
 * when the bundle is older than them. Run: npm run build:near-wallet
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const NEAR_BUNDLE = new URL("public/near-wallet.js", root);
const SOURCES = [
  "src/near-wallet-entry.ts",
  "src/near-pay.ts",
  "src/near-payment.ts",
  "src/near-wallets.ts",
  "src/pay.ts",
  "src/answer.ts",
  "src/xrpl-payment.ts",
  "src/balance.ts",
  "src/crossmark-signer.ts",
  "package-lock.json",
  "package.json",
  "scripts/build-near-wallet.ts",
];

/** Line endings are normalised so a Windows checkout (autocrlf) hashes the same as Linux. */
export function nearSourceHash(): string {
  const h = createHash("sha256");
  for (const file of SOURCES) h.update(file + "\n" + readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n"));
  return h.digest("hex");
}

export async function buildNearWallet(): Promise<void> {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [fileURLToPath(new URL("src/near-wallet-entry.ts", root))],
    outfile: fileURLToPath(NEAR_BUNDLE),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { global: "globalThis" },
    legalComments: "eof",
    banner: { js: `/* PrivacyBuddy NEAR wallet bundle, built by npm run build:near-wallet; source sha256 ${nearSourceHash()} */` },
    logLevel: "info",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildNearWallet();

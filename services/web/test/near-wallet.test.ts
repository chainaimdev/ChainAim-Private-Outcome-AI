/**
 * The page's NEAR wallet (DESIGN "private-ai-NEAR" 5.3, G5): NEAR_WALLET, the
 * CSP it widens and by exactly how much, the near-wallet.js route and bundle,
 * what /api/wallets tells the page, and the check of near-connect's manifest
 * entry before any wallet code can load.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createWebApp, SECURITY_HEADERS, securityHeaders } from "../src/app.ts";
import { loadConfig, nearWalletFrom } from "../src/config.ts";
import { browserMaskModule } from "../src/mask.ts";
import { NEAR_WALLET_MANIFEST, NEAR_WALLETS, pickNearWallet } from "../src/near-wallets.ts";
import { buildVercel } from "../scripts/build-vercel.ts";
import { NEAR_BUNDLE, nearSourceHash } from "../scripts/build-near-wallet.ts";

/** The policy before the NEAR wallet existed, character for character. */
const CROSSMARK_ONLY_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' wss://s.altnet.rippletest.net:51233 wss://s1.ripple.com:51233; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const INTEAR_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' wss://s.altnet.rippletest.net:51233 wss://s1.ripple.com:51233 https://raw.githubusercontent.com https://wallet.intear.tech; " +
  "frame-src 'self' https://wallet.intear.tech; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const quoteHeader = Buffer.from(
  JSON.stringify({
    accepts: [
      { scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "524C555344000000000000000000000000000000", payTo: "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd", extra: { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" } },
      { scheme: "exact", network: "near:testnet", amount: "10000", asset: USDC, payTo: "merchant.chainaim-test.testnet", maxTimeoutSeconds: 600, extra: { invoiceId: "I1" } },
    ],
  }),
).toString("base64");
const paywall = (async () => new Response("{}", { status: 402, headers: { "payment-required": quoteHeader } })) as typeof fetch;

function makeApp(over: Partial<Parameters<typeof createWebApp>[0]> = {}) {
  return createWebApp({
    paywallUrl: "http://paywall.test",
    maskModule: browserMaskModule(),
    pageFile: new URL("../public/index.html", import.meta.url),
    cookiesFile: new URL("../public/cookies.html", import.meta.url),
    walletFile: new URL("../public/wallet.js", import.meta.url),
    fetcher: paywall,
    ...over,
  });
}

/** Intear Wallet's and Meteor Wallet's entries as near-connect's manifest listed them on 2026-11-04 (NEAR_WALLET_MANIFEST, version 1.0.4). */
const INTEAR = {
  id: "intear-wallet",
  name: "Intear Wallet",
  version: "1.0.0",
  executor: "https://wallet.intear.tech/near-selector.js",
  type: "sandbox",
  features: { signMessage: true, signAndSendTransaction: true, signAndSendTransactions: true, signInWithoutAddKey: true, testnet: true, signDelegateActions: true, signInAndSignMessage: true, signInWithFunctionCallKey: true },
  platform: { web: "https://wallet.intear.tech" },
  permissions: { storage: true, location: true, allowsOpen: ["https://wallet.intear.tech", "intear://"] },
};
const METEOR = {
  id: "meteor-wallet",
  name: "Meteor Wallet",
  version: "1.1.1",
  executor: "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/data-storage/storage/meteor-near-connect-latest.js",
  type: "sandbox",
  features: { signDelegateActions: true, mainnet: true, testnet: true },
  permissions: { storage: true, external: ["meteorCom", "meteorComV2"] },
};
const MANIFEST = { version: "1.0.4", wallets: [METEOR, INTEAR] };

describe("NEAR_WALLET and the CSP", () => {
  it("NEAR-G5 without NEAR_WALLET the CSP and every header are the Crossmark-only set, unchanged", async () => {
    assert.equal(SECURITY_HEADERS["content-security-policy"], CROSSMARK_ONLY_CSP);
    assert.deepEqual(securityHeaders(), SECURITY_HEADERS);
    const r = await makeApp().request("/");
    assert.equal(r.headers.get("content-security-policy"), CROSSMARK_ONLY_CSP);
    assert.equal((await makeApp().request("/near-wallet.js")).status, 404, "no NEAR bundle is served");
  });

  it("NEAR-G5 with NEAR_WALLET=intear-wallet the CSP gains exactly Intear's hosts, with no wildcard", async () => {
    assert.equal(securityHeaders("intear-wallet")["content-security-policy"], INTEAR_CSP);
    assert.doesNotMatch(INTEAR_CSP, /\*/);
    const r = await makeApp({ nearWallet: "intear-wallet" }).request("/cookies.html");
    assert.equal(r.headers.get("content-security-policy"), INTEAR_CSP);
    const { "content-security-policy": _, ...rest } = securityHeaders("intear-wallet");
    const { "content-security-policy": __, ...before } = SECURITY_HEADERS;
    assert.deepEqual(rest, before, "the other headers do not change");
  });

  it("NEAR-G5 reads NEAR_WALLET and names the allowed wallets when it is wrong", () => {
    const base = { PAYWALL_URL: "http://127.0.0.1:8080" };
    assert.equal("nearWallet" in loadConfig(base), false);
    assert.equal("nearWallet" in loadConfig({ ...base, NEAR_WALLET: " " }), false);
    assert.equal(loadConfig({ ...base, NEAR_WALLET: "intear-wallet" }).nearWallet, "intear-wallet");
    assert.throws(() => nearWalletFrom({ NEAR_WALLET: "meteor-wallet" }), /NEAR_WALLET must be one of intear-wallet, got meteor-wallet/);
  });
});

describe("the page's NEAR wallet routes", () => {
  it("NEAR-G5 serves near-wallet.js only with NEAR_WALLET, and says how to build it when it is missing", async () => {
    const r = await makeApp({ nearWallet: "intear-wallet" }).request("/near-wallet.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    const missing = await makeApp({ nearWallet: "intear-wallet", nearWalletFile: new URL("../public/no-such-file.js", import.meta.url) }).request("/near-wallet.js");
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /npm run build:near-wallet/);
  });

  it("NEAR-G5 /api/wallets names the NEAR wallet only when NEAR_WALLET is set", async () => {
    const off = await (await makeApp().request("/api/wallets")).json();
    assert.deepEqual(off.near, { network: "near:testnet", asset: USDC, payTo: "merchant.chainaim-test.testnet", amount: "10000", priced: true });
    const on = await (await makeApp({ nearWallet: "intear-wallet" }).request("/api/wallets")).json();
    assert.deepEqual(on.near, { ...off.near, wallet: "intear-wallet", walletName: "Intear Wallet" });
    assert.equal(on.payTo.address, off.payTo.address, "the RLUSD side is the same");
  });

  it("NEAR-G5 the page loads near-wallet.js only on demand, never as a static import", () => {
    const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    assert.match(page, /import\("\/near-wallet\.js"\)/);
    assert.doesNotMatch(page, /from "\/near-wallet\.js"/);
    assert.match(page, /import \{ savedAccount, connect, disconnect, balance, payAndAsk \} from "\/wallet\.js";/);
  });
});

describe("pickNearWallet (near-connect's manifest, checked before any wallet code loads)", () => {
  it("NEAR-G5 keeps only the chosen wallet's entry", () => {
    assert.deepEqual(pickNearWallet(MANIFEST, "intear-wallet", "testnet"), INTEAR);
    assert.equal(NEAR_WALLET_MANIFEST, "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json");
    const connectSrc: readonly string[] = NEAR_WALLETS["intear-wallet"].connectSrc;
    assert.ok(connectSrc.includes(new URL(NEAR_WALLET_MANIFEST).origin), "the manifest host is in connect-src");
    assert.ok(connectSrc.includes(new URL(NEAR_WALLETS["intear-wallet"].executorUrl).origin), "the executor host is in connect-src");
  });

  it("NEAR-G5 refuses a moved executor, a wallet that no longer signs delegates or works on testnet, or a missing entry", () => {
    const with_ = (over: Record<string, unknown>) => ({ version: "1.0.4", wallets: [{ ...INTEAR, ...over }] });
    assert.throws(() => pickNearWallet(with_({ executor: "https://cdn.example.com/intear.js" }), "intear-wallet", "testnet"), /moved to https:\/\/cdn\.example\.com\/intear\.js, which this page does not allow\. Nothing was shared\./);
    assert.throws(() => pickNearWallet(with_({ features: { ...INTEAR.features, signDelegateActions: false } }), "intear-wallet", "testnet"), /sign a payment without sending it/);
    assert.throws(() => pickNearWallet(with_({ features: { ...INTEAR.features, testnet: false } }), "intear-wallet", "testnet"), /NEAR TestNet/);
    assert.equal(pickNearWallet(with_({ features: { ...INTEAR.features, testnet: false } }), "intear-wallet", "mainnet").id, "intear-wallet");
    assert.throws(() => pickNearWallet(with_({ type: "injected" }), "intear-wallet", "testnet"), /not in the expected shape/);
    assert.throws(() => pickNearWallet({ version: "1.0.4", wallets: [METEOR] }, "intear-wallet", "testnet"), /no longer in the NEAR wallet list/);
    assert.throws(() => pickNearWallet("<html>rate limited</html>", "intear-wallet", "testnet"), /not in the expected shape/);
  });
});

describe("public/near-wallet.js", () => {
  it("NEAR-G5 was built from the current source (run npm run build:near-wallet if this fails)", () => {
    assert.match(readFileSync(NEAR_BUNDLE, "utf8").slice(0, 200), new RegExp(`source sha256 ${nearSourceHash()}`));
  });

  it("NEAR-G5 exports exactly what the page and the test console import, and fetches only the manifest, the executor and /api/chat", () => {
    const js = readFileSync(NEAR_BUNDLE, "utf8");
    const start = js.lastIndexOf("export{");
    const names = js.slice(start + "export{".length, js.indexOf("}", start)).split(",").map((e) => e.trim().split(" as ").pop()!).sort();
    assert.deepEqual(names, ["nearConnect", "nearDisconnect", "nearPayAndAsk", "nearPayAndChat", "nearSavedAccount"]);
    assert.ok(js.includes(NEAR_WALLET_MANIFEST));
    // near-connect's executor fetch, its own manifest loader (not called: the page passes the entry), the page's manifest fetch, and /api/chat.
    assert.equal(js.match(/[^.\w]fetch\(/g)?.length, 4);
  });
});

describe("buildVercel with NEAR_WALLET", () => {
  it("NEAR-G5 ships near-wallet.js and gives the static files the NEAR CSP", async () => {
    const out = mkdtempSync(join(tmpdir(), "near-vercel-"));
    try {
      await buildVercel(pathToFileURL(out + "/"), { NEAR_WALLET: "intear-wallet" });
      assert.ok(existsSync(join(out, "static", "near-wallet.js")));
      const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8"));
      assert.equal(config.routes[0].headers["content-security-policy"], INTEAR_CSP);
      await buildVercel(pathToFileURL(out + "/"), {});
      assert.equal(existsSync(join(out, "static", "near-wallet.js")), false);
      assert.equal(JSON.parse(readFileSync(join(out, "config.json"), "utf8")).routes[0].headers["content-security-policy"], CROSSMARK_ONLY_CSP);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

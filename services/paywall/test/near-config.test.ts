/**
 * PAY_RAILS and the NEAR_* configuration (DESIGN "private-ai-NEAR", sections
 * 5.1 and 7), and the start-up USDC check against the NEAR JSON-RPC double.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { KeyPair } from "@near-js/crypto";
import { createPaywall } from "../src/app.ts";
import { DEFAULT_NEAR_MAX_GAS, DEFAULT_NEAR_RPC_URLS, isNearAccountId, loadConfig, usdToBaseUnits, xrplOf } from "../src/config.ts";
import { failoverSigner } from "../src/near/facilitator.ts";
import { createNearRpc, redactUrl } from "../src/near/rpc.ts";
import { checkUsdc } from "../src/near/usdc.ts";
import { routesConfig } from "../src/routes.ts";
import { addAccount, nearRpcDouble } from "./near-rpc-double.ts";
import { close, listen, PAY_TO } from "./stubs.ts";

const base = { GATEWAY_URL: "http://gateway.railway.internal:8700", CHAINAIM_GATEWAY_KEY: "test-key" };
const xrplEnv = { ...base, XRPL_PAY_TO_TESTNET: PAY_TO };
const relayerKey = KeyPair.fromRandom("ed25519").toString();
const nearEnv = {
  NEAR_PAY_TO_TESTNET: "merchant.testnet",
  NEAR_USDC_CONTRACT_TESTNET: "usdc.chainaim-test.testnet",
  NEAR_USDC_DECIMALS_TESTNET: "6",
  NEAR_RELAYER_ACCOUNT_TESTNET: "relayer.testnet",
  NEAR_RELAYER_KEY_TESTNET: relayerKey,
};

describe("PAY_RAILS", () => {
  it("NEAR-7 unset is the XRPL-only configuration it always was, plus rails=[xrpl], and reads no NEAR_* variable", () => {
    const c = loadConfig({ ...xrplEnv, NEAR_PAY_TO_TESTNET: "not a NEAR account", NEAR_NETWORK: "betanet" });
    assert.deepEqual(c.rails, ["xrpl"]);
    assert.equal(c.near, undefined);
    assert.deepEqual(Object.keys(c), [
      "network", "networkName", "payTo", "facilitatorUrl", "currencyCode", "issuer", "sourceTag", "maxTimeoutSeconds", "gatewayUrl", "gatewayKey",
      "gatewayTimeoutMs", "port", "host", "publicBaseUrl", "prices", "phaseLog", "rails",
    ]);
    assert.deepEqual(loadConfig({ ...xrplEnv, PAY_RAILS: "xrpl" }), c);
  });

  it("NEAR-7 near alone needs no XRPL variable, and xrplOf refuses it", () => {
    const c = loadConfig({ ...base, ...nearEnv, PAY_RAILS: "near" });
    assert.deepEqual(c.rails, ["near"]);
    assert.equal(c.payTo, undefined);
    assert.throws(() => xrplOf(c), /xrpl rail is not enabled/);
    assert.deepEqual(
      { ...c.near, facilitator: { ...c.near!.facilitator, relayerKey: "(set)" } },
      {
        networkName: "testnet",
        network: "near:testnet",
        payTo: "merchant.testnet",
        usdcContract: "usdc.chainaim-test.testnet",
        usdcDecimals: 6,
        rpcUrl: DEFAULT_NEAR_RPC_URLS.testnet,
        facilitator: { kind: "local", relayerId: "relayer.testnet", relayerKey: "(set)" },
        maxGas: DEFAULT_NEAR_MAX_GAS,
      },
    );
  });

  it("NEAR-7 xrpl,near has both rails, in that order", () => {
    const c = loadConfig({ ...xrplEnv, ...nearEnv, PAY_RAILS: "xrpl,near" });
    assert.deepEqual(c.rails, ["xrpl", "near"]);
    assert.equal(c.payTo, PAY_TO);
    assert.equal(c.near?.payTo, "merchant.testnet");
    assert.deepEqual(loadConfig({ ...xrplEnv, ...nearEnv, PAY_RAILS: " near , xrpl " }).rails, ["near", "xrpl"]);
  });

  it("NEAR-5.1 refuses an unknown or repeated rail", () => {
    for (const v of ["solana", "xrpl,xrpl", "xrpl;near", ","]) assert.throws(() => loadConfig({ ...xrplEnv, ...nearEnv, PAY_RAILS: v }), /PAY_RAILS must be/, v);
  });

  it("NEAR-5.1 each NEAR variable is required only with the near rail, and names itself", () => {
    const env = { ...base, ...nearEnv, PAY_RAILS: "near" };
    for (const name of ["NEAR_PAY_TO_TESTNET", "NEAR_USDC_CONTRACT_TESTNET", "NEAR_USDC_DECIMALS_TESTNET", "NEAR_RELAYER_ACCOUNT_TESTNET", "NEAR_RELAYER_KEY_TESTNET"]) {
      assert.throws(() => loadConfig({ ...env, [name]: "" }), new RegExp(name), name);
    }
    assert.throws(() => loadConfig({ ...env, NEAR_NETWORK: "betanet" }), /NEAR_NETWORK/);
    assert.throws(() => loadConfig({ ...env, NEAR_PAY_TO_TESTNET: "Merchant..testnet" }), /NEAR_PAY_TO_TESTNET must be a NEAR account id/);
    assert.throws(() => loadConfig({ ...env, NEAR_USDC_DECIMALS_TESTNET: "25" }), /NEAR_USDC_DECIMALS_TESTNET/);
    assert.throws(() => loadConfig({ ...env, NEAR_RPC_URL_TESTNET: "rpc.example" }), /NEAR_RPC_URL_TESTNET/);
    assert.throws(() => loadConfig({ ...env, NEAR_MAX_GAS: "1e14" }), /NEAR_MAX_GAS/);
    assert.throws(() => loadConfig({ ...env, NEAR_MAX_GAS: "300000000000001" }), /NEAR_MAX_GAS/);
    assert.throws(() => loadConfig({ ...env, NEAR_RELAYER_ACCOUNT_TESTNET: "merchant.testnet" }), /must differ/);
  });

  it("NEAR-8 a bad relayer key is refused without its value in the message", () => {
    const secret = "ed25519:0OIl-not-base58-secret";
    assert.throws(
      () => loadConfig({ ...base, ...nearEnv, PAY_RAILS: "near", NEAR_RELAYER_KEY_TESTNET: secret }),
      (e: unknown) => e instanceof Error && /NEAR_RELAYER_KEY_TESTNET/.test(e.message) && !e.message.includes("not-base58-secret"),
    );
  });

  it("NEAR-3.2 a remote facilitator replaces the relayer, and only the chosen network's variables are read", () => {
    const c = loadConfig({ ...base, PAY_RAILS: "near", NEAR_NETWORK: "mainnet", NEAR_PAY_TO_MAINNET: "merchant.near", NEAR_USDC_CONTRACT_MAINNET: "usdc.near", NEAR_USDC_DECIMALS_MAINNET: "6", NEAR_FACILITATOR_URL_MAINNET: "https://facilitator.example.com/" });
    assert.equal(c.near?.network, "near:mainnet");
    assert.deepEqual(c.near?.facilitator, { kind: "remote", url: "https://facilitator.example.com" });
    assert.equal(c.near?.rpcUrl, DEFAULT_NEAR_RPC_URLS.mainnet);
  });

  it("NEAR-5.1 a price the token cannot express is refused at start", () => {
    assert.throws(() => loadConfig({ ...base, ...nearEnv, PAY_RAILS: "near", NEAR_USDC_DECIMALS_TESTNET: "2", PRICE_CHAT: "$0.005" }), /PRICE_CHAT cannot be paid in NEAR USDC/);
  });

  it("NEAR-5.2 the NEAR offer carries the USDC amount in base units, and no XRPL extra", () => {
    const c = loadConfig({ ...base, ...nearEnv, PAY_RAILS: "near", PRICE_SCAN: "$0.002" });
    const scan = routesConfig(c, () => "INV")["POST /v1/privacy/scan"].accepts;
    assert.equal(scan.length, 1);
    const { price, ...fixed } = scan[0];
    assert.deepEqual(fixed, { scheme: "exact", network: "near:testnet", payTo: "merchant.testnet", maxTimeoutSeconds: 600 });
    assert.deepEqual(price({}), { amount: "2000", asset: "usdc.chainaim-test.testnet", extra: { invoiceId: "INV" } });
  });

  it("NEAR-3.1 with two rails every offer of one request names one invoice, and the next request gets a new one", () => {
    let n = 0;
    const routes = routesConfig(loadConfig({ ...xrplEnv, ...nearEnv, PAY_RAILS: "xrpl,near" }), () => `INV-${++n}`);
    const [xrpl, near] = routes["POST /v1/chat/completions"].accepts;
    const one = {};
    assert.equal(xrpl.price(one).extra.invoiceId, "INV-1");
    assert.equal(near.price(one).extra.invoiceId, "INV-1");
    assert.equal(near.price({}).extra.invoiceId, "INV-2");
  });
});

describe("NEAR rail loading", () => {
  it("NEAR-AC1 an XRPL-only paywall loads no @x402/near or @near-js module", () => {
    const code = [
      'import { registerHooks } from "node:module";',
      "const seen = [];",
      "registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); seen.push(r.url); return r; } });",
      // The paths are joined at run time: they are data here, and scripts/check-deps.ts reads literal import specifiers as imports.
      `const at = (file) => new URL(file, ${JSON.stringify(new URL("../src/", import.meta.url).href)}).href;`,
      'const { createPaywall } = await import(at("app.ts"));',
      'const { loadConfig } = await import(at("config.ts"));',
      `createPaywall(loadConfig(${JSON.stringify(xrplEnv)}), { log: () => {} });`,
      'console.log(JSON.stringify({ loaded: seen.length, near: seen.filter((u) => /@x402[\\\\/]near|@near-js|[\\\\/]borsh[\\\\/]/.test(u)) }));',
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", env: { ...process.env, CHAINAIM_ENV_FILE: "/nonexistent" } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!) as { loaded: number; near: string[] };
    assert.ok(out.loaded > 10, "the resolve hook saw the app's modules");
    assert.deepEqual(out.near, []);
  });

  it("NEAR-5.2 a NEAR configuration without its loaded rail is refused, not served half-configured", () => {
    assert.throws(() => createPaywall(loadConfig({ ...base, ...nearEnv, PAY_RAILS: "near" }), { log: () => {} }), /near rail is enabled .* not loaded/);
  });
});

describe("NEAR helpers", () => {
  it("NEAR-7 converts a USD price to base units with integer arithmetic", () => {
    assert.equal(usdToBaseUnits("$0.01", 6), "10000");
    assert.equal(usdToBaseUnits("$1", 6), "1000000");
    assert.equal(usdToBaseUnits("$0.000001", 6), "1");
    assert.equal(usdToBaseUnits("$12.5", 0 + 6), "12500000");
    assert.equal(usdToBaseUnits("$0.10", 1), "1");
    assert.throws(() => usdToBaseUnits("$0.0000001", 6), /more decimals/);
    assert.throws(() => usdToBaseUnits("0.01", 6), /USD price/);
  });

  it("NEAR-5.1 knows a NEAR account id", () => {
    for (const ok of ["merchant.testnet", "a1", "usdc.chainaim-test.testnet", "x_y-z.near", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"]) assert.ok(isNearAccountId(ok), ok);
    for (const bad of ["a", "Upper.testnet", "a..b", "-a.testnet", "a-.testnet", "a b", "x".repeat(65)]) assert.equal(isNearAccountId(bad), false, bad);
  });

  it("NEAR-8 shows a token-bearing RPC URL as its scheme and host only", () => {
    assert.equal(redactUrl("https://cool-name.near-testnet.quiknode.pro/0123abcdTOKEN/"), "https://cool-name.near-testnet.quiknode.pro");
    assert.equal(redactUrl("not a url"), "(invalid URL)");
  });

  it("NEAR-5.2 failoverSigner reads from the fallback when the primary throws, and never submits twice", async () => {
    const calls: string[] = [];
    const signer = (name: string, fails: boolean) => ({
      getRelayerIds: () => ["relayer.testnet"],
      getCurrentBlockHeight: async () => {
        calls.push(`${name}.height`);
        if (fails) throw new Error("down");
        return 5n;
      },
      viewAccount: async () => null,
      viewAccessKey: async () => null,
      ftBalanceOf: async () => 0n,
      storageBalanceOf: async () => ({ supported: false as const }),
      submitSignedDelegateAction: async () => {
        calls.push(`${name}.submit`);
        throw new Error("timed out");
      },
    });
    const s = failoverSigner(signer("primary", true), signer("fallback", false));
    assert.equal(await s.getCurrentBlockHeight("near:testnet"), 5n);
    await assert.rejects(s.submitSignedDelegateAction({ network: "near:testnet", relayerId: "relayer.testnet", signedDelegateAction: "" }), /timed out/);
    assert.deepEqual(calls, ["primary.height", "fallback.height", "primary.submit"]);
  });
});

describe("checkUsdc (paywall start)", () => {
  const double = nearRpcDouble({ tokenId: "usdc.chainaim-test.testnet", decimals: 6 });
  const unavailable = createServer((_req, res) => {
    res.statusCode = 503;
    res.end("unavailable");
  });
  let url = "";
  let unavailableUrl = "";
  before(async () => {
    url = await listen(double.server);
    unavailableUrl = await listen(unavailable);
    addAccount(double.state, "merchant.testnet");
  });
  after(async () => {
    await close(double.server);
    await close(unavailable);
    // Let fetch's keep-alive sockets finish closing: --test-force-exit exiting mid-close aborts Node on Windows (libuv async.c).
    await new Promise((done) => setTimeout(done, 200));
  });
  const near = { usdcContract: "usdc.chainaim-test.testnet", usdcDecimals: 6, payTo: "merchant.testnet", networkName: "testnet" as const };

  it("NEAR-G2 passes when the contract reports the configured decimals and payTo is registered", async () => {
    double.state.token.registered.add("merchant.testnet");
    assert.deepEqual(await checkUsdc(near, createNearRpc({ urls: [url], timeoutMs: 2000 })), { symbol: "USDC", decimals: 6 });
  });

  it("NEAR-G2 stops on wrong decimals, an unregistered payTo, or an RPC that does not answer, and moves to the fallback", async () => {
    const rpc = createNearRpc({ urls: [url], timeoutMs: 2000 });
    await assert.rejects(checkUsdc({ ...near, usdcDecimals: 18 }, rpc), /NEAR_USDC_DECIMALS_TESTNET is 18, but .* reports 6/);
    double.state.token.registered.delete("merchant.testnet");
    await assert.rejects(checkUsdc(near, rpc), /not registered .*scripts\/near-storage\.ts/);
    double.state.token.registered.add("merchant.testnet");
    // A primary that is down (HTTP 503): the token in its path never reaches a message, and the fallback answers.
    const down = `${unavailableUrl}/secret-token`;
    await assert.rejects(checkUsdc(near, createNearRpc({ urls: [down], timeoutMs: 2000 })), (e: unknown) => e instanceof Error && /HTTP 503/.test(e.message) && !e.message.includes("secret-token"));
    assert.deepEqual(await checkUsdc(near, createNearRpc({ urls: [down, url], timeoutMs: 2000 })), { symbol: "USDC", decimals: 6 });
  });
});

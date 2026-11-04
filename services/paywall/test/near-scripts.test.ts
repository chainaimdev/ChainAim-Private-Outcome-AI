/**
 * The NEAR buyer scripts (DESIGN "private-ai-NEAR", section 5.4): the rig's
 * --rail near path (runTenant with a NearBuyer), tenant.json's "near" entry,
 * nearBuyer's environment rules, and near-storage's registration, against the
 * paywall (PAY_RAILS=near, its own facilitator) and the NEAR JSON-RPC double.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { nearBuyer, SetupError } from "../scripts/near.ts";
import { keySigner } from "../scripts/near-signer.ts";
import { registerWithToken } from "../scripts/near-storage.ts";
import { checkDistinct, loadTenants, runTenant, type CallRecord, type Tenant } from "../scripts/rig-core.ts";
import { addAccount, nearRpcDouble, STORAGE_MIN, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const TOKEN = "usdc.chainaim-test.testnet";
const PAY = "merchant.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";

describe("near-storage registerWithToken", () => {
  const double = nearRpcDouble({ tokenId: TOKEN });
  const opsKey = KeyPair.fromRandom("ed25519");
  let rpcUrl = "";
  before(async () => {
    rpcUrl = await listen(double.server);
    addAccount(double.state, "ops.chainaim-test.testnet", opsKey.getPublicKey().toString());
    addAccount(double.state, PAY);
  });
  after(() => close(double.server));
  const options = () => ({ rpcUrl, contract: TOKEN, account: PAY, signerId: "ops.chainaim-test.testnet", secretKey: opsKey.toString() });

  it("NEAR-G3 a dry run reports the deposit and sends nothing", async () => {
    assert.deepEqual(await registerWithToken({ ...options(), dryRun: true }), { registered: false, deposit: STORAGE_MIN });
    assert.equal(double.state.calls.includes("send_tx"), false);
  });

  it("NEAR-G3 registers with storage_deposit(min), signed by the signer, and then says it already is", async () => {
    const done = await registerWithToken(options());
    assert.equal(done.registered, true);
    assert.equal((done as { already: boolean }).already, false);
    assert.ok(double.state.token.registered.has(PAY));
    assert.deepEqual(await registerWithToken(options()), { registered: true, already: true });
  });
});

describe("rig --rail near", () => {
  const double = nearRpcDouble({ tokenId: TOKEN });
  const gateway = stubGateway();
  const relayerKey = KeyPair.fromRandom("ed25519");
  const tenantKey = KeyPair.fromRandom("ed25519");
  const TENANT = "t01.chainaim-test.testnet";
  let rpcUrl = "";
  let paywall: { url: string; close: () => Promise<void> };

  before(async () => {
    rpcUrl = await listen(double.server);
    addAccount(double.state, TENANT, tenantKey.getPublicKey().toString());
    addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
    addAccount(double.state, PAY);
    double.state.token.registered.add(PAY);
    double.state.token.balances.set(TENANT, 25_000n); // 0.025 USDC: two calls at $0.01, not three
    paywall = await startNearPaywall({
      PAY_RAILS: "near",
      NEAR_PAY_TO_TESTNET: PAY,
      NEAR_USDC_CONTRACT_TESTNET: TOKEN,
      NEAR_USDC_DECIMALS_TESTNET: "6",
      NEAR_RPC_URL_TESTNET: rpcUrl,
      NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER,
      NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(),
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: "test-gateway-key",
    });
  });
  after(async () => {
    await paywall.close();
    await close(double.server);
    await close(gateway.server);
  });

  it("NEAR-5.4 a tenant pays each call in USDC, records it, and stops at its spending ceiling", async () => {
    const tenant: Tenant = { id: "t01", name: "Test", seedPrefix: "XRPL_SEED_T01", queries: ["Patient Jane Roe, MRN 991122, was seen today."], near: { accountId: TENANT, keyEnv: "NEAR_KEY_T01" } };
    const buyer = { networkName: "testnet" as const, network: "near:testnet", rpcUrl, signer: keySigner({ accountId: TENANT, secretKey: tenantKey.toString(), network: "near:testnet", rpcUrl }) };
    const records: CallRecord[] = [];
    const summary = await runTenant(tenant, buyer, { url: paywall.url, endpoint: "scan", calls: 3, intervalMs: 0, maxSpend: "0.02", maxTokens: 256 }, { write: (r) => records.push(r) });
    assert.deepEqual(records.map((r) => r.result), ["settled", "settled", "stopped"]);
    assert.equal(summary.spent, "0.02");
    assert.equal(summary.payer, TENANT);
    assert.deepEqual([records[0].amount, records[0].network, records[0].payer], ["0.01", "near:testnet", TENANT]);
    assert.match(records[0].invoiceId ?? "", /^[0-9A-F]{32}$/);
    assert.equal(records[0].transaction, double.state.transfers[0].txHash);
    assert.match(records[2].error ?? "", /above the most this buyer may pay/);
    assert.equal(double.state.token.balances.get(TENANT), 5_000n);
  });

  it("NEAR-5.4 tenant.json's near entry is read and checked; two tenants may not share a NEAR account", () => {
    const dir = mkdtempSync(join(tmpdir(), "near-tenants-"));
    const write = (id: string, near: unknown) => {
      mkdirSync(join(dir, id));
      writeFileSync(join(dir, id, "tenant.json"), JSON.stringify({ id, name: id, seedPrefix: "XRPL_SEED_T01", ...(near === undefined ? {} : { near }) }));
      writeFileSync(join(dir, id, "queries.json"), JSON.stringify(["hello"]));
    };
    write("a", { accountId: "a.testnet", keyEnv: "NEAR_KEY_A" });
    write("b", undefined);
    const [a, b] = loadTenants(dir);
    assert.deepEqual(a.near, { accountId: "a.testnet", keyEnv: "NEAR_KEY_A" });
    assert.equal("near" in b, false, "a tenant without near loads as before");
    write("c", { accountId: "Not Valid", keyEnv: "NEAR_KEY_C" });
    assert.throws(() => loadTenants(dir), /near\.accountId/);
    const signer = keySigner({ accountId: "a.testnet", secretKey: tenantKey.toString(), network: "near:testnet", rpcUrl });
    const same = { networkName: "testnet" as const, network: "near:testnet", rpcUrl, signer };
    assert.throws(() => checkDistinct([{ tenant: a, buyer: same }, { tenant: b, buyer: same }]), /same account a\.testnet; give each its own NEAR account/);
  });
});

describe("nearBuyer (environment)", () => {
  const key = KeyPair.fromRandom("ed25519").toString();

  it("NEAR-5.4 reads the account and the key for the chosen network, and never quotes the key", () => {
    const b = nearBuyer({ NEAR_BUYER_ACCOUNT_TESTNET: "buyer.testnet", NEAR_BUYER_KEY_TESTNET: key });
    assert.deepEqual([b.networkName, b.network, b.signer.accountId], ["testnet", "near:testnet", "buyer.testnet"]);
    assert.equal(JSON.stringify(b).includes(key.slice(8)), false, "the secret key is not on the buyer");
    const t = nearBuyer({ NEAR_NETWORK: "mainnet", NEAR_KEY_T01_MAINNET: key }, { accountId: "t01.near", keyPrefix: "NEAR_KEY_T01" });
    assert.deepEqual([t.network, t.signer.accountId], ["near:mainnet", "t01.near"]);
  });

  it("NEAR-5.4 names what is missing or wrong", () => {
    assert.throws(() => nearBuyer({ NEAR_BUYER_KEY_TESTNET: key }), (e: unknown) => e instanceof SetupError && /NEAR_BUYER_ACCOUNT_TESTNET/.test(e.message));
    assert.throws(() => nearBuyer({ NEAR_BUYER_ACCOUNT_TESTNET: "buyer.testnet" }), /NEAR_BUYER_KEY_TESTNET is required/);
    assert.throws(
      () => nearBuyer({ NEAR_BUYER_ACCOUNT_TESTNET: "buyer.testnet", NEAR_BUYER_KEY_TESTNET: "ed25519:secretvaluethatisnotakey" }),
      (e: unknown) => e instanceof SetupError && !e.message.includes("secretvaluethatisnotakey"),
    );
    assert.throws(() => nearBuyer({ NEAR_NETWORK: "localnet" }), /NEAR_NETWORK/);
  });
});

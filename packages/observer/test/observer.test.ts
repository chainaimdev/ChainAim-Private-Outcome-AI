/**
 * privateAI-design-35 ARCH-650: packages/observer. Decoding runs on a real recorded
 * x402 NEAR payment (test/fixtures/x402-near-payment.json, copied from chainaim-adminUI-NEAR near-watch: transaction
 * H3ZFsVY1… on testnet, RPC EXPERIMENTAL_tx_status from archival-rpc.testnet.near.org). The RPC client is driven by a
 * test double fetcher that answers with that same recorded result, so the order of URLs and the error paths are exact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseToDecimal, decodePayment, explorerUrl, NOT_ON_CHAIN, observe, observerConfig, ObserverError, type Fetcher, type ObserverRpc } from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/x402-near-payment.json", import.meta.url), "utf8")) as { tx: string; contract: string; txStatus: Record<string, unknown> };
const TX = fx.tx;
const PAYER = "chainaim-buyer-seller.testnet";
const TRANSFER_BLOCK = "7PxC4Vk55o9ED1by4YMbQb1u5bGZKx4XvdSEhpViybPg";

test("ARCH-650 decodes the recorded meta-transaction payment: relayer, payer, token, pay-to, amount, block", () => {
  const v = decodePayment(fx.txStatus, "near:testnet", PAYER, 6);
  assert.equal(v.transaction, TX);
  assert.equal(v.signer, "chainaim-relayer-seller.testnet");
  assert.equal(v.relayer, "chainaim-relayer-seller.testnet");
  assert.equal(v.payer, PAYER);
  assert.equal(v.token, fx.contract);
  assert.equal(v.payTo, "chainaim-payto-seller.testnet");
  assert.equal(v.amountBase, "10000");
  assert.equal(v.amount, "0.01");
  assert.equal(v.memo, null);
  assert.equal(v.succeeded, true);
  assert.equal(v.blockHash, TRANSFER_BLOCK);
  assert.equal(v.explorerUrl, `https://testnet.nearblocks.io/txns/${TX}`);
  assert.deepEqual(v.notOnChain, [...NOT_ON_CHAIN]);
});

test("ARCH-650 a transaction moving someone else's tokens is refused for this job (409)", () => {
  assert.throws(() => decodePayment(fx.txStatus, "near:testnet", "someone-else.testnet", 6), (e: unknown) => e instanceof ObserverError && e.status === 409 && /receipt names someone-else\.testnet/.test(e.message));
});

test("ARCH-650 a direct ft_transfer signed by the payer (no relayer) is read too; a failed transfer is not shown as paid", () => {
  const args = Buffer.from(JSON.stringify({ receiver_id: "chainaim-payto.testnet", amount: "2500000", memo: "x" })).toString("base64");
  const raw = {
    status: { Failure: {} },
    transaction: { hash: TX, signer_id: "payer.testnet", receiver_id: "usdc.testnet", actions: [{ FunctionCall: { method_name: "ft_transfer", args } }] },
    receipts_outcome: [{ block_hash: "B1", outcome: { executor_id: "usdc.testnet", status: { Failure: {} } } }],
  };
  const v = decodePayment(raw, "near:mainnet", "payer.testnet", 6);
  assert.equal(v.relayer, null);
  assert.equal(v.payer, "payer.testnet");
  assert.equal(v.amount, "2.5");
  assert.equal(v.memo, "x");
  assert.equal(v.succeeded, false);
  assert.equal(v.explorerUrl, `https://nearblocks.io/txns/${TX}`);
});

test("ARCH-650 a transaction with no ft_transfer is not a payment (502)", () => {
  const raw = { transaction: { hash: TX, signer_id: "a.testnet", receiver_id: "b.testnet", actions: ["CreateAccount"] }, receipts_outcome: [] };
  assert.throws(() => decodePayment(raw, "near:testnet", null, 6), (e: unknown) => e instanceof ObserverError && e.status === 502 && /no ft_transfer/.test(e.message));
});

test("ARCH-650 baseToDecimal", () => {
  assert.equal(baseToDecimal("10000", 6), "0.01");
  assert.equal(baseToDecimal("0", 6), "0");
  assert.equal(baseToDecimal("1000000", 6), "1");
  assert.equal(baseToDecimal("1234567", 6), "1.234567");
  assert.equal(baseToDecimal("5", 0), "5");
  assert.throws(() => baseToDecimal("1.5", 6), ObserverError);
  assert.equal(explorerUrl("near:testnet", "abc"), "https://testnet.nearblocks.io/txns/abc");
});

const FLAGS = {
  "observer-rpc-testnet": "https://rpc.testnet.fastnear.com", "observer-rpc-fallback-testnet": "https://archival-rpc.testnet.near.org",
  "observer-rpc-mainnet": "https://rpc.mainnet.fastnear.com", "observer-rpc-fallback-mainnet": "https://archival-rpc.mainnet.near.org",
};

test("ARCH-650 observerConfig: on by default with primary then fallback; off; bad values named", () => {
  const c = observerConfig(FLAGS)!;
  assert.deepEqual(c.urls["near:testnet"], ["https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"]);
  assert.equal(c.timeoutMs, 15000);
  assert.equal(c.decimals, 6);
  assert.equal(observerConfig({ ...FLAGS, observer: "off" }), undefined);
  assert.deepEqual(observerConfig({ ...FLAGS, "observer-rpc-fallback-testnet": "none" })!.urls["near:testnet"], ["https://rpc.testnet.fastnear.com"]);
  assert.throws(() => observerConfig({ ...FLAGS, observer: "maybe" }), /--observer must be on or off/);
  assert.throws(() => observerConfig({ ...FLAGS, "observer-rpc-testnet": "ftp://x" }), /--observer-rpc-testnet must be http\(s\)/);
  assert.throws(() => observerConfig({ ...FLAGS, "observer-timeout-ms": "5" }), /--observer-timeout-ms/);
  assert.throws(() => observerConfig({ ...FLAGS, "observer-token-decimals": "x" }), /--observer-token-decimals/);
});

/** Test double: answers RPC per URL from a table; records each call. */
function fetcherOf(table: Record<string, (method: string, params: Record<string, unknown>) => unknown>, calls: string[]): Fetcher {
  return async (url, init) => {
    const body = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    calls.push(`${new URL(url).host} ${body.method} ${JSON.stringify(body.params)}`);
    const answer = table[url]?.(body.method, body.params);
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer };
  };
}

const CFG: ObserverRpc = observerConfig(FLAGS)!;
const UNKNOWN = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, message: "Server error" } };
const BLOCK = { jsonrpc: "2.0", result: { header: { height: 225000000, timestamp_nanosec: "1762264350000000000" } } };

test("ARCH-650 observe: asks the primary, falls back to the archival node for an old transaction, then that node for the block", async () => {
  const calls: string[] = [];
  const v = await observe({ network: "near:testnet", transaction: TX, payer: PAYER }, CFG, fetcherOf({
    "https://rpc.testnet.fastnear.com": () => UNKNOWN,
    "https://archival-rpc.testnet.near.org": (m) => (m === "tx" ? { jsonrpc: "2.0", result: fx.txStatus } : BLOCK),
  }, calls));
  assert.equal(v.rpcUrl, "https://archival-rpc.testnet.near.org");
  assert.equal(v.amount, "0.01");
  assert.equal(v.blockHeight, 225000000);
  assert.equal(v.blockTime, new Date(1762264350000).toISOString());
  assert.equal(calls.length, 3);
  assert.match(calls[0], /^rpc\.testnet\.fastnear\.com tx .*"sender_account_id":"chainaim-buyer-seller\.testnet"/, "routes by the receipt's payer");
  assert.match(calls[2], new RegExp(`^archival-rpc\\.testnet\\.near\\.org block \\{"block_id":"${TRANSFER_BLOCK}"\\}`));
});

test("ARCH-650 observe: unknown everywhere is 404; an RPC that cannot be reached is 502 naming the host", async () => {
  await assert.rejects(observe({ network: "near:testnet", transaction: TX, payer: PAYER }, CFG, fetcherOf({
    "https://rpc.testnet.fastnear.com": () => UNKNOWN, "https://archival-rpc.testnet.near.org": () => UNKNOWN }, [])),
  (e: unknown) => e instanceof ObserverError && e.status === 404);
  await assert.rejects(observe({ network: "near:testnet", transaction: TX, payer: PAYER }, CFG, fetcherOf({
    "https://rpc.testnet.fastnear.com": () => new Error("connect ECONNREFUSED"), "https://archival-rpc.testnet.near.org": () => UNKNOWN }, [])),
  (e: unknown) => e instanceof ObserverError && e.status === 502 && /rpc\.testnet\.fastnear\.com: connect ECONNREFUSED/.test(e.message));
});

test("ARCH-650 observe: a block lookup that fails still shows the transfer (no time); bad settlements are refused before any call", async () => {
  const v = await observe({ network: "near:testnet", transaction: TX, payer: PAYER }, CFG, fetcherOf({
    "https://rpc.testnet.fastnear.com": (m) => (m === "tx" ? { jsonrpc: "2.0", result: fx.txStatus } : new Error("timeout")) }, []));
  assert.equal(v.blockTime, null);
  assert.equal(v.rpcUrl, "https://rpc.testnet.fastnear.com");
  const calls: string[] = [];
  const f = fetcherOf({}, calls);
  await assert.rejects(observe({ network: "xrpl:1", transaction: TX, payer: PAYER }, CFG, f), (e: unknown) => e instanceof ObserverError && e.status === 400);
  await assert.rejects(observe({ network: "near:testnet", transaction: "not a hash!", payer: PAYER }, CFG, f), (e: unknown) => e instanceof ObserverError && e.status === 400);
  await assert.rejects(observe({ network: "near:testnet", transaction: TX, payer: null }, CFG, f), (e: unknown) => e instanceof ObserverError && e.status === 409);
  assert.equal(calls.length, 0);
});


/**
 * The NEAR USDC rail end to end on loopback (DESIGN "private-ai-NEAR", sections
 * 3, 8 and 9): the paywall with PAY_RAILS=near (and xrpl,near) as its own x402
 * facilitator (@x402/near's facilitator scheme, a relayer key generated for
 * this run), the buyer's real payment code (scripts/near.ts with
 * @x402/near's client signer), and the NEAR JSON-RPC protocol double, which
 * checks every signature and executes the ft_transfer. Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { createClientNearSigner } from "@x402/near";
import { nearPaymentHeader } from "../../web/src/near-payment.ts";
import type { PaymentSink } from "../src/sink.ts";
import { payAndFetchNear, SetupError, type NearBuyer } from "../scripts/near.ts";
import { keySigner } from "../scripts/near-signer.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, PAY_TO, stubFacilitator, stubGateway } from "./stubs.ts";

const TOKEN = "usdc.chainaim-test.testnet";
const NEAR_PAY_TO = "merchant.chainaim-test.testnet";
const BUYER = "buyer.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const KEY = "test-gateway-key";

type Required = { accepts: Record<string, any>[]; resource?: Record<string, unknown>; error?: string };
const decode = (header: string | null): Required => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));

/** A sink that keeps every line it is given. */
function recordingSink(): PaymentSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, send: (line) => void lines.push(line), stats: () => ({ sent: lines.length, failed: 0, dropped: 0, written: 0, writeErrors: 0 }), close: async () => undefined };
}

describe("NEAR USDC rail (PAY_RAILS=near)", () => {
  const buyerKey = KeyPair.fromRandom("ed25519");
  const relayerKey = KeyPair.fromRandom("ed25519");
  const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
  const gateway = stubGateway();
  const logs: string[] = [];
  const sink = recordingSink();
  let rpcUrl = "";
  let paywall: { url: string; close: () => Promise<void> };
  let buyer: NearBuyer;

  before(async () => {
    rpcUrl = await listen(double.server);
    const gatewayUrl = await listen(gateway.server);
    addAccount(double.state, BUYER, buyerKey.getPublicKey().toString());
    addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
    addAccount(double.state, NEAR_PAY_TO);
    paywall = await startNearPaywall(
      {
        PAY_RAILS: "near",
        NEAR_PAY_TO_TESTNET: NEAR_PAY_TO,
        NEAR_USDC_CONTRACT_TESTNET: TOKEN,
        NEAR_USDC_DECIMALS_TESTNET: "6",
        NEAR_RPC_URL_TESTNET: rpcUrl,
        NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER,
        NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(),
        GATEWAY_URL: gatewayUrl,
        CHAINAIM_GATEWAY_KEY: KEY,
      },
      (line) => logs.push(line),
      { sink },
    );
    buyer = { networkName: "testnet", network: "near:testnet", rpcUrl, signer: keySigner({ accountId: BUYER, secretKey: buyerKey.toString(), network: "near:testnet", rpcUrl }), usdcContract: TOKEN };
  });
  after(async () => {
    await paywall.close();
    await close(double.server);
    await close(gateway.server);
  });
  beforeEach(() => {
    const t = double.state.token;
    t.registered.clear();
    t.registered.add(NEAR_PAY_TO);
    t.registered.add(BUYER);
    t.balances.clear();
    t.balances.set(BUYER, 1_000_000n);
    double.state.transfers.length = 0;
    double.state.calls.length = 0;
    double.state.failNextTransfer = undefined;
    gateway.state.status = 200;
    gateway.seen.length = 0;
    logs.length = 0;
    sink.lines.length = 0;
  });

  const init = (body: unknown = { text: "Jane Roe" }) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("NEAR-5.2 quotes one exact offer in USDC base units on near:testnet, with an invoice and no relayer in it", async () => {
    const r = await fetch(`${paywall.url}/v1/privacy/scan`, init());
    assert.equal(r.status, 402);
    const required = decode(r.headers.get("payment-required"));
    assert.equal(required.accepts.length, 1);
    const a = required.accepts[0];
    assert.deepEqual([a.scheme, a.network, a.asset, a.amount, a.payTo, a.maxTimeoutSeconds], ["exact", "near:testnet", TOKEN, "10000", NEAR_PAY_TO, 600]);
    assert.match(a.extra.invoiceId, /^[0-9A-F]{32}$/);
    assert.equal(JSON.stringify(a).includes(RELAYER), false, "the relayer stays facilitator-side");
  });

  it("NEAR-AC2 a paid call is served, the USDC moves on chain, and the payment_settled line names NEAR", async () => {
    const paid = await payAndFetchNear(`${paywall.url}/v1/privacy/scan`, init(), buyer);
    assert.equal(paid.response.status, 200, await paid.response.clone().text());
    assert.equal(paid.amount, "0.01");
    assert.equal(paid.units, "10000");
    assert.equal(double.state.transfers.length, 1);
    const t = double.state.transfers[0];
    assert.deepEqual([t.sender, t.receiver, t.amount], [BUYER, NEAR_PAY_TO, 10_000n]);
    assert.equal(double.state.token.balances.get(BUYER), 990_000n);
    assert.equal(paid.receipt?.success, true);
    assert.equal(paid.receipt?.transaction, t.txHash);
    assert.equal(paid.receipt?.network, "near:testnet");
    const line = JSON.parse(logs.find((l) => l.includes("payment_settled"))!);
    assert.deepEqual(
      [line.event, line.route, line.amount, line.asset, line.network, line.payer, line.transaction, line.invoiceId],
      ["payment_settled", "POST /v1/privacy/scan", "10000", TOKEN, "near:testnet", BUYER, t.txHash, paid.invoiceId],
    );
    assert.equal(sink.lines.length, 1, "the sink gets the same line");
    assert.equal(gateway.seen.find((s) => s.path === "/v1/privacy/scan")?.headers["payment-signature"], undefined, "the payment never reaches the gateway");
  });

  it("NEAR-AC4 a call the gateway refuses submits nothing on chain", async () => {
    gateway.state.status = 503;
    const paid = await payAndFetchNear(`${paywall.url}/v1/privacy/scan`, init(), buyer);
    assert.equal(paid.response.status, 503);
    assert.equal(double.state.transfers.length, 0);
    assert.equal(double.state.calls.includes("send_tx"), false, "no transaction was sent");
    assert.equal(logs.some((l) => l.includes("payment_settled")), false);
  });

  it("NEAR-AC5 the same signed payment presented again is refused as payment_already_used", async () => {
    const quoted = decode((await fetch(`${paywall.url}/v1/privacy/scan`, init())).headers.get("payment-required"));
    const offer = quoted.accepts[0];
    const signed = await buyer.signer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: offer as never });
    const header = nearPaymentHeader(offer as never, signed, quoted.resource);
    const first = await fetch(`${paywall.url}/v1/privacy/scan`, { ...init(), headers: { ...init().headers, "PAYMENT-SIGNATURE": header } });
    assert.equal(first.status, 200);
    const again = await fetch(`${paywall.url}/v1/privacy/scan`, { ...init(), headers: { ...init().headers, "PAYMENT-SIGNATURE": header } });
    assert.equal(again.status, 402);
    assert.equal(double.state.transfers.length, 1, "paid once");
  });

  it("NEAR-8 a refused call's signed delegate cannot be presented again under a new invoice", async () => {
    gateway.state.status = 503;
    const quoted = decode((await fetch(`${paywall.url}/v1/privacy/scan`, init())).headers.get("payment-required"));
    const signed = await buyer.signer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: quoted.accepts[0] as never });
    const refused = await fetch(`${paywall.url}/v1/privacy/scan`, { ...init(), headers: { ...init().headers, "PAYMENT-SIGNATURE": nearPaymentHeader(quoted.accepts[0] as never, signed, quoted.resource) } });
    assert.equal(refused.status, 503);
    gateway.state.status = 200;
    gateway.seen.length = 0;
    const fresh = decode((await fetch(`${paywall.url}/v1/privacy/scan`, init())).headers.get("payment-required"));
    assert.notEqual(fresh.accepts[0].extra.invoiceId, quoted.accepts[0].extra.invoiceId);
    const replay = await fetch(`${paywall.url}/v1/privacy/scan`, { ...init(), headers: { ...init().headers, "PAYMENT-SIGNATURE": nearPaymentHeader(fresh.accepts[0] as never, signed, fresh.resource) } });
    assert.equal(replay.status, 402);
    assert.equal(decode(replay.headers.get("payment-required")).error, "payment_already_used");
    assert.equal(gateway.seen.some((s) => s.path === "/v1/privacy/scan"), false, "the replay never reached the gateway");
    assert.equal(double.state.transfers.length, 0);
  });

  it("NEAR-8 a payment for less than the price is refused before the call is served", async () => {
    const quoted = decode((await fetch(`${paywall.url}/v1/privacy/scan`, init())).headers.get("payment-required"));
    const offer = quoted.accepts[0];
    const cheap = createClientNearSigner({ accountId: BUYER, secretKey: buyerKey.toString(), rpcUrls: { "near:testnet": rpcUrl } });
    const signed = await cheap.createSignedDelegateAction({ x402Version: 2, paymentRequirements: { ...offer, amount: "1" } as never });
    const r = await fetch(`${paywall.url}/v1/privacy/scan`, { ...init(), headers: { ...init().headers, "PAYMENT-SIGNATURE": nearPaymentHeader(offer as never, signed, quoted.resource) } });
    assert.equal(r.status, 402);
    assert.match(decode(r.headers.get("payment-required")).error ?? "", /amount_mismatch/);
    assert.equal(gateway.seen.some((s) => s.path === "/v1/privacy/scan"), false);
    assert.equal(double.state.transfers.length, 0);
  });

  it("NEAR-8 a buyer without enough USDC is refused before the call is served", async () => {
    double.state.token.balances.set(BUYER, 9_999n);
    const paid = await payAndFetchNear(`${paywall.url}/v1/privacy/scan`, init(), buyer);
    assert.equal(paid.response.status, 402);
    assert.equal(paid.refusal, "insufficient_funds");
    assert.equal(gateway.seen.some((s) => s.path === "/v1/privacy/scan"), false);
  });

  it("NEAR-3.2 a transfer that fails on chain after the call was served is logged as payment_settle_failed with its invoice", async () => {
    double.state.failNextTransfer = "The account is frozen";
    const paid = await payAndFetchNear(`${paywall.url}/v1/privacy/scan`, init(), buyer);
    assert.notEqual(paid.response.status, 200, "an unsettled call is not handed over");
    assert.equal(double.state.transfers.length, 0);
    const line = JSON.parse(logs.find((l) => l.includes("payment_settle_failed"))!);
    assert.deepEqual([line.network, line.asset, line.invoiceId, line.reason], ["near:testnet", TOKEN, paid.invoiceId, "settlement_failed"]);
    assert.ok(line.transaction, "the failed transaction's hash is kept");
    assert.equal(logs.some((l) => l.includes("payment_settled")), false);
  });

  it("NEAR-5.4 the buyer refuses a price above --max-amount before signing", async () => {
    await assert.rejects(payAndFetchNear(`${paywall.url}/v1/privacy/scan`, init(), buyer, { maxAmount: "0.005" }), (e: unknown) => e instanceof SetupError && /above the most/.test(e.message));
    assert.equal(double.state.transfers.length, 0);
  });

  it("NEAR-5.4 the buyer refuses a price in another token than its USDC contract", async () => {
    await assert.rejects(payAndFetchNear(`${paywall.url}/v1/privacy/scan`, init(), { ...buyer, usdcContract: "other-usdc.testnet" }), /not the USDC contract/);
  });
});

describe("both rails (PAY_RAILS=xrpl,near)", () => {
  const buyerKey = KeyPair.fromRandom("ed25519");
  const relayerKey = KeyPair.fromRandom("ed25519");
  const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  const logs: string[] = [];
  let rpcUrl = "";
  let paywall: { url: string; close: () => Promise<void> };

  before(async () => {
    rpcUrl = await listen(double.server);
    const facilitatorUrl = await listen(facilitator.server);
    const gatewayUrl = await listen(gateway.server);
    addAccount(double.state, BUYER, buyerKey.getPublicKey().toString());
    addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
    addAccount(double.state, NEAR_PAY_TO);
    double.state.token.registered.add(NEAR_PAY_TO);
    double.state.token.balances.set(BUYER, 1_000_000n);
    paywall = await startNearPaywall(
      {
        PAY_RAILS: "xrpl,near",
        XRPL_PAY_TO_TESTNET: PAY_TO,
        FACILITATOR_URL_TESTNET: facilitatorUrl,
        NEAR_PAY_TO_TESTNET: NEAR_PAY_TO,
        NEAR_USDC_CONTRACT_TESTNET: TOKEN,
        NEAR_USDC_DECIMALS_TESTNET: "6",
        NEAR_RPC_URL_TESTNET: rpcUrl,
        NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER,
        NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(),
        PRICE_CHAT: "$0.02",
        GATEWAY_URL: gatewayUrl,
        CHAINAIM_GATEWAY_KEY: KEY,
      },
      (line) => logs.push(line),
    );
  });
  after(async () => {
    await paywall.close();
    await close(double.server);
    await close(facilitator.server);
    await close(gateway.server);
  });

  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) };

  it("NEAR-AC3 the 402 lists the RLUSD and the USDC offer, both for the same invoice", async () => {
    const r = await fetch(`${paywall.url}/v1/chat/completions`, init);
    assert.equal(r.status, 402);
    const [xrpl, near] = decode(r.headers.get("payment-required")).accepts;
    assert.deepEqual([xrpl.network, xrpl.amount, xrpl.payTo], ["xrpl:1", "0.02", PAY_TO]);
    assert.deepEqual([near.network, near.amount, near.payTo, near.asset], ["near:testnet", "20000", NEAR_PAY_TO, TOKEN]);
    assert.match(xrpl.extra.invoiceId, /^[0-9A-F]{32}$/);
    assert.equal(near.extra.invoiceId, xrpl.extra.invoiceId);
  });

  it("NEAR-AC3 a NEAR buyer pays the USDC offer of a two-rail quote and is served", async () => {
    const buyer: NearBuyer = { networkName: "testnet", network: "near:testnet", rpcUrl, signer: keySigner({ accountId: BUYER, secretKey: buyerKey.toString(), network: "near:testnet", rpcUrl }) };
    const paid = await payAndFetchNear(`${paywall.url}/v1/chat/completions`, init, buyer);
    assert.equal(paid.response.status, 200, await paid.response.clone().text());
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.receiver, t.amount]), [[BUYER, NEAR_PAY_TO, 20_000n]]);
    assert.equal(facilitator.calls.includes("/verify"), false, "the XRPL facilitator is not asked about a NEAR payment");
    const line = JSON.parse(logs.find((l) => l.includes("payment_settled"))!);
    assert.equal(line.network, "near:testnet");
  });

  it("NEAR-AC3 an RLUSD payment on the same route still goes to the XRPL facilitator", async () => {
    const quoted = decode((await fetch(`${paywall.url}/v1/chat/completions`, init)).headers.get("payment-required"));
    const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: quoted.accepts[0], payload: { signedTxBlob: "AB12" }, resource: quoted.resource })).toString("base64");
    facilitator.calls.length = 0;
    const r = await fetch(`${paywall.url}/v1/chat/completions`, { ...init, headers: { ...init.headers, "PAYMENT-SIGNATURE": payment } });
    assert.equal(r.status, 200);
    assert.deepEqual(facilitator.calls, ["/verify", "/settle"]);
  });
});

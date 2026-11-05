/**
 * The release of one paid job (src/near-pay.ts payNearRelease, architecture.md ARCH-111), driven in Node with a real
 * ed25519 key standing in for the browser wallet: it signs real NEP-366 SignedDelegates with @near-js, and @x402/near's
 * own decoder (the paywall's) reads them. The release route is a stand-in that quotes the job, then releases its result.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from "@near-js/transactions";
import { decodeSignedDelegateB64 } from "@x402/near";
import { AFTER_APPROVAL } from "../src/pay.ts";
import { NEAR_PRICE_CHANGED, payNearRelease, type NearFunctionCallAction, type NearPayDeps, type NearPayQuote } from "../src/near-pay.ts";

const BUYER = "buyer.chainaim-test.testnet";
const PAYTO = "merchant.chainaim-test.testnet";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const JOB = "0123456789abcdef0123456789abcdef";
const RELEASE_URL = `http://console.test/paid/jobs/${JOB}/release`;
const QUOTE: NearPayQuote = { network: "near:testnet", asset: USDC, payTo: PAYTO, amount: "5562" };
const OFFER = { scheme: "exact", network: "near:testnet", asset: USDC, amount: "5562", payTo: PAYTO, maxTimeoutSeconds: 600, extra: { invoiceId: "INVOICE-J1" } };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const REQUIRED = b64({ x402Version: 2, resource: { url: RELEASE_URL }, accepts: [OFFER] });
const RESULT = { question: "q", result: { columns: ["n"], rows: [{ n: 1 }], truncated: false }, answer: "one" };
const TX = "8ZsW6v9f7ZtX1x4UQ1nVJqF2c3yYb5mK6HrT9aLpE2dC";

const key = KeyPair.fromRandom("ed25519");
const signer = new KeyPairSigner(key);

function releaseRoute(paid: (req: Request) => Response | Promise<Response>, required = REQUIRED) {
  const seen: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    if (!req.headers.get("payment-signature")) return new Response("{}", { status: 402, headers: { "payment-required": required } });
    return paid(req);
  }) as typeof fetch;
  return { seen, fetcher };
}

async function walletSigns(request: { receiverId: string; actions: NearFunctionCallAction[] }): Promise<string> {
  const actions = request.actions.map((a) => actionCreators.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit)));
  const delegate = buildDelegateAction({ actions, maxBlockHeight: 1_000_500n, nonce: 7n, publicKey: key.getPublicKey(), receiverId: request.receiverId, senderId: BUYER });
  const [, signed] = await signer.signDelegateAction(delegate);
  return Buffer.from(encodeSignedDelegate(signed)).toString("base64");
}

function deps(fetcher: typeof fetch): NearPayDeps & { asked: unknown[] } {
  const asked: unknown[] = [];
  return { asked, signDelegate: async (request) => (asked.push(request), walletSigns(request)), decode: decodeSignedDelegateB64, fetch: fetcher };
}

const released = () => new Response(JSON.stringify(RESULT), { status: 200, headers: { "content-type": "application/json", "payment-response": b64({ success: true, transaction: TX, network: "near:testnet" }) } });

describe("payNearRelease (a paid tab 03 job, USDC on NEAR)", () => {
  it("ARCH-111: success returns the JSON result and tx", async () => {
    const route = releaseRoute(released);
    const d = deps(route.fetcher);
    const r = await payNearRelease(d, BUYER, QUOTE, RELEASE_URL);
    assert.deepEqual(r, { result: RESULT, transaction: TX, network: "near:testnet" });
    assert.equal(d.asked.length, 1);
    assert.deepEqual(d.asked[0], { receiverId: USDC, actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: PAYTO, amount: "5562" }, gas: "30000000000000", deposit: "1" } }] });
    assert.equal(route.seen.length, 2);
    assert.equal(route.seen[1].url, RELEASE_URL);
    const header = JSON.parse(Buffer.from(route.seen[1].headers.get("payment-signature")!, "base64").toString("utf8"));
    assert.deepEqual(header.accepted, OFFER);
    const sent = decodeSignedDelegateB64(header.payload.signedDelegateAction);
    assert.equal(sent.verifySignature(), true);
    assert.deepEqual([sent.delegate.senderId, sent.delegate.receiverId], [BUYER, USDC]);
  });

  it("ARCH-111: amount mismatch → NEAR_PRICE_CHANGED, nothing signed", async () => {
    for (const changed of [{ amount: "5563" }, { payTo: "other.testnet" }, { asset: "usdc.other.testnet" }]) {
      const route = releaseRoute(released, b64({ x402Version: 2, accepts: [{ ...OFFER, ...changed }] }));
      const d = deps(route.fetcher);
      await assert.rejects(payNearRelease(d, BUYER, QUOTE, RELEASE_URL), { message: NEAR_PRICE_CHANGED });
      assert.equal(d.asked.length, 0, "the wallet was not asked");
      assert.equal(route.seen.length, 1, "nothing was sent with a payment");
    }
  });

  it("ARCH-111: a refused payment says not charged; a failure after signing never does", async () => {
    const refused = releaseRoute(() => new Response("{}", { status: 402, headers: { "payment-required": b64({ error: "insufficient_funds" }) } }));
    assert.deepEqual(await payNearRelease(deps(refused.fetcher), BUYER, QUOTE, RELEASE_URL), { error: "The payment was not accepted (insufficient_funds). Check that your NEAR account holds enough USDC on NEAR TestNet. You were not charged.", status: 402 });
    const failed = releaseRoute(() => new Response(JSON.stringify({ error: { message: "the job's result could not be read; you were not charged" } }), { status: 502 }));
    assert.deepEqual(await payNearRelease(deps(failed.fetcher), BUYER, QUOTE, RELEASE_URL), { error: AFTER_APPROVAL, status: 502, transaction: null });
    const lost = releaseRoute(() => Promise.reject(new TypeError("fetch failed")));
    await assert.rejects(payNearRelease(deps(lost.fetcher), BUYER, QUOTE, RELEASE_URL), { message: AFTER_APPROVAL });
  });

  it("ARCH-111: a job that cannot be released (409 / 410) is reported with the paywall's sentence, and nothing is signed", async () => {
    const gone = (async () => new Response(JSON.stringify({ error: { message: "this job has expired; run it again. Nothing was charged" } }), { status: 410 })) as typeof fetch;
    const d = deps(gone);
    assert.deepEqual(await payNearRelease(d, BUYER, QUOTE, RELEASE_URL), { error: "this job has expired; run it again. Nothing was charged", status: 410 });
    assert.equal(d.asked.length, 0);
  });
});

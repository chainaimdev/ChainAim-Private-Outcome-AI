/**
 * The page's NEAR paid call (src/near-pay.ts), driven in Node with a real
 * ed25519 key standing in for the browser wallet: it signs real NEP-366
 * SignedDelegates with @near-js, and @x402/near's own decoder (the paywall's)
 * reads them. The /api/chat route is a stand-in that quotes, then answers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from "@near-js/transactions";
import { decodeSignedDelegateB64 } from "@x402/near";
import { AFTER_APPROVAL } from "../src/pay.ts";
import { NEAR_CANCELLED, NEAR_PRICE_CHANGED, NEAR_SIGN_TIMEOUT, payNearChat, type NearFunctionCallAction, type NearPayDeps, type NearPayQuote } from "../src/near-pay.ts";

const BUYER = "buyer.chainaim-test.testnet";
const PAYTO = "merchant.chainaim-test.testnet";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const CHAT_URL = "http://web.test/api/chat";
const QUOTE: NearPayQuote = { network: "near:testnet", asset: USDC, payTo: PAYTO, amount: "10000" };
const OFFER = { scheme: "exact", network: "near:testnet", asset: USDC, amount: "10000", payTo: PAYTO, maxTimeoutSeconds: 600, extra: { invoiceId: "INVOICE-1" } };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const REQUIRED = b64({ x402Version: 2, resource: { url: CHAT_URL }, accepts: [OFFER] });
const ANSWER = JSON.stringify({ choices: [{ message: { content: "Hi <C_PERSON_1>" } }] });
const BODY = { model: "chainaim/auto", messages: [{ role: "user", content: "Hi <C_PERSON_1>" }], max_tokens: 64 };
const TX = "8ZsW6v9f7ZtX1x4UQ1nVJqF2c3yYb5mK6HrT9aLpE2dC";

const key = KeyPair.fromRandom("ed25519");
const signer = new KeyPairSigner(key);

type Request402 = { required?: string };
/** A stand-in /api/chat: 402 with the quote first, then `paid` for the request that carries a payment. */
function chatRoute(paid: (req: Request) => Response | Promise<Response>, quoted: Request402 = {}) {
  const seen: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    if (!req.headers.get("payment-signature")) return new Response("{}", { status: 402, headers: { "payment-required": quoted.required ?? REQUIRED } });
    return paid(req);
  }) as typeof fetch;
  return { seen, fetcher };
}

/** What a NEAR wallet does with signDelegateActions: sign, and not send, one delegate holding the requested actions. */
async function walletSigns(request: { receiverId: string; actions: NearFunctionCallAction[] }, over: { senderId?: string; amount?: string } = {}): Promise<string> {
  const actions = request.actions.map((a) => {
    const args = over.amount ? { ...(a.params.args as Record<string, unknown>), amount: over.amount } : a.params.args;
    return actionCreators.functionCall(a.params.methodName, args, BigInt(a.params.gas), BigInt(a.params.deposit));
  });
  const delegate = buildDelegateAction({ actions, maxBlockHeight: 1_000_500n, nonce: 7n, publicKey: key.getPublicKey(), receiverId: request.receiverId, senderId: over.senderId ?? BUYER });
  const [, signed] = await signer.signDelegateAction(delegate);
  return Buffer.from(encodeSignedDelegate(signed)).toString("base64");
}

function deps(over: Partial<NearPayDeps> & { fetch: typeof fetch }): NearPayDeps & { asked: { receiverId: string; actions: NearFunctionCallAction[] }[] } {
  const asked: { receiverId: string; actions: NearFunctionCallAction[] }[] = [];
  return {
    asked,
    signDelegate: async (request) => (asked.push(request), walletSigns(request)),
    decode: decodeSignedDelegateB64,
    chatUrl: CHAT_URL,
    ...over,
  };
}

const paidHeader = (req: Request) => JSON.parse(Buffer.from(req.headers.get("payment-signature") ?? "", "base64").toString("utf8"));
const answered = () => new Response(ANSWER, { status: 200, headers: { "payment-response": b64({ success: true, transaction: TX, network: "near:testnet" }), "x-chainaim-model": "m1" } });

describe("payNearChat (USDC on NEAR from the page)", () => {
  it("NEAR-5.3 asks the wallet for exactly one ft_transfer of the quoted amount, sends the signed delegate, and shows the answer", async () => {
    const route = chatRoute(answered);
    const d = deps({ fetch: route.fetcher });
    let signedSeen = 0;
    const a = await payNearChat({ ...d, onSigned: () => signedSeen++ }, BUYER, QUOTE, BODY);
    assert.ok(!("error" in a));
    assert.equal(a.answer, "Hi <C_PERSON_1>");
    assert.deepEqual(a.payment, { transaction: TX, network: "near:testnet" });
    assert.equal(signedSeen, 1);
    assert.deepEqual(d.asked, [
      { receiverId: USDC, actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: PAYTO, amount: "10000" }, gas: "30000000000000", deposit: "1" } }] },
    ]);
    assert.equal(route.seen.length, 2);
    const header = paidHeader(route.seen[1]);
    assert.deepEqual([header.x402Version, header.accepted, header.resource], [2, OFFER, { url: CHAT_URL }]);
    const sent = decodeSignedDelegateB64(header.payload.signedDelegateAction);
    assert.equal(sent.verifySignature(), true);
    assert.deepEqual([sent.delegate.senderId, sent.delegate.receiverId, sent.delegate.actionCount], [BUYER, USDC, 1]);
    assert.equal(await route.seen[1].text(), JSON.stringify(BODY), "the body goes out unchanged with the payment");
  });

  it("NEAR-5.3 refuses before the wallet is asked when the paywall's price is not the one the page showed", async () => {
    for (const changed of [{ amount: "20000" }, { payTo: "other.testnet" }, { asset: "usdc.fakes.testnet" }]) {
      const route = chatRoute(answered, { required: b64({ x402Version: 2, accepts: [{ ...OFFER, ...changed }] }) });
      const d = deps({ fetch: route.fetcher });
      await assert.rejects(payNearChat(d, BUYER, QUOTE, BODY), { message: NEAR_PRICE_CHANGED });
      assert.equal(d.asked.length, 0, "the wallet was not asked");
      assert.equal(route.seen.length, 1, "nothing was sent with a payment");
    }
  });

  it("NEAR-5.3 checks what the wallet signed: another amount, another account or a broken signature is refused and nothing is sent", async () => {
    const cases: [Partial<NearPayDeps>, RegExp][] = [
      [{ signDelegate: (r) => walletSigns(r, { amount: "99999999" }) }, /^The signed payment is for 99999999 base units, not 10000; nothing was paid\.$/],
      [{ signDelegate: (r) => walletSigns(r, { senderId: "someone-else.testnet" }) }, /signed for someone-else\.testnet, not buyer\.chainaim-test\.testnet; nothing was paid\.$/],
      [{ decode: (s) => ({ ...decodeSignedDelegateB64(s), verifySignature: () => false }) }, /signature does not verify; nothing was paid\.$/],
      [{ signDelegate: async () => "bm90IGEgZGVsZWdhdGU=" }, /not a signed NEAR payment; nothing was paid\.$/],
    ];
    for (const [over, message] of cases) {
      const route = chatRoute(answered);
      await assert.rejects(payNearChat(deps({ fetch: route.fetcher, ...over }), BUYER, QUOTE, BODY), { message });
      assert.equal(route.seen.length, 1, `nothing was sent for ${message}`);
    }
  });

  it("NEAR-5.3 says nothing was paid when the visitor closes the wallet or it never answers", async () => {
    const route = chatRoute(answered);
    await assert.rejects(payNearChat(deps({ fetch: route.fetcher, signDelegate: async () => Promise.reject(new Error("User rejected the transactions")) }), BUYER, QUOTE, BODY), { message: NEAR_CANCELLED });
    await assert.rejects(payNearChat(deps({ fetch: route.fetcher, signMs: 20, signDelegate: () => new Promise<string>(() => {}) }), BUYER, QUOTE, BODY), { message: NEAR_SIGN_TIMEOUT });
  });

  it("NEAR-5.3 a refused payment gives the paywall's reason and says USDC on NEAR TestNet", async () => {
    const route = chatRoute(() => new Response("{}", { status: 402, headers: { "payment-required": b64({ error: "insufficient_funds" }) } }));
    const a = await payNearChat(deps({ fetch: route.fetcher }), BUYER, QUOTE, BODY);
    assert.deepEqual(a, { error: "The payment was not accepted (insufficient_funds). Check that your NEAR account holds enough USDC on NEAR TestNet. You were not charged.", status: 402 });
  });

  it("NEAR-5.3 after signing, a lost connection or a server failure never says not charged", async () => {
    const lost = chatRoute(() => Promise.reject(new TypeError("fetch failed")));
    await assert.rejects(payNearChat(deps({ fetch: lost.fetcher }), BUYER, QUOTE, BODY), { message: AFTER_APPROVAL });
    const failed = chatRoute(() => new Response(JSON.stringify({ error: { message: "Gateway failed. You were not charged." } }), { status: 502 }));
    assert.deepEqual(await payNearChat(deps({ fetch: failed.fetcher }), BUYER, QUOTE, BODY), { error: AFTER_APPROVAL, status: 502, transaction: null });
  });
});

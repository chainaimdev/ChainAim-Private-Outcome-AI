/**
 * The NEAR USDC payment code the page and the paywall's buyer scripts share
 * (src/near-payment.ts; DESIGN "private-ai-NEAR", sections 5.3 and 5.4). The
 * same checks run on real signed delegates in services/paywall/test/near-rail.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSignedDelegate, ftTransferCall, nearOffer, nearPaymentHeader, unitsToUsdc, usdcToUnits, type DecodedDelegate, type NearOffer } from "../src/near-payment.ts";
import { readQuote } from "../src/wallets.ts";

const OFFER: NearOffer = { scheme: "exact", network: "near:testnet", asset: "usdc.chainaim-test.testnet", amount: "10000", payTo: "merchant.testnet", maxTimeoutSeconds: 600, extra: { invoiceId: "0123456789ABCDEF0123456789ABCDEF" } };
const args = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));
const good = (): DecodedDelegate => ({
  senderId: "buyer.testnet",
  receiverId: OFFER.asset,
  publicKey: "ed25519:11111111111111111111111111111111",
  maxBlockHeight: 1000n,
  actionCount: 1,
  functionCall: { methodName: "ft_transfer", args: args({ receiver_id: OFFER.payTo, amount: OFFER.amount }), gas: 30_000_000_000_000n, deposit: 1n },
});

describe("near-payment", () => {
  it("NEAR-5.3 picks the exact offer for the network and refuses a malformed one", () => {
    const xrpl = { scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "RLUSD", payTo: "r..." };
    assert.deepEqual(nearOffer([xrpl, OFFER], "near:testnet"), OFFER);
    assert.equal(nearOffer([xrpl], "near:testnet"), undefined);
    assert.throws(() => nearOffer([{ ...OFFER, amount: "0.01" }], "near:testnet"), /not in the expected shape/);
  });

  it("NEAR-G3 asks for one ft_transfer of the quoted amount to payTo on the USDC contract, with 1 yoctoNEAR and 30 TGas", () => {
    assert.deepEqual(ftTransferCall(OFFER), { receiverId: OFFER.asset, methodName: "ft_transfer", args: { receiver_id: "merchant.testnet", amount: "10000" }, gas: "30000000000000", deposit: "1" });
  });

  it("NEAR-8 accepts exactly the payment the offer asks for", () => {
    assert.doesNotThrow(() => checkSignedDelegate(good(), true, OFFER, "buyer.testnet"));
  });

  it("NEAR-8 refuses another signer, a bad signature, another token, more actions, another method, recipient, amount, deposit or too much gas", () => {
    const fc = good().functionCall!;
    const cases: [DecodedDelegate, boolean, RegExp][] = [
      [{ ...good(), senderId: "other.testnet" }, true, /signed for other\.testnet/],
      [good(), false, /signature does not verify/],
      [{ ...good(), receiverId: "fake-usdc.testnet" }, true, /for the token fake-usdc/],
      [{ ...good(), actionCount: 2 }, true, /exactly one function call/],
      [{ ...good(), functionCall: null }, true, /exactly one function call/],
      [{ ...good(), functionCall: { ...fc, methodName: "ft_transfer_call" } }, true, /calls ft_transfer_call/],
      [{ ...good(), functionCall: { ...fc, args: args({ receiver_id: "thief.testnet", amount: "10000" }) } }, true, /pays thief\.testnet/],
      [{ ...good(), functionCall: { ...fc, args: args({ receiver_id: OFFER.payTo, amount: "100000" }) } }, true, /100000 base units, not 10000/],
      [{ ...good(), functionCall: { ...fc, deposit: 2n } }, true, /exactly 1 yoctoNEAR/],
      [{ ...good(), functionCall: { ...fc, gas: 300_000_000_000_000n } }, true, /more gas/],
    ];
    for (const [d, valid, message] of cases) assert.throws(() => checkSignedDelegate(d, valid, OFFER, "buyer.testnet"), (e: unknown) => e instanceof Error && message.test(e.message) && /nothing was paid$/.test(e.message), String(message));
  });

  it("NEAR-5.3 builds the x402 v2 PAYMENT-SIGNATURE header with the offer as accepted and the signed delegate", () => {
    const decoded = JSON.parse(Buffer.from(nearPaymentHeader(OFFER, "c2lnbmVk", { url: "https://pay.example.com/v1/chat/completions" }), "base64").toString("utf8"));
    assert.deepEqual(decoded, { x402Version: 2, accepted: OFFER, payload: { signedDelegateAction: "c2lnbmVk" }, resource: { url: "https://pay.example.com/v1/chat/completions" } });
  });

  it("NEAR-7 converts USDC base units and decimals with integer arithmetic only", () => {
    assert.equal(unitsToUsdc("10000", 6), "0.01");
    assert.equal(unitsToUsdc(1_500_000n, 6), "1.5");
    assert.equal(unitsToUsdc("7", 0), "7");
    assert.equal(usdcToUnits("0.01", 6), 10_000n);
    assert.equal(usdcToUnits("2", 6), 2_000_000n);
    assert.throws(() => usdcToUnits("0.0000001", 6), /more than 6 decimals/);
    assert.throws(() => usdcToUnits("-1", 6), /not a decimal/);
  });
});

describe("readQuote with two rails", () => {
  const RLUSD = { scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "524C555344000000000000000000000000000000", payTo: "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd", extra: { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" } };
  const quote = (accepts: unknown[]) => readQuote("http://paywall.test", "/v1/chat/completions", async () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ accepts })).toString("base64") } }));

  it("NEAR-AC3 reads the RLUSD offer wherever it is listed, and the NEAR offer beside it", async () => {
    const q = await quote([OFFER, RLUSD]);
    assert.deepEqual(q, { payTo: RLUSD.payTo, network: "xrpl:1", asset: RLUSD.asset, issuer: RLUSD.extra.issuer, price: 0.01, near: { network: "near:testnet", asset: OFFER.asset, payTo: OFFER.payTo, amount: "10000" } });
    assert.equal("near" in (await quote([RLUSD])), false, "an XRPL-only quote reads as before");
  });
});

/**
 * One paid chat call in USDC on NEAR: /api/chat answers with a price, the
 * visitor's NEAR wallet signs (and does not send) the payment for it, the
 * signed payment is checked against the price, and the reply becomes an Answer
 * or one plain sentence. The wallet, the decoder and fetch are passed in, so
 * this file has no browser dependency: test/near-pay.test.ts drives it in Node,
 * and near-wallet-entry.ts passes near-connect, @x402/near's decoder and fetch.
 *
 * Money rule, as pay.ts: once the wallet has signed, a failure never says "not
 * charged", because the paywall may have served the call and sent the payment.
 */
import { readAnswer, type Answer, type Failure } from "./answer.ts";
import { checkSignedDelegate, ftTransferCall, nearOffer, nearPaymentHeader, type DecodedDelegate } from "./near-payment.ts";
import { AFTER_APPROVAL, within } from "./pay.ts";
import { decodeReceipt, decodeRequired } from "./xrpl-payment.ts";

/** What the page showed: the paywall's NEAR offer from /api/wallets. */
export type NearPayQuote = { network: string; asset: string; payTo: string; amount: string };

/** near-connect's FunctionCall action, the one action the wallet is asked to sign. */
export type NearFunctionCallAction = { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } };

export type NearPayDeps = {
  /** The wallet signs, without sending, one delegate with these actions, and returns it as base64 Borsh. Untimed: payNearChat adds the time limit. */
  signDelegate: (request: { receiverId: string; actions: NearFunctionCallAction[] }) => Promise<string>;
  /** @x402/near's decodeSignedDelegateB64: the same decoder the paywall uses. */
  decode: (signedDelegateB64: string) => { delegate: DecodedDelegate; verifySignature(): boolean };
  fetch: typeof fetch;
  /** Called once the signed payment has been checked. */
  onSigned?: () => void;
  /** The chat route; the browser uses the page-relative default. */
  chatUrl?: string;
  /** Sign time limit in ms (tests shorten it). */
  signMs?: number;
};

/** A wallet window the visitor never answers would wait for ever. */
const SIGN_MS = 180_000;
export const NEAR_SIGN_TIMEOUT = "The NEAR wallet did not answer in time. Nothing was paid.";
export const NEAR_CANCELLED = "You closed the NEAR wallet before signing. Nothing was paid.";
export const NEAR_PRICE_CHANGED = "The price changed since this page loaded. Reload the page to see the new price. Nothing was paid.";
const NETWORK_LABEL: Record<string, string> = { "near:mainnet": "NEAR MainNet", "near:testnet": "NEAR TestNet" };

/** The paywall's reason for refusing the payment, from its base64 Payment-Required header. */
function refusalReason(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const e = (JSON.parse(atob(header)) as { error?: unknown }).error;
    if (typeof e !== "string") return undefined;
    const reason = e.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
    return reason && reason !== "Payment required" ? reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page's paid chat call with any body the chat route accepts, paid in USDC
 * on NEAR from accountId. The body goes out unchanged, to ask the price and with the payment.
 */
export async function payNearChat(deps: NearPayDeps, accountId: string, quote: NearPayQuote, body: Record<string, unknown>): Promise<Answer | Failure> {
  let signed = false;
  const ask = (payment?: string): Promise<Response> =>
    deps.fetch(deps.chatUrl ?? "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(payment ? { "PAYMENT-SIGNATURE": payment } : {}) },
      body: JSON.stringify(body),
    });
  let r: Response;
  try {
    r = await ask();
    const quoted = r.status === 402 ? r.headers.get("payment-required") : null;
    if (quoted) {
      const required = decodeRequired(quoted);
      const offer = nearOffer(required.accepts as Record<string, unknown>[], quote.network);
      if (!offer) throw new Error(`the price is not quoted for ${quote.network}`);
      // The wallet is asked for exactly what the page showed, or for nothing.
      if (offer.asset !== quote.asset || offer.payTo !== quote.payTo || offer.amount !== quote.amount) throw new Error(NEAR_PRICE_CHANGED);
      const call = ftTransferCall(offer);
      const action: NearFunctionCallAction = { type: "FunctionCall", params: { methodName: call.methodName, args: call.args, gas: call.gas, deposit: call.deposit } };
      const signedDelegate = await within(deps.signDelegate({ receiverId: call.receiverId, actions: [action] }), deps.signMs ?? SIGN_MS, NEAR_SIGN_TIMEOUT);
      if (typeof signedDelegate !== "string" || signedDelegate === "") throw new Error("the NEAR wallet returned no signed payment; nothing was paid");
      let decoded: ReturnType<NearPayDeps["decode"]>;
      try {
        decoded = deps.decode(signedDelegate);
      } catch {
        throw new Error("the NEAR wallet returned something that is not a signed NEAR payment; nothing was paid");
      }
      checkSignedDelegate(decoded.delegate, decoded.verifySignature(), offer, accountId);
      signed = true;
      try {
        deps.onSigned?.();
      } catch {
        /* a status line must not break the payment */
      }
      r = await ask(nearPaymentHeader(offer, signedDelegate, required.resource));
    }
  } catch (e) {
    // The visitor sees one plain sentence; the console keeps the real error for debugging (it holds no text or keys).
    console.error("[privacybuddy] NEAR paid call failed", { signed, error: e });
    const m = String((e as Error)?.message ?? e);
    if (m.includes(NEAR_SIGN_TIMEOUT)) throw new Error(NEAR_SIGN_TIMEOUT);
    if (m.includes(NEAR_PRICE_CHANGED)) throw new Error(NEAR_PRICE_CHANGED);
    if (signed) throw new Error(AFTER_APPROVAL);
    // near-connect and Intear say "User rejected" when the visitor closes or declines the wallet window.
    if (/user rejected/i.test(m)) throw new Error(NEAR_CANCELLED);
    if (m.endsWith("nothing was paid")) throw new Error(`${m.charAt(0).toUpperCase()}${m.slice(1)}.`);
    throw new Error(`The payment could not be made (${m.slice(0, 200)}). Nothing was paid.`);
  }
  if (r.status === 402) {
    const reason = refusalReason(r.headers.get("payment-required"));
    const where = NETWORK_LABEL[quote.network];
    // A refused payment is never sent by the paywall: it sends only after the call was served.
    return { error: `The payment was not accepted${reason ? ` (${reason})` : ""}. Check that your NEAR account holds enough USDC${where ? ` on ${where}` : ""}. You were not charged.`, status: 402 };
  }
  const settled = decodeReceipt(r.headers.get("payment-response"));
  const transaction = settled?.transaction ?? null;
  let text: string;
  try {
    text = await r.text();
  } catch (e) {
    console.error("[privacybuddy] reading the answer failed", { signed, status: r.status, error: e });
    if (signed) return { error: AFTER_APPROVAL, status: 502, transaction };
    throw new Error("The answer could not be read. Nothing was paid.");
  }
  const result = readAnswer(r.status, text, (name) => r.headers.get(name), settled);
  if (!("error" in result)) return result;
  if (signed && r.status >= 500 && /not charged/i.test(result.error)) return { error: AFTER_APPROVAL, status: r.status, transaction };
  return transaction && !result.transaction ? { ...result, transaction } : result;
}

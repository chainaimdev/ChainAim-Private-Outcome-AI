/**
 * The browser side of paying in USDC on NEAR, bundled into public/near-wallet.js
 * by scripts/build-near-wallet.ts (npm run build:near-wallet). The page loads
 * it only when /api/wallets says this deployment offers a NEAR wallet, and
 * nothing here contacts another host until the visitor presses Connect.
 *
 * near-connect runs the wallet's own code in a sandboxed iframe. The page
 * fetches near-connect's wallet list itself and gives the connector only the
 * chosen wallet's entry, after pickNearWallet has checked it, so no other
 * wallet's code can load; the CSP (app.ts) allows only that wallet's hosts.
 * Only the account id, its network and the wallet id are kept by this page, in
 * localStorage; the wallet keeps its keys.
 */
import { NearConnector } from "@hot-labs/near-connect";
import { decodeSignedDelegateB64 } from "@x402/near";
import type { Answer, Failure } from "./answer.ts";
import { payNearChat, type NearPayQuote } from "./near-pay.ts";
import { NEAR_WALLET_MANIFEST, NEAR_WALLETS, isNearWalletId, pickNearWallet, type NearWalletId } from "./near-wallets.ts";
import { within } from "./pay.ts";

export type { NearPayQuote };

const KEY = "privacybuddy.near";
/** A wallet window the visitor never answers would wait for ever, so connecting has a time limit. */
const CONNECT_MS = 120_000;
const CONNECT_TIMEOUT = "The NEAR wallet did not answer in time. Nothing was shared.";
const MANIFEST_MS = 15_000;

type Saved = { accountId: string; caip2: string; wallet: NearWalletId };

function networkOf(caip2: string): "testnet" | "mainnet" {
  if (caip2 === "near:testnet") return "testnet";
  if (caip2 === "near:mainnet") return "mainnet";
  throw new Error(`This page does not pay on ${caip2}.`);
}

function walletOf(id: string): NearWalletId {
  if (!isNearWalletId(id)) throw new Error(`This page does not allow the NEAR wallet ${id}.`);
  return id;
}

export function nearSavedAccount(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return v && typeof v.accountId === "string" && typeof v.caip2 === "string" && isNearWalletId(v.wallet) ? { accountId: v.accountId, caip2: v.caip2, wallet: v.wallet } : null;
  } catch {
    return null;
  }
}

/** One connector per wallet and network, built on first use from the checked manifest entry. */
const connectors = new Map<string, Promise<NearConnector>>();

function connector(id: NearWalletId, caip2: string): Promise<NearConnector> {
  const network = networkOf(caip2);
  const key = `${id}|${network}`;
  let c = connectors.get(key);
  if (!c) {
    c = (async () => {
      let manifest: { version?: unknown };
      try {
        const r = await fetch(NEAR_WALLET_MANIFEST, { credentials: "omit", signal: AbortSignal.timeout(MANIFEST_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        manifest = (await r.json()) as { version?: unknown };
      } catch (e) {
        throw new Error(`The NEAR wallet list could not be loaded (${String((e as Error)?.message ?? e).slice(0, 120)}). Nothing was shared.`);
      }
      const entry = pickNearWallet(manifest, id, network);
      return new NearConnector({
        manifest: { version: typeof manifest.version === "string" ? manifest.version : "1.0.0", wallets: [entry as never] },
        network,
        features: { signDelegateActions: true },
        // An extension announcing itself must not open a wallet window the visitor did not ask for.
        autoConnect: false,
      });
    })();
    c.catch(() => connectors.delete(key));
    connectors.set(key, c);
  }
  return c;
}

/** Ask the NEAR wallet for the account to pay from; caip2 is the network this page pays on. */
export async function nearConnect(walletId: string, caip2: string): Promise<string> {
  const id = walletOf(walletId);
  const c = await connector(id, caip2);
  let accountId: unknown;
  try {
    const wallet = await within(c.connect({ walletId: id }), CONNECT_MS, CONNECT_TIMEOUT);
    accountId = (await wallet.getAccounts({ network: networkOf(caip2) }))[0]?.accountId;
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (m === CONNECT_TIMEOUT) throw new Error(CONNECT_TIMEOUT);
    if (/user rejected/i.test(m)) throw new Error(`You closed ${NEAR_WALLETS[id].name} before connecting. Nothing was shared.`);
    throw new Error(`${NEAR_WALLETS[id].name} could not connect: ${m.slice(0, 200)}`);
  }
  if (typeof accountId !== "string" || !accountId) throw new Error(`${NEAR_WALLETS[id].name} did not share an account.`);
  try {
    localStorage.setItem(KEY, JSON.stringify({ accountId, caip2, wallet: id }));
  } catch {
    /* private window: the page asks again next time */
  }
  return accountId;
}

/** Forget the account on this page and sign out of the wallet's session. */
export async function nearDisconnect(): Promise<void> {
  const saved = nearSavedAccount();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
  if (!saved) return;
  try {
    const c = await connector(saved.wallet, saved.caip2);
    await c.disconnect(await c.wallet(saved.wallet));
  } catch (e) {
    // The page has already forgotten the account; the wallet's own session ends when its site data is cleared.
    console.error("[privacybuddy] NEAR wallet sign-out failed", { error: e });
  }
}

/** The page's paid chat call, paid in USDC on NEAR: one masked user message. */
export function nearPayAndAsk(accountId: string, walletId: string, quote: NearPayQuote, masked: string, maxTokens = 512, onSigned?: () => void): Promise<Answer | Failure> {
  return nearPayAndChat(accountId, walletId, quote, { model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens }, "/api/chat", onSigned);
}

/**
 * The test console's paid chat (test-console/console): any chat body the
 * paywall accepts, sent to chatUrl, which relays it to the paywall. Same
 * payment, signing and money rules as nearPayAndAsk.
 */
export async function nearPayAndChat(accountId: string, walletId: string, quote: NearPayQuote, body: Record<string, unknown>, chatUrl: string, onSigned?: () => void): Promise<Answer | Failure> {
  const id = walletOf(walletId);
  const network = networkOf(quote.network);
  const c = await connector(id, quote.network);
  const wallet = await c.wallet(id);
  return payNearChat(
    {
      async signDelegate(request) {
        const out = await wallet.signDelegateActions({ network, signerId: accountId, delegateActions: [request] });
        const list = out?.signedDelegateActions;
        if (!Array.isArray(list) || list.length !== 1) throw new Error("the NEAR wallet did not return exactly one signed payment; nothing was paid");
        return list[0];
      },
      decode: decodeSignedDelegateB64,
      fetch: (input, init) => fetch(input, init),
      onSigned,
      chatUrl,
    },
    accountId,
    quote,
    body,
  );
}

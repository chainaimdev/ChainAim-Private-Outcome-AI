/**
 * The PrivacyBuddy web app: the page, the browser masking module, the wallet
 * bundle, what the paywall asks for, and the paid chat relay. The server holds
 * no wallet key: the visitor's Crossmark wallet signs each payment in the browser.
 * Everything it depends on is passed in, so the tests run it with a stand-in paywall.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { NETWORKS } from "./balance.ts";
import { NEAR_WALLETS, type NearWalletId } from "./near-wallets.ts";
import { MAX_MASKED_CHARS, registerRelay } from "./relay.ts";
import { networkInfo, networkName, readQuote, type Quote } from "./wallets.ts";

export { MAX_MASKED_CHARS };

const CHAT = "/v1/chat/completions";
const SCAN = "/v1/privacy/scan";
/**
 * The page's CSP. With no NEAR wallet it is the Crossmark-only policy, unchanged.
 * With one, connect-src gains exactly that wallet's hosts and frame-src is
 * stated with them (it fell back to default-src 'self' before); nothing else
 * changes. src/near-wallets.ts lists the hosts, docs/NEAR-GATES.md says why.
 */
function csp(nearWallet?: NearWalletId): string {
  const near = nearWallet ? NEAR_WALLETS[nearWallet] : undefined;
  return (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    // The browser reads balances and payment details from the public XRP Ledger servers, over WebSocket.
    `connect-src 'self' ${Object.values(NETWORKS).map((n) => new URL(n.wsUrl).origin).join(" ")}${near ? ` ${near.connectSrc.join(" ")}` : ""}; ` +
    (near ? `frame-src 'self' ${near.frameSrc.join(" ")}; ` : "") +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
}

/** The headers sent on every response; scripts/build-vercel.ts gives Vercel's static files the same set. */
export function securityHeaders(nearWallet?: NearWalletId): Record<string, string> {
  return {
    "content-security-policy": csp(nearWallet),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/** The headers with no NEAR wallet: Crossmark and RLUSD only. */
export const SECURITY_HEADERS: Record<string, string> = securityHeaders();

export type Deps = {
  paywallUrl: string;
  /** client-mask.ts as browser JavaScript. */
  maskModule: string;
  /** The page, read on every request so an edit shows without a restart. */
  pageFile: URL;
  /** The cookie policy page, public/cookies.html. */
  cookiesFile: URL;
  /** public/wallet.js: the Crossmark and x402 browser bundle (npm run build:wallet). */
  walletFile: URL;
  /** NEAR_WALLET: the NEAR wallet the page may run. Unset: no NEAR button and the Crossmark-only CSP. */
  nearWallet?: NearWalletId;
  /** public/near-wallet.js (npm run build:near-wallet), served only when nearWallet is set. */
  nearWalletFile?: URL;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Status, sizes and timing only. Never text, placeholders, the map or the payment. */
  log?: (line: Record<string, unknown>) => void;
};

function cached<T>(ttlMs: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; v: T } | undefined;
  return async () => {
    if (value && now() - value.at < ttlMs) return value.v;
    const v = await load();
    value = { at: now(), v };
    return v;
  };
}

export function createWebApp(deps: Deps): Hono {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  // The chat quote carries the price; if chat cannot be quoted (no capacity), the scan quote still gives the pay-to address and network.
  const quote = cached<{ quote: Quote; priced: boolean }>(30_000, now, async () => {
    try {
      return { quote: await readQuote(deps.paywallUrl, CHAT, fetcher), priced: true };
    } catch {
      return { quote: await readQuote(deps.paywallUrl, SCAN, fetcher), priced: false };
    }
  });

  const app = new Hono();
  const headers = deps.nearWallet ? securityHeaders(deps.nearWallet) : SECURITY_HEADERS;

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
  });

  app.get("/", async (c) => c.html(await readFile(deps.pageFile, "utf8")));
  app.get("/cookies.html", async (c) => c.html(await readFile(deps.cookiesFile, "utf8")));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/client-mask.js", (c) => c.body(deps.maskModule, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }));
  app.get("/wallet.js", async (c) => {
    const js = await readFile(deps.walletFile, "utf8").catch(() => undefined);
    if (js === undefined) return c.json({ error: { message: "public/wallet.js is not built. Run npm run build:wallet." } }, 404);
    return c.body(js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  });
  if (deps.nearWallet) {
    const file = deps.nearWalletFile ?? new URL("../public/near-wallet.js", import.meta.url);
    app.get("/near-wallet.js", async (c) => {
      const js = await readFile(file, "utf8").catch(() => undefined);
      if (js === undefined) return c.json({ error: { message: "public/near-wallet.js is not built. Run npm run build:near-wallet." } }, 404);
      return c.body(js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    });
  }

  app.get("/api/wallets", async (c) => {
    const q = await quote().catch(() => undefined);
    const network = q ? networkName(q.quote.network) : "unknown";
    const info = networkInfo(network);
    return c.json({
      network,
      caip2: info?.caip2 ?? null,
      wsUrl: info?.wsUrl ?? null,
      asset: q?.quote.asset ?? null,
      issuer: q?.quote.issuer ?? null,
      payTo: q ? { address: q.quote.payTo } : null,
      prices: { chat: q?.priced ? q.quote.price : null },
      // Only when the paywall also offers USDC on NEAR (PAY_RAILS=xrpl,near); the amount is whole USDC base units.
      // wallet: the NEAR wallet this page may run (NEAR_WALLET); without it the page shows no NEAR button.
      ...(q?.quote.near ? { near: { ...q.quote.near, priced: q.priced, ...(deps.nearWallet ? { wallet: deps.nearWallet, walletName: NEAR_WALLETS[deps.nearWallet].name } : {}) } } : {}),
    });
  });

  registerRelay(app, { paywallUrl: deps.paywallUrl, fetcher, now, log });

  app.notFound((c) => c.json({ error: { message: "Not found." } }, 404));
  return app;
}

/**
 * The console's way to ChainAim's signer (privateAI-design-36 ARCH-663). The console is the data plane: it holds the
 * files, the question, the result and the unmasking. Everything that is signed for a paid job (the price, the AP2
 * quote, the checkout mandate check, the receipt and its settlement) is done by the signer, which sees ids, sizes, hashes
 * and amounts only (packages/signer allowlist).
 *
 *   --signer local|remote          local (default): the signer runs in this process with the keys of --ap2-key-env /
 *                                  --receipt-key-env (one-process development and tests); remote: ca-control-signer over
 *                                  HTTP, and this console holds no ChainAim signing key at all
 *   --signer-url URL               remote only: e.g. http://host.docker.internal:8780 (own compose project on the PC) or
 *                                  https://<service>.up.railway.app (control plane in the cloud)
 *   --signer-key-env NAME          remote only: the request key sent as X-Signer-Key (default SIGNER_REQUEST_KEY)
 *   --signer-timeout-sec N         remote only: per request (default 10)
 *   --signer-start-wait-sec N      remote only: how long start-up waits for the signer's public keys (default 60)
 *
 * A signer that cannot be reached means nothing is quoted, run or settled (SignerUnavailable -> 502 at the caller; at the
 * paid release the paywall then settles nothing, ARCH-611). Messages carry statuses and the signer's own error text
 * (which names fields, never values); never a key.
 */
import type { Ap2Signer, PublicJwk } from "../../packages/ap2/src/index.ts";
import type { ReceiptSigner, SignedReceipt } from "../../packages/receipt/src/index.ts";
import type { JobQuote } from "../../packages/crossask/src/cost.ts";
import type { MandateRequest, MandateResult, PriceRequest, PublicKeys, QuoteRequest, ReceiptRequest, SettleRequest, SignedQuote, SignerApi } from "../../packages/signer/src/index.ts";

export type SignerClientFlags = { signer?: string; "signer-url"?: string; "signer-key-env"?: string; "signer-timeout-sec"?: string; "signer-start-wait-sec"?: string };
export type SignerClientConfig = { mode: "local" } | { mode: "remote"; url: string; key: string; keyEnv: string; timeoutMs: number; startWaitMs: number };

/** The signer could not be reached or failed: nothing was signed. */
export class SignerUnavailable extends Error {}
/** The signer refused the request (400 a field it does not accept, 409 not what it signed): nothing was signed. */
export class SignerRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const whole = (raw: string | undefined, fallback: number, name: string, lo: number, hi: number): number => {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be a whole number from ${lo} to ${hi}, got ${raw}`);
  return n;
};

/** The checked flags; throws naming the flag or the variable (never its value). */
export function signerClientConfig(flags: SignerClientFlags, env: Record<string, string | undefined>): SignerClientConfig {
  const mode = flags.signer ?? "local";
  if (mode !== "local" && mode !== "remote") throw new Error(`--signer must be local or remote, got ${mode}`);
  if (mode === "local") {
    for (const f of ["signer-url", "signer-key-env", "signer-timeout-sec", "signer-start-wait-sec"] as const) if (flags[f] !== undefined) throw new Error(`--${f} needs --signer remote`);
    return { mode };
  }
  const url = flags["signer-url"];
  if (!url || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new Error("--signer remote needs --signer-url http(s)://... (ca-control-signer)");
  const keyEnv = flags["signer-key-env"] ?? "SIGNER_REQUEST_KEY";
  if (!ENV_NAME.test(keyEnv)) throw new Error(`--signer-key-env must be an environment variable name, got ${keyEnv}`);
  const key = env[keyEnv]?.trim() ?? "";
  if (key.length < 32) throw new Error(`--signer remote needs ${keyEnv}: the request key ca-control-signer expects (at least 32 characters; desk.ps1 -SignerKeys)`);
  return {
    mode, url: url.replace(/\/+$/, ""), key, keyEnv,
    timeoutMs: whole(flags["signer-timeout-sec"], 10, "signer-timeout-sec", 1, 300) * 1000,
    startWaitMs: whole(flags["signer-start-wait-sec"], 60, "signer-start-wait-sec", 0, 600) * 1000,
  };
}

/** ca-control-signer over HTTP: the same SignerApi as the in-process SellerSigner. */
export class RemoteSigner implements SignerApi {
  private readonly url: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  constructor(cfg: { url: string; key: string; timeoutMs: number }) {
    this.url = cfg.url;
    this.key = cfg.key;
    this.timeoutMs = cfg.timeoutMs;
  }

  private async call(path: string, body?: unknown, okStatuses: readonly number[] = [200]): Promise<{ status: number; body: unknown }> {
    let r: Response;
    try {
      r = await fetch(`${this.url}${path}`, body === undefined
        ? { signal: AbortSignal.timeout(this.timeoutMs) }
        : { method: "POST", headers: { "content-type": "application/json", "x-signer-key": this.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new SignerUnavailable((e as Error).name === "TimeoutError" ? `ChainAim's signer did not answer within ${this.timeoutMs / 1000} s; nothing was signed` : "ChainAim's signer cannot be reached; nothing was signed");
    }
    let parsed: unknown;
    try { parsed = await r.json(); } catch { parsed = undefined; }
    if (okStatuses.includes(r.status)) return { status: r.status, body: parsed };
    const why = typeof (parsed as { error?: unknown })?.error === "string" ? (parsed as { error: string }).error : `HTTP ${r.status}`;
    if (r.status === 400 || r.status === 409) throw new SignerRefused(r.status, `ChainAim's signer refused: ${why}`);
    throw new SignerUnavailable(`ChainAim's signer failed (HTTP ${r.status}): ${why}; nothing was signed`);
  }

  async keys(): Promise<PublicKeys> { return (await this.call("/.well-known/keys")).body as PublicKeys; }
  async price(r: PriceRequest): Promise<JobQuote> { return (await this.call("/v1/price", r)).body as JobQuote; }
  async signQuote(r: QuoteRequest): Promise<SignedQuote> { return (await this.call("/v1/quotes", r)).body as SignedQuote; }
  async signReceipt(r: ReceiptRequest): Promise<SignedReceipt> { return (await this.call("/v1/receipts", r)).body as SignedReceipt; }
  async settle(r: SettleRequest): Promise<SignedReceipt> { return (await this.call("/v1/receipts/settle", r)).body as SignedReceipt; }
  async verifyMandate(r: MandateRequest): Promise<MandateResult> { return (await this.call("/v1/mandates/verify", r, [200, 422])).body as MandateResult; }
}

/** The signer's public keys, retried until it answers or startWaitMs passes (up.ps1 starts it first; Railway may be cold). */
export async function waitForSignerKeys(s: SignerApi, startWaitMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<PublicKeys> {
  const until = Date.now() + startWaitMs;
  for (;;) {
    try { return await s.keys(); }
    catch (e) {
      if (!(e instanceof SignerUnavailable) || Date.now() >= until) throw e;
      await sleep(2000);
    }
  }
}

const HELD_ELSEWHERE = "this console holds no ChainAim signing key (--signer remote): ca-control-signer signs";

/**
 * The public half of a key the remote signer holds, shaped as the console's AP2 / receipt config expects it (the UCP
 * profile and GET /jobs/<id>/receipt publish it). Signing with it throws: with --signer remote the console never signs.
 */
export function remoteAp2Signer(jwk: PublicJwk): Ap2Signer {
  return { kid: jwk.kid, alg: "ES256", publicJwk: jwk, signBytes: () => { throw new Error(HELD_ELSEWHERE); } };
}
export function remoteReceiptSigner(k: { keyId: string; publicKeyPem: string }): ReceiptSigner {
  return { keyId: k.keyId, publicKeyPem: k.publicKeyPem, signBytes: () => { throw new Error(HELD_ELSEWHERE); } };
}

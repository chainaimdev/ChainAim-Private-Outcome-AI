/**
 * AP2 closed Checkout Mandate (privateAI-design-36 ARCH-665; design-33 section 4 Phase 2).
 *
 * The buyer's agent signs its permission to complete ONE merchant-signed checkout; ChainAim's signer verifies it before
 * the job runs (ARCH-667). The format follows the closed example of https://ap2-protocol.org/ap2/checkout_mandate/
 * (read 2026-11-13; the page shows SD-JWT with disclosures):
 *
 *   presentation = <signed JWT> "~" <D2> "~" <D1> "~"
 *   signed JWT   header  {alg: "ES256", typ: "kb+sd-jwt", kid}            (kid: the tenant's mandate key, RFC 7638 id)
 *                payload {delegate_payload: [{"...": digest(D2)}], iat, aud, nonce, sd_hash: digest(D1), _sd_alg: "sha-256"}
 *   D2 (array element disclosure)   [salt, {_sd: [digest(D1)], vct: "mandate.checkout.1", checkout_hash, iat, exp}]
 *   D1 (object property disclosure) [salt, "checkout_jwt", <compact JWS of the checkout>]
 *
 * digest(D) = base64url(SHA-256(ASCII(D))) as SD-JWT (RFC 9901) defines it; checkout_hash = base64url(SHA-256(checkout_jwt)).
 * checkout_jwt is the attached form of ChainAim's merchant_authorization (index.ts attachedJws), so the mandate commits to
 * exactly the checkout ChainAim signed. nonce is the paywall's invoice id for this payment, aud the business id of the
 * verifier (--mandate-audience). vct uses the ".1" form of the page's type section and example (its schema table says
 * "mandate.checkout"; design-33 section 4 chose ".1").
 *
 * Where the page is not explicit, these choices are ours and stated here: the agent signs both the mandate and its key
 * binding with one tenant key (no separate user-signed open mandate: the tenant's spending policy plays that role), so the
 * signed JWT carries kid; sd_hash is the digest of the checkout_jwt disclosure, as in the page's closed example. Every
 * member is required and nothing else is accepted, so two parties never read a different mandate.
 *
 * Nothing here logs. Messages name members and codes, never a key or a token.
 */
import { createHash, createPrivateKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { b64u, B64URL, fromB64u, keyFromJwk, publicJwkOf, type Ap2ErrorCode } from "./index.ts";

export const MANDATE_VCT = "mandate.checkout.1";
export const MANDATE_TYP = "kb+sd-jwt";
export const SD_ALG = "sha-256";

/** base64url(SHA-256(ASCII(s))): an SD-JWT disclosure digest, and checkout_hash over checkout_jwt. */
export const sdDigest = (s: string): string => createHash("sha256").update(s, "ascii").digest("base64url");
/** SHA-256 hex of a whole presentation: what a receipt records (mandate.sha256). */
export const mandateSha256 = (presentation: string): string => createHash("sha256").update(presentation, "utf8").digest("hex");

const encodeDisclosure = (arr: unknown[]): string => b64u(JSON.stringify(arr));

export type MandateInput = {
  /** The compact JWS of the checkout (attachedJws of the merchant_authorization). */
  checkoutJwt: string;
  /** The tenant's mandate signing key (EC P-256 private) and its kid (publicJwkOf(key).kid). */
  key: KeyObject;
  kid: string;
  aud: string;
  nonce: string;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
};

/** Builds a closed checkout mandate presentation. Throws on a bad input (never on a key value). */
export function buildCheckoutMandate(i: MandateInput): string {
  if (typeof i.checkoutJwt !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(i.checkoutJwt)) throw new Error("checkout_jwt must be a compact JWS");
  if (!/^[0-9a-f]{32}$/.test(i.kid)) throw new Error("the mandate key id must be 32 hex characters");
  if (typeof i.aud !== "string" || !/^[\x21-\x7E]{1,200}$/.test(i.aud)) throw new Error("aud must be 1 to 200 printable characters");
  if (typeof i.nonce !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(i.nonce)) throw new Error("nonce must be the payment's invoice id");
  if (!Number.isInteger(i.iat) || !Number.isInteger(i.exp) || i.exp <= i.iat) throw new Error("iat and exp must be whole seconds with exp after iat");
  if (i.key.type !== "private" || i.key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the mandate key must be an EC P-256 private key");
  const d1 = encodeDisclosure([b64u(randomBytes(16)), "checkout_jwt", i.checkoutJwt]);
  const d1Digest = sdDigest(d1);
  const d2 = encodeDisclosure([b64u(randomBytes(16)), { _sd: [d1Digest], vct: MANDATE_VCT, checkout_hash: sdDigest(i.checkoutJwt), iat: i.iat, exp: i.exp }]);
  const header = b64u(JSON.stringify({ alg: "ES256", typ: MANDATE_TYP, kid: i.kid }));
  const payload = b64u(JSON.stringify({ delegate_payload: [{ "...": sdDigest(d2) }], iat: i.iat, aud: i.aud, nonce: i.nonce, sd_hash: d1Digest, _sd_alg: SD_ALG }));
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`, "ascii"), { key: i.key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64u(sig)}~${d2}~${d1}~`;
}

export type MandateKeyEntry = { tenant: string; accountId: string; keys: unknown[] };

export type MandateCheck = {
  /** The registered tenants and their public mandate keys (config/ap2-mandate-keys.json). */
  registry: readonly MandateKeyEntry[];
  aud: string;
  /** The invoice id the payment carries; omitted only when a receipt is re-checked offline (the receipt records it). */
  nonce?: string;
  /** Seconds since the epoch; omitted = times not checked (offline re-check of a mandate that was checked before the run). */
  now?: number;
  skewSec?: number;
  maxLifetimeSec?: number;
};

export type MandateVerdict =
  | { ok: true; kid: string; tenant: string; accountId: string; nonce: string; aud: string; iat: number; exp: number; checkoutJwt: string; sha256: string }
  | { ok: false; code: Ap2ErrorCode; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactly = (o: Record<string, unknown>, names: readonly string[]): boolean => {
  const k = Object.keys(o).sort();
  const want = [...names].sort();
  return k.length === want.length && k.every((n, i) => n === want[i]);
};
const jsonOf = (s: string): unknown => {
  if (!B64URL.test(s) || s === "") throw new Error("not base64url");
  return JSON.parse(fromB64u(s).toString("utf8"));
};

/** The largest presentation accepted (a checkout of one line item is far below this). */
export const MANDATE_MAX_CHARS = 16_384;

/**
 * Verifies a closed checkout mandate: structure, digests, the tenant key's signature, audience, nonce and times. Does NOT
 * verify the checkout's merchant signature (the caller holds the merchant keys: signer or verify-receipt), but returns the
 * checkout_jwt it committed to. Never throws.
 */
export function verifyCheckoutMandate(presentation: unknown, c: MandateCheck): MandateVerdict {
  const bad = (reason: string): MandateVerdict => ({ ok: false, code: "mandate_invalid_signature", reason });
  const scope = (reason: string): MandateVerdict => ({ ok: false, code: "mandate_scope_mismatch", reason });
  if (presentation === undefined || presentation === null || presentation === "") return { ok: false, code: "mandate_required", reason: "no checkout mandate was presented" };
  if (typeof presentation !== "string" || presentation.length > MANDATE_MAX_CHARS) return bad(`the checkout mandate must be a string of at most ${MANDATE_MAX_CHARS} characters`);
  const parts = presentation.split("~");
  if (parts.length !== 4 || parts[3] !== "") return bad("the checkout mandate must be <jwt>~<mandate disclosure>~<checkout disclosure>~");
  const [jwt, d2, d1] = parts;
  const seg = jwt.split(".");
  if (seg.length !== 3) return bad("the mandate JWT must have three parts");
  let header: unknown, payload: unknown, m: unknown, ck: unknown;
  try {
    header = jsonOf(seg[0]);
    payload = jsonOf(seg[1]);
    m = jsonOf(d2);
    ck = jsonOf(d1);
  } catch {
    return bad("a mandate part is not base64url JSON");
  }
  if (!isObj(header) || !exactly(header, ["alg", "typ", "kid"])) return bad("the mandate header must hold exactly alg, typ and kid");
  if (header.alg !== "ES256") return bad("the mandate alg must be ES256");
  if (header.typ !== MANDATE_TYP) return bad(`the mandate typ must be ${MANDATE_TYP}`);
  if (typeof header.kid !== "string" || !/^[0-9a-f]{32}$/.test(header.kid)) return bad("the mandate kid must be 32 hex characters");
  let found: { tenant: string; accountId: string; key: KeyObject } | undefined;
  for (const t of c.registry) {
    for (const k of t.keys) {
      let parsed;
      try { parsed = keyFromJwk(k); } catch { continue; } // a malformed registry entry is not a candidate
      if (parsed.kid === header.kid) { found = { tenant: t.tenant, accountId: t.accountId, key: parsed.key }; break; }
    }
    if (found) break;
  }
  if (!found) return { ok: false, code: "agent_missing_key", reason: "the mandate's kid is not a registered tenant mandate key" };
  const sig = (() => { try { return fromB64u(seg[2]); } catch { return Buffer.alloc(0); } })();
  if (sig.length !== 64) return bad("the ES256 mandate signature must be 64 bytes (IEEE P1363 r||s)");
  if (!verify("sha256", Buffer.from(`${seg[0]}.${seg[1]}`, "ascii"), { key: found.key, dsaEncoding: "ieee-p1363" }, sig)) return bad("the tenant's mandate signature does not verify");
  if (!isObj(payload) || !exactly(payload, ["delegate_payload", "iat", "aud", "nonce", "sd_hash", "_sd_alg"])) return bad("the mandate payload must hold exactly delegate_payload, iat, aud, nonce, sd_hash and _sd_alg");
  if (payload._sd_alg !== SD_ALG) return bad(`_sd_alg must be ${SD_ALG}`);
  const dp = payload.delegate_payload;
  if (!Array.isArray(dp) || dp.length !== 1 || !isObj(dp[0]) || !exactly(dp[0], ["..."]) || dp[0]["..."] !== sdDigest(d2)) return bad("delegate_payload must hold the digest of the mandate disclosure");
  if (!Array.isArray(m) || m.length !== 2 || typeof m[0] !== "string" || !isObj(m[1])) return bad("the mandate disclosure must be [salt, mandate]");
  const md = m[1];
  if (!exactly(md, ["_sd", "vct", "checkout_hash", "iat", "exp"])) return bad("the mandate must hold exactly _sd, vct, checkout_hash, iat and exp");
  if (md.vct !== MANDATE_VCT) return bad(`vct must be ${MANDATE_VCT} (a closed checkout mandate)`);
  const d1Digest = sdDigest(d1);
  if (!Array.isArray(md._sd) || md._sd.length !== 1 || md._sd[0] !== d1Digest) return bad("the mandate's _sd must hold the digest of the checkout disclosure");
  if (payload.sd_hash !== d1Digest) return bad("sd_hash must be the digest of the checkout disclosure");
  if (!Array.isArray(ck) || ck.length !== 3 || typeof ck[0] !== "string" || ck[1] !== "checkout_jwt" || typeof ck[2] !== "string") return bad("the checkout disclosure must be [salt, \"checkout_jwt\", jws]");
  const checkoutJwt = ck[2];
  if (md.checkout_hash !== sdDigest(checkoutJwt)) return bad("checkout_hash is not the hash of checkout_jwt");
  for (const [n, v] of [["iat", payload.iat], ["mandate iat", md.iat], ["mandate exp", md.exp]] as const) if (!Number.isInteger(v)) return bad(`${n} must be whole seconds`);
  const iat = payload.iat as number, mIat = md.iat as number, exp = md.exp as number;
  if (exp <= mIat) return bad("the mandate's exp must be after its iat");
  if (payload.aud !== c.aud) return scope("the mandate is addressed to another business (aud)");
  if (typeof payload.nonce !== "string" || payload.nonce === "") return bad("the mandate nonce must be a non-empty string");
  if (c.nonce !== undefined && payload.nonce !== c.nonce) return scope("the mandate's nonce is not this payment's invoice id");
  if (c.now !== undefined) {
    const skew = c.skewSec ?? 30;
    if (iat > c.now + skew || mIat > c.now + skew) return { ok: false, code: "mandate_expired", reason: "the mandate is dated in the future" };
    if (exp <= c.now - skew) return { ok: false, code: "mandate_expired", reason: "the mandate has expired" };
    if (c.maxLifetimeSec !== undefined && exp - mIat > c.maxLifetimeSec) return { ok: false, code: "mandate_expired", reason: `the mandate lives longer than ${c.maxLifetimeSec} s` };
  }
  return { ok: true, kid: header.kid, tenant: found.tenant, accountId: found.accountId, nonce: payload.nonce, aud: payload.aud as string, iat: mIat, exp, checkoutJwt, sha256: mandateSha256(presentation) };
}

/** The detached merchant_authorization and the checkout object of a compact checkout JWS (inverse of attachedJws). */
export function detachCheckoutJwt(checkoutJwt: string): { merchantAuthorization: string; checkout: Record<string, unknown> } {
  const seg = checkoutJwt.split(".");
  if (seg.length !== 3) throw new Error("checkout_jwt must be a compact JWS");
  const checkout = jsonOf(seg[1]);
  if (!isObj(checkout)) throw new Error("checkout_jwt's payload must be a JSON object");
  return { merchantAuthorization: `${seg[0]}..${seg[2]}`, checkout };
}

/** config/ap2-mandate-keys.json: {tenants: [{tenant, accountId, keys: [public JWK]}]}, checked entry by entry. */
export function parseMandateRegistry(raw: unknown): MandateKeyEntry[] {
  const t = isObj(raw) ? raw.tenants : undefined;
  if (!Array.isArray(t)) throw new Error("the mandate key registry must be {\"tenants\": [...]}");
  const seen = new Set<string>();
  return t.map((e, i) => {
    if (!isObj(e) || typeof e.tenant !== "string" || !/^[a-z0-9_-]{1,32}$/.test(e.tenant)) throw new Error(`tenants[${i}].tenant must be a tenant id`);
    if (typeof e.accountId !== "string" || !/^[a-z0-9._-]{2,64}$/.test(e.accountId)) throw new Error(`tenants[${i}].accountId must be a NEAR account id`);
    if (!Array.isArray(e.keys) || e.keys.length === 0) throw new Error(`tenants[${i}].keys must list at least one public key`);
    for (const [j, k] of e.keys.entries()) {
      let kid: string;
      try { kid = keyFromJwk(k).kid; } catch (err) { throw new Error(`tenants[${i}].keys[${j}]: ${(err as Error).message}`); }
      if (seen.has(kid)) throw new Error(`tenants[${i}].keys[${j}]: the key id ${kid} is registered twice`);
      seen.add(kid);
    }
    return { tenant: e.tenant, accountId: e.accountId, keys: e.keys };
  });
}

/** The agent's environment variable holding tenant <id>'s mandate key (PKCS#8 PEM, EC P-256, newlines written as \\n). */
export function mandateKeyVariable(tenant: string): string {
  if (!/^[a-z0-9_-]{1,32}$/.test(tenant)) throw new Error(`the tenant id must look like t02, got ${tenant}`);
  return `AP2_MANDATE_KEY_${tenant.toUpperCase().replace(/-/g, "_")}`;
}

/** Tenant <id>'s mandate key from the environment, or undefined when unset; throws naming the variable when it is not P-256. */
export function mandateKeyFromEnv(env: Record<string, string | undefined>, tenant: string): { key: KeyObject; kid: string } | undefined {
  const variable = mandateKeyVariable(tenant);
  const raw = env[variable]?.trim();
  if (!raw) return undefined;
  let key: KeyObject;
  try { key = createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" }); } catch { throw new Error(`${variable} is not a PEM private key`); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`${variable} must be an EC P-256 key (ES256)`);
  return { key, kid: publicJwkOf(key).kid };
}

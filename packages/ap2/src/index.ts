/**
 * AP2 mandates over UCP checkout (privateAI-design-33 ARCH-626).
 *
 * merchant_authorization (UCP extension dev.ucp.common.payment.ap2_mandate, version 2026-08-25): a JWS with detached
 * content (RFC 7515 Appendix F), written `<base64url header>..<base64url signature>`, over the JCS (RFC 8785) form of the
 * checkout with its `ap2` member removed. The header carries `alg` and `kid`; `kid` names a key in the business
 * profile's top-level `keys[]` (GET /.well-known/ucp). AP2 v0.2 allows ECDSA only (ES256/ES384/ES512); this module
 * implements ES256 (owner decision D1, design-33 section 1): P-256, SHA-256, signature as IEEE P1363 r||s (64 bytes).
 *
 * AP2's `checkout_jwt` (Phase 2, the checkout mandate) is the attached form of the same JWS (`attachedJws`), so the
 * checkout is signed once.
 *
 * Nothing here logs. Error messages name fields and codes, never a key or a payload.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";

/** The UCP AP2 extension this module implements. */
export const AP2_CAPABILITY = "dev.ucp.common.payment.ap2_mandate";
export const UCP_VERSION = "2026-08-25";

/** The verification error codes of the UCP AP2 extension (payment_ap2_mandate.json error_code). */
export const AP2_ERROR_CODES = [
  "mandate_required",
  "agent_missing_key",
  "mandate_invalid_signature",
  "mandate_expired",
  "mandate_scope_mismatch",
  "merchant_authorization_invalid",
  "merchant_authorization_missing",
] as const;
export type Ap2ErrorCode = (typeof AP2_ERROR_CODES)[number];

/** The algorithms this module signs and verifies with. AP2 v0.2 allows ES256/ES384/ES512; only ES256 is implemented. */
export const AP2_ALGS = ["ES256"] as const;
export type Ap2Alg = (typeof AP2_ALGS)[number];

// ---- JCS (RFC 8785) ---------------------------------------------------------------------------------------------------

/**
 * The JCS form of a JSON value. Strings and numbers are written as ECMAScript JSON.stringify writes them, which is what
 * RFC 8785 sections 3.2.2.2 and 3.2.2.3 prescribe; object members are sorted by their names as UTF-16 code units
 * (section 3.2.3), which is what Array.prototype.sort compares. undefined, functions, symbols, bigints, non-finite
 * numbers and non-plain objects are refused with the path of the value, never dropped, so two parties never sign
 * different bytes for what looks like the same object.
 */
export function jcs(value: unknown, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => jcs(v, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not a plain object`);
      const obj = value as Record<string, unknown>;
      const names = Object.keys(obj).sort();
      return `{${names.map((n) => `${JSON.stringify(n)}:${jcs(obj[n], `${path}.${n}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`${path} is ${typeof value}, which has no JSON form`);
  }
}

// ---- base64url --------------------------------------------------------------------------------------------------------

export const B64URL = /^[A-Za-z0-9_-]*$/;
export const b64u = (data: string | Uint8Array): string => Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64url");
/** Decodes base64url without padding; throws on any other character. */
export function fromB64u(s: string): Buffer {
  if (!B64URL.test(s)) throw new Error("not base64url");
  return Buffer.from(s, "base64url");
}

// ---- keys -------------------------------------------------------------------------------------------------------------

/** A public signing key as published in a UCP profile's keys[] (RFC 7517). */
export type PublicJwk = { kid: string; kty: "EC"; crv: "P-256"; x: string; y: string; use: "sig"; alg: Ap2Alg };

/** The RFC 7638 thumbprint input of an EC public key: the required members crv, kty, x, y in that order, no whitespace. */
export function thumbprintInput(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

/** The key id: the first 16 bytes (hex) of the SHA-256 RFC 7638 thumbprint, deterministic from the key like the receipt key id. */
export function kidOf(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash("sha256").update(thumbprintInput(jwk), "utf8").digest("hex").slice(0, 32);
}

function assertP256(key: KeyObject, what: string): void {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`${what} must be an EC P-256 key (ES256)`);
}

/** The public JWK of a P-256 key (private or public KeyObject), with kid, use and alg. */
export function publicJwkOf(key: KeyObject): PublicJwk {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  assertP256(pub, "the key");
  const j = pub.export({ format: "jwk" }) as JsonWebKey;
  if (j.kty !== "EC" || j.crv !== "P-256" || typeof j.x !== "string" || typeof j.y !== "string") throw new Error("the key could not be exported as an EC P-256 JWK");
  return { kid: kidOf({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }), kty: "EC", crv: "P-256", x: j.x, y: j.y, use: "sig", alg: "ES256" };
}

/**
 * A published key checked member by member: EC, P-256, base64url x and y of 32 bytes, use "sig" when present, alg ES256
 * when present, and kid equal to kidOf (a key whose kid does not match its own thumbprint is refused, so a profile cannot
 * relabel a key). Returns the node KeyObject. The message names the member, never its value.
 */
export function keyFromJwk(jwk: unknown): { kid: string; key: KeyObject } {
  const j = jwk as Record<string, unknown> | null;
  if (typeof j !== "object" || j === null) throw new Error("the key must be a JWK object");
  if (j.kty !== "EC" || j.crv !== "P-256") throw new Error("the key must be kty EC, crv P-256");
  for (const m of ["x", "y"] as const) {
    if (typeof j[m] !== "string" || !B64URL.test(j[m] as string) || fromB64u(j[m] as string).length !== 32) throw new Error(`the key's ${m} must be 32 bytes, base64url`);
  }
  if (j.use !== undefined && j.use !== "sig") throw new Error("the key's use must be sig");
  if (j.alg !== undefined && j.alg !== "ES256") throw new Error("the key's alg must be ES256");
  if ("d" in j) throw new Error("the key is a private key; only public keys are published or pinned");
  const kid = kidOf({ crv: "P-256", kty: "EC", x: j.x as string, y: j.y as string });
  if (j.kid !== kid) throw new Error("the key's kid is not its RFC 7638 thumbprint id");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: j.x as string, y: j.y as string }, format: "jwk" });
  } catch {
    throw new Error("the key is not a point on P-256");
  }
  return { kid, key };
}

/** A signer for merchant authorizations. */
export type Ap2Signer = { kid: string; alg: Ap2Alg; publicJwk: PublicJwk; signBytes: (data: string) => Buffer };

export function signerFromKey(privateKey: KeyObject): Ap2Signer {
  if (privateKey.type !== "private") throw new Error("the AP2 signing key must be a private key");
  assertP256(privateKey, "the AP2 signing key");
  const publicJwk = publicJwkOf(privateKey);
  return {
    kid: publicJwk.kid,
    alg: "ES256",
    publicJwk,
    signBytes: (data) => sign("sha256", Buffer.from(data, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" }),
  };
}

/**
 * The signer from a PKCS#8 PEM P-256 private key in the environment variable `variable` (console --ap2-key-env, default
 * AP2_SIGNING_KEY; newlines written as \n, as scripts/receipt-key-core.ts writes them). Refuses naming the variable only.
 */
export function signerFromEnv(env: Record<string, string | undefined>, variable: string): Ap2Signer {
  const raw = env[variable]?.trim();
  if (!raw) throw new Error(`${variable} is not set: the AP2 signing key (PKCS#8 PEM, EC P-256); create it with .\\test-console\\desk.ps1 -Ap2Key, see MANUAL_SETUP.md`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" });
  } catch {
    throw new Error(`${variable} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`${variable} must be an EC P-256 key (ES256)`);
  return signerFromKey(key);
}

// ---- merchant_authorization (JWS detached content) --------------------------------------------------------------------

/** The value a merchant authorization signs: the checkout with its `ap2` member removed (UCP AP2: "excluding the ap2 field"). */
export function checkoutPayload(checkout: Record<string, unknown>): Record<string, unknown> {
  if (typeof checkout !== "object" || checkout === null || Array.isArray(checkout)) throw new Error("the checkout must be a JSON object");
  const { ap2: _ap2, ...rest } = checkout;
  return rest;
}

/** UCP AP2 pattern of merchant_authorization: `<header>..<signature>`, both base64url. */
export const DETACHED_JWS = /^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/;

/** Signs a checkout: the detached JWS `<b64u(JCS(header))>..<b64u(signature)>` over JCS(checkout minus ap2). */
export function signMerchantAuthorization(checkout: Record<string, unknown>, signer: Ap2Signer): string {
  const header = b64u(jcs({ alg: signer.alg, kid: signer.kid }));
  const payload = b64u(jcs(checkoutPayload(checkout)));
  return `${header}..${b64u(signer.signBytes(`${header}.${payload}`))}`;
}

/** The attached (compact) form of a detached JWS for this checkout: AP2's checkout_jwt. Does not verify. */
export function attachedJws(merchantAuthorization: string, checkout: Record<string, unknown>): string {
  const m = DETACHED_JWS.exec(merchantAuthorization);
  if (!m) throw new Error("merchant_authorization must be <header>..<signature>");
  return `${m[1]}.${b64u(jcs(checkoutPayload(checkout)))}.${m[2]}`;
}

export type MerchantVerdict = { ok: true; kid: string; alg: Ap2Alg } | { ok: false; code: Ap2ErrorCode; reason: string };

/**
 * Verifies a merchant authorization over `checkout` (its `ap2` member, if any, is left out of the signed bytes) with one
 * of `keys` (public JWKs, each checked by keyFromJwk). Refuses: a missing value (merchant_authorization_missing); a value
 * that is not `<header>..<signature>`, a header that is not a JSON object of exactly alg and kid, an alg outside
 * `allowedAlgs`, an unknown kid, a signature that is not 64 bytes, and a signature that does not verify
 * (merchant_authorization_invalid). A header with any other member (crit, b64, ...) is refused rather than half-understood.
 */
export function verifyMerchantAuthorization(
  merchantAuthorization: unknown,
  checkout: Record<string, unknown>,
  keys: readonly unknown[],
  allowedAlgs: readonly Ap2Alg[] = AP2_ALGS,
): MerchantVerdict {
  const bad = (reason: string): MerchantVerdict => ({ ok: false, code: "merchant_authorization_invalid", reason });
  if (merchantAuthorization === undefined || merchantAuthorization === null || merchantAuthorization === "") {
    return { ok: false, code: "merchant_authorization_missing", reason: "the checkout carries no ap2.merchant_authorization" };
  }
  if (typeof merchantAuthorization !== "string") return bad("merchant_authorization must be a string");
  const m = DETACHED_JWS.exec(merchantAuthorization);
  if (!m) return bad("merchant_authorization must be a detached JWS <header>..<signature>");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64u(m[1]).toString("utf8")) as Record<string, unknown>;
  } catch {
    return bad("the JWS header is not base64url JSON");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) return bad("the JWS header must be a JSON object");
  const members = Object.keys(header).sort();
  if (members.length !== 2 || members[0] !== "alg" || members[1] !== "kid") return bad("the JWS header must hold exactly alg and kid");
  if (!(allowedAlgs as readonly unknown[]).includes(header.alg)) return bad(`the JWS alg must be one of ${allowedAlgs.join(", ")}`);
  if (typeof header.kid !== "string" || header.kid === "") return bad("the JWS kid must be a non-empty string");
  let key: KeyObject | undefined;
  for (const k of keys) {
    let parsed;
    try {
      parsed = keyFromJwk(k);
    } catch {
      continue; // a malformed entry is not a candidate; the kid lookup below reports the miss
    }
    if (parsed.kid === header.kid) { key = parsed.key; break; }
  }
  if (!key) return bad("the JWS kid names no key this verifier holds");
  const sig = fromB64u(m[2]);
  if (sig.length !== 64) return bad("the ES256 signature must be 64 bytes (IEEE P1363 r||s)");
  let payload: string;
  try {
    payload = b64u(jcs(checkoutPayload(checkout)));
  } catch (e) {
    return bad(`the checkout has no JCS form: ${(e as Error).message}`);
  }
  const ok = verify("sha256", Buffer.from(`${m[1]}.${payload}`, "ascii"), { key, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) return bad("the merchant signature does not verify over this checkout");
  return { ok: true, kid: header.kid, alg: header.alg as Ap2Alg };
}

/** SHA-256 hex of a merchant authorization string (receipt merchantAuthSha256, design-33 ARCH-631). */
export function merchantAuthSha256(merchantAuthorization: string): string {
  return createHash("sha256").update(merchantAuthorization, "utf8").digest("hex");
}

// privateAI-design-36 ARCH-665: the buyer side, the closed Checkout Mandate (mandate.ts).
export * from "./mandate.ts";

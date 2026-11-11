import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  AP2_ERROR_CODES,
  attachedJws,
  checkoutPayload,
  fromB64u,
  jcs,
  keyFromJwk,
  kidOf,
  merchantAuthSha256,
  publicJwkOf,
  signerFromEnv,
  signerFromKey,
  signMerchantAuthorization,
  thumbprintInput,
  verifyMerchantAuthorization,
} from "../src/index.ts";

const newSigner = () => signerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
const checkout = (): Record<string, unknown> => ({
  id: "0123456789abcdef0123456789abcdef",
  status: "ready_for_complete",
  currency: "USD",
  line_items: [{ id: "job", quantity: 1, item: { id: "chainaim.crossask", title: "ChainAim private analysis job", price: 1 }, totals: [{ type: "subtotal", amount: 1 }, { type: "total", amount: 1 }] }],
  totals: [{ type: "subtotal", amount: 1 }, { type: "total", amount: 1 }],
  links: [{ type: "terms_of_service", url: "https://chainaim.example/terms" }],
});

// ---- JCS: RFC 8785 test data (sections 3.2.2, 3.2.3, Appendix B) ----------------------------------------------------

test("ARCH-626 jcs: the RFC 8785 section 3.2.2 sample gives the section 3.2.3 output", () => {
  const input = JSON.parse(`{
    "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    "string": "\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\"\\/",
    "literals": [null, true, false]
  }`);
  assert.equal(jcs(input), `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`);
});

test("ARCH-626 jcs: members are sorted by UTF-16 code units (RFC 8785 section 3.2.3 sorting example)", () => {
  const input = JSON.parse(`{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}`);
  const values = Object.values(JSON.parse(jcs(input)) as Record<string, string>);
  // Object.values would reorder the integer-like key "1"; read the order from the text instead.
  const order = [...jcs(input).matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"]);
  assert.equal(values.length, 7);
});

test("ARCH-626 jcs: numbers serialize as RFC 8785 Appendix B shows (IEEE 754 hex -> text)", () => {
  const rows: [string, string][] = [
    ["0000000000000000", "0"], ["8000000000000000", "0"], ["0000000000000001", "5e-324"], ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"], ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"], ["c340000000000000", "-9007199254740992"], ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"], ["44b52d02c7e14af6", "1e+23"], ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"], ["3eb0c6f7a0b5ed8d", "0.000001"], ["43143ff3c1cb0959", "1424953923781206.2"],
  ];
  for (const [hex, want] of rows) {
    const n = Buffer.from(hex, "hex").readDoubleBE(0);
    assert.equal(jcs(n), want, hex);
  }
});

test("ARCH-626 jcs: values with no single JSON form are refused with their path, never dropped", () => {
  assert.throws(() => jcs({ a: undefined }), /\$\.a is undefined/);
  assert.throws(() => jcs({ a: [1, Number.NaN] }), /\$\.a\[1\] is not a finite number/);
  assert.throws(() => jcs({ a: Infinity }), /not a finite number/);
  assert.throws(() => jcs({ a: 1n }), /bigint/);
  assert.throws(() => jcs({ d: new Date(0) }), /\$\.d is not a plain object/);
});

// ---- keys -------------------------------------------------------------------------------------------------------------

test("ARCH-626 jwk: the public JWK is EC P-256 with use sig, alg ES256 and kid = RFC 7638 thumbprint id", () => {
  const s = newSigner();
  const j = s.publicJwk;
  assert.deepEqual(Object.keys(j).sort(), ["alg", "crv", "kid", "kty", "use", "x", "y"]);
  assert.equal(j.kty, "EC"); assert.equal(j.crv, "P-256"); assert.equal(j.use, "sig"); assert.equal(j.alg, "ES256");
  assert.equal(thumbprintInput(j), `{"crv":"P-256","kty":"EC","x":"${j.x}","y":"${j.y}"}`);
  assert.match(j.kid, /^[0-9a-f]{32}$/);
  assert.equal(j.kid, kidOf(j));
  assert.equal(s.kid, j.kid);
  assert.equal(keyFromJwk(j).kid, j.kid);
});

test("ARCH-626 jwk: a relabelled kid, a private key, another curve or a bad coordinate is refused", () => {
  const j = newSigner().publicJwk;
  assert.throws(() => keyFromJwk({ ...j, kid: "business_2025" }), /kid is not its RFC 7638 thumbprint id/);
  assert.throws(() => keyFromJwk({ ...j, d: "AAAA" }), /private key/);
  assert.throws(() => keyFromJwk({ ...j, crv: "P-384" }), /crv P-256/);
  assert.throws(() => keyFromJwk({ ...j, alg: "EdDSA" }), /alg must be ES256/);
  assert.throws(() => keyFromJwk({ ...j, x: "abc" }), /x must be 32 bytes/);
  assert.throws(() => keyFromJwk({ ...j, use: "enc" }), /use must be sig/);
});

test("ARCH-626 signerFromEnv: reads a \\n-escaped PKCS#8 P-256 PEM; refuses missing, non-PEM and Ed25519 keys naming the variable only", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const value = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\r?\n/g, "\\n");
  const s = signerFromEnv({ AP2_SIGNING_KEY: value }, "AP2_SIGNING_KEY");
  assert.equal(s.kid, publicJwkOf(privateKey).kid);
  assert.throws(() => signerFromEnv({}, "AP2_SIGNING_KEY"), /AP2_SIGNING_KEY is not set.*-Ap2Key/);
  assert.throws(() => signerFromEnv({ K: "nope" }, "K"), /^Error: K is not a PEM private key$/);
  const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => signerFromEnv({ K: ed }, "K"), /K must be an EC P-256 key \(ES256\)/);
  try { signerFromEnv({ K: ed }, "K"); } catch (e) { assert.ok(!(e as Error).message.includes("PRIVATE KEY")); }
});

// ---- merchant_authorization -------------------------------------------------------------------------------------------

test("ARCH-626 merchant_authorization: detached JWS <header>..<sig>, header JCS {alg ES256, kid}, verifies with the published key", () => {
  const s = newSigner();
  const c = checkout();
  const ma = signMerchantAuthorization(c, s);
  assert.match(ma, /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
  const [h, , sig] = ma.split(".");
  assert.equal(fromB64u(h).toString("utf8"), `{"alg":"ES256","kid":"${s.kid}"}`);
  assert.equal(fromB64u(sig).length, 64);
  assert.deepEqual(verifyMerchantAuthorization(ma, c, [s.publicJwk]), { ok: true, kid: s.kid, alg: "ES256" });
});

test("ARCH-626 merchant_authorization: the ap2 member is not signed, so adding it (UCP checkout response) keeps the signature valid", () => {
  const s = newSigner();
  const c = checkout();
  const ma = signMerchantAuthorization(c, s);
  const withAp2 = { ...c, ap2: { merchant_authorization: ma } };
  assert.deepEqual(checkoutPayload(withAp2), c);
  assert.equal(verifyMerchantAuthorization(ma, withAp2, [s.publicJwk]).ok, true);
  assert.equal(signMerchantAuthorization(withAp2, s).split("..")[0], ma.split("..")[0]);
});

test("ARCH-626 merchant_authorization: member order does not matter (JCS), any changed term does (merchant_authorization_invalid)", () => {
  const s = newSigner();
  const c = checkout();
  const ma = signMerchantAuthorization(c, s);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(verifyMerchantAuthorization(ma, reordered, [s.publicJwk]).ok, true);
  const dearer = { ...c, totals: [{ type: "subtotal", amount: 2 }, { type: "total", amount: 2 }] };
  const v = verifyMerchantAuthorization(ma, dearer, [s.publicJwk]);
  assert.deepEqual(v, { ok: false, code: "merchant_authorization_invalid", reason: "the merchant signature does not verify over this checkout" });
});

test("ARCH-626 merchant_authorization: missing, malformed, wrong alg, extra header member, unknown kid, short signature are refused with the AP2 code", () => {
  const s = newSigner();
  const other = newSigner();
  const c = checkout();
  const ma = signMerchantAuthorization(c, s);
  const [h, , sig] = ma.split(".");
  const hdr = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  for (const missing of [undefined, null, ""]) assert.equal((verifyMerchantAuthorization(missing, c, [s.publicJwk]) as { code: string }).code, "merchant_authorization_missing");
  const cases: [unknown, RegExp][] = [
    [42, /must be a string/],
    [`${h}.${Buffer.from(jcs(c)).toString("base64url")}.${sig}`, /detached JWS/],
    [`${hdr({ alg: "ES384", kid: s.kid })}..${sig}`, /alg must be one of ES256/],
    [`${hdr({ alg: "EdDSA", kid: s.kid })}..${sig}`, /alg must be one of ES256/],
    [`${hdr({ alg: "none", kid: s.kid })}..${sig}`, /alg must be one of ES256/],
    [`${hdr({ alg: "ES256", kid: s.kid, crit: ["b64"], b64: false })}..${sig}`, /exactly alg and kid/],
    [`${hdr({ alg: "ES256" })}..${sig}`, /exactly alg and kid/],
    [`${hdr([1])}..${sig}`, /JSON object|exactly alg and kid/],
    [`!!..${sig}`, /detached JWS/],
    [`${h}..${sig.slice(0, 40)}`, /64 bytes/],
  ];
  for (const [value, re] of cases) {
    const v = verifyMerchantAuthorization(value, c, [s.publicJwk]);
    assert.equal(v.ok, false);
    assert.equal((v as { code: string }).code, "merchant_authorization_invalid");
    assert.match((v as { reason: string }).reason, re);
  }
  const unknown = verifyMerchantAuthorization(ma, c, [other.publicJwk]);
  assert.match((unknown as { reason: string }).reason, /kid names no key/);
  // A malformed key in the set is skipped, the right one still found.
  assert.equal(verifyMerchantAuthorization(ma, c, [{ kty: "RSA" }, s.publicJwk]).ok, true);
  // A key relabelled with the signer's kid does not stand in for it.
  assert.equal(verifyMerchantAuthorization(ma, c, [{ ...other.publicJwk, kid: s.kid }]).ok, false);
});

test("ARCH-626 merchant_authorization: the signature is IEEE P1363 over ASCII(header.payload), checked with node:crypto directly", () => {
  const s = newSigner();
  const c = checkout();
  const ma = signMerchantAuthorization(c, s);
  const [h, , sig] = ma.split(".");
  const signingInput = `${h}.${Buffer.from(jcs(c), "utf8").toString("base64url")}`;
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: s.publicJwk.x, y: s.publicJwk.y }, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(signingInput, "ascii"), { key: pub, dsaEncoding: "ieee-p1363" }, fromB64u(sig)), true);
  // The same bytes as DER are not accepted by a P1363 verifier: the encoding is fixed.
  assert.equal(verify("sha256", Buffer.from(signingInput, "ascii"), { key: pub, dsaEncoding: "der" }, fromB64u(sig)), false);
});

test("ARCH-626 attachedJws: AP2 checkout_jwt is the compact form of the same signature (payload = JCS checkout minus ap2)", () => {
  const s = newSigner();
  const c = checkout();
  const ma = signMerchantAuthorization(c, s);
  const jwt = attachedJws(ma, { ...c, ap2: { merchant_authorization: ma } });
  const [h, p, sig] = jwt.split(".");
  assert.equal(`${h}..${sig}`, ma);
  assert.deepEqual(JSON.parse(fromB64u(p).toString("utf8")), c);
  assert.throws(() => attachedJws("abc", c), /<header>..<signature>/);
});

test("ARCH-626 merchantAuthSha256 and the error code list", () => {
  assert.equal(merchantAuthSha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.deepEqual([...AP2_ERROR_CODES], ["mandate_required", "agent_missing_key", "mandate_invalid_signature", "mandate_expired", "mandate_scope_mismatch", "merchant_authorization_invalid", "merchant_authorization_missing"]);
});

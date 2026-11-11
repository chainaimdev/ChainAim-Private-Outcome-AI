/**
 * privateAI-design-32 ARCH-614: the console's receipt signing key in <secretsDir>\chainaim.env, made by
 * scripts/receipt-key.ts (desk.ps1 -ReceiptKey). Real files in a temporary folder and the real CLI; no stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import { ensureReceiptKey, readEnvValue, upsertEnvLine } from "../receipt-key-core.ts";
import { signerFromEnv } from "../../packages/receipt/src/index.ts";
import { keyFromJwk, signerFromEnv as ap2SignerFromEnv, signMerchantAuthorization, verifyMerchantAuthorization } from "../../packages/ap2/src/index.ts";

const CLI = fileURLToPath(new URL("../receipt-key.ts", import.meta.url));
const fresh = () => mkdtempSync(join(tmpdir(), "receipt-key-"));
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 20_000 });
/** The base64 body of a one-line PEM value, to prove it never appears in output. */
const keyBody = (value: string) => value.replace(/-----[A-Z ]+-----/g, "").replace(/\\n/g, "").trim();

test("ARCH-614 upsertEnvLine: other lines, comments and CRLF kept; duplicates collapse to one line where the first was; appended when absent", () => {
  const crlf = "# keys\r\nOPENROUTER_API_KEY=a\r\nRECEIPT_SIGNING_KEY=old1\r\nBEDROCK_API_KEY=b\r\nRECEIPT_SIGNING_KEY=old2\r\n";
  assert.equal(upsertEnvLine(crlf, "RECEIPT_SIGNING_KEY", "new"), "# keys\r\nOPENROUTER_API_KEY=a\r\nRECEIPT_SIGNING_KEY=new\r\nBEDROCK_API_KEY=b\r\n");
  assert.equal(upsertEnvLine("A=1\nB=2", "RECEIPT_SIGNING_KEY", "v"), "A=1\nB=2\nRECEIPT_SIGNING_KEY=v\n");
  assert.equal(upsertEnvLine("", "RECEIPT_SIGNING_KEY", "v"), "RECEIPT_SIGNING_KEY=v\n");
  assert.equal(upsertEnvLine("RECEIPT_SIGNING_KEY_OLD=x\n", "RECEIPT_SIGNING_KEY", "v"), "RECEIPT_SIGNING_KEY_OLD=x\nRECEIPT_SIGNING_KEY=v\n", "a longer name is another variable");
  assert.throws(() => upsertEnvLine("", "RECEIPT_SIGNING_KEY", "a\nb"), /one line/);
  assert.throws(() => upsertEnvLine("", "bad-name", "v"), /variable name/);
});

test("ARCH-614 readEnvValue: the last line wins, quotes trimmed as up.ps1 does, empty is absent", () => {
  assert.equal(readEnvValue("K=1\nK=2\n", "K"), "2");
  assert.equal(readEnvValue("K=\"q\"\r\n", "K"), "q");
  assert.equal(readEnvValue("K=\n", "K"), undefined);
  assert.equal(readEnvValue("KK=1\n", "K"), undefined);
});

test("ARCH-614 ensureReceiptKey: created, kept on a second run (file unchanged), rotated on request; the key signs and verifies", () => {
  const dir = fresh();
  try {
    const f = join(dir, "chainaim.env");
    writeFileSync(f, "OPENROUTER_API_KEY=keep-me\r\n");
    const a = ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", false);
    assert.equal(a.outcome, "created");
    const text1 = readFileSync(f, "utf8");
    assert.ok(text1.startsWith("OPENROUTER_API_KEY=keep-me\r\n"), "the other line is kept, with its CRLF");
    const value = readEnvValue(text1, "RECEIPT_SIGNING_KEY")!;
    assert.match(value, /^-----BEGIN PRIVATE KEY-----\\n.+\\n-----END PRIVATE KEY-----$/, "one line, newlines as \\n");
    const s = signerFromEnv({ RECEIPT_SIGNING_KEY: value }, "RECEIPT_SIGNING_KEY");
    assert.equal(s.keyId, a.keyId);
    assert.equal(s.publicKeyPem, a.publicKeyPem);
    const sig = sign(null, Buffer.from("x"), createPrivateKey(value.replace(/\\n/g, "\n")));
    assert.ok(verify(null, Buffer.from("x"), createPublicKey(a.publicKeyPem), sig));
    assert.equal(JSON.stringify(a).includes(keyBody(value)), false, "the result never carries the private key");

    const b = ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", false);
    assert.equal(b.outcome, "kept");
    assert.equal(b.keyId, a.keyId);
    assert.equal(readFileSync(f, "utf8"), text1, "a second run changes nothing");

    const c = ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", true);
    assert.equal(c.outcome, "rotated");
    assert.notEqual(c.keyId, a.keyId);
    assert.equal(c.outcome === "rotated" && c.previousKeyId, a.keyId);
    const text3 = readFileSync(f, "utf8");
    assert.equal((text3.match(/^RECEIPT_SIGNING_KEY=/gm) ?? []).length, 1);
    assert.ok(text3.startsWith("OPENROUTER_API_KEY=keep-me\r\n"));
    assert.equal(existsSync(`${f}.tmp-${process.pid}`), false, "no temporary file left");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ARCH-614 ensureReceiptKey: an invalid existing key is refused without rotate (file unchanged, value never in the message); rotate replaces it", () => {
  const dir = fresh();
  try {
    const f = join(dir, "chainaim.env");
    const before = "RECEIPT_SIGNING_KEY=not-a-key-SECRETMARKER\n";
    writeFileSync(f, before);
    assert.throws(() => ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", false), (e: Error) => /RECEIPT_SIGNING_KEY .*not a valid/.test(e.message) && !e.message.includes("SECRETMARKER"));
    assert.equal(readFileSync(f, "utf8"), before);
    const r = ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", true);
    assert.equal(r.outcome, "rotated");
    assert.equal(r.outcome === "rotated" && r.previousKeyId, null);
    assert.equal(readFileSync(f, "utf8").includes("SECRETMARKER"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ARCH-614 the CLI prints the key id and PUBLIC key only; a second run keeps the key; bad usage exits 2, an invalid key 1", () => {
  const dir = fresh();
  try {
    const f = join(dir, "chainaim.env");
    const pub = join(dir, "receipt-public.pem");
    const r1 = run("--secrets-file", f, "--public-out", pub);
    assert.equal(r1.status, 0, r1.stderr);
    const value = readEnvValue(readFileSync(f, "utf8"), "RECEIPT_SIGNING_KEY")!;
    const out = r1.stdout + r1.stderr;
    assert.match(out, /created/);
    assert.match(out, /KEY ID  [0-9a-f]{32}/);
    assert.match(out, /-----BEGIN PUBLIC KEY-----/);
    assert.equal(/PRIVATE KEY/.test(out.replace("private key not shown", "")), false, "no private key block printed");
    assert.equal(out.includes(keyBody(value)), false, "the private key's bytes are never printed");
    assert.match(readFileSync(pub, "utf8"), /^-----BEGIN PUBLIC KEY-----/);
    const r2 = run("--secrets-file", f);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /already present and valid; kept/);
    assert.equal(readEnvValue(readFileSync(f, "utf8"), "RECEIPT_SIGNING_KEY"), value);
    assert.equal(run("--var", "RECEIPT_SIGNING_KEY").status, 2, "no --secrets-file");
    assert.equal(run("--secrets-file", f, "--var", "bad-name").status, 2);
    assert.equal(run("--secrets-file", f, "--nope").status, 2);
    writeFileSync(f, "RECEIPT_SIGNING_KEY=garbage\n");
    const r3 = run("--secrets-file", f);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /-ReceiptKeyRotate/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ARCH-627 ensureReceiptKey ES256: a P-256 key the AP2 signer reads, with its public JWK; kept on a second run; the receipt key beside it untouched", () => {
  const dir = fresh();
  try {
    const f = join(dir, "chainaim.env");
    const receipt = ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", false);
    const text0 = readFileSync(f, "utf8");
    const a = ensureReceiptKey(f, "AP2_SIGNING_KEY", false, "ES256");
    assert.equal(a.outcome, "created");
    const text1 = readFileSync(f, "utf8");
    assert.ok(text1.startsWith(text0), "the receipt key line is kept as it was");
    assert.equal(ensureReceiptKey(f, "RECEIPT_SIGNING_KEY", false).keyId, receipt.keyId);
    const value = readEnvValue(text1, "AP2_SIGNING_KEY")!;
    const s = ap2SignerFromEnv({ AP2_SIGNING_KEY: value }, "AP2_SIGNING_KEY");
    assert.equal(s.kid, a.keyId);
    assert.deepEqual(a.publicJwk, s.publicJwk);
    assert.equal(keyFromJwk(a.publicJwk).kid, a.keyId, "the published JWK passes the verifier's own checks");
    const checkout = { id: "j1", totals: [{ type: "total", amount: 1 }] };
    assert.equal(verifyMerchantAuthorization(signMerchantAuthorization(checkout, s), checkout, [a.publicJwk]).ok, true);
    assert.equal(createPublicKey(a.publicKeyPem).asymmetricKeyDetails?.namedCurve, "prime256v1");
    assert.equal(JSON.stringify(a).includes(keyBody(value)), false, "the result never carries the private key");
    const b = ensureReceiptKey(f, "AP2_SIGNING_KEY", false, "ES256");
    assert.equal(b.outcome, "kept");
    assert.equal(readFileSync(f, "utf8"), text1, "a second run changes nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ARCH-627 ensureReceiptKey: a key of the other kind is refused without rotate (Ed25519 under --alg ES256 and the reverse), naming the right rotate switch", () => {
  const dir = fresh();
  try {
    const f = join(dir, "chainaim.env");
    ensureReceiptKey(f, "K", false);
    const before = readFileSync(f, "utf8");
    assert.throws(() => ensureReceiptKey(f, "K", false, "ES256"), /K in the env file is not a valid EC P-256 \(ES256\) PKCS#8 PEM key; replace it with -Ap2KeyRotate/);
    assert.equal(readFileSync(f, "utf8"), before);
    ensureReceiptKey(f, "E", false, "ES256");
    assert.throws(() => ensureReceiptKey(f, "E", false), /not a valid Ed25519 PKCS#8 PEM key; replace it with -ReceiptKeyRotate/);
    assert.throws(() => ensureReceiptKey(f, "E", false, "EdDSA" as never), /must be one of ed25519, ES256/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ARCH-627 the CLI with --alg ES256: default variable AP2_SIGNING_KEY, a JWK Set public file, no private key printed; a bad --alg exits 2", () => {
  const dir = fresh();
  try {
    const f = join(dir, "chainaim.env");
    const pub = join(dir, "ap2-public-key.jwk.json");
    const r1 = run("--secrets-file", f, "--alg", "ES256", "--public-out", pub);
    assert.equal(r1.status, 0, r1.stderr);
    const value = readEnvValue(readFileSync(f, "utf8"), "AP2_SIGNING_KEY")!;
    assert.ok(value, "AP2_SIGNING_KEY is the default variable with ES256");
    assert.equal(readEnvValue(readFileSync(f, "utf8"), "RECEIPT_SIGNING_KEY"), undefined);
    const out = r1.stdout + r1.stderr;
    assert.match(out, /OK      AP2 signing key \(ES256\) AP2_SIGNING_KEY created/);
    const kid = /KEY ID  ([0-9a-f]{32})/.exec(out)![1];
    assert.equal(/PRIVATE KEY/.test(out.replace("private key not shown", "")), false);
    assert.equal(out.includes(keyBody(value)), false);
    assert.equal(/"d"/.test(out), false, "no private JWK member printed");
    const set = JSON.parse(readFileSync(pub, "utf8")) as { keys: unknown[] };
    assert.equal(set.keys.length, 1);
    assert.equal(keyFromJwk(set.keys[0]).kid, kid);
    assert.deepEqual(Object.keys(set.keys[0] as object).sort(), ["alg", "crv", "kid", "kty", "use", "x", "y"]);
    const r2 = run("--secrets-file", f, "--alg", "ES256");
    assert.match(r2.stdout, /kept \(use -Ap2KeyRotate to replace it\)/);
    assert.equal(run("--secrets-file", f, "--alg", "EdDSA").status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

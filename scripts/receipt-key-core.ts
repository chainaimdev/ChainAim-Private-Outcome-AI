/**
 * The console's signing keys in an env file: the receipt key (privateAI-design-32 ARCH-614, Ed25519, desk.ps1 -ReceiptKey)
 * and the AP2 merchant authorization key (privateAI-design-33 ARCH-627, ES256 = EC P-256, desk.ps1 -Ap2Key). Pure text
 * functions plus one file operation, used by scripts/receipt-key.ts. The private key never leaves this module except into
 * the env file: results carry only the key id and the public key.
 *
 * Format in the env file: one line NAME=<PKCS#8 PEM, Ed25519, newlines written as \n>. packages/receipt signerFromEnv
 * reads exactly that (it turns \n back into newlines); test-console/up.ps1 reads the line by name and passes the value
 * to the console container by name (docker-compose.yml console-api environment).
 */
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { signerFromEnv } from "../packages/receipt/src/index.ts";
import { signerFromEnv as ap2SignerFromEnv, type PublicJwk } from "../packages/ap2/src/index.ts";

/** The key kinds: ed25519 (receipts, packages/receipt) and ES256 (AP2 merchant_authorization, packages/ap2). */
export const KEY_ALGS = ["ed25519", "ES256"] as const;
export type KeyAlg = (typeof KEY_ALGS)[number];

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The value of the last `NAME=value` line for `name` (quotes trimmed as up.ps1's Read-EnvFile does); undefined when absent or empty. */
export function readEnvValue(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    found = v === "" ? undefined : v;
  }
  return found;
}

/**
 * The text with `name` set to `value`: every existing `name=` line is removed and one line is put where the first one
 * was (or appended). Every other line, comment and the file's line ending (CRLF or LF) are kept as they were.
 */
export function upsertEnvLine(text: string, name: string, value: string): string {
  if (!ENV_NAME.test(name)) throw new Error(`the variable name must look like RECEIPT_SIGNING_KEY, got ${name}`);
  if (/[\r\n]/.test(value)) throw new Error("the value must be one line");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const endsWithEol = lines.length > 0 && lines[lines.length - 1] === "";
  if (endsWithEol) lines.pop();
  const isName = (l: string) => new RegExp(`^\\s*${name}\\s*=`).test(l);
  const first = lines.findIndex(isName);
  const kept = lines.filter((l) => !isName(l));
  const line = `${name}=${value}`;
  if (first === -1) kept.push(line);
  else kept.splice(first, 0, line); // the lines before the first match hold no other match, so its index is unchanged
  return kept.join(eol) + eol;
}

/** publicJwk only for ES256: the key as published in /.well-known/ucp keys[] and pinned by the agent. */
export type KeyInfo = { keyId: string; publicKeyPem: string; publicJwk?: PublicJwk };

/**
 * The id and public key of a one-line env value, read with the same package that signs with it (so ids always agree).
 * Throws when the value is not a key of that kind.
 */
export function keyInfoOf(value: string, alg: KeyAlg): KeyInfo {
  if (alg === "ed25519") {
    const s = signerFromEnv({ K: value }, "K");
    return { keyId: s.keyId, publicKeyPem: s.publicKeyPem };
  }
  const s = ap2SignerFromEnv({ K: value }, "K");
  const publicKeyPem = createPublicKey({ key: { ...s.publicJwk }, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
  return { keyId: s.kid, publicKeyPem, publicJwk: s.publicJwk };
}

/** A new key of `alg` as the one-line env value (PKCS#8 PEM, newlines written as \n), with its id and public key. */
export function newKeyValue(alg: KeyAlg = "ed25519"): { value: string } & KeyInfo {
  const { privateKey } = alg === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const value = pem.replace(/\r?\n/g, "\\n");
  return { value, ...keyInfoOf(value, alg) };
}

/** What the public key file holds: the PEM for ed25519, a JWK Set {keys: [jwk]} for ES256 (RFC 7517, as in a UCP profile). */
export function publicFileText(info: KeyInfo, alg: KeyAlg): string {
  if (alg === "ed25519") return info.publicKeyPem;
  if (!info.publicJwk) throw new Error("an ES256 key must carry its public JWK");
  return `${JSON.stringify({ keys: [info.publicJwk] }, null, 2)}\n`;
}

export type KeyResult =
  | ({ outcome: "created" | "kept" } & KeyInfo)
  | ({ outcome: "rotated"; previousKeyId: string | null } & KeyInfo);

/**
 * Makes sure `envFile` holds a valid key in `name`:
 *   absent           -> a new key is written (created; the file is created when missing)
 *   present + valid  -> nothing is written unless rotate (kept), so running it twice is safe
 *   present, rotate  -> replaced (rotated); receipts signed with the old key then verify only with the old public key
 *   present, invalid -> refused unless rotate, naming the variable only
 * Written through a temporary file and a rename, then read back and checked; the private key is never returned.
 */
export function ensureReceiptKey(envFile: string, name: string, rotate: boolean, alg: KeyAlg = "ed25519"): KeyResult {
  if (!(KEY_ALGS as readonly string[]).includes(alg)) throw new Error(`the key algorithm must be one of ${KEY_ALGS.join(", ")}, got ${alg}`);
  const kind = alg === "ed25519" ? "Ed25519" : "EC P-256 (ES256)";
  const rotateSwitch = alg === "ed25519" ? "-ReceiptKeyRotate" : "-Ap2KeyRotate";
  if (!ENV_NAME.test(name)) throw new Error(`the variable name must look like RECEIPT_SIGNING_KEY, got ${name}`);
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const current = readEnvValue(text, name);
  let previousKeyId: string | null = null;
  if (current !== undefined) {
    let ok: KeyInfo | undefined;
    try { ok = keyInfoOf(current, alg); } catch { ok = undefined; } // not a key of this kind: reported just below
    if (ok && !rotate) return { outcome: "kept", ...ok };
    if (!ok && !rotate) throw new Error(`${name} in the env file is not a valid ${kind} PKCS#8 PEM key; replace it with ${rotateSwitch} (nothing was changed)`);
    previousKeyId = ok?.keyId ?? null;
  }
  const k = newKeyValue(alg);
  const tmp = `${envFile}.tmp-${process.pid}`;
  writeFileSync(tmp, upsertEnvLine(text, name, k.value), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, envFile);
  const back = readEnvValue(readFileSync(envFile, "utf8"), name);
  if (back === undefined || keyInfoOf(back, alg).keyId !== k.keyId) throw new Error(`${name} could not be read back from the env file after writing`);
  const info: KeyInfo = { keyId: k.keyId, publicKeyPem: k.publicKeyPem, ...(k.publicJwk ? { publicJwk: k.publicJwk } : {}) };
  return current === undefined ? { outcome: "created", ...info } : { outcome: "rotated", previousKeyId, ...info };
}

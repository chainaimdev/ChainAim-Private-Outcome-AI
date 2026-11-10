/**
 * The console's receipt signing key in an env file (privateAI-design-32 ARCH-614). Pure text functions plus one file
 * operation, used by scripts/receipt-key.ts (desk.ps1 -ReceiptKey). The private key never leaves this module except into
 * the env file: results carry only the key id and the public key.
 *
 * Format in the env file: one line NAME=<PKCS#8 PEM, Ed25519, newlines written as \n>. packages/receipt signerFromEnv
 * reads exactly that (it turns \n back into newlines); test-console/up.ps1 reads the line by name and passes the value
 * to the console container by name (docker-compose.yml console-api environment).
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { signerFromEnv } from "../packages/receipt/src/index.ts";

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

export type KeyInfo = { keyId: string; publicKeyPem: string };

/** A new Ed25519 key as the one-line env value, with its id and public key (from packages/receipt, so ids always agree). */
export function newKeyValue(): { value: string } & KeyInfo {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const value = pem.replace(/\r?\n/g, "\\n");
  const s = signerFromEnv({ K: value }, "K");
  return { value, keyId: s.keyId, publicKeyPem: s.publicKeyPem };
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
export function ensureReceiptKey(envFile: string, name: string, rotate: boolean): KeyResult {
  if (!ENV_NAME.test(name)) throw new Error(`the variable name must look like RECEIPT_SIGNING_KEY, got ${name}`);
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const current = readEnvValue(text, name);
  let previousKeyId: string | null = null;
  if (current !== undefined) {
    let ok: KeyInfo | undefined;
    try { const s = signerFromEnv({ [name]: current }, name); ok = { keyId: s.keyId, publicKeyPem: s.publicKeyPem }; } catch { ok = undefined; }
    if (ok && !rotate) return { outcome: "kept", ...ok };
    if (!ok && !rotate) throw new Error(`${name} in the env file is not a valid Ed25519 PKCS#8 PEM key; replace it with -ReceiptKeyRotate (nothing was changed)`);
    previousKeyId = ok?.keyId ?? null;
  }
  const k = newKeyValue();
  const tmp = `${envFile}.tmp-${process.pid}`;
  writeFileSync(tmp, upsertEnvLine(text, name, k.value), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, envFile);
  const back = readEnvValue(readFileSync(envFile, "utf8"), name);
  if (back === undefined || signerFromEnv({ [name]: back }, name).keyId !== k.keyId) throw new Error(`${name} could not be read back from the env file after writing`);
  const info = { keyId: k.keyId, publicKeyPem: k.publicKeyPem };
  return current === undefined ? { outcome: "created", ...info } : { outcome: "rotated", previousKeyId, ...info };
}

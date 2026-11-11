/**
 * Creates (or keeps, or rotates) one of the console's signing keys in an env file: the receipt key (privateAI-design-32
 * ARCH-614, Ed25519; desk.ps1 -ReceiptKey) or the AP2 merchant authorization key (privateAI-design-33 ARCH-627, ES256;
 * desk.ps1 -Ap2Key). desk.ps1 passes <secretsDir>\chainaim.env; desk.ps1 itself never reads a secret.
 *
 *   node scripts/receipt-key.ts --secrets-file PATH [--alg ed25519|ES256] [--var NAME] [--rotate] [--public-out PATH]
 *
 *   --secrets-file PATH  the env file to hold the key (created when missing; every other line is kept as it was).
 *                      Not called --env-file: Node takes --env-file anywhere on its command line as its own option
 *                      (owner run 2026-11-10: "node.exe: ...chainaim.env: not found", exit 9).
 *   --alg ALG          ed25519 (default; the receipt key) or ES256 (EC P-256; the AP2 key, design-33 D1)
 *   --var NAME         the variable name (default RECEIPT_SIGNING_KEY with ed25519, AP2_SIGNING_KEY with ES256; up.ps1's
 *                      -ReceiptKeyName / -Ap2KeyName must match)
 *   --rotate           replace an existing key (receipts signed before then verify only with the old public key)
 *   --public-out PATH  also write the public key to this file, for verifiers; it is not secret. ed25519: SPKI PEM
 *                      (config/receipt-public-key.pem). ES256: a JWK Set {"keys":[jwk]} (config/ap2-public-key.jwk.json).
 *
 * Prints the outcome, the key id and the public key. Never prints, logs or returns the private key.
 * Exit 0 = a valid key is in the file; 1 = refused (an invalid existing key without --rotate, a write that did not read
 * back); 2 = usage.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ENV_NAME, ensureReceiptKey, KEY_ALGS, publicFileText, type KeyAlg } from "./receipt-key-core.ts";

const usage = (m: string): never => { process.stderr.write(`receipt-key: ${m}\n`); process.exit(2); };
let o: { "secrets-file"?: string; alg?: string; var?: string; rotate?: boolean; "public-out"?: string };
try {
  o = parseArgs({
    strict: true,
    options: {
      "secrets-file": { type: "string" },
      alg: { type: "string", default: "ed25519" },
      var: { type: "string" },
      rotate: { type: "boolean", default: false },
      "public-out": { type: "string" },
    },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (!o!["secrets-file"]) usage("--secrets-file PATH is required (desk.ps1 passes <secretsDir>\\chainaim.env)");
if (!(KEY_ALGS as readonly string[]).includes(o!.alg!)) usage(`--alg must be one of ${KEY_ALGS.join(", ")}, got ${o!.alg}`);
const alg = o!.alg as KeyAlg;
const what = alg === "ed25519" ? "receipt signing key" : "AP2 signing key (ES256)";
const rotateSwitch = alg === "ed25519" ? "-ReceiptKeyRotate" : "-Ap2KeyRotate";
const name = o!.var ?? (alg === "ed25519" ? "RECEIPT_SIGNING_KEY" : "AP2_SIGNING_KEY");
if (!ENV_NAME.test(name)) usage(`--var must be an environment variable name such as RECEIPT_SIGNING_KEY, got ${name}`);

try {
  const r = ensureReceiptKey(o!["secrets-file"]!, name, o!.rotate!, alg);
  const outcome = r.outcome === "created" ? "created" : r.outcome === "kept" ? `already present and valid; kept (use ${rotateSwitch} to replace it)` : `rotated (previous key id ${r.previousKeyId ?? "unreadable"})`;
  process.stdout.write(`OK      ${what} ${name} ${outcome} in ${o!["secrets-file"]} (private key not shown)\n`);
  process.stdout.write(`KEY ID  ${r.keyId}\n`);
  process.stdout.write(`PUBLIC  verifiers use this key; it is not secret:\n${publicFileText(r, alg).trim()}\n`);
  if (o!["public-out"]) {
    writeFileSync(o!["public-out"], publicFileText(r, alg), "utf8");
    process.stdout.write(`OK      public key written to ${o!["public-out"]}\n`);
  }
  if (r.outcome === "rotated") process.stdout.write(`NOTE    ${alg === "ed25519" ? "receipts" : "quotes"} signed before this rotation verify only with the previous public key; restart the stack (desk.ps1) so the console signs with the new one\n`);
  process.exit(0);
} catch (e) {
  process.stderr.write(`receipt-key: ${(e as Error).message}\n`);
  process.exit(1);
}

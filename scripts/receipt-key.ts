/**
 * Creates (or keeps, or rotates) the console's receipt signing key in an env file (privateAI-design-32 ARCH-614).
 * Run by test-console\desk.ps1 -ReceiptKey, which passes <secretsDir>\chainaim.env; desk.ps1 itself never reads a secret.
 *
 *   node scripts/receipt-key.ts --secrets-file PATH [--var RECEIPT_SIGNING_KEY] [--rotate] [--public-out PATH]
 *
 *   --secrets-file PATH  the env file to hold the key (created when missing; every other line is kept as it was).
 *                      Not called --env-file: Node takes --env-file anywhere on its command line as its own option
 *                      (owner run 2026-11-10: "node.exe: ...chainaim.env: not found", exit 9).
 *   --var NAME         the variable name (default RECEIPT_SIGNING_KEY; up.ps1 -ReceiptKeyName must match)
 *   --rotate           replace an existing key (receipts signed before then verify only with the old public key)
 *   --public-out PATH  also write the public key (PEM) to this file, for verifiers; it is not secret
 *
 * Prints the outcome, the key id and the public key. Never prints, logs or returns the private key.
 * Exit 0 = a valid key is in the file; 1 = refused (an invalid existing key without --rotate, a write that did not read
 * back); 2 = usage.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ENV_NAME, ensureReceiptKey } from "./receipt-key-core.ts";

const usage = (m: string): never => { process.stderr.write(`receipt-key: ${m}\n`); process.exit(2); };
let o: { "secrets-file"?: string; var?: string; rotate?: boolean; "public-out"?: string };
try {
  o = parseArgs({
    strict: true,
    options: {
      "secrets-file": { type: "string" },
      var: { type: "string", default: "RECEIPT_SIGNING_KEY" },
      rotate: { type: "boolean", default: false },
      "public-out": { type: "string" },
    },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (!o!["secrets-file"]) usage("--secrets-file PATH is required (desk.ps1 passes <secretsDir>\\chainaim.env)");
const name = o!.var!;
if (!ENV_NAME.test(name)) usage(`--var must be an environment variable name such as RECEIPT_SIGNING_KEY, got ${name}`);

try {
  const r = ensureReceiptKey(o!["secrets-file"]!, name, o!.rotate!);
  const what = r.outcome === "created" ? "created" : r.outcome === "kept" ? "already present and valid; kept (use -ReceiptKeyRotate to replace it)" : `rotated (previous key id ${r.previousKeyId ?? "unreadable"})`;
  process.stdout.write(`OK      receipt signing key ${name} ${what} in ${o!["secrets-file"]} (private key not shown)\n`);
  process.stdout.write(`KEY ID  ${r.keyId}\n`);
  process.stdout.write(`PUBLIC  verifiers use this key; it is not secret:\n${r.publicKeyPem.trim()}\n`);
  if (o!["public-out"]) {
    writeFileSync(o!["public-out"], r.publicKeyPem, "utf8");
    process.stdout.write(`OK      public key written to ${o!["public-out"]}\n`);
  }
  if (r.outcome === "rotated") process.stdout.write("NOTE    receipts signed before this rotation verify only with the previous public key; restart the stack (desk.ps1) so the console signs with the new one\n");
  process.exit(0);
} catch (e) {
  process.stderr.write(`receipt-key: ${(e as Error).message}\n`);
  process.exit(1);
}

/**
 * desk.ps1 -SignerKeys (privateAI-design-36 ARCH-664, MANUAL_SETUP 2026-11-13 "Signer split", step 1b): puts ChainAim's
 * two signing keys in the seller's own folder and makes the request key the data plane uses to call ca-control-signer.
 *
 *   seller file  (default C:\CHAINAIM-SELLER-SECRETS\signer.env)   AP2_SIGNING_KEY, RECEIPT_SIGNING_KEY, SIGNER_REQUEST_KEY
 *   client file  (default C:\PRIV-AI-SECRETS\signer-client.env)    SIGNER_REQUEST_KEY only
 *
 * The two signing keys are COPIED from the buyer-side file (chainaim.env) when the seller file does not hold them yet, so
 * their key ids stay the same (83816e6f..., d27d1e9f...: the pinned config\ap2-public-key.jwk.json and
 * config\receipt-public-key.pem and every receipt already issued keep verifying). The buyer-side file is only READ here:
 * removing the two lines from it is the owner's step (MANUAL_SETUP), so this script never edits it. Running it again
 * changes nothing (kept), unless --rotate-request-key. Results carry key ids and file paths only, never a value.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keyInfoOf, readEnvValue, upsertEnvLine } from "./receipt-key-core.ts";
import { mandateKeyVariable } from "../packages/ap2/src/index.ts";

export { mandateKeyVariable };

export const SELLER_KEYS = [
  { name: "AP2_SIGNING_KEY", alg: "ES256" as const },
  { name: "RECEIPT_SIGNING_KEY", alg: "ed25519" as const },
];
export const REQUEST_KEY = "SIGNER_REQUEST_KEY";

export type SignerKeysResult = {
  keys: { name: string; keyId: string; outcome: "copied" | "kept" }[];
  requestKey: "created" | "kept" | "rotated";
  /** Names still present in the buyer-side file (the owner removes those lines by hand). */
  leftInBuyerFile: string[];
};

const readText = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function ensureSignerKeys(o: { buyerFile: string; sellerFile: string; clientFile: string; rotateRequestKey?: boolean }): SignerKeysResult {
  if (o.sellerFile === o.buyerFile || o.clientFile === o.sellerFile) throw new Error("the seller file must be another file than the buyer-side file and the client file");
  const buyer = readText(o.buyerFile);
  let seller = readText(o.sellerFile);
  const keys: SignerKeysResult["keys"] = [];
  for (const k of SELLER_KEYS) {
    const have = readEnvValue(seller, k.name);
    if (have !== undefined) {
      let id: string;
      try { id = keyInfoOf(have, k.alg).keyId; } catch { throw new Error(`${k.name} in ${o.sellerFile} is not a valid ${k.alg} key (nothing was changed)`); }
      keys.push({ name: k.name, keyId: id, outcome: "kept" });
      continue;
    }
    const from = readEnvValue(buyer, k.name);
    if (from === undefined) throw new Error(`${k.name} is in neither ${o.sellerFile} nor ${o.buyerFile}: make it first (desk.ps1 ${k.alg === "ES256" ? "-Ap2Key" : "-ReceiptKey"}), then run this again (nothing was changed)`);
    let id: string;
    try { id = keyInfoOf(from, k.alg).keyId; } catch { throw new Error(`${k.name} in ${o.buyerFile} is not a valid ${k.alg} key (nothing was changed)`); }
    seller = upsertEnvLine(seller, k.name, from);
    keys.push({ name: k.name, keyId: id, outcome: "copied" });
  }
  const existing = readEnvValue(seller, REQUEST_KEY);
  let requestKey: SignerKeysResult["requestKey"] = "kept";
  let req = existing;
  if (existing === undefined || existing.length < 32 || o.rotateRequestKey) {
    req = randomBytes(32).toString("hex");
    requestKey = existing === undefined ? "created" : "rotated";
    seller = upsertEnvLine(seller, REQUEST_KEY, req);
  }
  writeAtomic(o.sellerFile, seller);
  const client = readText(o.clientFile);
  if (readEnvValue(client, REQUEST_KEY) !== req) writeAtomic(o.clientFile, upsertEnvLine(client, REQUEST_KEY, req!));
  // Read back: both files hold the same request key and the seller file both signing keys with the ids reported.
  const sBack = readFileSync(o.sellerFile, "utf8"), cBack = readFileSync(o.clientFile, "utf8");
  if (readEnvValue(sBack, REQUEST_KEY) !== req || readEnvValue(cBack, REQUEST_KEY) !== req) throw new Error("the request key could not be read back from both files");
  for (const k of keys) if (keyInfoOf(readEnvValue(sBack, k.name)!, SELLER_KEYS.find((x) => x.name === k.name)!.alg).keyId !== k.keyId) throw new Error(`${k.name} could not be read back from ${o.sellerFile}`);
  const leftInBuyerFile = SELLER_KEYS.map((k) => k.name).filter((n) => readEnvValue(buyer, n) !== undefined);
  return { keys, requestKey, leftInBuyerFile };
}

// ---- desk.ps1 -MandateKey: a tenant's checkout mandate key (ARCH-666) -------------------------------------------------

export type MandateKeyResult = { tenant: string; variable: string; kid: string; outcome: "created" | "kept" | "rotated" };

/**
 * Makes sure the agent's env file holds tenant <id>'s mandate key and the PUBLIC key registry (committed,
 * config/ap2-mandate-keys.json) lists its public key for that tenant and NEAR account. Kept when both agree; a new private
 * key with rotate. The registry only ever gains keys: the tenant's earlier public keys stay listed after the new one, so
 * mandates signed before still verify. The private key goes only into the agent's env file.
 */
export function ensureMandateKey(o: { agentEnvFile: string; registryFile: string; tenant: string; accountId: string; rotate?: boolean }): MandateKeyResult {
  const variable = mandateKeyVariable(o.tenant);
  if (!/^[a-z0-9._-]{2,64}$/.test(o.accountId)) throw new Error(`${o.accountId} is not a NEAR account id`);
  let env = readText(o.agentEnvFile);
  const current = readEnvValue(env, variable);
  let kid: string | undefined, jwk: unknown;
  let outcome: MandateKeyResult["outcome"] = "kept";
  if (current !== undefined && !o.rotate) {
    try { const k = keyInfoOf(current, "ES256"); kid = k.keyId; jwk = k.publicJwk; } catch { throw new Error(`${variable} in the agent's env file is not a valid EC P-256 key; replace it with -MandateKeyRotate (nothing was changed)`); }
  } else {
    const k = newMandateKey();
    env = upsertEnvLine(env, variable, k.value);
    writeAtomic(o.agentEnvFile, env);
    if (keyInfoOf(readEnvValue(readFileSync(o.agentEnvFile, "utf8"), variable)!, "ES256").keyId !== k.kid) throw new Error(`${variable} could not be read back from the agent's env file`);
    kid = k.kid; jwk = k.jwk; outcome = current === undefined ? "created" : "rotated";
  }
  const reg = existsSync(o.registryFile) ? (JSON.parse(readFileSync(o.registryFile, "utf8").replace(/^﻿/, "")) as { tenants?: { tenant: string; accountId: string; keys: unknown[] }[] }) : { tenants: [] };
  // The new (or kept) public key is ADDED in front of the tenant's list; the keys already there stay, so mandates signed
  // with them (and the judge sample) still verify. Taking a public key out is a hand edit of the registry.
  const before = (reg.tenants ?? []).find((t) => t.tenant === o.tenant);
  const kidOf = (k: unknown) => (typeof k === "object" && k !== null ? (k as { kid?: unknown }).kid : undefined);
  const kept = (Array.isArray(before?.keys) ? before!.keys : []).filter((k) => kidOf(k) !== kid);
  const tenants = (reg.tenants ?? []).filter((t) => t.tenant !== o.tenant);
  tenants.push({ tenant: o.tenant, accountId: o.accountId, keys: [jwk, ...kept] });
  tenants.sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
  writeAtomic(o.registryFile, `${JSON.stringify({ note: "Tenants' PUBLIC AP2 checkout mandate keys (privateAI-design-36 ARCH-666). Written by desk.ps1 -MandateKey; the private keys are only in the agent's env file. ca-control-signer and verify-receipt check mandates with these.", tenants }, null, 2)}\n`);
  return { tenant: o.tenant, variable, kid: kid!, outcome };
}

function newMandateKey(): { value: string; kid: string; jwk: unknown } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const value = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\r?\n/g, "\\n");
  const info = keyInfoOf(value, "ES256");
  return { value, kid: info.keyId, jwk: info.publicJwk };
}

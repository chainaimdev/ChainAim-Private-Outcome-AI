/**
 * desk.ps1 -SignerKeys / -MandateKey (privateAI-design-36 ARCH-664 / ARCH-666): scripts/signer-keys-core.ts on temporary
 * files with real keys. The buyer-side file is never written; key ids survive the move; values never reach the output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newKeyValue, readEnvValue } from "../receipt-key-core.ts";
import { ensureMandateKey, ensureSignerKeys, mandateKeyVariable } from "../signer-keys-core.ts";
import { parseMandateRegistry } from "../../packages/ap2/src/index.ts";

const CLI = fileURLToPath(new URL("../signer-keys.ts", import.meta.url));

function folders() {
  const d = mkdtempSync(join(tmpdir(), "signer-keys-"));
  const buyer = join(d, "PRIV-AI-SECRETS", "chainaim.env");
  mkdirSync(join(d, "PRIV-AI-SECRETS"));
  const ap2 = newKeyValue("ES256"), rcpt = newKeyValue("ed25519");
  writeFileSync(buyer, `OPENROUTER_API_KEY=or-key\r\nAP2_SIGNING_KEY=${ap2.value}\r\nRECEIPT_SIGNING_KEY=${rcpt.value}\r\n`);
  return { d, buyer, seller: join(d, "CHAINAIM-SELLER-SECRETS", "signer.env"), client: join(d, "PRIV-AI-SECRETS", "signer-client.env"), ap2, rcpt };
}

test("ARCH-664 -SignerKeys: copies both signing keys with their ids, makes one request key for both sides, never writes the buyer file", () => {
  const f = folders();
  const before = readFileSync(f.buyer, "utf8");
  const r = ensureSignerKeys({ buyerFile: f.buyer, sellerFile: f.seller, clientFile: f.client });
  assert.deepEqual(r.keys, [{ name: "AP2_SIGNING_KEY", keyId: f.ap2.keyId, outcome: "copied" }, { name: "RECEIPT_SIGNING_KEY", keyId: f.rcpt.keyId, outcome: "copied" }]);
  assert.equal(r.requestKey, "created");
  assert.deepEqual(r.leftInBuyerFile, ["AP2_SIGNING_KEY", "RECEIPT_SIGNING_KEY"]);
  assert.equal(readFileSync(f.buyer, "utf8"), before, "the buyer-side file is only read");
  const seller = readFileSync(f.seller, "utf8"), client = readFileSync(f.client, "utf8");
  assert.equal(readEnvValue(seller, "SIGNER_REQUEST_KEY"), readEnvValue(client, "SIGNER_REQUEST_KEY"));
  assert.match(readEnvValue(client, "SIGNER_REQUEST_KEY")!, /^[0-9a-f]{64}$/);
  assert.equal(client.includes("SIGNING_KEY"), false, "the client file holds the request key only");
  assert.equal(seller.includes("OPENROUTER_API_KEY"), false, "no buyer secret is copied");
  const again = ensureSignerKeys({ buyerFile: f.buyer, sellerFile: f.seller, clientFile: f.client });
  assert.deepEqual(again.keys.map((k) => k.outcome), ["kept", "kept"]);
  assert.equal(again.requestKey, "kept");
  assert.equal(readFileSync(f.seller, "utf8"), seller, "running it twice changes nothing");
  // Once the owner removed the two lines, the seller file is the only place; nothing is left to report.
  writeFileSync(f.buyer, "OPENROUTER_API_KEY=or-key\r\n");
  assert.deepEqual(ensureSignerKeys({ buyerFile: f.buyer, sellerFile: f.seller, clientFile: f.client }).leftInBuyerFile, []);
});

test("ARCH-664 -SignerKeys CLI: prints key ids and paths only; refuses when a key exists nowhere", () => {
  const f = folders();
  const r = spawnSync(process.execPath, [CLI, "signer", "--buyer-file", f.buyer, "--seller-file", f.seller, "--client-file", f.client], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`AP2_SIGNING_KEY key id ${f.ap2.keyId}: copied`));
  assert.match(r.stdout, /NEXT +AP2_SIGNING_KEY and RECEIPT_SIGNING_KEY are still in/);
  const req = readEnvValue(readFileSync(f.client, "utf8"), "SIGNER_REQUEST_KEY")!;
  for (const v of [f.ap2.value, f.rcpt.value, req, "BEGIN PRIVATE KEY"]) assert.equal((r.stdout + r.stderr).includes(v), false);
  const empty = mkdtempSync(join(tmpdir(), "signer-keys-empty-"));
  const none = spawnSync(process.execPath, [CLI, "signer", "--buyer-file", join(empty, "a.env"), "--seller-file", join(empty, "b.env"), "--client-file", join(empty, "c.env")], { encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /AP2_SIGNING_KEY is in neither/);
});

test("ARCH-666 -MandateKey: the private key goes to the agent's env file only; the registry lists the public key per tenant", () => {
  const d = mkdtempSync(join(tmpdir(), "mandate-key-"));
  const env = join(d, "agent-tenants.env"), reg = join(d, "ap2-mandate-keys.json");
  writeFileSync(env, "NEAR_T02_KEY=ed25519:abc\n");
  const a = ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t02", accountId: "chainaim-t02-seller.testnet" });
  assert.equal(a.outcome, "created");
  assert.equal(a.variable, mandateKeyVariable("t02"));
  assert.equal(a.variable, "AP2_MANDATE_KEY_T02");
  const text = readFileSync(reg, "utf8");
  assert.equal(/"d"\s*:/.test(text) || text.includes("PRIVATE"), false, "public keys only");
  const registry = parseMandateRegistry(JSON.parse(text));
  assert.deepEqual(registry.map((t) => [t.tenant, t.accountId]), [["t02", "chainaim-t02-seller.testnet"]]);
  assert.match(readFileSync(env, "utf8"), /^NEAR_T02_KEY=ed25519:abc$/m, "other lines kept");
  assert.equal(ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t02", accountId: "chainaim-t02-seller.testnet" }).kid, a.kid, "kept");
  const b = ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t01", accountId: "chainaim-t01-seller.testnet" });
  assert.deepEqual(parseMandateRegistry(JSON.parse(readFileSync(reg, "utf8"))).map((t) => t.tenant), ["t01", "t02"]);
  const rot = ensureMandateKey({ agentEnvFile: env, registryFile: reg, tenant: "t02", accountId: "chainaim-t02-seller.testnet", rotate: true });
  assert.equal(rot.outcome, "rotated");
  assert.notEqual(rot.kid, a.kid);
  assert.notEqual(b.kid, a.kid);
});

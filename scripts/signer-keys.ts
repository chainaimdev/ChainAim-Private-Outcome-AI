/**
 * desk.ps1 -SignerKeys and -MandateKey (privateAI-design-36 ARCH-664 / ARCH-666). See scripts/signer-keys-core.ts.
 *
 *   node scripts/signer-keys.ts signer  --buyer-file F --seller-file F --client-file F [--rotate-request-key]
 *   node scripts/signer-keys.ts mandate --agent-env-file F --tenant ID --tenants-dir rig/tenants --registry FILE [--rotate]
 *
 * Prints key ids, outcomes and file paths only; never a key value. Exit 0 = done, 1 = refused (reason printed), 2 = usage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureMandateKey, ensureSignerKeys } from "./signer-keys-core.ts";

const say = (tag: string, text: string) => process.stdout.write(`${tag.padEnd(6)} ${text}\n`);
const usage = (m: string): never => { process.stderr.write(`signer-keys: ${m}\n`); process.exit(2); };
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "signer") {
    const o = parseArgs({ args: rest, strict: true, options: { "buyer-file": { type: "string" }, "seller-file": { type: "string" }, "client-file": { type: "string" }, "rotate-request-key": { type: "boolean", default: false } } }).values;
    if (!o["buyer-file"] || !o["seller-file"] || !o["client-file"]) usage("--buyer-file, --seller-file and --client-file are required");
    const r = ensureSignerKeys({ buyerFile: o["buyer-file"]!, sellerFile: o["seller-file"]!, clientFile: o["client-file"]!, rotateRequestKey: o["rotate-request-key"] });
    for (const k of r.keys) say("OK", `${k.name} key id ${k.keyId}: ${k.outcome === "copied" ? `copied into ${o["seller-file"]}` : `already in ${o["seller-file"]}`}`);
    say("OK", `SIGNER_REQUEST_KEY ${r.requestKey} (the same value in ${o["seller-file"]} and ${o["client-file"]}; not printed)`);
    if (r.leftInBuyerFile.length) say("NEXT", `${r.leftInBuyerFile.join(" and ")} are still in ${o["buyer-file"]}: remove those lines by hand (MANUAL_SETUP.md 2026-11-13 Signer split and checkout mandates, step 2) so the buyer side holds none of ChainAim's keys`);
    else say("OK", `${o["buyer-file"]} holds none of ChainAim's signing keys`);
  } else if (cmd === "mandate") {
    const o = parseArgs({ args: rest, strict: true, options: { "agent-env-file": { type: "string" }, tenant: { type: "string" }, "tenants-dir": { type: "string", default: "rig/tenants" }, registry: { type: "string" }, rotate: { type: "boolean", default: false } } }).values;
    if (!o["agent-env-file"] || !o.tenant || !o.registry) usage("--agent-env-file, --tenant and --registry are required");
    let accountId: unknown;
    try { accountId = (JSON.parse(readFileSync(join(o["tenants-dir"]!, o.tenant!, "tenant.json"), "utf8").replace(/^﻿/, "")) as { near?: { accountId?: unknown } }).near?.accountId; }
    catch { usage(`${join(o["tenants-dir"]!, o.tenant!, "tenant.json")} cannot be read`); }
    if (typeof accountId !== "string") usage(`tenant ${o.tenant} has no near.accountId in its tenant.json`);
    const r = ensureMandateKey({ agentEnvFile: o["agent-env-file"]!, registryFile: o.registry!, tenant: o.tenant!, accountId: accountId as string, rotate: o.rotate });
    say("OK", `${r.variable} (tenant ${r.tenant}, ${accountId}) key id ${r.kid}: ${r.outcome}${r.outcome === "kept" ? "" : ` in ${o["agent-env-file"]} (not printed)`}`);
    say("OK", `public key for ${r.tenant} written to ${o.registry} (commit it with the next ship)`);
  } else usage("the first argument must be signer or mandate");
} catch (e) {
  say("STOP", (e as Error).message);
  process.exit(1);
}

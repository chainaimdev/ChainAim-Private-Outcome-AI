/**
 * privateAI-design-35 ARCH-650/652: what anyone reading NEAR learns about one paid job, from its receipt file, with no key
 * and no ChainAim service: the settlement transaction is read from public NEAR RPC (packages/observer, the
 * same code as tab 03's "What the chain shows"). For judges and auditors.
 *
 *   node scripts/observe-receipt.ts --file PATH [--rpc-testnet URL] [--rpc-fallback-testnet URL|none]
 *                                   [--rpc-mainnet URL] [--rpc-fallback-mainnet URL|none] [--timeout-ms N] [--decimals N]
 *
 *   --file      the receipt: {receipt, publicKeyPem[, ap2]} (tab 03 "Download receipt", desk.ps1 -AgentAsk / -VerifyJob)
 *               or a bare signed receipt {body, sig, settlement?, settlementSig?}
 *   --rpc-*     the RPC URLs, asked in order (defaults: rpc.<net>.fastnear.com, then archival-rpc.<net>.near.org)
 *   --timeout-ms one RPC call (default 15000); --decimals the token's decimals (default 6, NEAR USDC)
 *
 * This does not check the receipt's signature: scripts/verify-receipt.ts does. Sent to the RPC: the transaction hash and
 * the payer account, both already public. Exit 0 = shown; 1 = the chain does not show this payment as the receipt says;
 * 2 = usage, or a file that cannot be read.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { observe, observerConfig, ObserverError } from "../packages/observer/src/index.ts";

const usage = (m: string): never => { process.stderr.write(`observe-receipt: ${m}\n`); process.exit(2); };
let o: Record<string, string | undefined> = {};
try {
  o = parseArgs({ strict: true, options: {
    file: { type: "string" },
    "rpc-testnet": { type: "string", default: "https://rpc.testnet.fastnear.com" },
    "rpc-fallback-testnet": { type: "string", default: "https://archival-rpc.testnet.near.org" },
    "rpc-mainnet": { type: "string", default: "https://rpc.mainnet.fastnear.com" },
    "rpc-fallback-mainnet": { type: "string", default: "https://archival-rpc.mainnet.near.org" },
    "timeout-ms": { type: "string", default: "15000" },
    decimals: { type: "string", default: "6" },
  } }).values;
} catch (e) { usage((e as Error).message); }
if (!o.file) usage("--file PATH is required (a receipt file)");

let doc: unknown;
try { doc = JSON.parse(readFileSync(o.file!, "utf8")); } catch (e) { usage(`cannot read ${o.file}: ${(e as Error).message}`); }
const receipt = (doc as { receipt?: unknown }).receipt ?? doc;
const settlement = (receipt as { settlement?: { network: string; transaction: string; payer: string | null } }).settlement;
const body = (receipt as { body?: { jobId?: string; price?: { amountUnits?: string; priceUsd?: string } } }).body;
if (!settlement) { process.stdout.write("NO      the receipt carries no settlement: the job was not paid on chain (or the settlement was not attached)\n"); process.exit(1); }

let cfg;
try {
  cfg = observerConfig({ observer: "on", "observer-rpc-testnet": o["rpc-testnet"], "observer-rpc-fallback-testnet": o["rpc-fallback-testnet"],
    "observer-rpc-mainnet": o["rpc-mainnet"], "observer-rpc-fallback-mainnet": o["rpc-fallback-mainnet"],
    "observer-timeout-ms": o["timeout-ms"], "observer-token-decimals": o.decimals })!;
} catch (e) { usage((e as Error).message.replace(/--observer-(rpc-)?/g, "--")); }

const say = (tag: string, text: string) => process.stdout.write(`${tag.padEnd(7)} ${text}\n`);
// The exit code is SET and the process ends on its own: process.exit() while fetch's sockets are still closing trips a
// libuv assertion on Windows (src\win\async.c: !(handle->flags & UV_HANDLE_CLOSING), exit 3221226505).
try {
  const v = await observe(settlement, cfg!);
  say("CHAIN", `${v.network} transaction ${v.transaction}  (read from ${new URL(v.rpcUrl).host}, no key)`);
  say("PUBLIC", `paid by     ${v.payer}`);
  if (v.relayer) say("PUBLIC", `sent by     ${v.relayer} (relayer, pays the gas; NEP-366 meta transaction)`);
  say("PUBLIC", `paid to     ${v.payTo}`);
  say("PUBLIC", `amount      ${v.amount} (base units ${v.amountBase}; token ${v.token})`);
  say("PUBLIC", `when        ${v.blockTime ?? "not given by the RPC node"}${v.blockHeight !== null ? ` (block ${v.blockHeight})` : ""}`);
  if (v.memo) say("PUBLIC", `memo        ${v.memo}`);
  say("PRIVATE", `not on the chain: ${v.notOnChain.join("; ")}`);
  say("LINK", v.explorerUrl);
  // The receipt's price against the transfer: the same job, the same amount.
  const units = body?.price?.amountUnits;
  if (!v.succeeded) { say("NO", "the transfer failed on chain"); process.exitCode = 1; }
  else if (units !== undefined && units !== v.amountBase) { say("NO", `the receipt's price is ${units} base units, the transfer moved ${v.amountBase}`); process.exitCode = 1; }
  else say("OK", `the chain shows this receipt's payment${units !== undefined ? ` (${v.amount}, as the receipt's price${body?.jobId ? ` for job ${body.jobId}` : ""})` : ""}`);
} catch (e) {
  const status = e instanceof ObserverError ? e.status : 502;
  say("NO", (e as Error).message);
  process.exitCode = status === 400 ? 2 : 1;
}

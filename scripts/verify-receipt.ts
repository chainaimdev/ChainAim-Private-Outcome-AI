/**
 * desk.ps1 -VerifyReceipt <file> (privateAI-design-32 step D): checks a Job Evidence Receipt offline, with the console's
 * PINNED public key (config/receipt-public-key.pem), using packages/receipt verifyReceipt: the same code the console signs
 * with and the agent verifies with. No network, no service: anyone with the repository can run it (a lender, an auditor).
 *
 *   node scripts/verify-receipt.ts --file PATH [--public-key config/receipt-public-key.pem] [--result auto|none|PATH]
 *
 *   --file        the receipt: tab 03's "Download receipt" file or desk.ps1 -AgentAsk's, {receipt, publicKeyPem}, or a
 *                 bare signed receipt {body, sig, settlement?, settlementSig?}
 *   --public-key  the pinned key (default config/receipt-public-key.pem). The publicKeyPem inside the file is NOT trusted;
 *                 it is only compared with the pinned key and the outcome printed
 *   --result      the released result to check against the receipt's resultSha256: a JSON file, none, or auto (default:
 *                 chainaim-result-<jobId>.json beside the receipt file when present, as desk.ps1 -AgentAsk saves it)
 *
 * Prints what the receipt commits to (ids, dataset, template, files, hashes, model calls, price, settlement): never a
 * question, a row or a key, because the receipt holds none.
 * Exit 0 = valid; 1 = not valid (the reason is printed); 2 = usage, or a file that cannot be read.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicKey } from "node:crypto";
import { keyIdOf, verifyReceipt, type SignedReceipt } from "../packages/receipt/src/index.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const say = (tag: string, text: string) => process.stdout.write(`${tag.padEnd(7)} ${text}\n`);
const usage = (m: string): never => { process.stderr.write(`verify-receipt: ${m}\n`); process.exit(2); };

let o: { file?: string; "public-key"?: string; result?: string };
try {
  o = parseArgs({ strict: true, options: { file: { type: "string" }, "public-key": { type: "string", default: join(REPO, "config", "receipt-public-key.pem") }, result: { type: "string", default: "auto" } } }).values;
} catch (e) {
  usage((e as Error).message);
}
const file = o!.file ?? usage("--file PATH is required (a receipt from tab 03's Download receipt or desk.ps1 -AgentAsk)");
const readJson = (path: string, what: string): unknown => {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return usage(`${what} ${path} could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"})`); }
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return usage(`${what} ${path} is not JSON`); }
};

let pinnedPem: string;
try { pinnedPem = readFileSync(o!["public-key"]!, "utf8"); } catch (e) { usage(`the pinned public key ${o!["public-key"]} could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"}): .\\test-console\\desk.ps1 -ReceiptKey exports it`); }
let pinnedId: string;
try { pinnedId = keyIdOf(createPublicKey(pinnedPem!)); } catch { usage(`${o!["public-key"]} is not a PEM public key`); }

const raw = readJson(file, "the receipt file") as { receipt?: unknown; publicKeyPem?: unknown; body?: unknown };
const receipt = (raw && typeof raw === "object" && "receipt" in raw ? raw.receipt : raw) as SignedReceipt;
if (!receipt || typeof receipt !== "object" || typeof receipt.body !== "object" || receipt.body === null || typeof receipt.sig !== "object" || receipt.sig === null) usage(`${file} holds no signed receipt ({receipt, publicKeyPem} or {body, sig, ...})`);

// The released result: explicit file, none, or the one desk.ps1 -AgentAsk saved beside the receipt.
let result: unknown, resultFrom = "not checked (no result file)";
if (o!.result === "auto") {
  const sibling = join(dirname(file), basename(file).replace(/^chainaim-receipt-/, "chainaim-result-"));
  if (sibling !== file && existsSync(sibling)) { result = readJson(sibling, "the result file"); resultFrom = sibling; }
} else if (o!.result !== "none") {
  result = readJson(o!.result!, "the result file"); resultFrom = o!.result!;
}

const v = verifyReceipt(receipt, pinnedPem!, result);
const b = receipt.body;
say("KEY", `pinned ${pinnedId!} from ${o!["public-key"]}`);
if (raw && typeof raw === "object" && typeof (raw as { publicKeyPem?: unknown }).publicKeyPem === "string") {
  let fileId = "unreadable";
  try { fileId = keyIdOf(createPublicKey((raw as { publicKeyPem: string }).publicKeyPem)); } catch { /* reported below as unreadable */ }
  say("INFO", `the file also carries a public key (id ${fileId}); it is ${fileId === pinnedId! ? "the pinned key" : "NOT the pinned key and is ignored"}`);
}
if (!v.ok) {
  say("FAIL", `receipt NOT valid: ${v.reason}`);
  process.exit(1);
}
const s = receipt.settlement;
const lines: [string, string][] = [
  ["receipt", `${b.receiptId} (v${b.v}, made ${b.createdAt})`],
  ["job", `${b.jobId} · quote ${b.quoteId}${b.counterOf ? ` · counter of ${b.counterOf}` : ""}`],
  ["dataset", `${b.datasetId}${b.templateLabel ? ` · template "${b.templateLabel}"` : ""}`],
  ["route", b.route],
  ["files", `${b.files.length}: ${b.files.map((f) => `${f.name} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 12)}…)`).join(", ")}`],
  ["filesRoot", b.filesRoot],
  ["query", `sha256 ${b.sqlSha256}`],
  ["result", `sha256 ${b.resultSha256} · ${result === undefined ? resultFrom : `matches ${resultFrom}`}`],
  ["calls", b.calls.length ? b.calls.map((c, i) => `${i + 1} ${c.servedModel} attest ${c.attestStatus}${c.chatId ? ` chat ${c.chatId}` : ""}`).join(" · ") : "none (exact query, no worded answer)"],
  ["price", `${b.price.priceUsd} USD = ${b.price.amountUnits} units (${b.price.usdcDecimals} decimals)${b.price.actualUsd ? ` · metered ${b.price.actualUsd}` : ""}`],
  ["settled", s ? `${s.network} transaction ${s.transaction} · invoice ${s.invoiceId}${s.payer ? ` · payer ${s.payer}` : ""} · ${s.settledAt}` : "no settlement attached (signed before settlement)"],
];
for (const [k, val] of lines) process.stdout.write(`        ${k.padEnd(10)} ${val}\n`);
if (s && /^near:(testnet|mainnet)$/.test(s.network)) process.stdout.write(`        ${"explorer".padEnd(10)} https://${s.network === "near:mainnet" ? "" : "testnet."}nearblocks.io/txns/${s.transaction}\n`);
say("OK", `receipt valid: signed by the pinned key ${pinnedId!}${v.settled ? ", settlement signed too" : ""}${result === undefined ? "" : ", result matches"}`);
process.exit(0);

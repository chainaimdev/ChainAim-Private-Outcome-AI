/**
 * desk.ps1 -VerifyReceipt <file> (privateAI-design-32 step D): checks a Job Evidence Receipt offline, with the console's
 * PINNED public key (config/receipt-public-key.pem), using packages/receipt verifyReceipt: the same code the console signs
 * with and the agent verifies with. No network, no service: anyone with the repository can run it (a lender, an auditor).
 *
 *   node scripts/verify-receipt.ts --file PATH [--public-key config/receipt-public-key.pem] [--result auto|none|PATH]
 *                                  [--ap2-public-key config/ap2-public-key.jwk.json]
 *
 *   --file        the receipt: tab 03's "Download receipt" file or desk.ps1 -AgentAsk's, {receipt, publicKeyPem}, or a
 *                 bare signed receipt {body, sig, settlement?, settlementSig?}
 *   --public-key  the pinned key (default config/receipt-public-key.pem). The publicKeyPem inside the file is NOT trusted;
 *                 it is only compared with the pinned key and the outcome printed
 *   --result      the released result to check against the receipt's resultSha256: a JSON file, none, or auto (default:
 *                 chainaim-result-<jobId>.json beside the receipt file when present, as desk.ps1 -AgentAsk saves it)
 *   --ap2-public-key  privateAI-design-33 ARCH-631: the pinned AP2 key (JWK Set). When the receipt carries merchantAuthSha256
 *                 and the file carries the signed quote (ap2 {checkout, merchant_authorization}, as the console serves it with
 *                 --ap2 on), the quote is verified with this key and bound to the receipt: hash, job id and amount
 *   --mandate-keys  privateAI-design-36 ARCH-668: the tenants' PUBLIC checkout mandate keys (default
 *                 config/ap2-mandate-keys.json). When the receipt records a mandate and the file carries it (mandate, as
 *                 the console serves it), the buyer's mandate is verified too: the tenant's signature, the checkout it
 *                 permits being exactly the signed quote, its nonce being the settled invoice and its tenant the payer
 *   --mandate-audience  the business id the mandate must be addressed to (default chainaim)
 *
 * privateAI-design-38 ARCH-684: when the signed quote carries limits (v2.1.0 on), the receipt's quoteBasis must equal them
 * (files, totalBytes, prompt caps, maxTokens, retries, answer rows, phrase, userSql), its calls may not exceed modelCalls and
 * its route may name only the signed models: OK says ", signed limits match", a breach prints FAIL limits: <field> (exit 1).
 * A quote without limits (before v2.1.0) still verifies and OK says so.
 *   --refund      privateAI-design-40 ARCH-694: a refund record FILE (design-37) instead of a receipt: checks its signature
 *                 with the pinned receipt key and prints paid -> refunded. --file is then not needed
 *
 * privateAI-design-40: a receipt with price.economics prints its money trail (paid, NEAR AI cost at catalog prices, gas,
 * margin, overrun absorbed; checkBody re-computes the identities); one without says "no money trail (before v2.1.0)".
 * A receipt with evidenceBundleSha256 and a file carrying `attestation` (the console's download) re-hashes the bundle.
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
import { canonicalJson, keyIdOf, sha256Hex, verifyReceipt, verifyRefund, type SignedReceipt } from "../packages/receipt/src/index.ts";
import { attachedJws, merchantAuthSha256, parseMandateRegistry, verifyCheckoutMandate, verifyMerchantAuthorization } from "../packages/ap2/src/index.ts";
import { parseLimits, type CheckoutLimits } from "../packages/offer/src/index.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const say = (tag: string, text: string) => process.stdout.write(`${tag.padEnd(7)} ${text}\n`);
const usage = (m: string): never => { process.stderr.write(`verify-receipt: ${m}\n`); process.exit(2); };

let o: { file?: string; "public-key"?: string; result?: string; "ap2-public-key"?: string; "mandate-keys"?: string; "mandate-audience"?: string; refund?: string };
try {
  o = parseArgs({ strict: true, options: { file: { type: "string" }, "public-key": { type: "string", default: join(REPO, "config", "receipt-public-key.pem") }, result: { type: "string", default: "auto" }, "ap2-public-key": { type: "string", default: join(REPO, "config", "ap2-public-key.jwk.json") }, "mandate-keys": { type: "string", default: join(REPO, "config", "ap2-mandate-keys.json") }, "mandate-audience": { type: "string", default: "chainaim" }, refund: { type: "string" } } }).values;
} catch (e) {
  usage((e as Error).message);
}
const file = o!.file ?? (o!.refund !== undefined ? "" : usage("--file PATH is required (a receipt from tab 03's Download receipt or desk.ps1 -AgentAsk)"));
const readJson = (path: string, what: string): unknown => {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return usage(`${what} ${path} could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"})`); }
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return usage(`${what} ${path} is not JSON`); }
};

let pinnedPem: string;
try { pinnedPem = readFileSync(o!["public-key"]!, "utf8"); } catch (e) { usage(`the pinned public key ${o!["public-key"]} could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"}): .\\test-console\\desk.ps1 -ReceiptKey exports it`); }
let pinnedId: string;
try { pinnedId = keyIdOf(createPublicKey(pinnedPem!)); } catch { usage(`${o!["public-key"]} is not a PEM public key`); }

// privateAI-design-40 ARCH-694: a refunded job has no receipt (design-37 I3); its signed refund record is checked instead.
if (o!.refund !== undefined) {
  const rec = readJson(o!.refund, "the refund file");
  say("KEY", `pinned ${pinnedId!} from ${o!["public-key"]}`);
  const rv = verifyRefund(rec, pinnedPem!);
  if (!rv.ok) {
    say("FAIL", `refund NOT valid: ${rv.reason}`);
    process.exit(1);
  }
  const f = rv.record;
  say("OK", `refund valid: invoice ${f.invoiceId} (job ${f.jobId}) paid ${f.paidTx} -> ${f.status === "refunded" ? `refunded ${f.refundTx}` : `${f.status}${f.refundTx ? ` ${f.refundTx}` : ""}`} to ${f.payer}, ${f.amountUnits} units on ${f.network}, reason ${f.reason}, at ${f.at}`);
  process.exit(0);
}

const raw = readJson(file, "the receipt file") as { receipt?: unknown; publicKeyPem?: unknown; body?: unknown; ap2?: unknown; mandate?: unknown; attestation?: unknown };
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
// ARCH-631: the signed quote the receipt points at, checked with the pinned AP2 key when the file carries it.
let quoteLine: string | undefined;
let quoteOk = false;
let limitsNote = "";
if (b.merchantAuthSha256 !== undefined) {
  const q = raw && typeof raw === "object" ? (raw.ap2 as { checkout?: unknown; merchant_authorization?: unknown } | undefined) : undefined;
  if (!q || typeof q !== "object") {
    quoteLine = `sha256 ${b.merchantAuthSha256} · signed quote not in this file, not checked`;
  } else {
    const jwks = readJson(o!["ap2-public-key"]!, "the pinned AP2 public key") as { keys?: unknown };
    const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
    const ck = q.checkout as Record<string, unknown>;
    const fail = (why: string): never => { say("FAIL", `signed quote NOT valid: ${why}`); process.exit(1); };
    if (typeof q.merchant_authorization !== "string" || typeof ck !== "object" || ck === null) fail("the file's ap2 has no checkout or merchant_authorization");
    const v2 = verifyMerchantAuthorization(q.merchant_authorization, ck, keys);
    if (!v2.ok) fail(`${v2.code}: ${v2.reason}`);
    if (merchantAuthSha256(q.merchant_authorization as string) !== b.merchantAuthSha256) fail("the receipt's merchantAuthSha256 is not the hash of this signed quote");
    if (ck.id !== b.jobId) fail("the signed quote is for another job");
    const ext = ck["dev.chainaim.job"] as { amountUnits?: unknown } | undefined;
    if (ext?.amountUnits !== b.price.amountUnits) fail("the signed quote's amount is not the receipt's amount");
    quoteOk = true;
    quoteLine = `sha256 ${b.merchantAuthSha256} · signed by the pinned AP2 key ${(v2 as { kid: string }).kid} · job and amount match the receipt`;
    // privateAI-design-38 ARCH-684: the run the receipt records against the limits the quote signed (when it has some).
    const signedLimits = (ext as { limits?: unknown } | undefined)?.limits;
    if (signedLimits === undefined) {
      // Only an estimate-first quote is priced before the run and carries limits; a run-hold quote never has any.
      if ((ext as { mode?: unknown } | undefined)?.mode === "estimate-first") limitsNote = ", quote has no signed limits (before v2.1.0)";
    } else {
      const failL = (field: string, why: string): never => { say("FAIL", `limits: ${field}: ${why}`); process.exit(1); };
      let L: CheckoutLimits;
      try { L = parseLimits(signedLimits); } catch (e) { failL("shape", (e as Error).message); }
      const qb = b.price.quoteBasis as Record<string, unknown>;
      for (const f of ["files", "totalBytes", "maxPromptChars", "maxTokens", "sqlRetries", "answerMaxRows", "phrase", "userSql"] as const) {
        if (qb[f] !== L![f]) failL(f, `the receipt says ${String(qb[f])}, the signed quote ${String(L![f])}`);
      }
      for (const f of ["answerMaxPromptChars", "sizeTolerancePct"] as const) if (qb[f] !== undefined && qb[f] !== L![f]) failL(f, `the receipt says ${String(qb[f])}, the signed quote ${String(L![f])}`);
      const calls = typeof qb.calls === "number" ? qb.calls : b.calls.length;
      if (calls > L!.modelCalls || b.calls.length > L!.modelCalls) failL("modelCalls", `the receipt records ${Math.max(calls, b.calls.length)} model calls, the signed quote allows ${L!.modelCalls}`);
      const signedModels = new Set([L!.model, L!.answerModel]);
      for (const m of b.route.split("+")) if (m !== "analyst-only" && !signedModels.has(m)) failL("model", `the route names ${m}, not a model the quote signed for`);
      limitsNote = ", signed limits match";
      quoteLine += ` · limits: ${L!.modelCalls} call(s), max ${L!.maxTokens} tokens, ${[...signedModels].join(" / ")}`;
    }
  }
}
// ARCH-668: the buyer agent's checkout mandate the receipt records, re-checked with the pinned tenant keys.
let mandateLine: string | undefined;
let mandateOk = false;
const s = receipt.settlement;
if (b.mandate !== undefined) {
  const m = b.mandate;
  const token = raw && typeof raw === "object" ? raw.mandate : undefined;
  if (typeof token !== "string") {
    mandateLine = `sha256 ${m.sha256} · tenant ${m.tenant} (${m.accountId}) · the mandate itself is not in this file, not checked`;
  } else {
    const fail = (why: string): never => { say("FAIL", `checkout mandate NOT valid: ${why}`); process.exit(1); };
    let registry;
    try { registry = parseMandateRegistry(readJson(o!["mandate-keys"]!, "the pinned mandate keys")); } catch (e) { usage(`${o!["mandate-keys"]}: ${(e as Error).message}`); }
    const v = verifyCheckoutMandate(token, { registry: registry!, aud: o!["mandate-audience"]!, nonce: m.nonce });
    if (!v.ok) fail(`${v.code}: ${v.reason}`);
    const ok = v as Extract<typeof v, { ok: true }>;
    if (ok.sha256 !== m.sha256 || ok.kid !== m.kid || ok.tenant !== m.tenant || ok.accountId !== m.accountId) fail("the receipt's mandate record is not this mandate");
    const q = raw.ap2 as { checkout?: Record<string, unknown>; merchant_authorization?: unknown } | undefined;
    if (!q || typeof q.merchant_authorization !== "string" || typeof q.checkout !== "object") fail("the mandate cannot be bound: the file carries no signed quote");
    if (ok.checkoutJwt !== attachedJws(q!.merchant_authorization as string, q!.checkout as Record<string, unknown>)) fail("the mandate permits another checkout than this receipt's signed quote");
    if (s && s.invoiceId !== m.nonce) fail("the settled invoice is not the one the mandate permitted");
    if (s && s.payer !== null && s.payer !== m.accountId) fail("the payment came from another account than the mandate's tenant");
    mandateOk = true;
    mandateLine = `sha256 ${m.sha256} · signed by tenant ${m.tenant} (${m.accountId}) key ${m.kid} · permits exactly the signed quote · nonce = invoice ${m.nonce}${s ? " (the settled one)" : ""}`;
  }
}
// privateAI-design-40 ARCH-692/693: the attestation bundle the receipt commits to, re-hashed when the file carries it.
let bundleLine: string | undefined;
if (b.evidenceBundleSha256 !== undefined) {
  const bundle = raw && typeof raw === "object" ? raw.attestation : undefined;
  if (bundle === undefined) {
    bundleLine = `sha256 ${b.evidenceBundleSha256} · bundle not in this file, not checked`;
  } else {
    let hash: string;
    try { hash = sha256Hex(canonicalJson(bundle)); } catch (e) { say("FAIL", `attestation bundle NOT valid: ${(e as Error).message}`); process.exit(1); }
    if (hash! !== b.evidenceBundleSha256) { say("FAIL", "attestation bundle does NOT match evidenceBundleSha256"); process.exit(1); }
    const calls = Array.isArray((bundle as { calls?: unknown }).calls) ? ((bundle as { calls: { status?: unknown }[] }).calls) : [];
    const attested = calls.filter((c) => c.status !== "not_applicable");
    bundleLine = `matches evidenceBundleSha256 (${attested.filter((c) => c.status === "verified").length}/${attested.length} NEAR AI calls verified)`;
  }
}
// ARCH-693: the money trail; verifyReceipt (checkBody) already re-computed cost, margin and overrun from these members.
const e = b.price.economics;
const paidHow = s ? ` (${[...(s.flow ? [s.flow] : []), `tx ${s.transaction.slice(0, 4)}…`].join(", ")})` : "";
const trail = e
  ? `paid ${b.price.priceUsd} USDC${paidHow} · NEAR AI cost ${e.nearAiCostUsd} · gas ${e.nearGasUsd} · cost ${e.costUsd} · margin ${e.marginUsd} · overrun absorbed ${e.overrunAbsorbedUsd} (costs at ChainAim's catalog prices)`
  : undefined;
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
  ...(quoteLine ? [["quote", quoteLine] as [string, string]] : []),
  ...(mandateLine ? [["mandate", mandateLine] as [string, string]] : []),
  ["price", `${b.price.priceUsd} USD = ${b.price.amountUnits} units (${b.price.usdcDecimals} decimals)${b.price.actualUsd ? ` · metered ${b.price.actualUsd}` : ""}`],
  ...(e ? [["economics", `NEAR AI ${e.nearAiCostUsd} + gas ${e.nearGasUsd} = cost ${e.costUsd} · call fees ${e.callFeesUsd} · analyst ${e.analystUsd} · margin ${e.marginUsd} · overrun absorbed ${e.overrunAbsorbedUsd} · basis ${e.costBasis}`] as [string, string]] : []),
  ...(bundleLine ? [["evidence", bundleLine] as [string, string]] : []),
  ["settled", s ? `${s.network} transaction ${s.transaction} · invoice ${s.invoiceId}${s.payer ? ` · payer ${s.payer}` : ""}${s.flow ? ` · flow ${s.flow}` : ""} · ${s.settledAt}` : "no settlement attached (signed before settlement)"],
];
for (const [k, val] of lines) process.stdout.write(`        ${k.padEnd(10)} ${val}\n`);
if (s && /^near:(testnet|mainnet)$/.test(s.network)) process.stdout.write(`        ${"explorer".padEnd(10)} https://${s.network === "near:mainnet" ? "" : "testnet."}nearblocks.io/txns/${s.transaction}\n`);
say("OK", `receipt valid: signed by the pinned key ${pinnedId!}${v.settled ? ", settlement signed too" : ""}${result === undefined ? "" : ", result matches"}${quoteOk ? ", signed quote matches" : ""}${mandateOk ? ", checkout mandate matches" : ""}${quoteOk ? limitsNote : ""}`);
say("OK", trail ? `money trail: ${trail}` : "no money trail (before v2.1.0)");
if (bundleLine && raw && typeof raw === "object" && raw.attestation !== undefined) say("OK", `attestation bundle ${bundleLine}`);
process.exit(0);

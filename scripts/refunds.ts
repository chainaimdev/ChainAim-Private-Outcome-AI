/**
 * desk.ps1 -Refunds [-RefundRetry INVOICE] (privateAI-design-37 §6/§7): the refund ledger of ca-control-signer, and the
 * owner's retry of a refund that failed (e.g. the payTo wallet was out of NEAR for gas).
 *
 *   node scripts/refunds.ts --signer-url URL --client-file F [--retry INVOICE]
 *
 * The request key is read here from the client file (SIGNER_REQUEST_KEY, desk.ps1 -SignerKeys made it), so desk.ps1 never
 * holds it. Prints ids, accounts, amounts and status only. Exit 0 = done, 1 = refused / unreachable (reason printed), 2 = usage.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const say = (tag: string, text: string) => process.stdout.write(`${tag.padEnd(6)} ${text}\n`);
const usage = (m: string): never => { process.stderr.write(`refunds: ${m}\n`); process.exit(2); };

/** SIGNER_REQUEST_KEY from a KEY=value file (quotes and a BOM allowed); the value is never printed. */
export function requestKeyOf(text: string): string | undefined {
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*SIGNER_REQUEST_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

type Row = { invoiceId: string; jobId: string; status: string; payer: string; amountUnits: string; paidTx: string; refundTx: string; reason: string; failedReason?: string; at: string };

/** One line per refund, fixed columns; USDC shown with 6 decimals. */
export function formatRows(rows: Row[]): string[] {
  if (rows.length === 0) return ["(no refunds in the ledger)"];
  const usdc = (u: string) => { const n = u.padStart(7, "0"); return `${n.slice(0, -6)}.${n.slice(-6)}`; };
  return rows.map((r) => `${r.at.slice(0, 19)}Z  ${r.status.padEnd(13)} ${usdc(r.amountUnits).padStart(10)} USDC  to ${r.payer}  invoice ${r.invoiceId}  job ${r.jobId}  paid ${r.paidTx}  refund ${r.status === "refund_failed" ? "-" : r.refundTx}  (${r.reason}${r.failedReason ? `: ${r.failedReason}` : ""})`);
}

async function main(): Promise<void> {
  const o = parseArgs({ strict: true, options: { "signer-url": { type: "string" }, "client-file": { type: "string" }, retry: { type: "string" } } }).values;
  if (!o["signer-url"] || !o["client-file"]) usage("--signer-url and --client-file are required");
  if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(o["signer-url"]!)) usage("--signer-url must be http(s)://host[:port]");
  if (o.retry !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(o.retry)) usage("--retry must be an invoice id");
  let text: string;
  try { text = readFileSync(o["client-file"]!, "utf8"); } catch { say("STOP", `${o["client-file"]} cannot be read (desk.ps1 -SignerKeys makes it)`); process.exit(1); }
  const key = requestKeyOf(text!);
  if (!key) { say("STOP", `${o["client-file"]} has no SIGNER_REQUEST_KEY (desk.ps1 -SignerKeys)`); process.exit(1); }
  const base = o["signer-url"]!.replace(/\/+$/, "");
  const headers = { "x-signer-key": key!, "content-type": "application/json" };
  let r: Response;
  try {
    r = o.retry !== undefined
      ? await fetch(`${base}/v1/refunds/retry`, { method: "POST", headers, body: JSON.stringify({ invoiceId: o.retry }), signal: AbortSignal.timeout(60_000) })
      : await fetch(`${base}/v1/refunds`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    say("STOP", `ca-control-signer at ${base} did not answer (${(e as Error).name}); is it running? desk.ps1 -Check`);
    process.exit(1);
  }
  const body = (await r!.json().catch(() => null)) as { refunds?: Row[]; error?: { message?: string } | string; status?: string; refundTx?: string | null; reason?: string } | null;
  if (r!.status === 404 && o.retry === undefined) { say("STOP", "this signer has no refund routes: it runs without --refunds on (start with desk.ps1 -All -PaidFlow upfront)"); process.exit(1); }
  if (!r!.ok) {
    const msg = typeof body?.error === "string" ? body.error : body?.error?.message ?? `HTTP ${r!.status}`;
    say("STOP", `the signer refused: ${msg}`);
    process.exit(1);
  }
  if (o.retry !== undefined) {
    say(body?.status === "refunded" ? "OK" : "WAIT", `invoice ${o.retry}: ${body?.status}${body?.refundTx ? ` in ${body.refundTx}` : ""} (${body?.reason ?? ""})`);
    return;
  }
  const rows = body?.refunds ?? [];
  say("OK", `${rows.length} refund(s) in the ledger of ${base}:`);
  for (const line of formatRows(rows)) process.stdout.write(`  ${line}\n`);
  const failed = rows.filter((x) => x.status === "refund_failed");
  if (failed.length) say("NEXT", `${failed.length} failed: fix the cause (e.g. NEAR for gas in the payTo wallet), then .\\test-console\\desk.ps1 -Refunds -RefundRetry ${failed[0].invoiceId}`);
}

const isMain = process.argv[1] !== undefined && /refunds\.ts$/.test(process.argv[1]);
if (isMain) void main();

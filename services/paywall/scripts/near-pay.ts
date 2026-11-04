/**
 * Pay for one call to a paywall route in USDC on NEAR (x402 exact scheme,
 * @x402/near; the paywall must have PAY_RAILS=near or xrpl,near). The buyer
 * is NEAR_BUYER_ACCOUNT_TESTNET with the full-access key in
 * NEAR_BUYER_KEY_TESTNET (or _MAINNET when NEAR_NETWORK is mainnet), or the
 * account and key prefix given by --account and --key-prefix. It needs USDC on
 * that network and no NEAR: the paywall's relayer pays the gas. --dry-run shows
 * the price and pays nothing.
 *
 * The body comes from exactly one of --text, --body-file or the positional
 * argument, as in scripts/pay.ts.
 *
 *   node scripts/near-pay.ts --dry-run https://PAYWALL/v1/privacy/scan
 *   node scripts/near-pay.ts https://PAYWALL/v1/privacy/mask --text "Patient Jane Roe, MRN 991122."
 *   node scripts/near-pay.ts https://PAYWALL/v1/chat/completions --body-file ask.json --max-amount 0.05
 *   node scripts/near-pay.ts --account t01.chainaim.testnet --key-prefix NEAR_KEY_T01 https://PAYWALL/v1/privacy/scan --text "hello"
 *
 * Exit code: 0 when the call was served and paid, 1 when the paywall answered
 * otherwise, 2 for a set-up problem found before anything was paid.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    text: { type: "string" },
    "body-file": { type: "string" },
    /** The paying account; NEAR_BUYER_ACCOUNT_<NETWORK> by default. */
    account: { type: "string" },
    /** The key is read from PREFIX_TESTNET or PREFIX_MAINNET. */
    "key-prefix": { type: "string", default: "NEAR_BUYER_KEY" },
    /** Refuse, before signing, a price above this many USDC. */
    "max-amount": { type: "string" },
  },
});

const USAGE = "usage: node scripts/near-pay.ts [--dry-run] [--account ID] [--key-prefix NAME] [--max-amount USDC] URL [--text TEXT | --body-file FILE | JSON_BODY]";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

const [url, positionalBody] = positionals;
if (!url) fail(USAGE);
const sources = [values.text !== undefined, values["body-file"] !== undefined, positionalBody !== undefined].filter(Boolean).length;
if (sources > 1) fail("give the body once: --text, --body-file or the positional argument, not more than one");
const body =
  values.text !== undefined ? JSON.stringify({ text: values.text }) : values["body-file"] !== undefined ? readBodyFile(values["body-file"]) : (positionalBody ?? "{}");
try {
  JSON.parse(body);
} catch (e) {
  fail(`${values["body-file"] ?? "the request body"} is not valid JSON: ${(e as Error).message}`);
}
const init = { method: "POST", headers: { "content-type": "application/json" }, body };

const { nearBuyer, payAndFetchNear, SetupError, tokenDecimals, nearRpcUrl } = await import("./near.ts");
const { createNearRpc } = await import("../src/near/rpc.ts");
const { unitsToUsdc } = await import("../../web/src/near-payment.ts");

// process.exitCode, not process.exit(), after a network call: exiting right after one crashes Node on Windows.
if (values["dry-run"]) {
  const r = await fetch(url, init);
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) {
    console.log(`HTTP ${r.status}, no payment asked: ${(await r.text()).slice(0, 300)}`);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: Record<string, any>[]; resource?: { url?: string } };
    const rpc = createNearRpc({ urls: [nearRpcUrl(process.env)], timeoutMs: 10_000 });
    for (const a of required.accepts) {
      if (typeof a.network === "string" && a.network.startsWith("near:")) {
        const decimals = await tokenDecimals(rpc, a.asset).catch(() => undefined);
        const shown = decimals === undefined ? `${a.amount} base units` : `${unitsToUsdc(a.amount, decimals)} USDC (${a.amount} base units)`;
        console.log(`price ${shown} of ${a.asset} on ${a.network} to ${a.payTo}; invoice=${a.extra?.invoiceId ?? "none"}`);
      } else {
        console.log(`also offered: ${a.amount} ${a.asset} on ${a.network} (not paid by this script)`);
      }
    }
    console.log(`resource ${required.resource?.url}`);
    process.exitCode = 0;
  }
} else {
  try {
    const buyer = nearBuyer(process.env, { ...(values.account ? { accountId: values.account } : {}), keyPrefix: values["key-prefix"] });
    console.log(`buyer ${buyer.signer.accountId} on ${buyer.network}`);
    const { response: r, receipt, refusal, amount } = await payAndFetchNear(url, init, buyer, values["max-amount"] ? { maxAmount: values["max-amount"] } : {});
    console.log(`HTTP ${r.status}`);
    if (refusal) console.log(`payment refused by the paywall: ${refusal}`);
    console.log((await r.text()).slice(0, 1000));
    if (r.ok) console.log(`paid ${amount} USDC: ${JSON.stringify(receipt)}`);
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    console.error(e.message);
    process.exitCode = 2;
  }
}

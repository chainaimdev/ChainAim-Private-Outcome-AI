/**
 * privateAI-design-37 ARCH-673..675: ChainAim's signer refunds an upfront payment. Real keys, the real RefundBook on a temp
 * folder, the real near-refund transaction code. The chain is a loopback NEAR JSON-RPC server that answers the paid
 * transaction with the RECORDED testnet answer of the 05:47Z live job (packages/near-refund/test/fixtures), checks the
 * ed25519 signature of every refund transaction it is sent, and records it as executed (or not, per test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedJws, buildCheckoutMandate, publicJwkOf, signerFromKey as ap2SignerFromKey } from "../../ap2/src/index.ts";
import { filesRoot, signerFromKey as receiptSignerFromKey, verifyRefund, type ReceiptBody } from "../../receipt/src/index.ts";
import { base58Encode, nearKeyOf } from "../../near-refund/src/index.ts";
import { parseReceiptRequest, SellerSigner } from "../src/index.ts";
import { LEDGER_FILE, RefundBook } from "../src/refund-book.ts";
import { parseRefundRequest, RefundDesk, RefundInputError, RefundRefused } from "../src/refund.ts";

const recorded = JSON.parse(readFileSync(new URL("../../near-refund/test/fixtures/paid-tx-4vv6QJSa.json", import.meta.url), "utf8")).result;
const PAID_TX = "4vv6QJSaL1V9dDeqWeVGhX5vaeQ3EhXheJSnYSmGWAAc";
const PAID_BLOCK = "8Hu8ankSuY2eo1NnkqXCNdYXzeAJgF9oWnzCuEGcTj7M";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const PAY_TO = "chainaim-payto-seller.testnet";
const BUYER = "chainaim-buyer-seller.testnet";
const RELAYER = "chainaim-relayer-seller.testnet";
const PAID_AT = Date.parse("2026-11-13T05:47:30Z");
const JOB = "8314afbf65b672d657a9a43bc45c8c2d";
const INVOICE = "C702E26D9A1B4C5D8E7F60718293A4B5";

function newNearSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return `ed25519:${base58Encode(Buffer.concat([privateKey.export({ type: "pkcs8", format: "der" }).subarray(16), publicKey.export({ type: "spki", format: "der" }).subarray(12)]))}`;
}

/** Reads the refund transaction the way nearcore does: borsh fields, then the ed25519 signature over sha256(tx). */
function readTx(b64: string) {
  const b = Buffer.from(b64, "base64");
  let o = 0;
  const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u32(); const s = b.subarray(o, o + n).toString("utf8"); o += n; return s; };
  const signerId = str();
  assert.equal(b[o++], 0);
  const pub = b.subarray(o, o + 32); o += 32;
  const nonce = b.readBigUInt64LE(o); o += 8;
  const contract = str();
  o += 32;
  assert.equal(u32(), 1);
  assert.equal(b[o++], 2);
  const method = str();
  const args = JSON.parse(str());
  o += 8;
  const deposit = b.readBigUInt64LE(o); o += 16;
  const txBytes = b.subarray(0, o);
  assert.equal(b[o++], 0);
  const hash = createHash("sha256").update(txBytes).digest();
  const ok = verify(null, hash, { key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" }, b.subarray(o, o + 64));
  return { signerId, pub: `ed25519:${base58Encode(pub)}`, nonce, contract, method, args, deposit, hash: base58Encode(hash), ok };
}

type Chain = { url: string; server: Server; sent: ReturnType<typeof readTx>[]; executed: Set<string>; mode: "ok" | "slow" | "drop" | "invalid"; akNonce: bigint; paidAt: number; balance: bigint };

async function chain(signerPub: string): Promise<Chain> {
  const c = { sent: [], executed: new Set<string>(), mode: "ok", akNonce: 1000n, paidAt: PAID_AT, balance: 5n * 10n ** 24n } as unknown as Chain;
  const status = (hash: string) => ({ final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { signer_id: PAY_TO, hash }, transaction_outcome: { block_hash: PAID_BLOCK }, receipts: [], receipts_outcome: [] });
  c.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw);
      const ok = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      const err = (name: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name }, data: name } }));
      if (method === "EXPERIMENTAL_tx_status") {
        if (params.tx_hash === PAID_TX && params.sender_account_id === RELAYER) return ok(recorded);
        if (c.executed.has(params.tx_hash) && params.sender_account_id === PAY_TO) return ok(status(params.tx_hash));
        return err("UNKNOWN_TRANSACTION");
      }
      if (method === "block") return ok({ header: { hash: params.block_id, timestamp_nanosec: String(BigInt(c.paidAt) * 1_000_000n) } });
      if (method === "query" && params.request_type === "view_access_key") {
        if (params.account_id !== PAY_TO || params.public_key !== signerPub) return err("UNKNOWN_ACCESS_KEY");
        return ok({ nonce: Number(c.akNonce), block_hash: PAID_BLOCK, permission: "FullAccess" });
      }
      if (method === "query" && params.request_type === "view_account") return ok({ amount: c.balance.toString() });
      if (method === "send_tx") {
        const tx = readTx(params.signed_tx_base64);
        c.sent.push(tx);
        if (!tx.ok) return err("INVALID_TRANSACTION");
        if (c.mode === "invalid") return err("INVALID_TRANSACTION");
        if (tx.nonce <= c.akNonce) return c.executed.has(tx.hash) ? ok(status(tx.hash)) : err("INVALID_TRANSACTION");
        if (c.mode !== "drop") { c.akNonce = tx.nonce; c.executed.add(tx.hash); }
        if (c.mode === "slow" || c.mode === "drop") return void setTimeout(() => ok(status(tx.hash)), 400);
        return ok(status(tx.hash));
      }
      err("METHOD_NOT_FOUND");
    });
  });
  await new Promise<void>((r) => c.server.listen(0, "127.0.0.1", () => r()));
  c.url = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  return c;
}

async function setup(over: { usdc?: string; account?: string; now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chainaim-refunds-"));
  const receipt = receiptSignerFromKey(generateKeyPairSync("ed25519").privateKey);
  const key = nearKeyOf(newNearSecret());
  const c = await chain(key.publicKeyText);
  const book = new RefundBook(dir, receipt);
  const settings = { receipt, network: "near:testnet" as const, account: over.account ?? PAY_TO, key, usdcContract: over.usdc ?? USDC, rpcUrl: c.url, paidTxSender: RELAYER, gas: 30_000_000_000_000n, confirmTimeoutMs: 200, maxAgeSec: 86_400, rpcTimeoutMs: 2000, minYocto: 5n * 10n ** 23n, now: () => over.now ?? PAID_AT + 60_000 };
  const desk = new RefundDesk({ ...settings, book });
  const done = async () => { await new Promise<void>((r) => { c.server.closeAllConnections(); c.server.close(() => r()); }); rmSync(dir, { recursive: true, force: true }); };
  return { dir, receipt, key, c, book, desk, settings, done };
}

const REQ = { invoiceId: INVOICE, jobId: JOB, paidTx: PAID_TX, network: "near:testnet", amountUnits: "20000", reason: "over_estimate" };

test("ARCH-673 refund: the chain's payer gets the paid amount back in one signed ft_transfer; the record is signed with the receipt key", async () => {
  const t = await setup();
  try {
    const r = await t.desk.refund(REQ);
    assert.equal(t.c.sent.length, 1);
    const tx = t.c.sent[0];
    assert.equal(tx.ok, true, "signed with the payTo account's key");
    assert.deepEqual([tx.signerId, tx.pub, tx.nonce, tx.contract, tx.method, tx.deposit], [PAY_TO, t.key.publicKeyText, 1001n, USDC, "ft_transfer", 1n]);
    assert.deepEqual(tx.args, { receiver_id: BUYER, amount: "20000", memo: `chainaim refund ${INVOICE}` });
    assert.deepEqual([r.status, r.refundTx, r.payer, r.paidTx, r.amountUnits, r.reason, r.jobId], ["refunded", tx.hash, BUYER, PAID_TX, "20000", "over_estimate", JOB]);
    assert.equal(verifyRefund(JSON.parse(JSON.stringify(r)), t.receipt.publicKeyPem).ok, true);
    // idempotent: the same request answers the same refund, nothing is sent again
    const again = await t.desk.refund(REQ);
    assert.deepEqual([again.status, again.refundTx], ["refunded", tx.hash]);
    assert.equal(t.c.sent.length, 1);
    assert.equal(t.desk.get(INVOICE)!.refundTx, tx.hash);
    assert.equal(t.desk.get("OTHER"), undefined);
    const kinds = readFileSync(join(t.dir, LEDGER_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
    assert.deepEqual(kinds, ["refunding", "refunded"], "the signed transaction is on disk before it is sent");
  } finally { await t.done(); }
});

test("ARCH-673 every mismatch with the chain is refused (409) and nothing moves", async () => {
  const cases: [Record<string, string>, RegExp, Parameters<typeof setup>[0]?][] = [
    [{ amountUnits: "20001" }, /amountUnits is not the amount paidTx transferred/],
    [{ network: "near:mainnet" }, /network must be near:testnet/],
    [{ paidTx: "5vv6QJSaL1V9dDeqWeVGhX5vaeQ3EhXheJSnYSmGWAAc" }, /paidTx is not on chain/],
    [{}, /exactly one USDC ft_transfer to chainaim-payto-seller.testnet, it holds 0/, { usdc: "usdc.other.testnet" }],
    [{}, /exactly one USDC ft_transfer to someone-else.testnet, it holds 0/, { account: "someone-else.testnet" }],
    [{}, /older than 86400 s/, { now: PAID_AT + 86_401_000 }],
  ];
  for (const [over, re, s] of cases) {
    const t = await setup(s);
    try {
      await assert.rejects(t.desk.refund({ ...REQ, ...over }), (e: Error) => e instanceof RefundRefused && re.test(e.message), re.source);
      assert.equal(t.c.sent.length, 0, re.source);
      assert.equal(t.book.refundOf(INVOICE), undefined);
    } finally { await t.done(); }
  }
});

test("ARCH-673 I2: the payer must be the account of the mandate accepted for that invoice; a paid tx is refunded for one invoice only", async () => {
  const t = await setup();
  try {
    t.book.append({ kind: "mandate_accepted", invoiceId: INVOICE, jobId: JOB, accountId: "chainaim-t02-seller.testnet", exp: 1 });
    await assert.rejects(t.desk.refund(REQ), /another account or job than the checkout mandate/);
    assert.equal(t.c.sent.length, 0);
    const other = "D802E26D9A1B4C5D8E7F60718293A4B5";
    t.book.append({ kind: "mandate_accepted", invoiceId: other, jobId: JOB, accountId: BUYER, exp: 1 });
    assert.equal((await t.desk.refund({ ...REQ, invoiceId: other })).status, "refunded");
    await assert.rejects(t.desk.refund({ ...REQ, invoiceId: "E902E26D9A1B4C5D8E7F60718293A4B5" }), /already refunded for another invoice/);
    await assert.rejects(t.desk.refund({ ...REQ, invoiceId: other, amountUnits: "10000" }), /names another job, payment or amount/);
    assert.equal(t.c.sent.length, 1);
  } finally { await t.done(); }
});

test("ARCH-673 the request allowlist: ids and amounts only, each field checked by name", () => {
  assert.deepEqual(parseRefundRequest(REQ), REQ);
  assert.throws(() => parseRefundRequest({ ...REQ, receiver: "attacker.testnet" }), (e: Error) => e instanceof RefundInputError && /\$\.receiver is not accepted/.test(e.message));
  assert.throws(() => parseRefundRequest({ ...REQ, reason: "because" }), /\$\.reason must be over_estimate/);
  // privateAI-design-39 ARCH-689: a run refused because NEAR AI attestation was not proven is refunded by name.
  assert.equal(parseRefundRequest({ ...REQ, reason: "attestation_not_proven" }).reason, "attestation_not_proven");
  assert.throws(() => parseRefundRequest({ ...REQ, amountUnits: "-1" }), /\$\.amountUnits/);
  assert.throws(() => parseRefundRequest([]), /\$ must be a JSON object/);
});

test("ARCH-673 ARCH-674 a timeout leaves the refund pending; sweep finds it final; a refund the chain never saw is sent again", async () => {
  const t = await setup();
  try {
    t.c.mode = "slow";
    const r = await t.desk.refund(REQ);
    assert.equal(r.status, "refund_pending");
    assert.equal(typeof r.refundTx, "string");
    assert.equal(t.book.refundOf(INVOICE)!.status, "refunding");
    await t.desk.sweep();
    assert.equal(t.desk.get(INVOICE)!.status, "refunded");
    assert.equal(t.desk.walletState, "ok");
    assert.equal(t.c.sent.length, 1, "found by its hash, not sent twice");
  } finally { await t.done(); }
  // A refund the chain never saw (dropped on the way), on a fresh desk: the recorded payment can be refunded once per ledger.
  const u = await setup();
  try {
    u.c.mode = "drop";
    assert.equal((await u.desk.refund(REQ)).status, "refund_pending");
    assert.equal(u.c.executed.size, 0, "the chain never saw it");
    u.c.mode = "ok";
    await u.desk.sweep();
    assert.equal(u.c.sent.length, 2, "the same bytes were sent again");
    assert.equal(u.c.sent[1].hash, u.c.sent[0].hash);
    assert.equal(u.desk.get(INVOICE)!.status, "refunded");
  } finally { await u.done(); }
});

test("ARCH-673 a refused transaction is refund_failed (unsigned refundTx, reason kept); the owner's retry sends a new one", async () => {
  const t = await setup();
  try {
    t.c.mode = "invalid";
    const r = await t.desk.refund(REQ);
    assert.deepEqual([r.status, r.refundTx], ["refund_pending", null]);
    assert.match(r.reason, /^refund_failed: /);
    assert.equal(verifyRefund(JSON.parse(JSON.stringify(r)), t.receipt.publicKeyPem).ok, true);
    t.c.mode = "ok";
    const again = await t.desk.retry(INVOICE);
    assert.equal(again.status, "refunded");
    assert.equal(t.c.executed.size, 1);
    await assert.rejects(t.desk.retry("NOSUCHINVOICE"), /no refund was asked for this invoice/);
  } finally { await t.done(); }
});

test("ARCH-674 the ledger replays after a restart; a changed line stops the signer naming the line", async () => {
  const t = await setup();
  try {
    await t.desk.refund(REQ);
    const reopened = new RefundBook(t.dir, t.receipt);
    assert.equal(reopened.refundOf(INVOICE)!.status, "refunded");
    assert.equal(reopened.refundOfJob(JOB)!.payer, BUYER);
    assert.equal(reopened.invoiceOfPaidTx(PAID_TX), INVOICE);
    const file = join(t.dir, LEDGER_FILE);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[0] = lines[0].replace(`"payer":"${BUYER}"`, '"payer":"attacker.testnet"');
    writeFileSync(file, lines.join("\n"));
    assert.throws(() => new RefundBook(t.dir, t.receipt), /refunds\.jsonl line 1 does not carry this signer's signature/);
    const other = receiptSignerFromKey(generateKeyPairSync("ed25519").privateKey);
    writeFileSync(file, readFileSync(file, "utf8").replace('"payer":"attacker.testnet"', `"payer":"${BUYER}"`));
    assert.throws(() => new RefundBook(t.dir, other), /line 1 .*another receipt key is loaded/);
  } finally { await t.done(); }
});

// ---- ARCH-675 (I3) and the mandate nonce across restarts, on the real SellerSigner ----------------------------------------

function receiptBody(jobId: string, amountUnits: string, extra: Record<string, unknown> = {}): ReceiptBody {
  const files = [{ name: "gl.csv", bytes: 1200, sha256: "a".repeat(64) }];
  return {
    v: 1, receiptId: "f".repeat(32), jobId, quoteId: jobId, route: "nearai/deepseek-v4.1-flash", datasetId: "smb-erp-fin", files, filesRoot: filesRoot(files),
    sqlSha256: "b".repeat(64), resultSha256: "c".repeat(64), calls: [{ servedModel: "deepseek/deepseek-v4.1-flash", attestStatus: "pending", reqSha256: "d".repeat(64), respSha256: "e".repeat(64) }],
    price: { amountUnits, usdcDecimals: 6, priceUsd: "0.02", quoteBasis: { pricing: "after", phrase: "llm", userSql: true, files: 1, totalBytes: 1200, calls: 1 } },
    createdAt: "2026-11-13T05:47:00.000Z", ...extra,
  } as ReceiptBody;
}

test("ARCH-675 I3: a refunded job gets no receipt (409); a job with a delivered receipt is never refunded", async () => {
  const t = await setup();
  try {
    const signer = new SellerSigner({ receipt: t.receipt, pricing: { prices: new Map(), fees: { perModelCallUsd: "0", analystUsd: "0", nearGasUsd: "0", marginPct: "0", minPriceUsd: "0.01" }, round: "cent" }, termsUrl: "https://chainaim.example/terms", refunds: t.book });
    await t.desk.refund(REQ);
    assert.throws(() => signer.signReceipt(parseReceiptRequest({ body: receiptBody(JOB, "20000") })), /this job was refunded; no receipt/);
    const delivered = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    signer.signReceipt(parseReceiptRequest({ body: receiptBody(delivered, "20000") }));
    await assert.rejects(t.desk.refund({ ...REQ, jobId: delivered, invoiceId: "A102E26D9A1B4C5D8E7F60718293A4B5" }), /a receipt was delivered for this job; no refund/);
    assert.equal(t.c.sent.length, 1);
  } finally { await t.done(); }
});

test("ARCH-674 a mandate accepted for an invoice stays used after the signer restarts", async () => {
  const t = await setup();
  try {
    const ap2Key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const tenantKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const tenantJwk = publicJwkOf(tenantKey);
    const now = () => Date.parse("2026-11-13T05:00:00Z");
    const make = (book: RefundBook) => new SellerSigner({
      ap2: ap2SignerFromKey(ap2Key), receipt: t.receipt, now, refunds: book,
      pricing: { prices: new Map([["nearai/deepseek-v4.1-flash", { inputPerM: "0.27", outputPerM: "1.10" }]]), fees: { perModelCallUsd: "0.001", analystUsd: "0.001", nearGasUsd: "0.001", marginPct: "20", minPriceUsd: "0.01" }, round: "cent" },
      termsUrl: "https://chainaim.example/terms",
      mandates: { registry: [{ tenant: "t02", accountId: "chainaim-t02-seller.testnet", keys: [tenantJwk] }], aud: "chainaim", skewSec: 30, maxLifetimeSec: 900 },
    });
    const first = make(t.book);
    const amount = first.price({ kind: "metered", meter: [{ model: "nearai/deepseek-v4.1-flash", promptTokens: 1000, completionTokens: 100 }] }).amount;
    const signed = first.signQuote({ jobId: JOB, expiresAt: Date.parse("2026-11-13T05:15:00Z"), offer: { network: "near:testnet", asset: USDC, payTo: PAY_TO, amount }, pricing: { kind: "metered", meter: [{ model: "nearai/deepseek-v4.1-flash", promptTokens: 1000, completionTokens: 100 }] }, route: "nearai/deepseek-v4.1-flash" });
    const ap2 = { checkout: signed.checkout, merchant_authorization: signed.merchant_authorization };
    const iat = Math.floor(now() / 1000);
    const mandate = buildCheckoutMandate({ checkoutJwt: attachedJws(signed.merchant_authorization, signed.checkout), key: tenantKey, kid: tenantJwk.kid, aud: "chainaim", nonce: INVOICE, iat, exp: iat + 300 });
    assert.equal(first.verifyMandate({ mandate, jobId: JOB, nonce: INVOICE, ap2 }).ok, true);
    assert.equal(t.book.mandateFor(INVOICE)!.accountId, "chainaim-t02-seller.testnet");
    const restarted = make(new RefundBook(t.dir, t.receipt));
    const again = restarted.verifyMandate({ mandate, jobId: JOB, nonce: INVOICE, ap2 });
    assert.deepEqual([again.ok, again.ok ? "" : again.reason], [false, "a mandate for this invoice was already accepted"]);
  } finally { await t.done(); }
});

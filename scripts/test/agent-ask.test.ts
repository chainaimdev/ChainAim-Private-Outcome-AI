/**
 * privateAI-design-32 steps C and D: desk.ps1 -AgentAsk (scripts/agent-ask.ts) and -VerifyReceipt (scripts/verify-receipt.ts).
 * The real CLIs, run as child processes against a loopback console stand-in that answers the console API's routes the
 * way test-console/console/server.ts does (GET /datasets, /agent/config, /gateway/models, /jobs/<id>/receipt; POST
 * /agent/crossask as an event stream). Receipts are signed with packages/receipt (real Ed25519, canonical JSON). The agent
 * run itself (policy, payment, receipt check) is covered by services/paywall/test/agent-policy.test.ts and
 * agent-receipt.test.ts; the relay by console-agent.test.ts.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addSettlement, filesRoot, resultSha256, sha256Hex, signerFromKey, signReceipt, type ReceiptSigner, type SignedReceipt } from "../../packages/receipt/src/index.ts";
import { merchantAuthSha256, signerFromKey as ap2SignerFromKey, signMerchantAuthorization } from "../../packages/ap2/src/index.ts";
import { buildRun, parseFrame, resultText, stepLine, type ListedDataset } from "../agent-ask-core.ts";

const ASK = fileURLToPath(new URL("../agent-ask.ts", import.meta.url));
const VERIFY = fileURLToPath(new URL("../verify-receipt.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agent-ask-"));
const signer: ReceiptSigner = signerFromKey(generateKeyPairSync("ed25519").privateKey);
const other: ReceiptSigner = signerFromKey(generateKeyPairSync("ed25519").privateKey);
const pinnedFile = join(dir, "receipt-public-key.pem");
writeFileSync(pinnedFile, signer.publicKeyPem);
const TX = "gzDPwE9qAbCdEfGhJkLmNpQrStUvXYbJwC";
const RESULT = { result: { columns: ["month", "net_cash_flow"], rows: [{ month: "2026-10", net_cash_flow: "742.25" }] }, answer: "Net cash flow was 742.25.", served: [] };

function receiptFor(jobId: string, result: unknown, s: ReceiptSigner, transaction?: string): SignedReceipt {
  const files = [{ name: "sample_bofa_full_statement.csv", bytes: 812, sha256: sha256Hex("bank") }];
  const r = signReceipt({
    v: 1, receiptId: sha256Hex(`${jobId}:r`).slice(0, 32), jobId, quoteId: jobId, route: "nearai/deepseek-v4.1-flash", datasetId: "smb-fin-1", templateLabel: "Cash flow vs installment",
    files, filesRoot: filesRoot(files), sqlSha256: sha256Hex("select"), resultSha256: resultSha256(result), calls: [{ servedModel: "nearai/deepseek-v4.1-flash", attestStatus: "verified", reqSha256: sha256Hex("q"), respSha256: sha256Hex("a") }],
    price: { amountUnits: "10000", usdcDecimals: 6, priceUsd: "0.01", quoteBasis: { rows: 1 } }, createdAt: new Date().toISOString(),
  }, s);
  return transaction ? addSettlement(r, { network: "near:testnet", transaction, invoiceId: "inv-1", payer: "chainaim-buyer-seller.testnet", settledAt: new Date().toISOString() }, s) : r;
}

const DATASETS: ListedDataset[] = [
  { id: "smb-fin-1", label: "Small Biz Financials - 1", engine: "crossask", folder: "/app/sample-data/smb-fin/statements", exists: true, allowed: true, sets: [], defaultSubfolder: null,
    templates: [{ label: "Cash flow vs installment", q: "By month, how much cash came in?", sql: "SELECT 1" }, { label: "Receivables vs payables: need a loan?", q: "How much is owed?", sql: "SELECT 2" }] },
  { id: "dental-prms", label: "Practice Management - Dental", engine: "domain-pack", folder: "/app/sample-data/prms/dent", exists: true, allowed: true, sets: [], defaultSubfolder: null, templates: [] },
  { id: "setted", label: "With sets", engine: "crossask", folder: "/app/sample-data/x", exists: true, allowed: true, sets: [{ name: "SET-1/POS", files: ["a.csv"] }, { name: "SET-2", files: ["b.csv"] }], defaultSubfolder: "SET-2",
    templates: [{ label: "T", q: "Q?" }] },
];

// ---- the console stand-in --------------------------------------------------------------------------------------------
const consoleState: { stream: (jobId: string) => string; posted: Record<string, unknown>[]; receipt: (jobId: string) => SignedReceipt | null } = { stream: () => "", posted: [], receipt: () => null };
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const paidStream = (jobId: string) => [
  frame("masked", { counts: {} }), frame("tool_called", { tool: "chainaim_ask_across_files" }), frame("job_ran", { jobId, expiresAt: 1 }),
  frame("quoted", { jobId, amount: "10000", totalUsd: "0.010000", network: "near:testnet", asset: "usdc", payTo: "chainaim-payto-seller.testnet" }),
  frame("policy", { tenant: "t01", decision: "pay", reason: "within", spentTodayUsd: "0", checks: [{ check: "max_per_job", limit: "0.05", value: "0.01", ok: true }] }),
  frame("signed", { account: "chainaim-buyer-seller.testnet" }), frame("settled", { transaction: TX, network: "near:testnet" }),
  frame("released", { jobId, rows: 1, calls: 1, result: RESULT }), frame("receipt_verified", { jobId, receiptId: "r", keyId: signer.keyId, settled: true, transaction: TX }), frame("done", {}),
].join("");
let jobId = "";
const consoleServer: Server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url ?? "/", "http://console");
  const json = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.method === "GET" && url.pathname === "/datasets") return json(200, { root: url.searchParams.get("root"), datasets: DATASETS });
  if (req.method === "GET" && url.pathname === "/agent/config") return json(200, { network: "near:testnet", tenants: [{ id: "t01", name: "Northwind (synthetic)", accountId: "chainaim-buyer-seller.testnet" }, { id: "t03", name: "Harborline", accountId: "chainaim-t03-seller.testnet" }] });
  if (req.method === "GET" && url.pathname === "/gateway/models") return json(200, { defaultAnswerModel: "nearai/deepseek-v4.1-flash", models: [] });
  if (req.method === "POST" && url.pathname === "/agent/crossask") {
    consoleState.posted.push(JSON.parse(body));
    jobId = randomBytes(16).toString("hex");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    return res.end(consoleState.stream(jobId));
  }
  const m = /^\/jobs\/([0-9a-f]{32})\/receipt$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const r = consoleState.receipt(m[1]);
    return r ? json(200, { receipt: r, publicKeyPem: signer.publicKeyPem }) : json(404, { error: "receipts are off: start the console with --receipts on" });
  }
  json(404, { error: "no route" });
});
let api = "";

function cli(script: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => ok({ code: code ?? -1, out, err }));
  });
}
const ask = (...extra: string[]) => cli(ASK, ["--api", api, "--out-dir", join(dir, "out"), "--receipt-poll-ms", "100", "--receipt-poll-max", "2", ...extra]);
const verifyCli = (...args: string[]) => cli(VERIFY, ["--public-key", pinnedFile, ...args]);

before(async () => { api = await new Promise((ok) => consoleServer.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(consoleServer.address() as { port: number }).port}`))); });
after(() => { consoleServer.close(); rmSync(dir, { recursive: true, force: true }); });

describe("step C -AgentAsk: the run body is the page's", () => {
  test("ARCH-309 ARCH-613: template 1 by number or by label sends its question, exact query, datasetId and templateLabel; default answer model is the console's", () => {
    const a = buildRun("t01", DATASETS, { dataset: "smb-fin-1", template: "1", answerModel: "default" }, "nearai/deepseek-v4.1-flash");
    assert.deepEqual(a, { run: { tenant: "t01", folder: "/app/sample-data/smb-fin/statements", question: "By month, how much cash came in?", phrase: "llm", datasetId: "smb-fin-1", answerModel: "nearai/deepseek-v4.1-flash", sql: "SELECT 1", templateLabel: "Cash flow vs installment" }, datasetLabel: "Small Biz Financials - 1", templateLabel: "Cash flow vs installment" });
    const b = buildRun("t01", DATASETS, { dataset: "smb-fin-1", template: "receivables vs payables: need a loan?", answerModel: "none" }, "x/y");
    assert.ok(!("error" in b) && b.run.sql === "SELECT 2" && b.run.phrase === "none" && !("answerModel" in b.run));
  });

  test("ARCH-613: a typed question has no exact query and no template label; a dataset with sets uses its default set; refusals name the problem", () => {
    const q = buildRun("t01", DATASETS, { dataset: "smb-fin-1", template: "1", question: "  Total? ", answerModel: "none" }, null);
    assert.ok(!("error" in q));
    assert.deepEqual([q.run.question, q.run.sql, q.run.templateLabel], ["Total?", undefined, undefined]);
    const s = buildRun("t01", DATASETS, { dataset: "setted", template: "1", answerModel: "none" }, null);
    assert.ok(!("error" in s) && s.run.folder === "/app/sample-data/x/SET-2");
    const s1 = buildRun("t01", DATASETS, { dataset: "setted", template: "1", set: "SET-1/POS", answerModel: "none" }, null);
    assert.ok(!("error" in s1) && s1.run.folder === "/app/sample-data/x/SET-1/POS");
    assert.match((buildRun("t01", DATASETS, { dataset: "nope", template: "1", answerModel: "none" }, null) as { error: string }).error, /^no dataset nope \(known: smb-fin-1, dental-prms, setted\)/);
    assert.match((buildRun("t01", DATASETS, { dataset: "dental-prms", template: "1", answerModel: "none" }, null) as { error: string }).error, /is a domain-pack dataset; -AgentAsk runs crossask datasets/);
    assert.match((buildRun("t01", DATASETS, { dataset: "smb-fin-1", template: "3", answerModel: "none" }, null) as { error: string }).error, /no template 3 \(1 to 2: 1 "Cash flow vs installment"/);
    assert.match((buildRun("t01", DATASETS, { dataset: "setted", template: "1", set: "X", answerModel: "none" }, null) as { error: string }).error, /has no set X/);
  });

  test("ARCH-620: --query-model sends tab 03's 'Writes the query' model (so an attested-route policy can pay); default and an exact query send none; a bad id is refused", () => {
    const typed = buildRun("t01", DATASETS, { dataset: "setted", template: "1", answerModel: "nearai/deepseek-v4.1-flash", queryModel: "nearai/deepseek-v4.1-flash" }, null);
    assert.ok(!("error" in typed));
    assert.equal(typed.run.model, "nearai/deepseek-v4.1-flash");
    assert.equal(typed.run.answerModel, "nearai/deepseek-v4.1-flash");
    const dflt = buildRun("t01", DATASETS, { dataset: "setted", template: "1", answerModel: "none", queryModel: "default" }, null);
    assert.ok(!("error" in dflt) && !("model" in dflt.run), "default leaves the console's query model");
    const unset = buildRun("t01", DATASETS, { dataset: "setted", template: "1", answerModel: "none" }, null);
    assert.ok(!("error" in unset) && !("model" in unset.run), "absent = as before");
    const exact = buildRun("t01", DATASETS, { dataset: "smb-fin-1", template: "1", answerModel: "none", queryModel: "nearai/deepseek-v4.1-flash" }, null);
    assert.ok(!("error" in exact) && !("model" in exact.run) && exact.run.sql === "SELECT 1", "an exact query needs no query model");
    assert.match((buildRun("t01", DATASETS, { dataset: "setted", template: "1", answerModel: "none", queryModel: "bad model" }, null) as { error: string }).error, /query model must be default or provider\/name, got bad model/);
  });

  test("ARCH-306: step lines carry who did each step, as tab 03; the result table shows the answer and rows", () => {
    assert.deepEqual(parseFrame('event: settled\ndata: {"transaction":"T"}'), { type: "settled", data: { transaction: "T" } });
    assert.equal(stepLine("t01", "quoted", { totalUsd: "0.010000", network: "near:testnet", payTo: "p.testnet" }), "[ChainAim] Quoted 0.01 USDC on near:testnet to p.testnet");
    assert.equal(stepLine("t03", "policy", { decision: "refuse", checks: [{ check: "max_per_job", limit: "0.005", value: "0.01", ok: false }] }), "[Agent t03] Spending policy: refused · at most 0.005 a job (quote 0.01) NO");
    // privateAI-design-39 ARCH-689 / ARCH-688: a refund because privacy was not proven names it; the policy row for the signed mode.
    assert.match(stepLine("t01", "refunded", { refundTx: "R1", network: "near:testnet", privacy: "unavailable" })!, /^\[ChainAim\] Refused: privacy not proven \(unavailable\) -> refunded OK \(record signed by ChainAim, verified by the agent\) · transaction R1 /);
    assert.match(stepLine("t01", "refunded", { refundTx: "R1", network: "near:testnet" })!, /^\[ChainAim\] Refunded OK \(record signed/);
    assert.match(stepLine("t01", "refund_pending", { invoiceId: "INV1", privacy: "unverified" })!, /^\[ChainAim\] Refused: privacy not proven \(unverified\): refund pending \(invoice INV1\)$/);
    assert.equal(stepLine("t01", "policy", { decision: "refuse", checks: [{ check: "require_attestation", limit: "verified", value: "evidence", ok: false }] }), "[Agent t01] Spending policy: refused · attestation verified or stronger (signed: evidence) NO");
    assert.match(stepLine("t01", "receipt_verified", { keyId: "d27d1e9f17a0", settled: true })!, /^\[Agent t01\] Agent verified the receipt OK · signed by the pinned key d27d1e9f… · result, job and amount and transaction match$/);
    assert.equal(resultText(RESULT, 20), ["Answer:", "  Net cash flow was 742.25.", "Result (1 row(s)):", "  month    net_cash_flow", "  -------  -------------", "  2026-10  742.25       "].join("\n"));
  });
});

describe("step C -AgentAsk: the real CLI against the console API", () => {
  test("ARCH-306 ARCH-613 ARCH-615: a paid run prints every step and the result, saves the receipt (page format) and result, exit 0", async () => {
    consoleState.stream = paidStream;
    consoleState.receipt = (id) => receiptFor(id, RESULT, signer, TX);
    consoleState.posted = [];
    const r = await ask("--tenant", "t01", "--dataset", "smb-fin-1", "--template", "1");
    assert.equal(r.code, 0, r.out + r.err);
    // offerMode (privateAI-design-34 D5): -AgentAsk's default, estimate-first.
    assert.deepEqual(consoleState.posted[0], { offerMode: "estimate-first", tenant: "t01", folder: "/app/sample-data/smb-fin/statements", question: "By month, how much cash came in?", phrase: "llm", datasetId: "smb-fin-1", answerModel: "nearai/deepseek-v4.1-flash", sql: "SELECT 1", templateLabel: "Cash flow vs installment" });
    assert.match(r.out, /^RUN +AI agent for Northwind \(synthetic\) \(t01\) pays from chainaim-buyer-seller\.testnet; dataset Small Biz Financials - 1, template "Cash flow vs installment"; query none \(exact query\); answer nearai\/deepseek-v4\.1-flash$/m);
    assert.match(r.out, / 4\. \[ChainAim\] Quoted 0\.01 USDC/);
    assert.match(r.out, / 8\. \[ChainAim\] Result released: 1 row\(s\)\n +9\. \[Agent t01\] Agent verified the receipt OK/);
    assert.match(r.out, /Answer:\n  Net cash flow was 742\.25\./);
    assert.match(r.out, /^PAID +transaction gzDPwE9q\S+ on near:testnet: https:\/\/testnet\.nearblocks\.io\/txns\/gzDPwE9q/m);
    const rf = join(dir, "out", `chainaim-receipt-${jobId}.json`), resf = join(dir, "out", `chainaim-result-${jobId}.json`);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(rf, "utf8"))).sort(), ["publicKeyPem", "receipt"], "tab 03's Download receipt format");
    assert.deepEqual(JSON.parse(readFileSync(resf, "utf8")), RESULT);
    assert.match(r.out, /^OK +paid, result released, receipt verified by the agent with the pinned key$/m);
    assert.ok(!/PRIVATE KEY/.test(r.out + r.err));

    // Step D on what step C saved: valid, the result beside it matches.
    const v = await verifyCli("--file", rf);
    assert.equal(v.code, 0, v.out + v.err);
    assert.match(v.out, new RegExp(`^KEY +pinned ${signer.keyId} from `, "m"));
    assert.match(v.out, /it is the pinned key/);
    assert.match(v.out, /dataset +smb-fin-1 · template "Cash flow vs installment"/);
    assert.match(v.out, new RegExp(`result +sha256 ${resultSha256(RESULT)} · matches .*chainaim-result-${jobId}\\.json`));
    assert.match(v.out, /settled +near:testnet transaction gzDPwE9q\S+ · invoice inv-1 · payer chainaim-buyer-seller\.testnet/);
    assert.match(v.out, /^OK +receipt valid: signed by the pinned key [0-9a-f]{32}, settlement signed too, result matches$/m);
  });

  test("ARCH-620: the CLI's --query-model reaches the console's /agent/crossask as model, and the RUN line names it", async () => {
    consoleState.stream = paidStream;
    consoleState.receipt = (id) => receiptFor(id, RESULT, signer, TX);
    consoleState.posted = [];
    const r = await ask("--tenant", "t01", "--dataset", "setted", "--question", "Total?", "--answer-model", "nearai/deepseek-v4.1-flash", "--query-model", "nearai/deepseek-v4.1-flash");
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(consoleState.posted[0].model, "nearai/deepseek-v4.1-flash");
    assert.match(r.out, /; query nearai\/deepseek-v4\.1-flash; answer nearai\/deepseek-v4\.1-flash$/m);
  });

  test("ARCH-620: a refused run prints the policy step and Not paid, saves nothing, exit 1", async () => {
    consoleState.stream = (id) => [frame("masked", { counts: {} }), frame("job_ran", { jobId: id, expiresAt: 1 }), frame("quoted", { jobId: id, totalUsd: "0.010000", network: "near:testnet", payTo: "p" }),
      frame("policy", { decision: "refuse", checks: [{ check: "max_per_job", limit: "0.005", value: "0.01", ok: false }] }), frame("refused", { reason: "refused by t03's spending policy: the cheapest quote 0.01 USD is above maxPerJobUsd 0.005; nothing was signed or paid" })].join("");
    const r = await ask("--tenant", "t03", "--dataset", "smb-fin-1");
    assert.equal(r.code, 1);
    assert.match(r.out, /\[Agent t03\] Spending policy: refused · at most 0\.005 a job \(quote 0\.01\) NO/);
    assert.match(r.out, /Not paid: refused by t03's spending policy/);
    assert.match(r.out, /^FAIL +not paid \(refused\)/m);
    assert.equal(existsSync(join(dir, "out", `chainaim-result-${jobId}.json`)), false);
  });

  test("ARCH-613: a failed receipt check by the agent is exit 1 although paid; unknown tenant, usage and an unreachable console are exit 2", async () => {
    consoleState.stream = (id) => paidStream(id).replace(/event: receipt_verified\ndata: .*\n\n/, frame("receipt_failed", { jobId: id, reason: "the receipt was signed by another key" }));
    const f = await ask("--tenant", "t01", "--dataset", "smb-fin-1");
    assert.equal(f.code, 1);
    assert.match(f.out, /Receipt check FAILED: the receipt was signed by another key \(the payment stands\)/);
    assert.equal((await ask("--tenant", "t09", "--dataset", "smb-fin-1")).code, 2);
    const u = await ask("--tenant", "t01", "--dataset", "smb-fin-1", "--template", "9");
    assert.equal(u.code, 2);
    assert.match(u.err, /no template 9/);
    const down = await cli(ASK, ["--api", "http://127.0.0.1:9", "--tenant", "t01", "--dataset", "smb-fin-1"]);
    assert.equal(down.code, 2);
    assert.match(down.out, /the console API is not answering at http:\/\/127\.0\.0\.1:9/);
  });
});

describe("step D -VerifyReceipt: offline, pinned key", () => {
  const write = (name: string, j: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(j)); return p; };
  const id = randomBytes(16).toString("hex");

  test("ARCH-613 ARCH-616: a downloaded receipt is valid; a bare receipt too; with --result none the result is not checked", async () => {
    const good = receiptFor(id, RESULT, signer, TX);
    const v = await verifyCli("--file", write("dl.json", { receipt: good, publicKeyPem: signer.publicKeyPem }), "--result", "none");
    assert.equal(v.code, 0, v.out + v.err);
    assert.match(v.out, /result +sha256 [0-9a-f]{64} · not checked \(no result file\)/);
    assert.match(v.out, /calls +1 nearai\/deepseek-v4\.1-flash attest verified/);
    assert.match(v.out, /explorer +https:\/\/testnet\.nearblocks\.io\/txns\/gzDPwE9q/);
    assert.equal((await verifyCli("--file", write("bare.json", good))).code, 0);
  });

  test("ARCH-613: the key is pinned: a receipt signed by another key fails even when the file carries that key", async () => {
    const v = await verifyCli("--file", write("other.json", { receipt: receiptFor(id, RESULT, other, TX), publicKeyPem: other.publicKeyPem }));
    assert.equal(v.code, 1);
    assert.match(v.out, /it is NOT the pinned key and is ignored/);
    assert.match(v.out, /^FAIL +receipt NOT valid: the receipt was signed by another key$/m);
  });

  test("ARCH-613 ARCH-616: an edited body, an edited settlement or a different result fails, naming why", async () => {
    const good = receiptFor(id, RESULT, signer, TX);
    const body = await verifyCli("--file", write("t1.json", { receipt: { ...good, body: { ...good.body, price: { ...good.body.price, priceUsd: "0.001" } } } }));
    assert.equal(body.code, 1);
    assert.match(body.out, /receipt NOT valid: the receipt signature does not verify/);
    const st = await verifyCli("--file", write("t2.json", { receipt: { ...good, settlement: { ...good.settlement!, transaction: "3abcdefghijkmnopqrstuvwxyzABCDEFG" } } }));
    assert.match(st.out, /receipt NOT valid: the settlement signature does not verify/);
    const res = await verifyCli("--file", write("t3.json", { receipt: good }), "--result", write("other-result.json", { result: { columns: ["n"], rows: [] } }));
    assert.equal(res.code, 1);
    assert.match(res.out, /receipt NOT valid: the result is not the one the receipt commits to/);
  });

  test("ARCH-613: usage: no --file, an unreadable or non-receipt file, a missing pinned key are exit 2 with the reason", async () => {
    assert.equal((await verifyCli()).code, 2);
    const miss = await verifyCli("--file", join(dir, "missing.json"));
    assert.equal(miss.code, 2);
    assert.match(miss.err, /missing\.json could not be read \(ENOENT\)/);
    assert.match((await verifyCli("--file", write("x.json", { hello: 1 }))).err, /holds no signed receipt/);
    const nokey = await cli(VERIFY, ["--file", write("y.json", receiptFor(id, RESULT, signer)), "--public-key", join(dir, "none.pem")]);
    assert.equal(nokey.code, 2);
    assert.match(nokey.err, /desk\.ps1 -ReceiptKey exports it/);
  });
});

describe("ARCH-630 ARCH-631 the signed quote in -AgentAsk and -VerifyReceipt", () => {
  const write = (name: string, j: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(j)); return p; };
  const ap2 = ap2SignerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  const ap2Other = ap2SignerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  const ap2File = join(dir, "ap2-public-key.jwk.json");
  writeFileSync(ap2File, JSON.stringify({ keys: [ap2.publicJwk] }));
  const id = randomBytes(16).toString("hex");
  const quoteFor = (jobId: string, amountUnits: string, s = ap2) => {
    const checkout = { id: jobId, currency: "USD", totals: [{ type: "total", amount: 1 }], "dev.chainaim.job": { amountUnits, usdcDecimals: 6 } };
    return { checkout, merchant_authorization: signMerchantAuthorization(checkout, s) };
  };
  /** A receipt that points at `q` (merchantAuthSha256), signed by the pinned receipt key. */
  const pointing = (q: { merchant_authorization: string }) => {
    const base = receiptFor(id, RESULT, signer);
    return signReceipt({ ...base.body, merchantAuthSha256: merchantAuthSha256(q.merchant_authorization) }, signer);
  };
  const v = (...a: string[]) => verifyCli("--ap2-public-key", ap2File, "--result", "none", ...a);

  test("ARCH-630: the step lines: quote signed by ChainAim, and a refusal carries its AP2 code", () => {
    assert.equal(stepLine("t01", "quote_signed", { kid: "83816e6fd32b879fd96d0318a40cd40d", cents: 1 }), "[Agent t01] Quote signed by ChainAim OK · key id 83816e6f… · price, payee and network match");
    assert.equal(stepLine("t01", "refused", { reason: "no", code: "mandate_scope_mismatch" }), "Not paid [mandate_scope_mismatch]: no");
    assert.equal(stepLine("t01", "refused", { reason: "no" }), "Not paid: no");
  });

  test("ARCH-631: a receipt with its signed quote: the quote verifies with the pinned AP2 key and matches the receipt", async () => {
    const q = quoteFor(id, "10000");
    const r = await v("--file", write("q-ok.json", { receipt: pointing(q), publicKeyPem: signer.publicKeyPem, ap2: q }));
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, new RegExp(`quote +sha256 ${merchantAuthSha256(q.merchant_authorization)} · signed by the pinned AP2 key ${ap2.kid} · job and amount match the receipt`));
    assert.match(r.out, /^OK .*signed quote matches$/m);
    const without = await v("--file", write("q-none.json", { receipt: pointing(q) }));
    assert.equal(without.code, 0);
    assert.match(without.out, /signed quote not in this file, not checked/);
  });

  test("ARCH-631: another AP2 key, another quote than the receipt points at, or another amount: exit 1, naming why", async () => {
    const q = quoteFor(id, "10000");
    const otherKey = await v("--file", write("q-k.json", { receipt: pointing(q), ap2: quoteFor(id, "10000", ap2Other) }));
    assert.equal(otherKey.code, 1);
    assert.match(otherKey.out, /signed quote NOT valid: merchant_authorization_invalid/);
    const swapped = quoteFor(id, "10000");
    const s = await v("--file", write("q-s.json", { receipt: pointing(q), ap2: { ...swapped, merchant_authorization: quoteFor(id, "10000").merchant_authorization } }));
    assert.equal(s.code, 1);
    const amt = quoteFor(id, "20000");
    const a = await v("--file", write("q-a.json", { receipt: pointing(amt), ap2: amt }));
    assert.equal(a.code, 1);
    assert.match(a.out, /signed quote's amount is not the receipt's amount/);
  });
});

test("privateAI-design-36 ARCH-666 ARCH-668: the terminal names both sides of the AP2 deal: the agent's mandate and ChainAim's signer's check of it", () => {
  assert.equal(stepLine("t02", "mandate_signed", { kid: "a1b2c3d4e5f60718", sha256: "f".repeat(64), nonce: "INV1" }), "[Agent t02] Checkout mandate signed OK · tenant key a1b2c3d4… · permits exactly this signed quote, for this payment only");
  assert.equal(stepLine("t02", "mandate_verified", { ok: true, sha256: "0123456789abcdef".repeat(4) }), "[ChainAim] Mandate verified by ChainAim's signer OK (before the job ran; recorded in the receipt) · 0123456789ab…");
  assert.equal(stepLine("t02", "mandate_verified", { ok: false, sha256: "0".repeat(64), reason: "the receipt records no mandate" }), "[ChainAim] Mandate NOT confirmed by the receipt: the receipt records no mandate");
});

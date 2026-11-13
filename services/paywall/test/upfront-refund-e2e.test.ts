/**
 * privateAI-design-37 end to end: "ChainAim never works unpaid; you never pay for a failed job."
 * The real paywall (PAID_JOBS_FLOW=upfront) settles the buyer's real signed delegate before the run; the console refuses the
 * run; the paywall asks the real ca-control-signer PROCESS (services/signer/src/main.ts --refunds on), which reads the
 * payment from the chain, signs a refund ft_transfer with the payTo key and sends it. The chain is the NEAR JSON-RPC
 * protocol double the NEAR rail tests use (it checks every signature and moves the token balances).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { nearPaymentHeader } from "../../web/src/near-payment.ts";
import { verifyRefund } from "../../../packages/receipt/src/index.ts";
import { keySigner } from "../scripts/near-signer.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "usdc.chainaim-test.testnet";
const PAY_TO = "merchant.chainaim-test.testnet";
const BUYER = "buyer.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const SIGNER_KEY = randomBytes(24).toString("hex");
const START = 10_000_000n;
const pem = (k: ReturnType<typeof generateKeyPairSync>["privateKey"]) => k.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n");

describe("design-37 upfront pay and automatic refund, end to end", () => {
  const buyerKey = KeyPair.fromRandom("ed25519");
  const relayerKey = KeyPair.fromRandom("ed25519");
  const payToKey = KeyPair.fromRandom("ed25519");
  const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
  const gateway = stubGateway();
  const dir = mkdtempSync(join(tmpdir(), "chainaim-upfront-e2e-"));
  const consoleState = { runStatus: 409 as 200 | 409 };
  const offers = new Set<string>();
  const consoleServer: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers["x-jobs-key"] !== JOBS_KEY) return send(401, { error: "x-jobs-key is missing or wrong" });
      const run = /^\/internal\/jobs\/([0-9a-f]{32})\/run$/.exec(req.url!);
      if (req.method === "POST" && run && offers.has(run[1])) {
        if (consoleState.runStatus === 409) return send(409, { error: "the job needs more model calls than estimated" });
        return send(200, { jobId: run[1], result: { rows: [{ n: 1 }] } });
      }
      if (/\/released$/.test(req.url!)) return send(200, { released: true });
      send(404, { error: "no route" });
    });
  });
  let paywall: { url: string; close: () => Promise<void> };
  let signerProc: ChildProcess;
  let signerUrl = "";
  let receiptPem = "";
  let signer: ReturnType<typeof keySigner>;
  const signerOut: string[] = [];

  before(async () => {
    const rpcUrl = await listen(double.server);
    const gatewayUrl = await listen(gateway.server);
    const consoleUrl = await listen(consoleServer);
    addAccount(double.state, BUYER, buyerKey.getPublicKey().toString());
    addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
    addAccount(double.state, PAY_TO, payToKey.getPublicKey().toString());
    double.state.token.registered.add(PAY_TO);
    double.state.token.registered.add(BUYER);
    double.state.token.balances.set(BUYER, START);

    const catalog = join(dir, "catalog.json");
    writeFileSync(catalog, JSON.stringify({ models: [{ id: "nearai/deepseek-v4.1-flash", pricing: { inputPerM: "0.27", outputPerM: "1.10" } }] }));
    signerProc = spawn(process.execPath, [
      join(ROOT, "services/signer/src/main.ts"), "--host", "127.0.0.1", "--port", "0",
      "--pricing-catalog", catalog, "--fee-per-model-call-usd", "0.001", "--fee-analyst-usd", "0.001", "--near-gas-fee-usd", "0.001", "--margin-pct", "20", "--min-price-usd", "0.01",
      "--terms-url", "https://chainaim.example/terms",
      "--refunds", "on", "--refund-store", join(dir, "refunds"), "--refund-account", PAY_TO, "--refund-usdc-contract", TOKEN,
      "--near-rpc-url", rpcUrl, "--paid-tx-sender", RELAYER, "--refund-sweep-sec", "3600", "--refund-confirm-timeout-ms", "5000",
    ], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SIGNER_REQUEST_KEY: SIGNER_KEY, AP2_SIGNING_KEY: pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), RECEIPT_SIGNING_KEY: pem(generateKeyPairSync("ed25519").privateKey), SELLER_NEAR_PRIVATE_KEY: payToKey.toString() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    signerUrl = await new Promise<string>((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`the signer did not start: ${signerOut.join("")}`)), 20_000);
      const read = (d: Buffer) => {
        signerOut.push(d.toString());
        const m = /listening on ([\d.]+):(\d+)/.exec(signerOut.join(""));
        if (m) { clearTimeout(t); ok(`http://127.0.0.1:${m[2]}`); }
      };
      signerProc.stdout!.on("data", read);
      signerProc.stderr!.on("data", read);
      signerProc.on("exit", (code) => { clearTimeout(t); fail(new Error(`the signer exited ${code}: ${signerOut.join("")}`)); });
    });
    receiptPem = ((await (await fetch(`${signerUrl}/.well-known/keys`)).json()) as { receipt: { publicKeyPem: string } }).receipt.publicKeyPem;

    paywall = await startNearPaywall({
      PAY_RAILS: "near",
      NEAR_PAY_TO_TESTNET: PAY_TO, NEAR_USDC_CONTRACT_TESTNET: TOKEN, NEAR_USDC_DECIMALS_TESTNET: "6", NEAR_RPC_URL_TESTNET: rpcUrl,
      NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER, NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(),
      GATEWAY_URL: gatewayUrl, CHAINAIM_GATEWAY_KEY: "test-gateway-key",
      PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: consoleUrl,
      PAID_JOBS_FLOW: "upfront", PAID_JOBS_REFUND_URL: signerUrl, SIGNER_REQUEST_KEY: SIGNER_KEY,
    }, () => undefined);
    signer = keySigner({ accountId: BUYER, secretKey: buyerKey.toString(), network: "near:testnet", rpcUrl });
  });
  after(async () => {
    signerProc?.removeAllListeners("exit");
    signerProc?.kill();
    await paywall?.close();
    await close(double.server);
    await close(gateway.server);
    await close(consoleServer);
    rmSync(dir, { recursive: true, force: true });
  });

  async function payOffer(amount: string) {
    const jobId = randomBytes(16).toString("hex");
    offers.add(jobId);
    const reg = await fetch(`${paywall.url}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify({ jobId, amount, expiresAt: Date.now() + 600_000, run: true }) });
    assert.equal(reg.status, 201);
    const url = `${paywall.url}/v1/jobs/${jobId}/release`;
    const quoted = JSON.parse(Buffer.from((await fetch(url, { method: "POST" })).headers.get("payment-required")!, "base64").toString("utf8"));
    const accept = quoted.accepts[0];
    const signed = await signer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: accept });
    const r = await fetch(url, { method: "POST", headers: { "PAYMENT-SIGNATURE": nearPaymentHeader(accept, signed, quoted.resource) } });
    return { r, jobId, invoiceId: accept.extra.invoiceId as string };
  }

  it("ARCH-672 ARCH-673: paid before the run, refused, refunded on chain to the buyer, with a refund record signed by ChainAim", async () => {
    consoleState.runStatus = 409;
    const { r, jobId, invoiceId } = await payOffer("20000");
    assert.equal(r.status, 409);
    const body = await r.json();
    const [paid, refund] = double.state.transfers;
    assert.deepEqual([paid.sender, paid.receiver, paid.amount], [BUYER, PAY_TO, 20000n], "the payment settled first");
    assert.deepEqual([refund.sender, refund.receiver, refund.amount, refund.memo], [PAY_TO, BUYER, 20000n, `chainaim refund ${invoiceId}`], "then the refund");
    assert.equal(double.state.token.balances.get(BUYER), START, "the buyer has every unit back");
    assert.equal(double.state.token.balances.get(PAY_TO), 0n);
    assert.deepEqual([body.refund.status, body.refund.paidTx, body.refund.refundTx, body.refund.payer, body.refund.jobId, body.refund.reason], ["refunded", paid.txHash, refund.txHash, BUYER, jobId, "over_estimate"]);
    assert.equal(verifyRefund(body.refund, receiptPem).ok, true, "the buyer verifies the record with the pinned receipt key");
    const got = await fetch(`${paywall.url}/v1/refunds/${invoiceId}`);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).refundTx, refund.txHash);
  });

  it("ARCH-671: a good run is delivered and nothing is refunded; a refund asked for it with a wrong amount is refused by the chain check", async () => {
    consoleState.runStatus = 200;
    const before = double.state.transfers.length;
    const { r, jobId, invoiceId } = await payOffer("15000");
    assert.equal(r.status, 200);
    assert.equal(double.state.transfers.length, before + 1, "one payment, no refund");
    const paid = double.state.transfers.at(-1)!;
    const forged = await fetch(`${signerUrl}/v1/refunds`, { method: "POST", headers: { "content-type": "application/json", "x-signer-key": SIGNER_KEY }, body: JSON.stringify({ invoiceId, jobId, paidTx: paid.txHash, network: "near:testnet", amountUnits: "99999", reason: "owner" }) });
    assert.equal(forged.status, 409);
    assert.match((await forged.json()).error.message, /amountUnits is not the amount paidTx transferred/);
    const noKey = await fetch(`${signerUrl}/v1/refunds/${invoiceId}`);
    assert.equal(noKey.status, 401);
    assert.equal(double.state.transfers.length, before + 1, "nothing moved");
    assert.equal(signerOut.join("").includes(SIGNER_KEY), false);
    assert.equal(signerOut.join("").includes(payToKey.toString()), false);
  });
});

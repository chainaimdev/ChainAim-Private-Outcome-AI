import { test } from "node:test";
import assert from "node:assert/strict";
import type { EnvSpec, Registry } from "../../../packages/chain-contracts/src/index.ts";
import { assetText, xrplAdapter } from "../src/adapters/xrpl.ts";
import { nearAdapter } from "../src/adapters/near.ts";
import { RpcError, type Rpc } from "../src/adapters/rpc.ts";
import { chainsSummary, query } from "../src/core.ts";

/** A fake RPC: records every call and answers from a function. */
function fake(answer: (url: string, body: any) => any): { rpc: Rpc; calls: { url: string; body: any }[] } {
  const calls: { url: string; body: any }[] = [];
  return { calls, rpc: async (url, body) => { calls.push({ url, body }); return answer(url, body); } };
}
const xrplEnv: EnvSpec = { rpc: { http: "https://lend.example/" }, capabilities: ["payments", "vaults", "loans"], sources: [] };

test("xrpl vaults: by ID and by owner, filtered by LedgerEntryType, paged with marker", async () => {
  const { rpc, calls } = fake((_u, b) => {
    const p = b.params[0];
    if (b.method === "ledger_entry") return { result: { status: "success", node: { index: p.index, LedgerEntryType: "Vault", Owner: "rOwner1", Asset: { currency: "XRP" }, AssetsAvailable: "500", AssetsTotal: "800", AssetsMaximum: "1000", VaultKind: 1 } } };
    if (b.method === "account_objects" && !p.marker) return { result: { status: "success", marker: "m1", account_objects: [{ index: "V2", LedgerEntryType: "Vault", Owner: p.account, Asset: { currency: "USD", issuer: "rIss" }, AssetsAvailable: { value: "12.5" } }, { index: "T1", LedgerEntryType: "RippleState" }] } };
    if (b.method === "account_objects") return { result: { status: "success", account_objects: [{ index: "V3", LedgerEntryType: "Vault", Owner: p.account, Asset: { mpt_issuance_id: "00AB" } }] } };
    throw new Error("unexpected " + b.method);
  });
  const rows = await xrplAdapter(rpc, 1000).vaults({ chain: "xrpl", env: "lending-devnet", spec: xrplEnv }, { id: "ledger", kind: "native", vaultIds: ["V1"], vaultOwners: ["rOwner2"] });
  assert.deepEqual(rows.map((r) => [r.vaultId, r.asset, r.available]), [["V1", "XRP", "500"], ["V2", "USD.rIss", "12.5"], ["V3", "MPT 00AB", null]]);
  assert.equal(calls.filter((c) => c.body.method === "account_objects").length, 2);
  assert.equal(calls[0].body.params[0].ledger_index, "validated");
});

test("xrpl loan terms come from loan brokers; rates are 1/10 bp shown as percent; per-loan terms stay empty", async () => {
  const { rpc } = fake((_u, b) => {
    const p = b.params[0];
    if (b.method === "ledger_entry" && p.index === "B1") return { result: { status: "success", node: { index: "B1", LedgerEntryType: "LoanBroker", Owner: "rLender", VaultID: "V9", ManagementFeeRate: 1000, CoverRateMinimum: 10000, DebtMaximum: "5000", DebtTotal: "1000" } } };
    if (b.method === "ledger_entry" && p.index === "V9") return { result: { status: "success", node: { index: "V9", Asset: { currency: "XRP" }, AssetsAvailable: "4000", VaultKind: 1 } } };
    throw new Error("unexpected");
  });
  const [r] = await xrplAdapter(rpc, 1000).loanTerms({ chain: "xrpl", env: "lending-devnet", spec: xrplEnv }, { id: "ledger", kind: "native", loanBrokerIds: ["B1"] });
  assert.equal(r.lender, "rLender"); assert.equal(r.available, "4000");
  assert.match(r.structure!, /closed-ended vault \(XRP\)/);
  assert.equal(r.annualRate, null); assert.equal(r.termMonths, null);
  assert.equal(r.extra!.managementFeeRatePercent, "1"); assert.equal(r.extra!.coverRateMinimumPercent, "10");
});

test("xrpl refuses an environment without the capability, and a source with placeholders", async () => {
  const a = xrplAdapter(async () => { throw new Error("no call expected"); }, 1000);
  await assert.rejects(a.vaults({ chain: "xrpl", env: "testnet", spec: { ...xrplEnv, capabilities: ["payments"] } }, { id: "ledger", kind: "native" }), /not enabled on xrpl testnet/);
  await assert.rejects(a.vaults({ chain: "xrpl", env: "lending-devnet", spec: xrplEnv }, { id: "ledger", kind: "native", vaultOwners: ["<PLACEHOLDER: r...>"] }), /not configured yet: vaultOwners\[0\]/);
});

test("xrpl RPC errors carry the server's message", async () => {
  const { rpc } = fake(() => ({ result: { status: "error", error: "actNotFound", error_message: "Account not found." } }));
  await assert.rejects(xrplAdapter(rpc, 1000).vaults({ chain: "xrpl", env: "x", spec: xrplEnv }, { id: "ledger", kind: "native", vaultOwners: ["rNobody"] }), /account_objects: Account not found/);
});

const nearEnv: EnvSpec = { rpc: { http: "https://primary.example", fallbacks: ["https://backup.example"] }, capabilities: ["vaults", "loans"], sources: [] };
const nearSource = { id: "own", kind: "own" as const, contract: "lend.testnet", methods: {
  loanTerms: { view: "get_terms", args: { from: 0 }, list: "$", map: { lender: "$.lender", annualRate: "$.rate_bps", termMonths: "$.months", extraField: "$.note" }, units: { annualRate: { bpsToPercent: true } } } } };

test("near: call_function with base64 args, bytes decoded as UTF-8 JSON, fallback on a retryable failure", async () => {
  const bytes = [...Buffer.from(JSON.stringify([{ lender: "bank.testnet", rate_bps: 950, months: 24, note: "secured" }]))];
  const { rpc, calls } = fake((url) => { if (url.includes("primary")) throw new RpcError("primary down", true); return { jsonrpc: "2.0", result: { result: bytes } }; });
  const rows = await nearAdapter(rpc, 1000).loanTerms({ chain: "near", env: "testnet", spec: nearEnv }, nearSource);
  assert.deepEqual(rows[0], { chain: "near", env: "testnet", source: "own", lender: "bank.testnet", available: null, structure: null, termMonths: "24", annualRate: "9.5", graceDays: null, lateFee: null, extra: { extraField: "secured" } });
  const q = calls[1].body;
  assert.equal(q.method, "query"); assert.equal(q.params.request_type, "call_function"); assert.equal(q.params.finality, "final");
  assert.equal(q.params.account_id, "lend.testnet"); assert.equal(q.params.method_name, "get_terms");
  assert.deepEqual(JSON.parse(Buffer.from(q.params.args_base64, "base64").toString("utf8")), { from: 0 });
  assert.ok(!Array.isArray(q), "one request object per POST, never a batch");
});

test("near: placeholders are refused with the missing fields; JSON-RPC errors are reported", async () => {
  const a = nearAdapter(async () => ({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "x.testnet" } } } }), 1000);
  await assert.rejects(a.vaults({ chain: "near", env: "testnet", spec: nearEnv }, { id: "own", kind: "own", contract: "<PLACEHOLDER: id>" }), /not configured yet: contract/);
  await assert.rejects(a.loanTerms({ chain: "near", env: "testnet", spec: nearEnv }, nearSource), /UNKNOWN_ACCOUNT/);
});

test("core: one failing source never hides another; summary marks placeholder sources", async () => {
  const reg: Registry = { version: 1, chains: { near: { label: "NEAR", adapter: "near", addressRule: "near-account", environments: { testnet: { ...nearEnv, sources: [
    { id: "own", kind: "own", contract: "<PLACEHOLDER: c>" }, nearSource as any] } } } } };
  const bytes = [...Buffer.from("[]")];
  const out = await query(reg, { near: nearAdapter(async () => ({ result: { result: bytes } }), 1000) }, "loan-terms", "near", "testnet");
  assert.match(out.results[0].error!, /not configured yet/);
  assert.deepEqual(out.results[1], { source: "own", rows: [] });
  const s = chainsSummary(reg, { chain: "near", env: "testnet" });
  assert.deepEqual(s.selected, { chain: "near", env: "testnet" });
  assert.equal(s.chains[0].environments[0].sources[0].ready, false);
  assert.deepEqual(s.chains[0].environments[0].sources[0].missing, ["contract"]);
});

test("xrpl nonstandard currency codes are shown as text", () => {
  assert.equal(assetText({ currency: "5455534400000000000000000000000000000000", issuer: "rBPci" }), "TUSD.rBPci");
  assert.equal(assetText({ currency: "0158415500000000C1F76FF6ECB0BAC600000000", issuer: "rX" }), "0158415500000000C1F76FF6ECB0BAC600000000.rX");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { applyUnit, hasPlaceholder, jsonPath, loadRegistry, mapItems, maskValue, parseRegistry, placeholderPaths, RegistryError, shiftDecimals, toCsv, validAddress } from "../src/index.ts";

test("shiftDecimals scales exactly, without floating point", () => {
  assert.equal(shiftDecimals("12000", 3), "12");
  assert.equal(shiftDecimals("12500", 3), "12.5");
  assert.equal(shiftDecimals("5", 2), "0.05");
  assert.equal(shiftDecimals("100", 0), "100");
  assert.equal(shiftDecimals("1000000000000000000000001", 24), "1.000000000000000000000001");
  assert.equal(shiftDecimals("-150", 2), "-1.5");
  assert.equal(shiftDecimals("0", 6), "0");
  assert.equal(shiftDecimals("12.5", 1), "1.25");
  assert.throws(() => shiftDecimals("1e5", 2), RegistryError);
});

test("jsonPath reads dotted, indexed and quoted steps; missing steps are undefined", () => {
  const v = { a: { b: [{ c: 7 }], "d e": "x" } };
  assert.equal(jsonPath(v, "$.a.b[0].c"), 7);
  assert.equal(jsonPath(v, "$.a['d e']"), "x");
  assert.equal(jsonPath(v, "$.a.zz.c"), undefined);
  assert.deepEqual(jsonPath(v, "$"), v);
  assert.throws(() => jsonPath(v, "a.b"), RegistryError);
  assert.throws(() => jsonPath(v, "$.a[*]"), RegistryError);
});

test("mapItems maps each item and applies unit rules (bps, 1/10 bps, decimals, decimalsFrom)", () => {
  const result = { terms: [{ lender: "bank.testnet", rate: 1250, fee: 500, amount: "2500000", dec: 6, nested: { m: 12 } }] };
  const rows = mapItems(result, { view: "get_terms", list: "$.terms",
    map: { lender: "$.lender", annualRate: "$.rate", lateFee: "$.fee", available: "$.amount", termMonths: "$.nested.m", missing: "$.nope" },
    units: { annualRate: { bpsToPercent: true }, lateFee: { tenthBpsToPercent: true }, available: { decimalsFrom: "$.dec" } } });
  assert.deepEqual(rows, [{ lender: "bank.testnet", annualRate: "12.5", lateFee: "0.5", available: "2.5", termMonths: "12", missing: null }]);
  assert.throws(() => mapItems({ terms: 3 }, { view: "v", list: "$.terms", map: {} }), RegistryError);
  assert.equal(applyUnit("7", undefined, {}), "7");
  assert.throws(() => applyUnit("7", "<PLACEHOLDER: x>", {}), RegistryError);
});

test("placeholders are found with their paths", () => {
  const s = { id: "x", contract: "<PLACEHOLDER: id>", methods: { vaults: { view: "<PLACEHOLDER>", map: { a: "$.a" } } } };
  assert.equal(hasPlaceholder(s), true);
  assert.deepEqual(placeholderPaths(s), ["contract", "methods.vaults.view"]);
  assert.equal(hasPlaceholder({ id: "x" }), false);
});

test("address rules and masking", () => {
  assert.equal(validAddress("xrpl-classic", "rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej"), true);
  assert.equal(validAddress("xrpl-classic", "rYOUR_TESTNET_ADDRESS"), false);
  assert.equal(validAddress("near-account", "chainaim.testnet"), true);
  assert.equal(validAddress("near-account", "Bad..Name"), false);
  assert.equal(maskValue("rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej"), "rn5h...gBej");
});

test("the committed registry parses, and its NEAR sources are still placeholders", () => {
  const reg = loadRegistry(fileURLToPath(new URL("../../../config/chains/networks.json", import.meta.url)));
  assert.deepEqual(Object.keys(reg.chains).sort(), ["near", "xrpl"]);
  assert.deepEqual(Object.keys(reg.chains.xrpl.environments), ["testnet", "devnet", "lending-devnet", "mainnet"]);
  assert.deepEqual(reg.chains.xrpl.environments.devnet.capabilities, ["payments", "vaults", "loans"]);
  assert.ok(reg.chains.near.environments.testnet.sources.every((s) => hasPlaceholder(s)));
});

test("parseRegistry refuses bad shapes", () => {
  assert.throws(() => parseRegistry({ version: 2 }), /version/);
  assert.throws(() => parseRegistry({ version: 1, x: { adapter: "a", environments: { t: { rpc: {}, capabilities: [], sources: [] } } } }), /rpc/);
  assert.throws(() => parseRegistry({ version: 1, x: { adapter: "a", environments: { t: { rpc: { http: "h" }, capabilities: ["fly"], sources: [] } } } }), /capabilities/);
  assert.throws(() => parseRegistry({ version: 1 }), /no chains/);
});

test("toCsv quotes and leaves out extra", () => {
  assert.equal(toCsv([{ a: "x,y", b: null, extra: { z: 1 } }]), 'a,b\r\n"x,y",\r\n');
});

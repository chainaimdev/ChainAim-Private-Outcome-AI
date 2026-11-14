import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/data.ts";
import { authorize, loadTenants } from "../src/tenants.ts";
import { JUPITER_LEI, TENANTS, TOMMY_LEI } from "./helpers.ts";

const reg = loadTenants(TENANTS);
const env = { QUOTE_TOKEN_JUPITER: "jupiter-token-a1", QUOTE_TOKEN_TOMMY: "tommy-token-b2" };
const h = (token: string, alias: string, lei: string) => ({ authorization: `Bearer ${token}`, "x-agent-alias": alias, "x-agent-lei": lei });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError, String(e));
    return `${e.status} ${e.code}`;
  }
  return "allowed";
};

test("ARCH-730 the registry holds both tenants with their LEIs and token variable names", () => {
  assert.deepEqual(Object.keys(reg), ["jupiter-knitting", "tommy-hilfiger-europe"]);
  assert.equal(reg["jupiter-knitting"]!.lei, JUPITER_LEI);
  assert.equal(reg["tommy-hilfiger-europe"]!.tokenEnv, "QUOTE_TOKEN_TOMMY");
  assert.deepEqual(reg["jupiter-knitting"]!.agents.jupiterCeoAgent, ["seller/synthesize"]);
});

test("ARCH-730 the right token, alias, path and LEI are allowed", () => {
  const c = authorize(reg, env, "jupiter-knitting", "agents/inventory", h("jupiter-token-a1", "JupiterInventoryAgent", JUPITER_LEI));
  assert.equal(c.alias, "JupiterInventoryAgent");
  assert.equal(c.tenant.id, "jupiter-knitting");
});

test("ARCH-730 a wrong or missing token is 401", () => {
  assert.equal(code(() => authorize(reg, env, "jupiter-knitting", "agents/inventory", h("nope", "JupiterInventoryAgent", JUPITER_LEI))), "401 bad_token");
  assert.equal(code(() => authorize(reg, env, "jupiter-knitting", "agents/inventory", { "x-agent-alias": "JupiterInventoryAgent", "x-agent-lei": JUPITER_LEI })), "401 no_token");
  assert.equal(code(() => authorize(reg, {}, "jupiter-knitting", "agents/inventory", h("jupiter-token-a1", "JupiterInventoryAgent", JUPITER_LEI))), "401 bad_token");
});

test("ARCH-730 an alias not allowed on the path, an unknown alias and a LEI mismatch are 403", () => {
  assert.equal(code(() => authorize(reg, env, "jupiter-knitting", "agents/treasury", h("jupiter-token-a1", "JupiterInventoryAgent", JUPITER_LEI))), "403 path_not_allowed");
  assert.equal(code(() => authorize(reg, env, "jupiter-knitting", "agents/inventory", h("jupiter-token-a1", "someoneElse", JUPITER_LEI))), "403 unknown_alias");
  assert.equal(code(() => authorize(reg, env, "jupiter-knitting", "agents/inventory", h("jupiter-token-a1", "JupiterInventoryAgent", TOMMY_LEI))), "403 lei_mismatch");
});

test("ARCH-730 Jupiter's token on the Tommy tenant is 403, and an unknown tenant is 404", () => {
  assert.equal(code(() => authorize(reg, env, "tommy-hilfiger-europe", "agents/treasury", h("jupiter-token-a1", "TommyTreasuryAgent", TOMMY_LEI))), "403 wrong_tenant");
  assert.equal(code(() => authorize(reg, env, "jupiter-knitting", "agents/inventory", h("tommy-token-b2", "JupiterInventoryAgent", JUPITER_LEI))), "403 wrong_tenant");
  assert.equal(code(() => authorize(reg, env, "acme", "agents/inventory", h("jupiter-token-a1", "JupiterInventoryAgent", JUPITER_LEI))), "404 unknown_tenant");
});

/**
 * quote-agents (privateAI-design-44 §3.3, §4): the tenant registry and the caller check.
 * Each call carries Authorization: Bearer <tenant token>, X-Agent-Alias and X-Agent-LEI. The token is compared in
 * constant time with the value of the tenant's tokenEnv variable (the name is in config/quote-tenants.json; the value
 * never is). Order: unknown tenant 404, token of another tenant 403, no matching token 401, alias not allowed on the
 * path 403, LEI mismatch 403.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { ApiError } from "./data.ts";

export type Tenant = { id: string; lei: string; dataDir: string; tokenEnv: string; rigTenant?: string; agents: Record<string, string[]> };
export type Registry = Record<string, Tenant>;

const LEI = /^[A-Z0-9]{18}[0-9]{2}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Load and check config/quote-tenants.json. Throws an Error naming the tenant and field. */
export function loadTenants(path: string): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`--tenants ${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`--tenants ${path}: an object of tenants is required`);
  const out: Registry = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = v as Record<string, unknown>;
    const where = `--tenants ${path}: ${id}`;
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`${where}: tenant ids are lower-case letters, digits and -`);
    if (typeof t?.lei !== "string" || !LEI.test(t.lei)) throw new Error(`${where}.lei must be a 20-character LEI`);
    if (typeof t.dataDir !== "string" || !/^[a-z0-9-]{1,64}$/.test(t.dataDir)) throw new Error(`${where}.dataDir must be a folder name`);
    if (typeof t.tokenEnv !== "string" || !ENV_NAME.test(t.tokenEnv)) throw new Error(`${where}.tokenEnv must be an environment variable NAME`);
    if (typeof t.agents !== "object" || t.agents === null) throw new Error(`${where}.agents must be an object`);
    const agents: Record<string, string[]> = {};
    for (const [alias, paths] of Object.entries(t.agents as Record<string, unknown>)) {
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p)) throw new Error(`${where}.agents.${alias} must list paths`);
      agents[alias] = paths as string[];
    }
    out[id] = { id, lei: t.lei, dataDir: t.dataDir, tokenEnv: t.tokenEnv, ...(typeof t.rigTenant === "string" ? { rigTenant: t.rigTenant } : {}), agents };
  }
  if (!Object.keys(out).length) throw new Error(`--tenants ${path}: no tenant`);
  return out;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** Constant-time string equality (both sides hashed first, so the lengths match). */
export const sameSecret = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export type Caller = { tenant: Tenant; alias: string };

/**
 * Check one call against the registry. `path` is the part after /v1/tenants/<id>/, e.g. "agents/inventory".
 * Throws ApiError 404/401/403; returns the tenant and alias when allowed.
 */
export function authorize(reg: Registry, env: NodeJS.ProcessEnv, tenantId: string, path: string, headers: Record<string, string | string[] | undefined>): Caller {
  const tenant = reg[tenantId];
  if (!tenant) throw new ApiError(404, "unknown_tenant", `no tenant ${tenantId}`);
  const auth = typeof headers.authorization === "string" ? headers.authorization : "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) throw new ApiError(401, "no_token", "Authorization: Bearer <tenant token> is required");
  const token = m[1]!;
  const expected = env[tenant.tokenEnv]?.trim();
  if (!expected || !sameSecret(token, expected)) {
    const other = Object.values(reg).some((t) => t.id !== tenant.id && !!env[t.tokenEnv]?.trim() && sameSecret(token, env[t.tokenEnv]!.trim()));
    if (other) throw new ApiError(403, "wrong_tenant", `this token belongs to another tenant, not ${tenant.id}`);
    throw new ApiError(401, "bad_token", expected ? "the token is not valid" : `${tenant.id} has no token configured (${tenant.tokenEnv} is not set)`);
  }
  const alias = typeof headers["x-agent-alias"] === "string" ? headers["x-agent-alias"] : "";
  const allowed = tenant.agents[alias];
  if (!allowed) throw new ApiError(403, "unknown_alias", `X-Agent-Alias ${alias || "(missing)"} is not an agent of ${tenant.id}`);
  if (!allowed.includes(path)) throw new ApiError(403, "path_not_allowed", `${alias} may not call ${path}`);
  const lei = typeof headers["x-agent-lei"] === "string" ? headers["x-agent-lei"] : "";
  if (lei !== tenant.lei) throw new ApiError(403, "lei_mismatch", `X-Agent-LEI does not match ${tenant.id}`);
  return { tenant, alias };
}

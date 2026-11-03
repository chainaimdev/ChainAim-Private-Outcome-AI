/**
 * NEAR adapter: vaults and loan terms read from contract view methods named in the registry (read-only call_function queries,
 * docs.near.org/api/rpc/contracts), mapped to the common rows by JSON paths and explicit unit rules. Nothing about a contract is
 * hard-coded here: a source whose contract, method or mapping is still a <PLACEHOLDER> is refused with the list of missing fields.
 */
import { hasPlaceholder, mapItems, placeholderPaths, type LoanTermRow, type MethodSpec, type SourceSpec, type VaultRow } from "../../../../packages/chain-contracts/src/index.ts";
import { firstAnswer, type Rpc } from "./rpc.ts";
import type { ChainAdapter, Ctx } from "./types.ts";

const VAULT_FIELDS = ["vaultId", "owner", "asset", "available", "total", "maximum"] as const;
const TERM_FIELDS = ["lender", "available", "structure", "termMonths", "annualRate", "graceDays", "lateFee"] as const;

export function nearAdapter(rpc: Rpc, timeoutMs: number): ChainAdapter {
  const urls = (ctx: Ctx) => [ctx.spec.rpc.http, ...(ctx.spec.rpc.fallbacks ?? [])].filter((u): u is string => typeof u === "string" && !hasPlaceholder(u));
  async function call(ctx: Ctx, method: string, params: unknown): Promise<any> {
    const u = urls(ctx);
    if (!u.length) throw new Error(`${ctx.chain}.${ctx.env} has no rpc.http endpoint`);
    // one JSON-RPC object per POST: nearcore rejects batches
    const j = await firstAnswer(rpc, u, { jsonrpc: "2.0", id: "chain-query", method, params }, timeoutMs);
    if (j?.error) throw new Error(`${method}: ${j.error.cause?.name ?? j.error.name ?? ""} ${j.error.cause?.info ? JSON.stringify(j.error.cause.info) : j.error.message ?? ""}`.trim());
    if (j?.result === undefined) throw new Error(`${method}: no result`);
    return j.result;
  }
  async function view(ctx: Ctx, contract: string, spec: MethodSpec): Promise<unknown> {
    const r = await call(ctx, "query", { request_type: "call_function", finality: "final", account_id: contract, method_name: spec.view,
      args_base64: Buffer.from(JSON.stringify(spec.args ?? {}), "utf8").toString("base64") });
    if (r.error) throw new Error(`${contract}.${spec.view}: ${r.error}`);
    if (!Array.isArray(r.result)) throw new Error(`${contract}.${spec.view}: the result holds no bytes`);
    const s = Buffer.from(r.result).toString("utf8");
    try { return JSON.parse(s); } catch { throw new Error(`${contract}.${spec.view}: the result is not JSON`); }
  }
  function ready(ctx: Ctx, cap: "vaults" | "loans", source: SourceSpec, key: "vaults" | "loanTerms"): { contract: string; spec: MethodSpec } {
    if (!ctx.spec.capabilities.includes(cap)) throw new Error(`${cap} are not enabled on ${ctx.chain} ${ctx.env}`);
    const spec = source.methods?.[key];
    const missing = placeholderPaths({ id: source.id, contract: source.contract, [key]: spec });
    if (missing.length) throw new Error(`source ${source.id} is not configured yet: ${missing.join(", ")}`);
    if (!source.contract) throw new Error(`source ${source.id} has no contract`);
    if (!spec) throw new Error(`source ${source.id} has no methods.${key}`);
    return { contract: source.contract, spec };
  }
  const pick = <K extends string>(r: Record<string, string | null>, keys: readonly K[]) => {
    const out = {} as Record<K, string | null>; for (const k of keys) out[k] = r[k] ?? null;
    const extra: Record<string, string | null> = {}; for (const [k, v] of Object.entries(r)) if (!(keys as readonly string[]).includes(k)) extra[k] = v;
    return { out, extra };
  };
  return {
    async ping(ctx) {
      try { const r = await call(ctx, "status", []); return { ok: true, detail: `chain ${r.chain_id ?? "?"}, nearcore ${r.version?.version ?? "?"}, block ${r.sync_info?.latest_block_height ?? "?"}` }; }
      catch (e) { return { ok: false, detail: (e as Error).message }; }
    },
    async vaults(ctx, source) {
      const { contract, spec } = ready(ctx, "vaults", source, "vaults");
      return mapItems(await view(ctx, contract, spec), spec).map((r): VaultRow => { const { out, extra } = pick(r, VAULT_FIELDS); return { chain: ctx.chain, env: ctx.env, source: source.id, ...out, extra }; });
    },
    async loanTerms(ctx, source) {
      const { contract, spec } = ready(ctx, "loans", source, "loanTerms");
      return mapItems(await view(ctx, contract, spec), spec).map((r): LoanTermRow => { const { out, extra } = pick(r, TERM_FIELDS); return { chain: ctx.chain, env: ctx.env, source: source.id, ...out, extra }; });
    },
  };
}

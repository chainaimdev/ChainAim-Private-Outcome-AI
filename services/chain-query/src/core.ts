/**
 * The service core: which adapter serves a chain, the /chains summary the UI builds its picklists from, and one query
 * across the sources of an environment (each source answers or fails on its own; one broken source never hides the others).
 */
import { findEnv, placeholderPaths, type LoanTermRow, type Registry, type SourceResult, type VaultRow } from "../../../packages/chain-contracts/src/index.ts";
import type { ChainAdapter, Ctx } from "./adapters/types.ts";

export type Adapters = Record<string, ChainAdapter>;
export type Kind = "vaults" | "loan-terms";

export function chainsSummary(reg: Registry, selected: { chain?: string; env?: string } | null) {
  return {
    selected: selected?.chain && reg.chains[selected.chain] ? { chain: selected.chain, env: selected.env ?? null } : null,
    chains: Object.entries(reg.chains).map(([id, c]) => ({
      id, label: c.label ?? id, addressRule: c.addressRule,
      environments: Object.entries(c.environments).map(([envId, e]) => ({
        id: envId, label: e.label ?? envId, capabilities: e.capabilities, explorer: placeholderPaths(e.explorer).length ? null : e.explorer ?? null,
        rpcReady: placeholderPaths(e.rpc).length === 0,
        sources: e.sources.map((s) => {
          const missing = placeholderPaths({ ...s, label: undefined, repo: undefined, docs: undefined });
          return { id: placeholderPaths(s.id).length ? "(not set)" : s.id, label: placeholderPaths(s.label).length ? "(not set yet)" : s.label ?? s.id, kind: s.kind, ready: missing.length === 0, missing };
        }),
      })),
    })),
  };
}

export async function query(reg: Registry, adapters: Adapters, kind: Kind, chain: string, env: string, sourceId?: string):
  Promise<{ chain: string; env: string; kind: Kind; results: SourceResult<VaultRow | LoanTermRow>[] }> {
  const { chain: c, env: e } = findEnv(reg, chain, env);
  const adapter = adapters[c.adapter];
  if (!adapter) throw new Error(`no adapter "${c.adapter}" for chain ${chain}`);
  const ctx: Ctx = { chain, env, spec: e };
  const sources = sourceId && sourceId !== "all" ? e.sources.filter((s) => s.id === sourceId) : e.sources;
  if (!sources.length) throw new Error(`no source "${sourceId}" on ${chain} ${env}`);
  const results = await Promise.all(sources.map(async (s): Promise<SourceResult<VaultRow | LoanTermRow>> => {
    try { return { source: s.id, rows: kind === "vaults" ? await adapter.vaults(ctx, s) : await adapter.loanTerms(ctx, s) }; }
    catch (err) { return { source: s.id, rows: [], error: (err as Error).message }; }
  }));
  return { chain, env, kind, results };
}

/** --validate: every environment's RPC answers, and every source either is complete or lists exactly what is missing. */
export async function validate(reg: Registry, adapters: Adapters, write: (line: string) => void): Promise<number> {
  let problems = 0;
  for (const [chain, c] of Object.entries(reg.chains)) {
    const adapter = adapters[c.adapter];
    for (const [env, e] of Object.entries(c.environments)) {
      const head = `${chain}.${env}`.padEnd(22);
      if (!adapter) { write(`${head} FAIL  no adapter "${c.adapter}"`); problems++; continue; }
      const p = await adapter.ping({ chain, env, spec: e });
      write(`${head} ${p.ok ? "OK  " : "FAIL"}  rpc: ${p.detail}`); if (!p.ok) problems++;
      write(`${"".padEnd(22)}       capabilities: ${e.capabilities.join(", ") || "none"}`);
      for (const s of e.sources) {
        const missing = placeholderPaths({ ...s, label: undefined, repo: undefined, docs: undefined });
        write(`${"".padEnd(22)} ${missing.length ? "TODO" : "OK  "}  source ${placeholderPaths(s.id).length ? "(id not set)" : s.id}${missing.length ? `: set ${missing.join(", ")}` : ""}`);
      }
    }
  }
  write(problems ? `${problems} environment(s) not reachable` : "every environment answered; TODO sources are placeholders to fill in config/chains/networks.json");
  return problems ? 1 : 0;
}

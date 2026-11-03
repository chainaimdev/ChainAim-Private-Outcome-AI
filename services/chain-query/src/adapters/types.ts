import type { EnvSpec, LoanTermRow, SourceSpec, VaultRow } from "../../../../packages/chain-contracts/src/index.ts";

export type Ctx = { chain: string; env: string; spec: EnvSpec };
export type Ping = { ok: boolean; detail: string };
/** What every chain adapter does. Read-only: nothing here signs or submits. */
export type ChainAdapter = {
  ping(ctx: Ctx): Promise<Ping>;
  vaults(ctx: Ctx, source: SourceSpec): Promise<VaultRow[]>;
  loanTerms(ctx: Ctx, source: SourceSpec): Promise<LoanTermRow[]>;
};

/**
 * XRP Ledger adapter: Single Asset Vaults (XLS-65) and loan brokers (XLS-66) read as native ledger entries over JSON-RPC.
 * Entries come from the source's vaultIds / loanBrokerIds (ledger_entry by ID, as CreditSeal services/lending/src/ledger.ts
 * does) and from the Vault / LoanBroker entries owned by vaultOwners (account_objects, filtered here by LedgerEntryType, so no
 * server-side type filter is assumed). Rates on the ledger are 1/10 basis points (XLS-66 §3.2.2); they are shown as percent.
 * Loan rate, term, grace period and late fees are set per loan (LoanSet), not on the broker, so a broker row leaves them empty.
 */
import { hasPlaceholder, placeholderPaths, shiftDecimals, type LoanTermRow, type SourceSpec, type VaultRow } from "../../../../packages/chain-contracts/src/index.ts";
import { firstAnswer, type Rpc } from "./rpc.ts";
import type { ChainAdapter, Ctx } from "./types.ts";

const MAX_PAGES = 20;
const text = (v: unknown): string | null => v === undefined || v === null ? null : typeof v === "object" ? String((v as { value?: unknown }).value ?? JSON.stringify(v)) : String(v);
/** A 40-hex nonstandard currency code (e.g. 5455534400...) as its ASCII text ("TUSD") when it is printable; otherwise unchanged. */
export function currencyText(code: string): string {
  if (!/^[0-9A-Fa-f]{40}$/.test(code) || code.startsWith("00")) return code;
  const t = Buffer.from(code, "hex").toString("latin1").replace(/\0+$/, "");
  return /^[\x20-\x7E]+$/.test(t) ? t : code;
}
export function assetText(a: any): string | null {
  if (!a) return null;
  if (typeof a === "string") return a;
  if (a.mpt_issuance_id) return `MPT ${a.mpt_issuance_id}`;
  if (a.currency === "XRP" && !a.issuer) return "XRP";
  const cur = typeof a.currency === "string" ? currencyText(a.currency) : a.currency;
  return a.issuer ? `${cur}.${a.issuer}` : String(cur ?? JSON.stringify(a));
}
const tenthBpsPercent = (v: unknown): string | null => (v === undefined || v === null ? null : shiftDecimals(String(v), 3));

export function xrplAdapter(rpc: Rpc, timeoutMs: number): ChainAdapter {
  const urls = (ctx: Ctx) => [ctx.spec.rpc.http, ...(ctx.spec.rpc.fallbacks ?? [])].filter((u): u is string => typeof u === "string" && !hasPlaceholder(u));
  async function call(ctx: Ctx, method: string, params: Record<string, unknown>): Promise<any> {
    const u = urls(ctx);
    if (!u.length) throw new Error(`${ctx.chain}.${ctx.env} has no rpc.http endpoint`);
    const j = await firstAnswer(rpc, u, { method, params: [params] }, timeoutMs);
    const r = j?.result;
    if (!r || r.status !== "success") throw new Error(`${method}: ${r?.error_message ?? r?.error ?? "no result"}`);
    return r;
  }
  async function owned(ctx: Ctx, account: string, type: string): Promise<any[]> {
    const out: any[] = []; let marker: unknown;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await call(ctx, "account_objects", { account, ledger_index: "validated", limit: 400, ...(marker ? { marker } : {}) });
      for (const o of r.account_objects ?? []) if (o.LedgerEntryType === type) out.push(o);
      marker = r.marker; if (!marker) break;
    }
    return out;
  }
  const byId = async (ctx: Ctx, id: string) => (await call(ctx, "ledger_entry", { index: id, ledger_index: "validated" })).node;
  function need(ctx: Ctx, cap: "vaults" | "loans", source: SourceSpec): void {
    if (!ctx.spec.capabilities.includes(cap)) throw new Error(`${cap} are not enabled on ${ctx.chain} ${ctx.env} (capabilities: ${ctx.spec.capabilities.join(", ")})`);
    const missing = placeholderPaths({ vaultOwners: source.vaultOwners, vaultIds: source.vaultIds, loanBrokerIds: source.loanBrokerIds });
    if (missing.length) throw new Error(`source ${source.id} is not configured yet: ${missing.join(", ")}`);
  }
  async function vaultEntries(ctx: Ctx, source: SourceSpec): Promise<any[]> {
    const seen = new Map<string, any>();
    for (const id of source.vaultIds ?? []) { const v = await byId(ctx, id); if (v) seen.set(v.index ?? id, v); }
    for (const owner of source.vaultOwners ?? []) for (const v of await owned(ctx, owner, "Vault")) seen.set(v.index, v);
    return [...seen.values()];
  }
  const vaultRow = (ctx: Ctx, source: SourceSpec, v: any): VaultRow => ({ chain: ctx.chain, env: ctx.env, source: source.id, vaultId: v.index ?? null, owner: v.Owner ?? null,
    asset: assetText(v.Asset), available: text(v.AssetsAvailable), total: text(v.AssetsTotal), maximum: text(v.AssetsMaximum),
    extra: { vaultKind: v.VaultKind ?? 0, lossUnrealized: text(v.LossUnrealized), subscriptionDate: v.SubscriptionDate ?? null, redemptionDate: v.RedemptionDate ?? null } });
  return {
    async ping(ctx) {
      try { const r = await call(ctx, "server_info", {}); const i = r.info ?? {}; return { ok: true, detail: `xrpld ${i.build_version ?? "?"}, network ${i.network_id ?? "?"}, validated ledger ${i.validated_ledger?.seq ?? "none"}` }; }
      catch (e) { return { ok: false, detail: (e as Error).message }; }
    },
    async vaults(ctx, source) {
      need(ctx, "vaults", source);
      return (await vaultEntries(ctx, source)).map((v) => vaultRow(ctx, source, v));
    },
    async loanTerms(ctx, source) {
      need(ctx, "loans", source);
      const brokers = new Map<string, any>();
      for (const id of source.loanBrokerIds ?? []) { const b = await byId(ctx, id); if (b) brokers.set(b.index ?? id, b); }
      for (const owner of source.vaultOwners ?? []) for (const b of await owned(ctx, owner, "LoanBroker")) brokers.set(b.index, b);
      const rows: LoanTermRow[] = [];
      for (const b of brokers.values()) {
        const v = b.VaultID ? await byId(ctx, b.VaultID).catch(() => null) : null;
        rows.push({ chain: ctx.chain, env: ctx.env, source: source.id, lender: b.Owner ?? null, available: v ? text(v.AssetsAvailable) : null,
          structure: `XLS-66 fixed-term loans from a ${v?.VaultKind === 1 ? "closed-ended" : "open-ended"} vault${v ? ` (${assetText(v.Asset)})` : ""}`,
          termMonths: null, annualRate: null, graceDays: null, lateFee: null,
          extra: { loanBrokerId: b.index ?? null, vaultId: b.VaultID ?? null, debtTotal: text(b.DebtTotal), debtMaximum: text(b.DebtMaximum), coverAvailable: text(b.CoverAvailable),
            coverRateMinimumPercent: tenthBpsPercent(b.CoverRateMinimum), managementFeeRatePercent: tenthBpsPercent(b.ManagementFeeRate),
            note: "rate, term, grace period and late fees are set per loan (LoanSet), not on the broker" } });
      }
      return rows;
    },
  };
}

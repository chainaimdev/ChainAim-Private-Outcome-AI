/**
 * Deposit reconciliation (first engine of the finance/rcm/dental pack, decoupling Phase 4a; DESIGN/xrplh-24 §5.1, §8).
 * Code computes, nothing is guessed:
 *   1. ledger <-> deposit detail: exact by payment ID (Curve "Payment #<id>" / "Deposit #<id>" = deposit detail ID); the
 *      deposit amount must equal the ledger amount with the crosswalk's sign rule (Payment rows negative, Deposit rows positive).
 *   2. deposit detail -> bank: each payment method belongs to one method group (config); payments are summed per group and
 *      key (posting date, or payer + posting date for insurance EFT); a bank credit of that group matches one Curve sum of
 *      equal amount (± tolerance) whose posting date is within the group's lag window. EFT credits are tied to a payer only
 *      through the payer-alias table (bank originator -> payer code); every match says the alias row's basis.
 * Reported, never guessed: unmapped payment methods, unmatched Curve sums, unmatched bank credits of a group, ACH credits
 * whose originator has no alias, and bank credits outside every group (listed for information). Phase 4c: config knownCredits
 * names bank credits that are identified but not paired with Curve (e.g. a deposit the practice receives outside Curve); they
 * are listed with their label and basis in otherCredits and are never reported as unaliased ACH or unposted.
 */
import { readFileSync } from "node:fs";
import { type Db, ident, rows } from "../db.ts";

export type GroupRule = { key: "date" | "payer_date"; bank: { originator?: string; des?: string; kind?: string; aliasBy?: "originator" }; lagDays: [number, number];
  /** A bank credit may be a partial or over deposit of a Curve sum (batches: true); an EFT is exact or missing (false). */ partialDeposits: boolean; basis: string };
export type DiagnoseConfig = { checkMethod: string; cashMethod: string; lateFundingMethods: string[]; lateFundingMaxDays: number; watchCodes: string[] };
/** Phase 4b-3: how exceptions are written for a model. direction = sign of bank minus Curve for each cause code. */
export type EvidenceDirection = "negative" | "positive" | "neutral";
export type EvidenceConfig = { directions: Record<string, EvidenceDirection>; trailRows: number; omitDetailCodes: string[] };
/** Phase 4c: a bank credit identified by originator (and DES when given), not paired with Curve; listed for information. */
export type KnownCredit = { originator: string; des?: string; label: string; basis: string };
export type ReconcileConfig = { version: 1; methodGroups: Record<string, string>; internalMethods: string[]; groups: Record<string, GroupRule>; payerAliases: string; amountToleranceCents: number; diagnose: DiagnoseConfig; evidence?: EvidenceConfig; knownCredits?: KnownCredit[] };
export type PayerAlias = { payer_code: string; payer_name: string; bank_originator: string; method: string; basis: string; owner_confirmed: string };

/** Reads and checks the config; paths inside it are relative to configRoot. */
export function readReconcileConfig(path: string, configRoot: string): { cfg: ReconcileConfig; aliases: PayerAlias[] } {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as ReconcileConfig;
  const bad = (m: string): never => { throw new Error(`${path}: ${m}`); };
  if (cfg.version !== 1) bad("version must be 1");
  for (const [m, g] of Object.entries(cfg.methodGroups ?? {})) if (!cfg.groups?.[g]) bad(`method ${m} names unknown group ${g}`);
  for (const [g, r] of Object.entries(cfg.groups ?? {})) {
    if (r.key !== "date" && r.key !== "payer_date") bad(`group ${g}: key must be date or payer_date`);
    if (!Array.isArray(r.lagDays) || r.lagDays.length !== 2 || !(r.lagDays[0] <= r.lagDays[1])) bad(`group ${g}: lagDays must be [min, max]`);
    if (r.key === "payer_date" && r.bank.aliasBy !== "originator") bad(`group ${g}: a payer_date group needs bank.aliasBy "originator"`);
    if (typeof r.partialDeposits !== "boolean") bad(`group ${g}: partialDeposits must be true or false`);
  }
  if (!Number.isInteger(cfg.amountToleranceCents) || cfg.amountToleranceCents < 0) bad("amountToleranceCents must be a non-negative integer");
  if (cfg.knownCredits !== undefined) {
    if (!Array.isArray(cfg.knownCredits)) bad("knownCredits must be a list");
    for (const [i, k] of cfg.knownCredits.entries()) if (!k || typeof k.originator !== "string" || !k.originator.trim() || (k.des !== undefined && typeof k.des !== "string")
      || typeof k.label !== "string" || !k.label.trim() || typeof k.basis !== "string" || !k.basis.trim()) bad(`knownCredits[${i}]: needs originator, label and basis (des optional)`);
  }
  const dg = cfg.diagnose;
  if (!dg || typeof dg.checkMethod !== "string" || typeof dg.cashMethod !== "string" || !Array.isArray(dg.lateFundingMethods) || !Array.isArray(dg.watchCodes)
    || !Number.isInteger(dg.lateFundingMaxDays) || dg.lateFundingMaxDays < 1) bad("diagnose: checkMethod, cashMethod, lateFundingMethods, lateFundingMaxDays (>= 1) and watchCodes are required");
  const ev = cfg.evidence;
  if (ev !== undefined) {
    if (!ev || typeof ev.directions !== "object" || ev.directions === null) bad("evidence: directions (cause code -> negative | positive | neutral) is required");
    for (const [code, d] of Object.entries(ev.directions)) if (d !== "negative" && d !== "positive" && d !== "neutral") bad(`evidence: direction of ${code} must be negative, positive or neutral`);
    if (!Number.isInteger(ev.trailRows) || ev.trailRows < 0) bad("evidence: trailRows must be a non-negative integer");
    if (!Array.isArray(ev.omitDetailCodes) || ev.omitDetailCodes.some((c) => typeof c !== "string")) bad("evidence: omitDetailCodes must be a list of cause codes");
  }
  const text = readFileSync(`${configRoot}/${cfg.payerAliases}`, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const split = (l: string) => { const out: string[] = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
  const head = split(text[0]);
  for (const need of ["payer_code", "bank_originator", "basis", "owner_confirmed"]) if (!head.includes(need)) bad(`${cfg.payerAliases}: column ${need} missing`);
  const aliases = text.slice(1).filter((l) => l.trim()).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v.trim()])) as PayerAlias);
  const seen = new Set<string>();
  for (const a of aliases) { const k = a.bank_originator.toUpperCase(); if (seen.has(k)) bad(`${cfg.payerAliases}: originator ${a.bank_originator} listed twice`); seen.add(k); }
  return { cfg, aliases };
}

export type CurveGroup = { group: string; payer: string | null; date: string; cents: number; ids: string[] };
export type BankCredit = { row: number; date: string; cents: number; description: string; kind: string; originator: string | null; des: string | null; trace: string | null };
export type DepositMatch = { bankRow: number; bankDate: string; cents: number; group: string; payer: string | null; curveDate: string; lagDays: number; paymentIds: string[]; aliasBasis: string | null; aliasConfirmed: boolean | null };
export type ReconcileResult = {
  ledgerToDeposit: { checkedIds: number; matched: number; missingInLedger: string[]; missingInDeposit: string[]; amountMismatch: { id: string; depositCents: number; ledgerCents: number }[] } | null;
  depositToBank: {
    matched: DepositMatch[];
    unmatchedCurve: CurveGroup[];
    unmatchedBank: (BankCredit & { group: string; payer: string | null })[];
    unmappedMethods: { method: string; rows: number; cents: number }[];
    unaliasedAch: { row: number; date: string; cents: number; originator: string | null; des: string | null }[];
    otherCredits: { kind: string; originator: string | null; count: number; cents: number; label?: string; basis?: string }[];
  };
  totals: Record<string, { curveCents: number; matchedCents: number }>;
};

/** Payer codes compare case- and space-insensitively (owner 2026-11-03: Curve shows 'DENTAQUEST' and 'AETNA ' where the alias
 * table says 'DentaQuest'); reports keep the spelling Curve used. */
export const payerKey = (p: string | null | undefined): string => (p ?? "").trim().replace(/\s+/g, " ").toUpperCase();
export const samePayer = (a: string | null | undefined, b: string | null | undefined): boolean => payerKey(a) === payerKey(b);
export const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function depositMatch(db: Db, t: { deposit: string; bank: string; ledger: string | null }, cfg: ReconcileConfig, aliases: PayerAlias[], toleranceCents = cfg.amountToleranceCents): Promise<ReconcileResult> {
  const dep = ident(t.deposit), bank = ident(t.bank);
  const methods = Object.keys(cfg.methodGroups);
  const inList = (xs: string[]) => (xs.length ? xs.map(lit).join(", ") : "NULL");
  const groupCase = `CASE method ${methods.map((m) => `WHEN ${lit(m)} THEN ${lit(cfg.methodGroups[m])}`).join(" ")} END`;
  const keyPayer = Object.entries(cfg.groups).filter(([, r]) => r.key === "payer_date").map(([g]) => g);

  const unmappedMethods = await rows<{ method: string; rows: number; cents: number }>(db, `SELECT method, CAST(count(*) AS INTEGER) "rows", CAST(sum(cents) AS BIGINT) cents
    FROM ${dep} WHERE method NOT IN (${inList(methods)}) AND method NOT IN (${inList(cfg.internalMethods)}) GROUP BY 1 ORDER BY 1`);
  const curve = (await rows<{ grp: string; payer: string | null; d: string; cents: number; ids: string[] }>(db, `WITH p AS (SELECT ${groupCase} grp, trim(payer) AS payer,
      upper(regexp_replace(trim(payer), '\\s+', ' ', 'g')) AS pk, "date", cents, payment_id FROM ${dep} WHERE method IN (${inList(methods)})),
    q AS (SELECT grp, CASE WHEN grp IN (${inList(keyPayer)}) THEN pk END AS pk, CAST("date" AS VARCHAR) AS d, min(payer) AS payer, CAST(sum(cents) AS BIGINT) AS cents,
      list(DISTINCT payment_id ORDER BY payment_id) AS ids FROM p GROUP BY 1, 2, 3)
    SELECT grp, CASE WHEN pk IS NULL THEN NULL ELSE payer END AS payer, d, cents, ids FROM q ORDER BY d, grp, pk`)).map((r) => ({ group: r.grp, payer: r.payer, date: r.d, cents: Number(r.cents), ids: [...r.ids] }));
  const credits = (await rows<BankCredit & { d: string }>(db, `SELECT "row", CAST("date" AS VARCHAR) d, cents, description, kind, originator, des, trace FROM ${bank} WHERE cents > 0 ORDER BY "date", "row"`))
    .map((r) => ({ ...r, date: r.d, cents: Number(r.cents) }));

  const alias = new Map(aliases.map((a) => [a.bank_originator.toUpperCase(), a]));
  const groupOf = (c: BankCredit): { group: string; payer: string | null; alias: PayerAlias | null } | null => {
    for (const [g, r] of Object.entries(cfg.groups)) {
      const b = r.bank;
      if (b.kind && c.kind !== b.kind) continue;
      if (b.originator && (c.originator ?? "").toUpperCase() !== b.originator.toUpperCase()) continue;
      if (b.des && (c.des ?? "").toUpperCase() !== b.des.toUpperCase()) continue;
      if (b.aliasBy === "originator") { const a = alias.get((c.originator ?? "").toUpperCase()); if (!a) continue; return { group: g, payer: a.payer_code, alias: a }; }
      return { group: g, payer: null, alias: null };
    }
    return null;
  };

  const used = new Set<CurveGroup>();
  const matched: DepositMatch[] = [], unmatchedBank: ReconcileResult["depositToBank"]["unmatchedBank"] = [];
  const unaliasedAch: ReconcileResult["depositToBank"]["unaliasedAch"] = [];
  const other = new Map<string, ReconcileResult["depositToBank"]["otherCredits"][number]>();
  const known = (c: BankCredit): KnownCredit | undefined => (cfg.knownCredits ?? []).find((k) => (c.originator ?? "").toUpperCase() === k.originator.toUpperCase()
    && (k.des === undefined || (c.des ?? "").toUpperCase() === k.des.toUpperCase()));
  for (const c of credits) {
    const g = groupOf(c);
    if (!g) {
      const kc = known(c);
      if (!kc && c.kind === "ach" && Object.values(cfg.groups).some((r) => r.bank.aliasBy === "originator")) unaliasedAch.push({ row: c.row, date: c.date, cents: c.cents, originator: c.originator, des: c.des });
      const k = `${c.kind}|${c.originator ?? ""}|${kc?.label ?? ""}`;
      const o = other.get(k) ?? { kind: c.kind, originator: c.originator, count: 0, cents: 0, ...(kc ? { label: kc.label, basis: kc.basis } : {}) }; o.count++; o.cents += c.cents; other.set(k, o);
      continue;
    }
    const [lo, hi] = cfg.groups[g.group].lagDays;
    const cand = curve.filter((x) => !used.has(x) && x.group === g.group && (g.payer === null || samePayer(x.payer, g.payer)) && Math.abs(x.cents - c.cents) <= toleranceCents)
      .map((x) => ({ x, lag: days(c.date, x.date) })).filter(({ lag }) => lag >= lo && lag <= hi)
      .sort((a, b) => Math.abs(a.lag) - Math.abs(b.lag) || a.x.date.localeCompare(b.x.date) || payerKey(a.x.payer).localeCompare(payerKey(b.x.payer)));
    if (!cand.length) { unmatchedBank.push({ ...c, group: g.group, payer: g.payer }); continue; }
    const { x, lag } = cand[0]; used.add(x);
    matched.push({ bankRow: c.row, bankDate: c.date, cents: c.cents, group: g.group, payer: x.payer, curveDate: x.date, lagDays: lag, paymentIds: x.ids,
      aliasBasis: g.alias?.basis ?? null, aliasConfirmed: g.alias ? g.alias.owner_confirmed.toLowerCase() === "yes" : null });
  }
  const totals: ReconcileResult["totals"] = {};
  for (const x of curve) { const tt = (totals[x.group] ??= { curveCents: 0, matchedCents: 0 }); tt.curveCents += x.cents; if (used.has(x)) tt.matchedCents += x.cents; }

  let ledgerToDeposit: ReconcileResult["ledgerToDeposit"] = null;
  if (t.ledger) {
    const led = ident(t.ledger);
    const link = await rows<{ id: string; dc: number | null; lc: number | null }>(db, `WITH l AS (SELECT entry_id id, CAST(sum(CASE entry WHEN 'payment' THEN -cents ELSE cents END) AS BIGINT) c FROM ${led}
        WHERE entry IN ('payment', 'deposit') AND (method IS NULL OR method NOT IN (${inList(cfg.internalMethods)})) GROUP BY 1),
      d AS (SELECT payment_id id, CAST(sum(cents) AS BIGINT) c FROM ${dep} GROUP BY 1)
      SELECT coalesce(d.id, l.id) id, d.c dc, l.c lc FROM d FULL JOIN l ON d.id = l.id ORDER BY 1`);
    ledgerToDeposit = { checkedIds: link.length, matched: link.filter((r) => r.dc !== null && r.lc !== null && Number(r.dc) === Number(r.lc)).length,
      missingInLedger: link.filter((r) => r.lc === null).map((r) => r.id), missingInDeposit: link.filter((r) => r.dc === null).map((r) => r.id),
      amountMismatch: link.filter((r) => r.dc !== null && r.lc !== null && Number(r.dc) !== Number(r.lc)).map((r) => ({ id: r.id, depositCents: Number(r.dc), ledgerCents: Number(r.lc) })) };
  }
  return { ledgerToDeposit, totals, depositToBank: { matched, unmatchedCurve: curve.filter((x) => !used.has(x)), unmatchedBank, unmappedMethods: unmappedMethods.map((m) => ({ ...m, cents: Number(m.cents) })), unaliasedAch, otherCredits: [...other.values()].sort((a, b) => a.kind.localeCompare(b.kind) || (a.originator ?? "").localeCompare(b.originator ?? "")) } };
}

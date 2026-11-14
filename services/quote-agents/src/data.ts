/**
 * quote-agents (privateAI-design-44 §3.2): load and check one tenant's private data under --data-root/<dataDir>.
 * Every file is JSON; a missing or malformed field stops the service at start with the file and field named.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Product = {
  sku: string;
  family: string;
  grade: string;
  description: string;
  unitCostCents: number;
  unitsPer40HC: number;
  productionLeadDays: number;
  capacityPerCycle: number;
  productionWarehouse: string;
};
export type Lot = {
  lot: string;
  sku: string;
  warehouse: string;
  kind: "FREE" | "WIP" | "ALLOCATED";
  onHand: number;
  reserved: number;
  qcHold: number;
  readyDate: string;
  tier?: "TIER1" | "TIER2";
  allocatedTo?: string;
  replacementOk?: boolean;
};
export type Sailing = { carrier: string; mode: "SEA_STD" | "SEA_EXP"; etd: string; eta: string; ratePer40HcUsd: number };
export type Air = { carrier: string; transitDays: number; clearanceDays: number; centsPerUnit: number; maxUnits: number };
export type Customer = { id: string; name: string; creditLimitUsd: number; openReceivableUsd: number };
export type Ledger = {
  cashUsd: number;
  creditLineHeadroomUsd: number;
  receivables: { customer: string; amountUsd: number; dueDate: string }[];
  payables: { vendor: string; amountUsd: number; dueDate: string }[];
};
export type Policy = {
  targetMargin: number;
  overheadPerOrderUsd: number;
  customsDays: number;
  drayageDays: number;
  cutoffDaysBeforeEtd: number;
  qcDays: number;
  inlandDays: Record<string, number>;
  reallocPremiumPct: { TIER1: number; TIER2: number };
  reallocAuthority: { TIER1: "SALES_OFFICER" | "CEO"; TIER2: "SALES_OFFICER" | "CEO" };
  advanceLever: { minAdvancePct: number; marginRelief: number };
  liquidityWindowDays: number;
  safetyThresholdUsd: number;
  defaultCustomer: string;
  roundMargins: Record<string, number>;
};
export type TenantData = {
  products: Product[];
  lots: Lot[];
  sailings: Sailing[];
  air: Air;
  customers: Customer[];
  ledger: Ledger;
  policy: Policy;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** date + n days, both YYYY-MM-DD (UTC calendar days). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The later of two YYYY-MM-DD dates. */
export const laterOf = (a: string, b: string): string => (a >= b ? a : b);

class DataError extends Error {}
const fail = (file: string, msg: string): never => {
  throw new DataError(`${file}: ${msg}`);
};
const num = (file: string, where: string, v: unknown, min = 0): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) fail(file, `${where} must be a number >= ${min}`);
  return v as number;
};
const int = (file: string, where: string, v: unknown, min = 0): number => {
  const n = num(file, where, v, min);
  if (!Number.isInteger(n)) fail(file, `${where} must be a whole number`);
  return n;
};
const str = (file: string, where: string, v: unknown): string => {
  if (typeof v !== "string" || !v) fail(file, `${where} must be a non-empty string`);
  return v as string;
};
const date = (file: string, where: string, v: unknown): string => {
  if (!isIsoDate(v)) fail(file, `${where} must be a YYYY-MM-DD date`);
  return v as string;
};
const arr = (file: string, where: string, v: unknown): unknown[] => {
  if (!Array.isArray(v)) fail(file, `${where} must be an array`);
  return v as unknown[];
};
const obj = (file: string, where: string, v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(file, `${where} must be an object`);
  return v as Record<string, unknown>;
};

function readJson(dir: string, file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(join(dir, file), "utf8");
  } catch (e) {
    throw new DataError(`${file}: cannot read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  try {
    return obj(file, "the file", JSON.parse(text.replace(/^﻿/, "")));
  } catch (e) {
    if (e instanceof DataError) throw e;
    throw new DataError(`${file}: not JSON (${(e as Error).message})`);
  }
}

/** Load and check every file of one tenant's data folder. Throws an Error naming the file and field. */
export function loadTenantData(dir: string): TenantData {
  const P = "products.json";
  const products = arr(P, "products", readJson(dir, P).products).map((raw, i) => {
    const p = obj(P, `products[${i}]`, raw);
    return {
      sku: str(P, `products[${i}].sku`, p.sku),
      family: str(P, `products[${i}].family`, p.family),
      grade: str(P, `products[${i}].grade`, p.grade),
      description: str(P, `products[${i}].description`, p.description),
      unitCostCents: int(P, `products[${i}].unitCostCents`, p.unitCostCents, 1),
      unitsPer40HC: int(P, `products[${i}].unitsPer40HC`, p.unitsPer40HC, 1),
      productionLeadDays: int(P, `products[${i}].productionLeadDays`, p.productionLeadDays),
      capacityPerCycle: int(P, `products[${i}].capacityPerCycle`, p.capacityPerCycle),
      productionWarehouse: str(P, `products[${i}].productionWarehouse`, p.productionWarehouse),
    };
  });
  const skus = new Set(products.map((p) => p.sku));
  if (skus.size !== products.length) fail(P, "sku values must be unique");

  const L = "inventory-lots.json";
  const lots = arr(L, "lots", readJson(dir, L).lots).map((raw, i): Lot => {
    const l = obj(L, `lots[${i}]`, raw);
    const kind = l.kind;
    if (kind !== "FREE" && kind !== "WIP" && kind !== "ALLOCATED") fail(L, `lots[${i}].kind must be FREE, WIP or ALLOCATED`);
    const sku = str(L, `lots[${i}].sku`, l.sku);
    if (!skus.has(sku)) fail(L, `lots[${i}].sku ${sku} is not in products.json`);
    const lot: Lot = {
      lot: str(L, `lots[${i}].lot`, l.lot),
      sku,
      warehouse: str(L, `lots[${i}].warehouse`, l.warehouse),
      kind: kind as Lot["kind"],
      onHand: int(L, `lots[${i}].onHand`, l.onHand),
      reserved: int(L, `lots[${i}].reserved`, l.reserved),
      qcHold: int(L, `lots[${i}].qcHold`, l.qcHold),
      readyDate: date(L, `lots[${i}].readyDate`, l.readyDate),
    };
    if (kind === "ALLOCATED") {
      if (l.tier !== "TIER1" && l.tier !== "TIER2") fail(L, `lots[${i}].tier must be TIER1 or TIER2 for an ALLOCATED lot`);
      lot.tier = l.tier as "TIER1" | "TIER2";
      lot.allocatedTo = str(L, `lots[${i}].allocatedTo`, l.allocatedTo);
      if (typeof l.replacementOk !== "boolean") fail(L, `lots[${i}].replacementOk must be true or false`);
      lot.replacementOk = l.replacementOk as boolean;
    }
    return lot;
  });

  const S = "sailings.json";
  const sailings = arr(S, "sailings", readJson(dir, S).sailings).map((raw, i): Sailing => {
    const s = obj(S, `sailings[${i}]`, raw);
    if (s.mode !== "SEA_STD" && s.mode !== "SEA_EXP") fail(S, `sailings[${i}].mode must be SEA_STD or SEA_EXP`);
    const etd = date(S, `sailings[${i}].etd`, s.etd);
    const eta = date(S, `sailings[${i}].eta`, s.eta);
    if (eta < etd) fail(S, `sailings[${i}].eta is before its etd`);
    return { carrier: str(S, `sailings[${i}].carrier`, s.carrier), mode: s.mode as Sailing["mode"], etd, eta, ratePer40HcUsd: num(S, `sailings[${i}].ratePer40HcUsd`, s.ratePer40HcUsd, 0) };
  });

  const A = "air.json";
  const a = readJson(dir, A);
  const air: Air = {
    carrier: str(A, "carrier", a.carrier),
    transitDays: int(A, "transitDays", a.transitDays),
    clearanceDays: int(A, "clearanceDays", a.clearanceDays),
    centsPerUnit: int(A, "centsPerUnit", a.centsPerUnit),
    maxUnits: int(A, "maxUnits", a.maxUnits),
  };

  const C = "customers.json";
  const customers = arr(C, "customers", readJson(dir, C).customers).map((raw, i): Customer => {
    const c = obj(C, `customers[${i}]`, raw);
    return { id: str(C, `customers[${i}].id`, c.id), name: str(C, `customers[${i}].name`, c.name), creditLimitUsd: num(C, `customers[${i}].creditLimitUsd`, c.creditLimitUsd), openReceivableUsd: num(C, `customers[${i}].openReceivableUsd`, c.openReceivableUsd) };
  });

  const T = "treasury-ledger.json";
  const t = readJson(dir, T);
  const ledger: Ledger = {
    cashUsd: num(T, "cashUsd", t.cashUsd, -Infinity),
    creditLineHeadroomUsd: num(T, "creditLineHeadroomUsd", t.creditLineHeadroomUsd),
    receivables: arr(T, "receivables", t.receivables).map((raw, i) => {
      const r = obj(T, `receivables[${i}]`, raw);
      return { customer: str(T, `receivables[${i}].customer`, r.customer), amountUsd: num(T, `receivables[${i}].amountUsd`, r.amountUsd), dueDate: date(T, `receivables[${i}].dueDate`, r.dueDate) };
    }),
    payables: arr(T, "payables", t.payables).map((raw, i) => {
      const r = obj(T, `payables[${i}]`, raw);
      return { vendor: str(T, `payables[${i}].vendor`, r.vendor), amountUsd: num(T, `payables[${i}].amountUsd`, r.amountUsd), dueDate: date(T, `payables[${i}].dueDate`, r.dueDate) };
    }),
  };

  const B = "business-policy.json";
  const b = readJson(dir, B);
  const inland = obj(B, "inlandDays", b.inlandDays);
  const premium = obj(B, "reallocPremiumPct", b.reallocPremiumPct);
  const authority = obj(B, "reallocAuthority", b.reallocAuthority);
  const lever = obj(B, "advanceLever", b.advanceLever);
  const rounds = obj(B, "roundMargins", b.roundMargins);
  const authOf = (k: string) => {
    if (authority[k] !== "SALES_OFFICER" && authority[k] !== "CEO") fail(B, `reallocAuthority.${k} must be SALES_OFFICER or CEO`);
    return authority[k] as "SALES_OFFICER" | "CEO";
  };
  const margin = (where: string, v: unknown) => {
    const m = num(B, where, v);
    if (m >= 1) fail(B, `${where} must be below 1`);
    return m;
  };
  const policy: Policy = {
    targetMargin: margin("targetMargin", b.targetMargin),
    overheadPerOrderUsd: num(B, "overheadPerOrderUsd", b.overheadPerOrderUsd),
    customsDays: int(B, "customsDays", b.customsDays),
    drayageDays: int(B, "drayageDays", b.drayageDays),
    cutoffDaysBeforeEtd: int(B, "cutoffDaysBeforeEtd", b.cutoffDaysBeforeEtd),
    qcDays: int(B, "qcDays", b.qcDays),
    inlandDays: Object.fromEntries(Object.entries(inland).map(([k, v]) => [k, int(B, `inlandDays.${k}`, v)])),
    reallocPremiumPct: { TIER1: num(B, "reallocPremiumPct.TIER1", premium.TIER1), TIER2: num(B, "reallocPremiumPct.TIER2", premium.TIER2) },
    reallocAuthority: { TIER1: authOf("TIER1"), TIER2: authOf("TIER2") },
    advanceLever: { minAdvancePct: num(B, "advanceLever.minAdvancePct", lever.minAdvancePct), marginRelief: margin("advanceLever.marginRelief", lever.marginRelief) },
    liquidityWindowDays: int(B, "liquidityWindowDays", b.liquidityWindowDays),
    safetyThresholdUsd: num(B, "safetyThresholdUsd", b.safetyThresholdUsd),
    defaultCustomer: str(B, "defaultCustomer", b.defaultCustomer),
    roundMargins: Object.fromEntries(Object.entries(rounds).map(([k, v]) => [k, margin(`roundMargins.${k}`, v)])),
  };
  if (!customers.some((c) => c.id === policy.defaultCustomer)) fail(B, `defaultCustomer ${policy.defaultCustomer} is not in customers.json`);
  for (const l of lots) if (!(l.warehouse in policy.inlandDays)) fail(L, `lot ${l.lot}: warehouse ${l.warehouse} has no inlandDays in business-policy.json`);
  return { products, lots, sailings, air, customers, ledger, policy };
}

/** An answer the API turns into {error:{code, message}} with this HTTP status (design §4 error list). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Field readers for request bodies: each throws ApiError 400 naming the field. */
export const body = {
  obj(v: unknown, where = "body"): Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ApiError(400, "bad_body", `${where} must be a JSON object`);
    return v as Record<string, unknown>;
  },
  str(o: Record<string, unknown>, k: string, max = 200): string {
    const v = o[k];
    if (typeof v !== "string" || !v || v.length > max) throw new ApiError(400, "bad_body", `${k} must be a string of 1-${max} characters`);
    return v;
  },
  int(o: Record<string, unknown>, k: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ApiError(400, "bad_body", `${k} must be a whole number ${min}-${max}`);
    return v;
  },
  date(o: Record<string, unknown>, k: string): string {
    if (!isIsoDate(o[k])) throw new ApiError(400, "bad_body", `${k} must be a YYYY-MM-DD date`);
    return o[k] as string;
  },
  bool(o: Record<string, unknown>, k: string): boolean {
    if (typeof o[k] !== "boolean") throw new ApiError(400, "bad_body", `${k} must be true or false`);
    return o[k] as boolean;
  },
};

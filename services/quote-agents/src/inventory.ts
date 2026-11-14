/**
 * Inventory agent (privateAI-design-44 §4, §5 Inventory): where `qty` units of `sku` can come from by `shipBy`.
 *   available to promise (ATP) per lot = on hand - reserved - QC hold
 *   sources, in order: FREE lots -> WIP lots (by ready date) -> one production cycle (ready = as-of + lead days + QC days,
 *   at most the capacity per cycle); only what is ready on or before shipBy.
 *   reallocatable: lots allocated to other customers, ready by shipBy, TIER2 (Sales Officer) before TIER1 (CEO), each with
 *   its premium; they are offers for the caller's authority, never counted as sources.
 *   gradeAlternatives: other SKUs of the same family with a better grade and stock ready by shipBy.
 *   shortfall = qty - sum(sources).
 */
import { addDays, ApiError, body, laterOf, type TenantData } from "./data.ts";

export type Source = { lot: string; kind: "FREE" | "WIP" | "PRODUCTION"; units: number; readyDate: string; warehouse: string };
export type Reallocatable = { lot: string; units: number; tier: "TIER1" | "TIER2"; requiredAuthority: "SALES_OFFICER" | "CEO"; premiumPct: number; replacementOk: boolean; readyDate: string; warehouse: string };
export type InventoryAnswer = { sources: Source[]; reallocatable: Reallocatable[]; gradeAlternatives: { sku: string; grade: string }[]; shortfall: number };

export type InventoryRequest = { sku: string; qty: number; shipBy: string };

export function parseInventoryRequest(raw: unknown): InventoryRequest {
  const o = body.obj(raw);
  body.str(o, "requestId");
  return { sku: body.str(o, "sku", 64), qty: body.int(o, "qty", 1, 10_000_000), shipBy: body.date(o, "shipBy") };
}

export function inventory(data: TenantData, asOf: string, req: InventoryRequest): InventoryAnswer {
  const product = data.products.find((p) => p.sku === req.sku);
  if (!product) throw new ApiError(422, "unknown_sku", `no product ${req.sku}`);
  const atp = (l: { onHand: number; reserved: number; qcHold: number }) => Math.max(0, l.onHand - l.reserved - l.qcHold);
  const ready = (d: string) => laterOf(d, asOf);

  let remaining = req.qty;
  const sources: Source[] = [];
  for (const kind of ["FREE", "WIP"] as const) {
    const lots = data.lots.filter((l) => l.sku === req.sku && l.kind === kind && ready(l.readyDate) <= req.shipBy).sort((a, b) => a.readyDate.localeCompare(b.readyDate) || a.lot.localeCompare(b.lot));
    for (const l of lots) {
      if (remaining <= 0) break;
      const units = Math.min(remaining, atp(l));
      if (units <= 0) continue;
      sources.push({ lot: l.lot, kind, units, readyDate: ready(l.readyDate), warehouse: l.warehouse });
      remaining -= units;
    }
  }
  if (remaining > 0 && product.capacityPerCycle > 0) {
    const readyDate = addDays(asOf, product.productionLeadDays + data.policy.qcDays);
    if (readyDate <= req.shipBy) {
      const units = Math.min(remaining, product.capacityPerCycle);
      sources.push({ lot: `PROD-${product.sku}-${readyDate}`, kind: "PRODUCTION", units, readyDate, warehouse: product.productionWarehouse });
      remaining -= units;
    }
  }

  const tierOrder = { TIER2: 0, TIER1: 1 } as const;
  const reallocatable: Reallocatable[] = data.lots
    .filter((l) => l.sku === req.sku && l.kind === "ALLOCATED" && l.tier && ready(l.readyDate) <= req.shipBy && l.onHand - l.qcHold > 0)
    .sort((a, b) => tierOrder[a.tier!] - tierOrder[b.tier!] || a.readyDate.localeCompare(b.readyDate) || a.lot.localeCompare(b.lot))
    .map((l) => ({
      lot: l.lot,
      units: l.onHand - l.qcHold,
      tier: l.tier!,
      requiredAuthority: data.policy.reallocAuthority[l.tier!],
      premiumPct: data.policy.reallocPremiumPct[l.tier!],
      replacementOk: l.replacementOk === true,
      readyDate: ready(l.readyDate),
      warehouse: l.warehouse,
    }));

  const gradeAlternatives = data.products
    .filter((p) => p.family === product.family && p.sku !== product.sku && p.grade < product.grade)
    .filter((p) => data.lots.some((l) => l.sku === p.sku && (l.kind === "FREE" || l.kind === "WIP") && ready(l.readyDate) <= req.shipBy && atp(l) > 0))
    .sort((a, b) => a.grade.localeCompare(b.grade))
    .map((p) => ({ sku: p.sku, grade: p.grade }));

  return { sources, reallocatable, gradeAlternatives, shortfall: remaining };
}

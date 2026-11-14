/**
 * Logistics agent (privateAI-design-44 §4, §5 Logistics): how each lot reaches the buyer by `deadline`.
 *   at port   = ready date + inland days of the lot's warehouse
 *   sailing   = the first sailing of the mode whose cutoff (ETD - cutoffDaysBeforeEtd) is on or after the at-port date
 *   delivered = ETA + customs days + drayage days
 *   mode      = SEA_STD, else SEA_EXP, else AIR (only with allowAir, up to air.maxUnits for the whole order); the first
 *               that meets the deadline. None meets it: the earliest-delivered sea option, and its units count as late.
 *   freight   = containers (ceil(units / units per 40HC), per leg) x rate per 40HC; air = units x cents per unit.
 * freightCents (per leg and in total) is the order's total in US cents, an integer.
 * airOption: when allowAir is false and units are late, what air would give for the latest late lot (null otherwise).
 */
import { addDays, ApiError, body, isIsoDate, type Sailing, type TenantData } from "./data.ts";

export type LotIn = { lot: string; units: number; readyDate: string; warehouse: string };
export type Leg = { lot: string; units: number; mode: "SEA_STD" | "SEA_EXP" | "AIR"; carrier: string; etd: string; delivered: string; freightCents: number; late: boolean };
export type LogisticsAnswer = { legs: Leg[]; freightCents: number; meetsDeadline: boolean; lateUnits: number; airOption: { deliveredBy: string; centsPerUnit: number; maxUnits: number } | null };
export type LogisticsRequest = { sku: string; lots: LotIn[]; deadline: string; allowAir: boolean };

export function parseLogisticsRequest(raw: unknown): LogisticsRequest {
  const o = body.obj(raw);
  body.str(o, "requestId");
  const lots = o.lots;
  if (!Array.isArray(lots) || lots.length === 0 || lots.length > 50) throw new ApiError(400, "bad_body", "lots must be an array of 1-50 lots");
  return {
    sku: body.str(o, "sku", 64),
    deadline: body.date(o, "deadline"),
    allowAir: body.bool(o, "allowAir"),
    lots: lots.map((raw, i) => {
      const l = body.obj(raw, `lots[${i}]`);
      if (!isIsoDate(l.readyDate)) throw new ApiError(400, "bad_body", `lots[${i}].readyDate must be a YYYY-MM-DD date`);
      return { lot: body.str(l, "lot", 64), units: body.int(l, "units", 1, 10_000_000), readyDate: l.readyDate as string, warehouse: body.str(l, "warehouse", 64) };
    }),
  };
}

export function logistics(data: TenantData, req: LogisticsRequest): LogisticsAnswer {
  const product = data.products.find((p) => p.sku === req.sku);
  if (!product) throw new ApiError(422, "unknown_sku", `no product ${req.sku}`);
  const pol = data.policy;
  const delivered = (s: Sailing) => addDays(s.eta, pol.customsDays + pol.drayageDays);
  const firstSailing = (mode: Sailing["mode"], atPort: string) =>
    data.sailings.filter((s) => s.mode === mode && addDays(s.etd, -pol.cutoffDaysBeforeEtd) >= atPort).sort((a, b) => a.etd.localeCompare(b.etd) || a.ratePer40HcUsd - b.ratePer40HcUsd)[0];
  const seaLeg = (l: LotIn, s: Sailing, late: boolean): Leg => ({
    lot: l.lot, units: l.units, mode: s.mode, carrier: s.carrier, etd: s.etd, delivered: delivered(s),
    freightCents: Math.ceil(l.units / product.unitsPer40HC) * Math.round(s.ratePer40HcUsd * 100), late,
  });

  let airLeft = req.allowAir ? data.air.maxUnits : 0;
  const legs: Leg[] = [];
  const lateAtPort: string[] = [];
  for (const l of req.lots) {
    if (!(l.warehouse in pol.inlandDays)) throw new ApiError(422, "unknown_warehouse", `no inland days for warehouse ${l.warehouse}`);
    const atPort = addDays(l.readyDate, pol.inlandDays[l.warehouse]!);
    const options = (["SEA_STD", "SEA_EXP"] as const).map((m) => firstSailing(m, atPort)).filter((s): s is Sailing => !!s);
    const onTime = options.find((s) => delivered(s) <= req.deadline);
    if (onTime) {
      legs.push(seaLeg(l, onTime, false));
      continue;
    }
    const airDelivered = addDays(atPort, data.air.transitDays + data.air.clearanceDays);
    if (req.allowAir && l.units <= airLeft && airDelivered <= req.deadline) {
      airLeft -= l.units;
      legs.push({ lot: l.lot, units: l.units, mode: "AIR", carrier: data.air.carrier, etd: atPort, delivered: airDelivered, freightCents: l.units * data.air.centsPerUnit, late: false });
      continue;
    }
    const earliest = options.sort((a, b) => delivered(a).localeCompare(delivered(b)) || a.ratePer40HcUsd - b.ratePer40HcUsd)[0];
    if (!earliest) throw new ApiError(422, "no_sailing", `no sailing leaves after lot ${l.lot} reaches port on ${atPort}`);
    legs.push(seaLeg(l, earliest, true));
    lateAtPort.push(atPort);
  }
  const lateUnits = legs.filter((g) => g.late).reduce((n, g) => n + g.units, 0);
  let airOption: LogisticsAnswer["airOption"] = null;
  if (!req.allowAir && lateUnits > 0) {
    const latest = lateAtPort.sort().at(-1)!;
    airOption = { deliveredBy: addDays(latest, data.air.transitDays + data.air.clearanceDays), centsPerUnit: data.air.centsPerUnit, maxUnits: data.air.maxUnits };
  }
  return { legs, freightCents: legs.reduce((n, g) => n + g.freightCents, 0), meetsDeadline: lateUnits === 0, lateUnits, airOption };
}

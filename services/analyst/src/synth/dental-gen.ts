/**
 * TypeScript port of tools/dental-synth/gen_dental_set.py (Phase 4b-2). Same flags, same random streams in the same call
 * order, same Decimal arithmetic and the same writers, so for the same flags every CSV is byte-identical to the Python
 * script's and truth.json is equal as JSON (flags.out excluded: it records the output path). Proof:
 * tools/dental-synth/compare_port.py (Python vs this port over seeds x scenarios x flag variants) and
 * services/analyst/test/dental-synth-port.test.ts. Everything in the generated data is SYNTHETIC.
 *
 * Python semantics kept on purpose (do not "simplify"): short-circuit draws (`a and rng.random()`), arguments evaluated
 * left to right, stable sorts on tuple keys, insertion-ordered dicts (Map), value-equal Decimal sets (Dec.key()), and the
 * leak stream lrng continuing into the late extra credits.
 */
import { csvRow, csvText, type CsvField } from "./pycsv.ts";
import { Dec, decFromFloat } from "./pydecimal.ts";
import { PyRandom } from "./pyrandom.ts";

// ---------------------------------------------------------------- reference data (synthetic), copied from the Python script
export const FIRST = ["Ana", "Brian", "Carla", "Daniel", "Elena", "Frank", "Gloria", "Hector", "Irene", "James", "Karen",
  "Luis", "Maria", "Nadia", "Oscar", "Paula", "Quinn", "Rosa", "Samuel", "Tanya", "Victor", "Wendy",
  "Xavier", "Yolanda", "Zach", "Aaron", "Bianca", "Carlos", "Diana", "Edwin", "Fatima", "George",
  "Hannah", "Ivan", "Julia", "Kevin", "Linda", "Marcus", "Nina", "Omar", "Priya", "Raj", "Sofia",
  "Thomas", "Uma", "Vera", "Will", "Yusuf"];
export const LAST = ["Alvarez", "Baker", "Castillo", "Dorsey", "Ellis", "Flores", "Grant", "Hughes", "Ibarra", "Jensen",
  "Keller", "Lopez", "Morales", "Nolan", "Ortega", "Patel", "Quinlan", "Rivera", "Santos", "Turner",
  "Underwood", "Vasquez", "Walsh", "Young", "Zimmer", "Abbott", "Brennan", "Coleman", "Delgado",
  "Espinoza", "Fischer", "Gomez", "Hart", "Irving", "Jacobs", "Kim", "Larson", "Mendez", "Nguyen",
  "Osei", "Price", "Ramos", "Shah", "Torres", "Vega", "Ward"];
/** curve payer code, patient-list plan name, method, bank originator (EFT only), weight, medicaid? */
type Payer = readonly [string, string, string, string | null, number, boolean];
const PAYERS: readonly Payer[] = [
  ["MH", "MassHealth Dental", "Direct Deposit", "COMM OF MASS", 28, true],
  ["DentaQuest", "DentaQuest MassHealth", "Direct Deposit", "DENTAQUEST", 7, true],
  ["HUSKY", "HUSKY Health CTDHP", "Direct Deposit", "STATE OF CONN DSS", 7, true],
  ["DELTA DENTAL MA(COVERSME.COM)", "Delta Dental of MA PPO", "Direct Deposit", "DELTA DENTAL MA", 7, false],
  ["ANTHEM BCBS", "Anthem BCBS Dental", "Direct Deposit", "ANTHEM BLUE CROSS", 6, false],
  ["AET", "Aetna Dental PPO", "Insurance Check", null, 6, false],
  ["CCS", "CCS Dental", "Ins VCC", null, 7, false],
  ["Cigna", "Cigna Dental PPO", "Ins VCC", null, 6, false],
  ["UHC DUAL COMPLETE", "UHC Dual Complete Dental", "Ins VCC", null, 5, false],
  ["UC", "UnitedHealthcare Dental", "Ins VCC", null, 4, false],
];
const FEES = [42, 58, 75, 85, 99, 110, 120, 143, 164, 191, 227, 285, 318, 364, 418, 478, 535, 608, 729, 857,
  1187, 1460, 1600, 1937, 2144, 3200];
const EXPENSES: readonly (readonly [string, number, number])[] = [
  ["HENRY SCHEIN {md} PURCHASE 800-472-4346 NY DEBIT CARD *4410", 150, 3500],
  ["PATTERSON DENTAL {md} PURCHASE 800-328-5536 MN DEBIT CARD *4410", 120, 2800],
  ["DENTAL LAB EXPRESS {md} PURCHASE 860-555-0199 CT DEBIT CARD *4410", 200, 1800],
  ["EVERSOURCE DES:BILLPAY ID:EV{rid} INDN:{legal} CO ID:1060000000 WEB", 300, 900],
  ["COMCAST BUSINESS {md} PURCHASE 800-391-3000 PA DEBIT CARD *4410", 180, 260],
];
export const LEAKS = ["UNDEPOSITED_CHECK", "EFT_MISSING", "CARD_BATCH_SHORT", "CASH_SHORT", "REF_MISMATCH", "POSTED_TWICE", "BANK_UNPOSTED", "HFD_LAG"];
export const SCENARIOS = ["pos", "neg-all", ...LEAKS.map((c) => "neg-" + c.toLowerCase().replaceAll("_", "-"))];
const CARD = ["Visa", "Mastercard", "HFD", "Ins VCC"];
const ATM = ["Cash", "Insurance Check"];

/** The Python script's argparse namespace, keyed by its dest names (truth.json records it as "flags"). */
export interface DentalFlags {
  out: string; set_name: string; scenario: string; leak_seed: number; hfd_lag_extra_days: number; short_max: number;
  seed: number; start: string; days: number; bank_tail_days: number; patients: number; providers: number; clinic: string;
  self_pay_share: number; cash_share: number; zero_invoice_share: number; min_invoices_day: number; max_invoices_day: number;
  claim_lag_days: number; first_id: number; card_lag_days: number; card_fee_pct: number; card_fee_mode: string;
  merchant_id: string; practice_name: string; legal_name: string; opening_balance: number; rent: number; payroll: number;
  patient_name_format: string;
}
/** argparse defaults of gen_dental_set.py; `kind` says how the CLI parses the value (Python int(), float() or str). */
export const FLAG_SPEC: Readonly<Record<keyof DentalFlags, { kind: "int" | "float" | "str"; dflt?: number | string; choices?: readonly string[] }>> = {
  out: { kind: "str" }, set_name: { kind: "str", dflt: "SET1" }, scenario: { kind: "str", dflt: "pos", choices: SCENARIOS },
  leak_seed: { kind: "int", dflt: 1 }, hfd_lag_extra_days: { kind: "int", dflt: 5 }, short_max: { kind: "float", dflt: 50.0 },
  seed: { kind: "int", dflt: 1 }, start: { kind: "str", dflt: "2024-09-01" }, days: { kind: "int", dflt: 30 },
  bank_tail_days: { kind: "int", dflt: 10 }, patients: { kind: "int", dflt: 260 }, providers: { kind: "int", dflt: 4 },
  clinic: { kind: "str", dflt: "S1" }, self_pay_share: { kind: "float", dflt: 0.25 }, cash_share: { kind: "float", dflt: 0.12 },
  zero_invoice_share: { kind: "float", dflt: 0.08 }, min_invoices_day: { kind: "int", dflt: 6 }, max_invoices_day: { kind: "int", dflt: 12 },
  claim_lag_days: { kind: "int", dflt: 5 }, first_id: { kind: "int", dflt: 300001 }, card_lag_days: { kind: "int", dflt: 1 },
  card_fee_pct: { kind: "float", dflt: 2.9 }, card_fee_mode: { kind: "str", dflt: "monthly", choices: ["monthly", "daily-net"] },
  merchant_id: { kind: "str", dflt: "8700000000001" }, practice_name: { kind: "str", dflt: "MAPLE GROVE DENTAL" },
  legal_name: { kind: "str", dflt: "MGD PC" }, opening_balance: { kind: "float", dflt: 120000.0 }, rent: { kind: "float", dflt: 6200.0 },
  payroll: { kind: "float", dflt: 28000.0 },
  patient_name_format: { kind: "str", dflt: "last_first", choices: ["last_first", "first_last"] },
};
export function defaultFlags(out: string, over: Partial<DentalFlags> = {}): DentalFlags {
  const f: Record<string, unknown> = { out };
  for (const [k, s] of Object.entries(FLAG_SPEC)) if (k !== "out") f[k] = s.dflt;
  return { ...(f as unknown as DentalFlags), ...over };
}

/** The Python script's SystemExit("...") conditions; the CLI prints the message and exits 1, as Python does. */
export class GenError extends Error {}

// ---------------------------------------------------------------- dates: integer days since 1970-01-01 (datetime.date)
type Day = number;
const MS = 86400000;
const dt = (d: Day) => new Date(d * MS);
const p2 = (n: number) => String(n).padStart(2, "0");
export function fromIso(s: string): Day {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!m || Number.isNaN(t) || dt(t / MS).getUTCDate() !== +m[3] || dt(t / MS).getUTCMonth() !== +m[2] - 1) throw new GenError(`Invalid isoformat string: '${s}'`);
  return t / MS;
}
const iso = (d: Day) => `${dt(d).getUTCFullYear()}-${p2(dt(d).getUTCMonth() + 1)}-${p2(dt(d).getUTCDate())}`;
const mdy = (d: Day) => `${dt(d).getUTCMonth() + 1}/${dt(d).getUTCDate()}/${dt(d).getUTCFullYear()}`; // 9/1/2024
const mdy0 = (d: Day) => `${p2(dt(d).getUTCMonth() + 1)}/${p2(dt(d).getUTCDate())}/${dt(d).getUTCFullYear()}`; // %m/%d/%Y
const md = (d: Day) => `${p2(dt(d).getUTCMonth() + 1)}/${p2(dt(d).getUTCDate())}`; // %m/%d
const dom = (d: Day) => dt(d).getUTCDate();
const weekday = (d: Day) => (dt(d).getUTCDay() + 6) % 7; // Python: Monday == 0

// ---------------------------------------------------------------- Decimal helpers and formats, as in the script
/** D(x) = Decimal(str(x)).quantize(CENT, ROUND_HALF_UP) for a Python float or a Decimal (str() of a Decimal re-reads to the same triple). */
const D = (x: number | Dec): Dec => (x instanceof Dec ? x : decFromFloat(x)).quantize(-2, "ROUND_HALF_UP");
/** D() of a Python int (str(int) has no ".0"). */
const Di = (x: number): Dec => Dec.of(x).quantize(-2, "ROUND_HALF_UP");
const ZERO = (): Dec => Di(0);
const sumD = (xs: Iterable<Dec>): Dec => { let s = ZERO(); for (const x of xs) s = s.add(x); return s; };
function amtMin(x0: Dec): string { const x = D(x0); let s = x.format(2); if (s.endsWith("00")) s = s.slice(0, -3); else if (s.endsWith("0")) s = s.slice(0, -1); return s; }
const absGe1000 = (x: Dec) => (x.sign ? x.neg() : x).cmp(Dec.of(1000)) >= 0;
const amtBank = (x0: Dec): string => { const x = D(x0); return absGe1000(x) ? x.format(2, true) : amtMin(x); };
const amtBal = (x: Dec): string => D(x).format(2, true);
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedNums = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);

interface Patient { key: string; first: string; last: string; dd: string; ins: Payer | null; sec: Payer | null; status: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = Record<string, any>;
interface Remit { code: string; method: string; remit: Day; post: Day; ref: string; trace: string; payments: Ev[]; eft_missing?: boolean }

function scenarioLeaks(scenario: string): string[] {
  if (scenario === "pos") return [];
  if (scenario === "neg-all") return [...LEAKS];
  return [scenario.slice(4).toUpperCase().replaceAll("-", "_")];
}

function plantLeaks(a: DentalFlags, leaks: string[], events: Ev[], remits: Remit[]) {
  const lrng = new PyRandom(BigInt(a.seed) * 1000003n + BigInt(a.leak_seed));
  const lag = a.card_lag_days;
  const total = (e: Ev): Dec => (e.kind === "InsPayment" ? sumD(e.rows.map((r: [string, Dec]) => r[1])) : e.amount);
  const banked = events.filter((e) => e.banked);
  const cardDays = new Map<Day, Ev[]>(), atmDays = new Map<Day, Ev[]>();
  for (const e of banked) {
    const m = CARD.includes(e.method) ? cardDays : ATM.includes(e.method) ? atmDays : null;
    if (m) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date)!.push(e); }
  }
  const get = (m: Map<Day, Ev[]>, d: Day) => m.get(d) ?? [];
  const plan = { card_short: new Map<Day, Dec>(), broken_card: new Map<Day, boolean>(), cash_short: new Map<Day, Dec>(), broken_atm: new Map<Day, boolean>(),
    exceptions: [] as Record<string, unknown>[], affected: new Set<number>(), unmatched_bank: 0, extras: [] as [string, Day, Dec][],
    extra_credits: (_a: DentalFlags, _ids: Map<string, string>): [Day, string, Dec][] => [] };
  const usedCard = new Set<Day>(), usedAtm = new Set<Day>(), usedIds = new Set<number>();
  let nextId = Math.max(...events.map((e) => e.id)) + 1;

  const exc = (code: string, group: string, date: Day, cents: Dec, ids: number[], severity = "exception", payer: string | null = null, detail = "") =>
    plan.exceptions.push({ code, severity, group, date: iso(date), cents: Number(cents.toBigInt()), payment_ids: [...ids].sort((x, y) => x - y), payer, detail });
  const pick = <T>(xs: T[], what: string): T => {
    if (xs.length === 0) throw new GenError(`cannot plant ${what}: no candidate left in this set (try another --seed or a longer --days)`);
    return lrng.choice(xs);
  };
  const shortFor = (dayEvents: Ev[], cap: number): Dec => {
    const singles = new Set(dayEvents.map((e) => total(e).key()));
    for (let i = 0; i < 1000; i++) {
      const x = D(lrng.uniform(1.0, cap));
      if (x.gt(Dec.of(0)) && !singles.has(x.key())) return x;
    }
    throw new GenError("cannot pick a short amount that differs from every single payment of the day");
  };
  const hundred = Dec.of(100);

  for (const leak of leaks) {
    if (leak === "UNDEPOSITED_CHECK") {
      const e = pick(banked.filter((x) => x.kind === "InsPayment" && x.method === "Insurance Check" && !usedAtm.has(x.date)), leak);
      e.undeposited = true; usedAtm.add(e.date); usedIds.add(e.id);
      const others = get(atmDays, e.date).filter((x) => x !== e);
      plan.broken_atm.set(e.date + 1, true);
      for (const x of get(atmDays, e.date)) plan.affected.add(x.id);
      plan.unmatched_bank += others.length ? 1 : 0;
      exc(leak, "branch_atm_deposit", e.date, total(e).mul(hundred), [e.id], undefined, null, "posted insurance check left out of the next ATM deposit");
    } else if (leak === "EFT_MISSING") {
      const r = pick(remits.filter((x) => x.method === "Direct Deposit" && !x.eft_missing), leak);
      r.eft_missing = true;
      const ids = r.payments.map((x) => x.id);
      for (const i of ids) plan.affected.add(i);
      exc(leak, "insurance_eft", r.post, sumD(r.payments.map(total)).mul(hundred), ids, undefined, r.code, "remittance posted in Curve, no bank credit");
    } else if (leak === "CARD_BATCH_SHORT") {
      const day = pick([...cardDays.keys()].filter((d) => !usedCard.has(d)).sort((x, y) => x - y), leak); usedCard.add(day);
      const short = shortFor(get(cardDays, day), a.short_max);
      plan.card_short.set(day + lag, short); plan.broken_card.set(day + lag, true);
      for (const x of get(cardDays, day)) plan.affected.add(x.id);
      plan.unmatched_bank += 1;
      exc(leak, "card_processor", day, short.mul(hundred), [], undefined, null, "card settlement credit lower than the day's card payments");
    } else if (leak === "CASH_SHORT") {
      const cashOf = (es: Ev[]) => sumD(es.filter((x) => x.method === "Cash").map(total));
      const cands = [...atmDays.entries()].filter(([d, es]) => !usedAtm.has(d) && cashOf(es).gt(Dec.of("1.01"))).map(([d]) => d).sort((x, y) => x - y);
      const day = pick(cands, leak); usedAtm.add(day);
      const cash = cashOf(get(atmDays, day));
      const capF = cash.sub(Dec.of("0.01")).toNumber();
      const short = shortFor(get(atmDays, day), capF < a.short_max ? capF : a.short_max); // Python min(): first wins on a tie
      plan.cash_short.set(day + 1, short); plan.broken_atm.set(day + 1, true);
      for (const x of get(atmDays, day)) plan.affected.add(x.id);
      plan.unmatched_bank += 1;
      exc(leak, "branch_atm_deposit", day, short.mul(hundred), [], undefined, null, "ATM deposit short of the day's cash");
    } else if (leak === "REF_MISMATCH") {
      const e = pick(banked.filter((x) => x.kind === "InsPayment" && x.method === "Insurance Check" && !usedIds.has(x.id)), leak);
      usedIds.add(e.id);
      let nw = e.ref;
      while (nw === e.ref) nw = `${lrng.randrange(10 ** 7, 10 ** 8)}`;
      e.dep_ref = nw;
      exc(leak, "branch_atm_deposit", e.date, total(e).mul(hundred), [e.id], undefined, null, `ledger reference ${e.ref} vs deposit detail Ref. ID ${nw}`);
    } else if (leak === "POSTED_TWICE") {
      const e = pick(banked.filter((x) => x.kind === "Deposit" && (x.method === "Visa" || x.method === "Mastercard") && !usedCard.has(x.date)), leak);
      usedCard.add(e.date);
      const dup: Ev = { ...e, id: nextId, dup_of: e.id, ext: `S${pad(lrng.randrange(10 ** 12, 10 ** 13), 13)}` };
      const app: Ev = { kind: "Payment", p: e.p, prov: e.prov, amount: e.amount, method: "Account Credit", banked: false, id: nextId + 1, date: e.date };
      nextId += 2;
      events.push(dup, app);
      plan.broken_card.set(e.date + lag, true);
      for (const x of get(cardDays, e.date)) plan.affected.add(x.id);
      plan.affected.add(dup.id); plan.unmatched_bank += 1;
      exc(leak, "card_processor", e.date, e.amount.mul(hundred), [e.id, dup.id], undefined, null, "same patient, amount and card posted twice; one settlement");
    } else if (leak === "BANK_UNPOSTED") {
      const mhDays = new Set(remits.filter((r) => r.code === "MH").map((r) => r.remit));
      const days = [...new Set(banked.map((x) => x.date as Day))].filter((d) => !mhDays.has(d)).sort((x, y) => x - y);
      const day = pick(days.filter((d) => weekday(d) < 5), leak);
      const sums = new Set(banked.map((x) => total(x).key()));
      let amt = D(lrng.uniform(100, 900));
      while (sums.has(amt.key())) amt = D(lrng.uniform(100, 900));
      plan.extras.push(["MH", day, amt]); plan.unmatched_bank += 1;
      exc(leak, "insurance_eft", day, amt.mul(hundred), [], undefined, "MH", "EFT credit in the bank with no Curve posting");
    } else if (leak === "HFD_LAG") {
      const e = pick(banked.filter((x) => x.kind === "Deposit" && x.method === "HFD" && !usedCard.has(x.date)), leak);
      usedCard.add(e.date); e.hfd_lag = true;
      const others = get(cardDays, e.date).filter((x) => x !== e);
      if (others.length) { plan.broken_card.set(e.date + lag, true); plan.unmatched_bank += 1; }
      for (const x of get(cardDays, e.date)) plan.affected.add(x.id);
      plan.unmatched_bank += 1;
      plan.extras.push(["HFD", e.date + lag + a.hfd_lag_extra_days, e.amount]);
      exc(leak, "card_processor", e.date, e.amount.mul(hundred), [e.id], "watch", null, `HFD funding ${a.hfd_lag_extra_days} day(s) after the card lag window, as its own credit`);
    }
  }

  plan.extra_credits = (a2: DentalFlags, payerIds: Map<string, string>) => {
    const out: [Day, string, Dec][] = [];
    for (const [kind, day, amt] of plan.extras) {
      if (kind === "HFD") out.push([day, `GB PY DES:GLOBAL DEP ID:${a2.merchant_id} INDN:${a2.practice_name} CO ID:N400000000 CCD`, amt]);
      else {
        const pid = payerIds.get(kind)!;
        const payer = PAYERS.find((p) => p[0] === kind)!;
        const id1 = lrng.randrange(10 ** 9, 10 ** 10);
        const trn = lrng.randrange(10 ** 14, 10 ** 15);
        out.push([day, `${payer[3]} DES:HCCLAIMPMT ID:${id1} INDN:${a2.legal_name} CO ID:${pid} CCD PMT INFO:TRN*1*${trn}*${pid}\\`, amt]);
      }
    }
    return out;
  };
  return plan;
}

export interface DentalSet {
  /** relative path -> file text, in the Python script's write order; truth.json is JSON.stringify(truth, null, 2). */
  files: Map<string, string>;
  truth: Record<string, unknown>;
}

export function generate(a: DentalFlags): DentalSet {
  for (const [k, s] of Object.entries(FLAG_SPEC) as [keyof DentalFlags, (typeof FLAG_SPEC)[keyof DentalFlags]][]) {
    if (s.choices && !s.choices.includes(String(a[k]))) throw new GenError(`invalid choice for ${k}: '${a[k]}' (choose from ${s.choices.join(", ")})`);
    if (s.kind === "int" && !Number.isSafeInteger(a[k])) throw new GenError(`${k} must be an int, got ${a[k]}`);
    if (s.kind === "float" && !Number.isFinite(a[k])) throw new GenError(`${k} must be a finite float, got ${a[k]}`);
  }
  const leaks = scenarioLeaks(a.scenario);
  const rng = new PyRandom(a.seed);
  const start = fromIso(a.start);
  const end = start + a.days - 1;
  const bankEnd = end + a.bank_tail_days;
  const providers = Array.from({ length: Math.max(0, a.providers) }, (_, i) => `PV${i + 1}`);

  // patients
  const combos: [string, string][] = [];
  for (const f of FIRST) for (const l of LAST) combos.push([f, l]);
  if (a.patients > combos.length) throw new GenError(`--patients max is ${combos.length}`);
  rng.shuffle(combos);
  const weights = PAYERS.map((p) => p[4]);
  const patients: Patient[] = [];
  combos.slice(0, Math.max(0, a.patients)).forEach(([f, l], idx) => {
    const ins = rng.random() < a.self_pay_share ? null : rng.choices(PAYERS, weights)[0];
    let sec: Payer | null = null;
    if (ins && !ins[5] && rng.random() < 0.08) sec = rng.choice(PAYERS.filter((p) => p !== ins && !p[5]));
    const dd = rng.choice(providers);
    const status = rng.random() < 0.93 ? "Active" : "Inactive";
    patients.push({ key: `PT${idx + 1}`, first: f, last: l, dd, ins, sec, status });
  });
  const active = patients.filter((p) => p.status === "Active");

  // remittance calendars
  const remitWd = new Map<string, number>();
  for (const p of PAYERS) remitWd.set(p[0], rng.randrange(0, 5));
  const payerIds = new Map<string, string>();
  for (const p of PAYERS) payerIds.set(p[0], `1${rng.randrange(10 ** 8, 10 ** 9)}`);
  const nextRemit = (code: string, after: Day): Day => { let d = after; while (weekday(d) !== remitWd.get(code)) d += 1; return d; };

  // events
  const ev: [Day, number, Ev][] = [];
  const add = (date: Day, kw: Ev): Ev => { ev.push([date, ev.length, kw]); return kw; };
  const claimsByRemit = new Map<string, { code: string; remit: Day; items: [Patient, string, Dec, Dec, string][] }>();
  const lastInvDay = end - (a.claim_lag_days + 7 + 2);
  for (let d = start; d <= lastInvDay; d += 1) {
    const n = rng.randint(a.min_invoices_day, a.max_invoices_day);
    for (let i = 0; i < n; i++) {
      const p = rng.choice(active);
      const prov = rng.random() < 0.7 ? p.dd : rng.choice(providers);
      if (rng.random() < a.zero_invoice_share) { add(d, { kind: "Invoice", p, prov, amount: ZERO() }); continue; }
      const fee = Di(rng.choice(FEES));
      add(d, { kind: "Invoice", p, prov, amount: fee });
      let ptResp = fee;
      if (p.ins) {
        const [code, , , , , medicaid] = p.ins;
        let insPaid: Dec, adjType: string, writeoff: Dec;
        if (medicaid) {
          insPaid = D(fee.mul(decFromFloat(rng.uniform(0.45, 0.75)))).quantize(0, "ROUND_HALF_EVEN");
          adjType = "Credit Adjustment"; ptResp = ZERO();
          writeoff = fee.sub(insPaid);
        } else {
          const allowed = D(fee.mul(decFromFloat(rng.uniform(0.6, 0.88)))).quantize(0, "ROUND_HALF_EVEN");
          insPaid = D(allowed.mul(decFromFloat(rng.choice([0.5, 0.8, 1.0]))));
          adjType = "PPO Write-off"; writeoff = fee.sub(allowed); ptResp = allowed.sub(insPaid);
        }
        const remit = nextRemit(code, d + a.claim_lag_days);
        const k = `${remit}|${code}`;
        if (!claimsByRemit.has(k)) claimsByRemit.set(k, { code, remit, items: [] });
        claimsByRemit.get(k)!.items.push([p, prov, insPaid, writeoff, adjType]);
      }
      if (ptResp.gt(Dec.of(0))) {
        const r = rng.random();
        if (r < a.cash_share) add(d, { kind: "Payment", p, prov, amount: ptResp, method: "Cash", banked: true });
        else {
          const method = ptResp.cmp(Dec.of(500)) >= 0 && rng.random() < 0.5 ? "HFD" : rng.choice(["Visa", "Visa", "Mastercard"]);
          const ext = method !== "HFD" ? `S${pad(rng.randrange(10 ** 12, 10 ** 13), 13)}` : "";
          add(d, { kind: "Deposit", p, prov, amount: ptResp, method, ext, banked: true });
          add(d, { kind: "Payment", p, prov, amount: ptResp, method: "Account Credit", banked: false });
        }
      }
    }
  }

  // insurance payments: one payment id per (patient, remit); one row per provider
  const remits: Remit[] = [];
  const claimGroups = [...claimsByRemit.values()].sort((x, y) => x.remit - y.remit || cmpStr(x.code, y.code));
  for (const { code, remit, items } of claimGroups) {
    const payer = PAYERS.find((p) => p[0] === code)!;
    const method = payer[2];
    const post = method === "Direct Deposit" ? remit + 1 : method === "Insurance Check" ? remit + 3 : remit;
    if (post > end) throw new GenError("internal: posting fell outside window; widen --days");
    const ref = method === "Insurance Check" ? `${rng.randrange(10 ** 7, 10 ** 8)}` : "";
    const trace = method === "Direct Deposit" ? `${rng.randrange(10 ** 14, 10 ** 15)}` : "";
    const byPt = new Map<string, Map<string, [Dec, Dec, string | null]>>();
    for (const [p, prov, paid, wo, adj] of items) {
      if (!byPt.has(p.key)) byPt.set(p.key, new Map());
      const provs = byPt.get(p.key)!;
      if (!provs.has(prov)) provs.set(prov, [ZERO(), ZERO(), null]);
      const cell = provs.get(prov)!;
      cell[0] = cell[0].add(paid); cell[1] = cell[1].add(wo); cell[2] = adj;
    }
    const rec: Remit = { code, method, remit, post, ref, trace, payments: [] };
    for (const [pkey, provs] of byPt) {
      const p = patients.find((x) => x.key === pkey)!;
      const pay = add(post, { kind: "InsPayment", p, rows: [...provs].map(([pv, v]) => [pv, v[0]]), method, payer: code, ref, banked: true, remit: rec });
      rec.payments.push(pay);
      for (const [pv, v] of provs) if (v[1].gt(Dec.of(0))) add(post, { kind: "Adjustment", p, prov: pv, amount: v[1], adj: v[2] });
    }
    remits.push(rec);
  }

  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let nid = a.first_id;
  for (const e of ev) { e[2].id = nid; e[2].date = e[0]; nid += 1; }
  const events = ev.map((e) => e[2]);
  const plan = leaks.length ? plantLeaks(a, leaks, events, remits) : null;

  // Curve files
  const nmLedger = (p: Patient) => `${p.last}, ${p.first}`;
  const nmRp = (p: Patient) => `${p.first} ${p.last}`;
  const ledger: [Patient, CsvField[]][] = [], dep: [Patient, CsvField[]][] = [];
  for (const e of events) {
    const p: Patient = e.p;
    const base = [p.key, p.last, p.first, p.dd];
    const k = e.kind;
    if (k === "Invoice") ledger.push([p, [mdy(e.date), `Invoice #${e.id}`, ...base, e.prov, a.clinic, a.clinic, amtMin(e.amount)]]);
    else if (k === "Adjustment") ledger.push([p, [mdy(e.date), `Adjustment #${e.id}, ${e.adj}`, ...base, e.prov, a.clinic, a.clinic, amtMin(e.amount.neg())]]);
    else if (k === "Deposit") {
      ledger.push([p, [mdy(e.date), `Deposit #${e.id}, ${e.method}`, ...base, e.prov, a.clinic, a.clinic, amtMin(e.amount)]]);
      dep.push([p, [mdy(e.date), String(e.id), "Office posted", e.method, "", e.ext, nmRp(p), p.key, nmRp(p), e.prov, a.clinic, amtMin(e.amount)]]);
    } else if (k === "Payment") {
      ledger.push([p, [mdy(e.date), `Payment #${e.id}, ${e.method}`, ...base, e.prov, a.clinic, a.clinic, amtMin(e.amount.neg())]]);
      if (e.banked) dep.push([p, [mdy(e.date), String(e.id), "Office posted", e.method, "", "", nmRp(p), p.key, nmRp(p), e.prov, a.clinic, amtMin(e.amount)]]);
    } else if (k === "InsPayment") {
      const det = `Payment #${e.id}, ${e.method}` + (e.ref ? ` - ${e.ref}` : "");
      for (const [pv, v] of e.rows as [string, Dec][]) {
        ledger.push([p, [mdy(e.date), det, ...base, pv, a.clinic, a.clinic, amtMin(v.neg())]]);
        dep.push([p, [mdy(e.date), String(e.id), "Office posted", e.method, "dep_ref" in e ? e.dep_ref : e.ref, "", e.payer, p.key, nmRp(p), pv, a.clinic, amtMin(v)]]);
      }
    }
  }
  ledger.sort((x, y) => cmpStr(x[0].last.toLowerCase(), y[0].last.toLowerCase()) || cmpStr(x[0].first.toLowerCase(), y[0].first.toLowerCase()));
  dep.sort((x, y) => cmpStr(x[0].first.toLowerCase(), y[0].first.toLowerCase()) || cmpStr(x[0].last.toLowerCase(), y[0].last.toLowerCase()));

  const L_HDR = ["Date", "Details", "Patient", "Patient-LM", "Patient-FM", "Default dentist", "Provider of service", "Clinic", "Posted at clinic", "Amount"];
  const D_HDR = ["Date", "ID", "Payment Posted By", "Payment Type", "Ref. ID", "Ext. ID", "Payer", "RP", "Responsible Party", "Provider", "Posted At Clinic", "Amount"];
  const P_HDR = ["Patient", "Full Name", "Status", "Preferred Clinic", "Default Doctor", "Prim. Insurance Plan", "Sec. Insurance Plan"];
  const pfmt = a.patient_name_format === "last_first" ? nmLedger : nmRp;
  const plist: CsvField[][] = [...patients].sort((x, y) => cmpStr(x.last.toLowerCase(), y.last.toLowerCase()) || cmpStr(x.first.toLowerCase(), y.first.toLowerCase()))
    .map((p) => [p.key, pfmt(p), p.status, a.practice_name, p.dd, p.ins ? p.ins[1] : "", p.sec ? p.sec[1] : ""]);

  // bank
  type BankRow = [Day, number, string, Dec];
  const bank: BankRow[] = [];
  const matches: Record<string, unknown>[] = [];
  const gp = new Map<Day, Ev[]>(), atm = new Map<Day, Ev[]>();
  const push = (m: Map<Day, Ev[]>, d: Day, e: Ev) => { if (!m.has(d)) m.set(d, []); m.get(d)!.push(e); };
  let cardFeeBase = ZERO();
  for (const e of events) {
    if (!e.banked || e.dup_of || e.hfd_lag || e.undeposited) continue;
    const m = e.method;
    if (CARD.includes(m)) push(gp, e.date + a.card_lag_days, e);
    else if (ATM.includes(m)) push(atm, e.date + 1, e);
  }
  const evTotal = (e: Ev): Dec => (e.kind === "InsPayment" ? sumD((e.rows as [string, Dec][]).map((r) => r[1])) : e.amount);
  const feeRate = decFromFloat(a.card_fee_pct).div(Dec.of(100));
  const zero = ZERO();
  for (const [sd, es] of [...gp].sort((x, y) => x[0] - y[0])) {
    const gross = sumD(es.map(evTotal));
    const fee = D(gross.mul(feeRate));
    cardFeeBase = cardFeeBase.add(gross);
    let amount = a.card_fee_mode === "daily-net" ? gross.sub(fee) : gross;
    if (plan) amount = amount.sub(plan.card_short.get(sd) ?? zero);
    const desc = `GB PY DES:GLOBAL DEP ID:${a.merchant_id} INDN:${a.practice_name} CO ID:N400000000 CCD`;
    bank.push([sd, 1, desc, amount]);
    if (plan && plan.broken_card.get(sd)) continue;
    matches.push({ bank_date: sd, description: desc, bank_amount: amount, group: "card_processor", curve_ids: sortedNums(es.map((e) => e.id)), curve_total: gross,
      fee: a.card_fee_mode === "daily-net" ? fee : ZERO() });
  }
  let seq = 1941;
  for (const [sd, es] of [...atm].sort((x, y) => x[0] - y[0])) {
    const total = sumD(es.map(evTotal));
    const desc = `BKOFAMERICA ATM ${md(sd)} #${pad(seq, 9)} DEPOSIT MAIN ST ANYTOWN CT CKCD 4135770000004410`;
    seq += 1;
    bank.push([sd, 1, desc, total.sub(plan ? plan.cash_short.get(sd) ?? zero : zero)]);
    if (plan && plan.broken_atm.get(sd)) continue;
    matches.push({ bank_date: sd, description: desc, bank_amount: total, group: "branch_atm_deposit", curve_ids: sortedNums(es.map((e) => e.id)), curve_total: total, fee: ZERO() });
  }
  for (const r of remits) {
    if (r.method !== "Direct Deposit" || r.eft_missing) continue;
    const payer = PAYERS.find((p) => p[0] === r.code)!;
    const total = sumD(r.payments.map(evTotal));
    const payerId = payerIds.get(r.code)!;
    const desc = `${payer[3]} DES:HCCLAIMPMT ID:${rng.randrange(10 ** 9, 10 ** 10)} INDN:${a.legal_name} CO ID:${payerId} CCD PMT INFO:TRN*1*${r.trace}*${payerId}\\`;
    bank.push([r.remit, 1, desc, total]);
    matches.push({ bank_date: r.remit, description: desc, bank_amount: total, group: "insurance_eft", payer: r.code, trace: r.trace,
      curve_ids: [...r.payments.map((e) => e.id as number)].sort((x, y) => x - y), curve_total: total, fee: ZERO() });
  }
  if (plan) for (const [bd, desc, amount] of plan.extra_credits(a, payerIds)) bank.push([bd, 1, desc, amount]);
  if (a.card_fee_mode === "monthly" && cardFeeBase.gt(Dec.of(0))) {
    const fd = end + 2;
    const fee = D(cardFeeBase.mul(feeRate));
    bank.push([fd, 2, `GB PY DES:GLOBAL STL ID:${a.merchant_id} INDN:${a.practice_name} CO ID:N400000000 CCD`, fee.neg()]);
  }
  // operating expenses (not part of reconciliation)
  let chk = 3001;
  for (let d = start; d <= bankEnd; d += 1) {
    if (dom(d) === 1) { bank.push([d, 3, `Check ${chk}`, D(a.rent).neg()]); chk += 1; }
    if (dom(d) === 15 || dom(d) === 30) {
      const id1 = rng.randrange(10 ** 8, 10 ** 9);
      const pay = D(rng.uniform(a.payroll * 0.95, a.payroll * 1.05)).neg();
      bank.push([d, 3, `PAYCHEX INC. DES:PAYROLL ID:PX${id1} INDN:${a.legal_name} CO ID:1160000000 CCD`, pay]);
      const id2 = rng.randrange(10 ** 8, 10 ** 9);
      const tax = D(rng.uniform(a.payroll * 0.08, a.payroll * 0.1)).neg();
      bank.push([d, 3, `PAYCHEX TPS DES:TAXES ID:${id2} INDN:${a.legal_name} CO ID:1160000000 CCD`, tax]);
    }
    if (rng.random() < 0.35) {
      const [t, lo, hi] = rng.choice(EXPENSES);
      const rid = rng.randrange(10 ** 6, 10 ** 7);
      const desc = t.replace("{md}", md(d - 1)).replace("{rid}", String(rid)).replace("{legal}", a.legal_name);
      bank.push([d, 3, desc, D(rng.uniform(lo, hi)).neg()]);
    }
  }
  bank.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const opening = D(a.opening_balance);
  let bal = opening;
  const rows: CsvField[][] = [[mdy(start), `Beginning balance as of ${mdy0(start)}`, "", amtBal(bal)]];
  let credits = ZERO(), debits = ZERO();
  const intZero = Dec.of(0);
  for (const [bd, , desc, amount] of bank) {
    bal = bal.add(amount);
    credits = credits.add(amount.gt(intZero) ? amount : intZero);
    debits = debits.add(amount.lt(intZero) ? amount : intZero);
    rows.push([mdy(bd), desc, amtBank(amount), amtBal(bal)]);
  }
  const pre: CsvField[][] = [["Description", "", "Summary Amt.", ""],
    [`Beginning balance as of ${mdy0(start)}`, "", amtBal(opening), amtBal(opening)],
    ["Total credits", "", amtBal(credits), amtBal(credits)],
    ["Total debits", "", amtBal(debits), amtBal(debits)],
    [`Ending balance as of ${mdy0(bankEnd)}`, "", amtBal(bal), amtBal(bal)],
    ["", "", "", ""],
    ["Date", "Description", "Amount", "Running Bal."]];
  if (!opening.add(credits).add(debits).eq(bal)) throw new Error("assert opening + credits + debits == bal");

  // write
  const tag = `${a.set_name}-${a.scenario.toUpperCase()}`;
  const files = new Map<string, string>();
  files.set(`BankDep-Det-${tag}.csv`, csvText([D_HDR, ...dep.map((r) => r[1])], { bom: true }));
  files.set(`Per-Sum-${tag}.csv`, csvText([L_HDR, ...ledger.map((r) => r[1])], { bom: true }));
  files.set(`SPR-patientlist-${tag}.csv`, csvText([P_HDR, ...plist], { bom: true }));
  files.set(`BANK-ST-${tag}.csv`, csvText([...pre, ...rows], { bom: false }));

  const groupOf: Record<string, string> = { Visa: "card_processor", Mastercard: "card_processor", HFD: "card_processor", "Ins VCC": "card_processor",
    Cash: "branch_atm_deposit", "Insurance Check": "branch_atm_deposit", "Direct Deposit": "insurance_eft" };
  const postedByGroup = new Map<string, Dec>();
  for (const e of events) if (e.banked && !e.dup_of) { const g = groupOf[e.method]; postedByGroup.set(g, (postedByGroup.get(g) ?? ZERO()).add(evTotal(e))); }
  const bankedByGroup = new Map<string, Dec>();
  for (const m of matches) { const g = m.group as string; bankedByGroup.set(g, (bankedByGroup.get(g) ?? ZERO()).add(m.curve_total as Dec)); }
  const strMap = (m: Map<string, Dec>) => Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));
  const truth: Record<string, unknown> = {
    generator: "gen_dental_set.py", seed: a.seed, scenario: a.scenario, set: a.set_name,
    synthetic: true, curve_window: [iso(start), iso(end)], bank_window: [iso(start), iso(bankEnd)],
    flags: { ...a },
    counts: { patients: patients.length, ledger_rows: ledger.length, deposit_rows: dep.length, bank_rows: rows.length - 1, bank_credits_matched: matches.length },
    posted_to_bank_by_group: strMap(postedByGroup), matched_in_bank_by_group: strMap(bankedByGroup),
    card_fee_mode: a.card_fee_mode,
    bank_totals: { opening: opening.toString(), credits: credits.toString(), debits: debits.toString(), ending: bal.toString() },
    expected_exceptions: plan ? plan.exceptions : [],
    affected_payment_ids: plan ? sortedNums(plan.affected) : [],
    unmatched_bank_credits: plan ? plan.unmatched_bank : 0,
    leak_seed: a.leak_seed,
    notes: !plan
      ? "POS: every banked Curve payment is in exactly one bank credit; Account Credit rows are internal and never banked."
      : "NEG: planted leaks in expected_exceptions; affected_payment_ids are in no exact match; unmatched_bank_credits bank credits match nothing exactly. Leaks use their own random stream (--leak-seed), so the base set equals POS.",
  };
  if (!plan) for (const [g, v] of postedByGroup) if (!v.eq(bankedByGroup.get(g) ?? Dec.of(0))) throw new Error(`assert posted == banked for ${g}`);
  files.set("_answer-key/truth.json", JSON.stringify(truth, null, 2));
  const em: CsvField[][] = [["bank_date", "bank_description", "bank_amount", "group", "payer", "trace", "curve_payment_ids", "curve_total", "fee"]];
  for (const m of [...matches].sort((x, y) => (x.bank_date as number) - (y.bank_date as number)))
    em.push([mdy(m.bank_date as Day), m.description as string, (m.bank_amount as Dec).format(2), m.group as string, (m.payer as string) ?? "",
      (m.trace as string) ?? "", (m.curve_ids as number[]).join(";"), (m.curve_total as Dec).format(2), (m.fee as Dec).format(2)]);
  files.set("_answer-key/expected-matches.csv", em.map((r) => csvRow(r)).join(""));
  return { files, truth };
}

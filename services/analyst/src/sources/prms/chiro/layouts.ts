/**
 * Chiropractic export layouts (privateAI-design-30 §3, §11 CHIRO-1b-2 stage 2): ChiroTouch, Jane, their processors (CT Payments,
 * Cash Practice, Jane Payments) and the owner-defined files (fee schedule, PI cases, care plans). Pure: no DuckDB import, so the
 * spec is tested anywhere (test/chiro-layouts.test.ts).
 *
 * A layout is its exact header line plus, per canonical column, { header, verified, basis } (the owner's rule). Nothing here is
 * guessed silently: every column that no real export has confirmed is verified: false, and each loaded file says so in its
 * checks ("layout verified against a real export"). When real header lines arrive, only this file changes.
 *
 * Person names are never loaded: such headers are in `forbidden` and cannot be mapped, except into name_key (normalized
 * "LAST FIRST", upper case, as in the Curve patient list) for later rule checks.
 *
 * Headerless exports (Juvonno notes ChiroTouch reports may export without column headings) are NOT detected by shape: a file
 * is recognised only by its exact header line. The owner adds the header line printed in tools/chiro-synth/README.md; no
 * positional guessing.
 */
import { headerOf } from "../../lines.ts";

export type ColType = "text" | "date" | "cents" | "int" | "name_key" | "map";
export type ColSpec = {
  /** Canonical column in the loaded table. */
  name: string;
  /** Source header (name_key: [last name header, first name header]). */
  from: string | readonly [string, string];
  type: ColType;
  /** type "map": source value -> canonical value; an unmapped value fails the file's check, never defaulted. */
  map?: Readonly<Record<string, string>>;
  /** Load the text only on rows where `column` is one of `in` (else NULL); used to keep person names out. */
  onlyWhen?: { column: string; in: readonly string[] };
  required: boolean;
  verified: boolean;
  basis: string;
};
export type ChiroLayout = {
  id: string;
  title: string;
  /** File-name prefix the generator and the owner use (design-30 §8.3); documentation only, detection is by header. */
  prefix: string;
  headers: readonly string[];
  forbidden: readonly string[];
  columns: readonly ColSpec[];
  /** Columns whose combined value must be unique. */
  key?: readonly string[];
  /** Row identities on canonical columns: name and SQL that is TRUE on a row that breaks it. */
  identities?: readonly { name: string; failsWhen: string }[];
  /** The header line itself: verified when a real export showed it. */
  header: { verified: boolean; basis: string };
};

// ---------------------------------------------------------------- bases (one sentence each, cited in every column)
const CT = "UNVERIFIED: canonical ChiroTouch layout written by tools/chiro-synth/gen_chiro_set.py; no published ChiroTouch export header found (web search 2026-11-04)";
const CP = "UNVERIFIED: canonical Cash Practice layout written by tools/chiro-synth/gen_chiro_set.py; Cash Practice help center shows its report columns only in screenshots (read 2026-11-04)";
const CTPAY = "UNVERIFIED: canonical CT Payments (Global Payments) batch layout written by tools/chiro-synth/gen_chiro_set.py; no published export header found";
const JANE = "UNVERIFIED: canonical Jane layout written by tools/chiro-synth/gen_chiro_set.py; no published Jane export header for this report found";
const JANE_PRF = "Jane guide 'Payments, Refunds, and Fees Report', Detail view field names (jane.app/guide/payments-refunds-and-fees-report, read 2026-11-05); spelling and order of a real export UNCONFIRMED";
const JANE_PO = "Jane guide 'Jane Payments Payouts Report' fields Date Created, Date Deposited, Payout Amount, Payout Status (jane.app/guide/jane-payments-payouts-report, read 2026-11-04); a real export UNCONFIRMED";
const OWN = "owner-defined kind (design-30 §3: no standard export exists); columns proposed by tools/chiro-synth/gen_chiro_set.py, not yet confirmed by the owner";
const DATES = "M/D/YYYY as the generator writes it; ASSUMPTION for real exports";

const t = (name: string, from: string, required: boolean, verified: boolean, basis: string): ColSpec => ({ name, from, type: "text", required, verified, basis });
const d = (name: string, from: string, required: boolean, verified: boolean, basis: string): ColSpec => ({ name, from, type: "date", required, verified, basis: `${basis}; ${DATES}` });
const c = (name: string, from: string, required: boolean, verified: boolean, basis: string): ColSpec => ({ name, from, type: "cents", required, verified, basis });
const n = (name: string, from: string, required: boolean, verified: boolean, basis: string): ColSpec => ({ name, from, type: "int", required, verified, basis });
const nameKey = (last: string, first: string, basis: string): ColSpec => ({ name: "name_key", from: [last, first], type: "name_key", required: true, verified: false, basis });
const ENTRY = { Charge: "charge", Payment: "payment", Adjustment: "adjustment" } as const;

// ---------------------------------------------------------------- ChiroTouch
export const CT_PATIENTS: ChiroLayout = {
  id: "prms/chirotouch/patients", title: "ChiroTouch patient data export (reference; layout UNVERIFIED)", prefix: "CT-PATIENTS-",
  headers: ["Patient ID", "Last Name", "First Name", "Primary Insurance", "Payer Class", "State", "Provider"],
  forbidden: ["Last Name", "First Name"], key: ["patient_key"], header: { verified: false, basis: CT },
  columns: [t("patient_key", "Patient ID", true, false, CT), nameKey("Last Name", "First Name", CT), t("primary_plan", "Primary Insurance", false, false, CT),
    t("payer_class", "Payer Class", true, false, CT), t("state", "State", false, false, CT), t("provider", "Provider", false, false, CT)],
};
export const CT_DAYSHEET: ChiroLayout = {
  id: "prms/chirotouch/daysheet", title: "ChiroTouch day sheet: charges, payments, adjustments (layout UNVERIFIED)", prefix: "CT-DAYSHEET-",
  headers: ["Date", "Patient ID", "Visit", "Provider", "Type", "Code", "Modifiers", "Units", "Amount", "Reference", "Payer"],
  forbidden: [], header: { verified: false, basis: CT },
  columns: [d("date", "Date", true, false, CT), t("patient_key", "Patient ID", true, false, CT), t("visit_ref", "Visit", true, false, CT),
    t("provider", "Provider", false, false, CT), { name: "entry", from: "Type", type: "map", map: ENTRY, required: true, verified: false, basis: CT },
    t("code", "Code", true, false, CT), t("modifiers", "Modifiers", false, false, CT), n("units", "Units", false, false, CT),
    c("cents", "Amount", true, false, `${CT}; charges positive, payments and adjustments negative`), t("ref", "Reference", false, false, CT), t("payer", "Payer", false, false, CT)],
};
export const CT_DEPOSITS: ChiroLayout = {
  id: "prms/chirotouch/deposits", title: "ChiroTouch deposit report: one row per payment received (layout UNVERIFIED)", prefix: "CT-DEPOSITS-",
  headers: ["Date", "Payment ID", "Method", "Payer", "Reference", "Amount", "Patient ID"],
  forbidden: [], key: ["payment_id"], header: { verified: false, basis: CT },
  columns: [d("date", "Date", true, false, CT), t("payment_id", "Payment ID", true, false, CT), t("method", "Method", true, false, CT),
    t("payer", "Payer", false, false, CT), t("ref_id", "Reference", false, false, CT), c("cents", "Amount", true, false, CT), t("rp_pseudonym", "Patient ID", false, false, CT)],
};
export const CT_PAYMENTS: ChiroLayout = {
  id: "processor/ct-payments", title: "CT Payments (Global Payments) daily card batches (layout UNVERIFIED)", prefix: "CTPAY-",
  headers: ["Batch Date", "Batch ID", "Transactions", "Gross", "Fees", "Net", "Settlement Date"],
  forbidden: [], key: ["batch_id"], header: { verified: false, basis: CTPAY },
  identities: [{ name: "Net = Gross - Fees", failsWhen: "net_cents <> gross_cents - fee_cents" }],
  columns: [d("batch_date", "Batch Date", true, false, CTPAY), t("batch_id", "Batch ID", true, false, CTPAY), n("txn_count", "Transactions", true, false, CTPAY),
    c("gross_cents", "Gross", true, false, CTPAY), c("fee_cents", "Fees", true, false, CTPAY), c("net_cents", "Net", true, false, CTPAY),
    d("settle_date", "Settlement Date", true, false, CTPAY)],
};
export const CASH_PRACTICE: ChiroLayout = {
  id: "processor/cash-practice", title: "Cash Practice auto-debit postings and returns (layout UNVERIFIED)", prefix: "CASHPRAC-",
  headers: ["Date", "Patient ID", "Plan ID", "Type", "Amount", "Reference"],
  forbidden: [], header: { verified: false, basis: CP },
  identities: [{ name: "debits positive, returns negative", failsWhen: "(kind = 'debit' AND cents <= 0) OR (kind = 'return' AND cents >= 0)" }],
  columns: [d("date", "Date", true, false, CP), t("patient_key", "Patient ID", true, false, CP), t("plan_id", "Plan ID", false, false, CP),
    { name: "kind", from: "Type", type: "map", map: { Debit: "debit", Return: "return" }, required: true, verified: false,
      basis: `${CP}; Return rows: Cash Practice help center says auto-debit returns must be imported into ChiroTouch each business day` },
    c("cents", "Amount", true, false, CP), t("ref", "Reference", true, false, CP)],
};

// ---------------------------------------------------------------- Jane
export const JANE_PATIENTS: ChiroLayout = {
  id: "prms/jane/patients", title: "Jane patients list (reference; layout UNVERIFIED)", prefix: "JANE-PATIENTS-",
  headers: ["Patient Number", "Last Name", "First Name", "Primary Policy", "Payer Class", "State", "Practitioner"],
  forbidden: ["Last Name", "First Name"], key: ["patient_key"], header: { verified: false, basis: JANE },
  columns: [t("patient_key", "Patient Number", true, false, JANE), nameKey("Last Name", "First Name", JANE), t("primary_plan", "Primary Policy", false, false, JANE),
    t("payer_class", "Payer Class", true, false, JANE), t("state", "State", false, false, JANE), t("provider", "Practitioner", false, false, JANE)],
};
export const JANE_TRANSACTIONS: ChiroLayout = {
  id: "prms/jane/transactions", title: "Jane transactions: charges, payments, adjustments (layout UNVERIFIED)", prefix: "JANE-TRANSACTIONS-",
  headers: ["Date", "Patient Number", "Invoice", "Practitioner", "Type", "Item", "Modifiers", "Units", "Amount", "Reference", "Payer"],
  forbidden: [], header: { verified: false, basis: JANE },
  columns: [d("date", "Date", true, false, JANE), t("patient_key", "Patient Number", true, false, JANE), t("visit_ref", "Invoice", true, false, JANE),
    t("provider", "Practitioner", false, false, JANE), { name: "entry", from: "Type", type: "map", map: ENTRY, required: true, verified: false, basis: JANE },
    t("code", "Item", true, false, JANE), t("modifiers", "Modifiers", false, false, JANE), n("units", "Units", false, false, JANE),
    c("cents", "Amount", true, false, `${JANE}; charges positive, payments and adjustments negative`), t("ref", "Reference", false, false, JANE), t("payer", "Payer", false, false, JANE)],
};
const INSURANCE_METHODS = ["EFT", "Manual EOB", "Insurance Check"] as const;
export const JANE_PAYMENTS_REFUNDS_FEES: ChiroLayout = {
  id: "prms/jane/payments-refunds-fees", title: "Jane Payments, Refunds and Fees report, Detail view (names from Jane's guide; export UNCONFIRMED)", prefix: "JANE-PAYMENTS-REFUNDS-FEES-",
  headers: ["Date", "Payor name", "Payment method", "Reference number", "Invoice number", "Amount", "Processing fees", "Amount paid to the clinic"],
  forbidden: [], key: ["payment_id"], header: { verified: false, basis: JANE_PRF },
  identities: [{ name: "Amount paid to the clinic = Amount - Processing fees (Jane guide)", failsWhen: "net_cents <> cents - fee_cents" }],
  columns: [d("date", "Date", true, false, JANE_PRF),
    { name: "payer", from: "Payor name", type: "text", onlyWhen: { column: "Payment method", in: INSURANCE_METHODS }, required: false, verified: false,
      basis: `${JANE_PRF}; Payor name can be a patient's name, so it is loaded only on insurance methods (${INSURANCE_METHODS.join(", ")}), ASSUMPTION that those carry the payer's organisation name` },
    t("method", "Payment method", true, false, JANE_PRF), t("ref_id", "Reference number", false, false, JANE_PRF),
    t("payment_id", "Invoice number", true, false, `${JANE_PRF}; the generator writes its payment ID here (a real export has the invoice number when the payment is tied to one)`),
    c("cents", "Amount", true, false, JANE_PRF), c("fee_cents", "Processing fees", true, false, JANE_PRF), c("net_cents", "Amount paid to the clinic", true, false, JANE_PRF)],
};
export const JANE_PAYOUTS: ChiroLayout = {
  id: "processor/jane-payments-payouts", title: "Jane Payments payouts (names from Jane's guide; export UNCONFIRMED)", prefix: "JANEPAY-PAYOUTS-",
  headers: ["Date Created", "Date Deposited", "Payout Amount", "Payout Status"],
  forbidden: [], header: { verified: false, basis: JANE_PO },
  columns: [d("date_created", "Date Created", true, false, JANE_PO), d("date_deposited", "Date Deposited", true, false, JANE_PO),
    c("payout_cents", "Payout Amount", true, false, `${JANE_PO}; net of Jane Payments fees, one bank line per payout (guide)`),
    { name: "status", from: "Payout Status", type: "map", map: { paid: "paid", pending: "pending", in_transit: "pending", failed: "failed" }, required: true, verified: false,
      basis: `${JANE_PO}; guide states paid, in transit (pending), failed; the generator writes in_transit` }],
};

// ---------------------------------------------------------------- owner-defined (both PRMS)
export const FEE_SCHEDULE: ChiroLayout = {
  id: "owner/fee-schedule", title: "Contracted fee schedule per payer and CPT (owner-defined)", prefix: "FEESCHED-",
  headers: ["Payer Code", "Payer", "CPT", "Allowed"], forbidden: [], key: ["payer_code", "cpt"], header: { verified: false, basis: `${OWN}; owner chose a fee schedule in v1 (design-30 §10 #7)` },
  columns: [t("payer_code", "Payer Code", true, false, OWN), t("payer", "Payer", false, false, OWN), t("cpt", "CPT", true, false, OWN), c("allowed_cents", "Allowed", true, false, OWN)],
};
export const PI_CASES: ChiroLayout = {
  id: "owner/pi-cases", title: "Personal-injury cases: letter of protection, carrier, settlement (owner-defined)", prefix: "PI-CASES-",
  headers: ["Case ID", "Patient ID", "State", "Coverage", "Carrier", "Attorney", "LOP Date", "Billed", "Carrier Paid", "Has Health Insurance", "Status",
    "Settled Date", "Prior Balance", "Settlement Received", "Reduction", "Reduction Approved"],
  forbidden: [], key: ["case_id"], header: { verified: false, basis: OWN },
  columns: [t("case_id", "Case ID", true, false, OWN), t("patient_key", "Patient ID", true, false, OWN), t("state", "State", false, false, OWN),
    t("coverage", "Coverage", false, false, `${OWN}; MA PIP / CT MedPay per design-30 §12`), t("carrier", "Carrier", false, false, OWN),
    t("attorney", "Attorney", false, false, `${OWN}; a law firm, not a person`), d("lop_date", "LOP Date", true, false, OWN), c("billed_cents", "Billed", true, false, OWN),
    c("carrier_paid_cents", "Carrier Paid", true, false, OWN), { name: "has_health_ins", from: "Has Health Insurance", type: "map", map: { yes: "yes", no: "no" }, required: true, verified: false, basis: OWN },
    { name: "status", from: "Status", type: "map", map: { open: "open", settled: "settled" }, required: true, verified: false, basis: OWN },
    d("settled_date", "Settled Date", false, false, OWN), c("prior_balance_cents", "Prior Balance", true, false, OWN), c("settlement_cents", "Settlement Received", true, false, OWN),
    c("reduction_cents", "Reduction", true, false, OWN), t("reduction_approved", "Reduction Approved", false, false, OWN)],
};
export const CARE_PLANS: ChiroLayout = {
  id: "owner/care-plans", title: "Prepaid care plans: price, visits used, collected, earned, unearned (owner-defined)", prefix: "CAREPLANS-",
  headers: ["Plan ID", "Patient ID", "Start Date", "Visits Bought", "Price", "Payment", "Visits Used", "Collected", "Earned", "Unearned"],
  forbidden: [], key: ["plan_id"], header: { verified: false, basis: OWN },
  identities: [{ name: "Unearned = Collected - Earned", failsWhen: "unearned_cents <> collected_cents - earned_cents" }],
  columns: [t("plan_id", "Plan ID", true, false, OWN), t("patient_key", "Patient ID", true, false, OWN), d("start_date", "Start Date", true, false, OWN),
    n("visits_bought", "Visits Bought", true, false, OWN), c("price_cents", "Price", true, false, OWN), t("payment", "Payment", true, false, OWN),
    n("visits_used", "Visits Used", true, false, OWN), c("collected_cents", "Collected", true, false, OWN), c("earned_cents", "Earned", true, false, OWN),
    c("unearned_cents", "Unearned", true, false, `${OWN}; pro-rata by visits is an ASSUMPTION (design-30 §12: no MA/CT rule found)`)],
};

export const CHIRO_LAYOUTS: readonly ChiroLayout[] = [CT_PATIENTS, CT_DAYSHEET, CT_DEPOSITS, CT_PAYMENTS, CASH_PRACTICE,
  JANE_PATIENTS, JANE_TRANSACTIONS, JANE_PAYMENTS_REFUNDS_FEES, JANE_PAYOUTS, FEE_SCHEDULE, PI_CASES, CARE_PLANS];

/** True when the first non-blank line is exactly this layout's header (BOM already removed by firstLines). */
export function detectChiro(layout: ChiroLayout, lines: readonly string[]): boolean {
  const h = headerOf(lines);
  return h.length === layout.headers.length && layout.headers.every((x, i) => h[i] === x);
}

/** Problems in a layout spec (empty = sound). Checked by the test and again when an adapter is built. */
export function specProblems(l: ChiroLayout): string[] {
  const out: string[] = [];
  const once = (h: string) => l.headers.filter((x) => x === h).length === 1;
  const names = new Set<string>();
  if (!l.header.basis.trim()) out.push(`${l.id}: header basis is empty`);
  for (const col of l.columns) {
    if (names.has(col.name)) out.push(`${l.id}: canonical column ${col.name} twice`);
    names.add(col.name);
    if (!col.basis.trim()) out.push(`${l.id}.${col.name}: basis is empty`);
    const froms = typeof col.from === "string" ? [col.from] : [...col.from];
    if ((col.type === "name_key") !== (froms.length === 2)) out.push(`${l.id}.${col.name}: name_key takes [last, first]; other types one header`);
    for (const h of froms) {
      if (!once(h)) out.push(`${l.id}.${col.name}: header "${h}" is not exactly once in the layout`);
      if (col.type !== "name_key" && l.forbidden.includes(h)) out.push(`${l.id}.${col.name}: header "${h}" is forbidden (person name)`);
    }
    if (col.type === "map" && (!col.map || !Object.keys(col.map).length)) out.push(`${l.id}.${col.name}: map is empty`);
    if (col.onlyWhen && !once(col.onlyWhen.column)) out.push(`${l.id}.${col.name}: onlyWhen column "${col.onlyWhen.column}" is not in the layout`);
    if (col.verified && /UNVERIFIED|UNCONFIRMED|ASSUMPTION/.test(col.basis)) out.push(`${l.id}.${col.name}: verified, but its basis says otherwise`);
  }
  for (const k of [...(l.key ?? []), "row"]) if (k !== "row" && !names.has(k)) out.push(`${l.id}: key column ${k} is not a canonical column`);
  if (names.has("row")) out.push(`${l.id}: "row" is reserved`);
  return out;
}

/** Canonical columns of a layout's table, in load order ("row" first: line in the file). */
export const chiroColumns = (l: ChiroLayout): string[] => ["row", ...l.columns.map((x) => x.name)];
/** Names of the columns (and the header) not yet verified against a real export. */
export const unverifiedOf = (l: ChiroLayout): string[] => [...(l.header.verified ? [] : ["header"]), ...l.columns.filter((x) => !x.verified).map((x) => x.name)];

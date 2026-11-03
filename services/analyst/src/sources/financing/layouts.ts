/**
 * Header signatures of the financing exports, read from the owner's GLOBAL-*-sample-fin-csv.csv samples (Phase 4c; 4a.2 had
 * header-only files). The Cherry export has an unnamed column after Reference (a second loan reference); exports end in empty
 * columns. Pure (no
 * DuckDB) so detection and config checks can be tested anywhere. Forbidden columns are never loaded nor mappable.
 */
import type { FinancingLayout } from "./spec.ts";

export const CARECREDIT_LAYOUT: FinancingLayout = {
  provider: "carecredit",
  headers: ["Merchant ID", "Date", "Name", "Amount", "Promo Code", "Type"],
  trailingEmptyOk: true,
  forbidden: ["Name"],
};

export const CHERRY_LAYOUT: FinancingLayout = {
  provider: "cherry",
  headers: ["Date", "Reference", "", "Phone", "Patient", "Gross Sales", "Refunds", "Fees", "Net Sale"],
  trailingEmptyOk: true,
  forbidden: ["Phone", "Patient"],
};

export const HFD_LAYOUT: FinancingLayout = {
  provider: "hfd",
  headers: ["Activation Date", "HFDID", "Applicant", "Funding Release Date", "Bank Account Last 4", "Treatment Amount", "Grade", "Patient ID", "Type",
    "Discount Rate", "Discount", "Amount", "Financed Amount", "Practice Name", "Bank Account Last 4", "Routing Number Last 4", "Doc Stamp Tax"],
  trailingEmptyOk: true,
  forbidden: ["Applicant", "Bank Account Last 4", "Routing Number Last 4"],
};

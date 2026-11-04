/**
 * finance/rcm: revenue-cycle files (practice-management ledger and deposit detail, bank statement, patient list) for any
 * specialty. Extends finance-generic explicitly: the role-name hints and party priority are inherited; kinds, file-name
 * hints, flow and measures are RCM's.
 * privateAI-design-30 §6.1 (chiro is the second specialty, DESIGN/xrplh-24 §5.3): adds the specialty-neutral kinds coverage
 * (insurance policies: payer, plan, priority, limits), remittance (ERA 835: adapter remit/x12-835) and ar_aging (aging snapshot).
 * Their hints come after the existing ones (first match wins), so a file the dental hints classified keeps its kind.
 */
import type { DomainPack } from "../../../core/ports.ts";

export const FINANCE_RCM: DomainPack = {
  id: "finance/rcm",
  title: "Revenue cycle (RCM): ledger, ERA remittance, deposit detail, bank, patient list, coverage, A/R aging",
  extends: "finance-generic",
  kinds: ["ledger", "remittance", "deposit_detail", "bank", "patient_list", "coverage", "ar_aging", "adjustments", "other"],
  kindHints: [
    ["deposit_detail", /bank.?dep|deposit.?det/i],
    ["ledger", /per.?sum|ledger|day.?sheet/i],
    ["patient_list", /patient|\bspr\b/i],
    ["bank", /bank|stmt|statement/i],
    ["adjustments", /adjust|write.?off/i],
    ["remittance", /^era[-_ ]|\.835$|remit/i],
    ["ar_aging", /aging/i],
    ["coverage", /insur.*polic|polic.*insur|coverage/i],
  ],
  flowOrder: ["ledger", "remittance", "deposit_detail", "bank"],
  excludeFromFlow: ["adjustments", "patient_list", "coverage", "ar_aging"],
  defaultMeasure: { ledger: "net", remittance: "abs", deposit_detail: "inflows", bank: "inflows", patient_list: "net", coverage: "net", ar_aging: "net", adjustments: "abs", other: "net" },
};

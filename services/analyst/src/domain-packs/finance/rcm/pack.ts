/**
 * finance/rcm: revenue-cycle files (practice-management ledger and deposit detail, bank statement, patient list) for any
 * specialty. Extends finance-generic explicitly: the role-name hints and party priority are inherited; kinds, file-name
 * hints, flow and measures are RCM's. Kept thin until a second specialty needs more here (DESIGN/xrplh-24 §5.3).
 */
import type { DomainPack } from "../../../core/ports.ts";

export const FINANCE_RCM: DomainPack = {
  id: "finance/rcm",
  title: "Revenue cycle (RCM): ledger, deposit detail, bank, patient list",
  extends: "finance-generic",
  kinds: ["ledger", "deposit_detail", "bank", "patient_list", "adjustments", "other"],
  kindHints: [
    ["deposit_detail", /bank.?dep|deposit.?det/i],
    ["ledger", /per.?sum|ledger|day.?sheet/i],
    ["patient_list", /patient|\bspr\b/i],
    ["bank", /bank|stmt|statement/i],
    ["adjustments", /adjust|write.?off/i],
  ],
  flowOrder: ["ledger", "deposit_detail", "bank"],
  excludeFromFlow: ["adjustments", "patient_list"],
  defaultMeasure: { ledger: "net", deposit_detail: "inflows", bank: "inflows", patient_list: "net", adjustments: "abs", other: "net" },
};

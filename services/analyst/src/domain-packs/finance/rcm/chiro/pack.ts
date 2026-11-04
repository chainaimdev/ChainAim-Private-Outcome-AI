/**
 * finance/rcm/chiro: US chiropractic practices on ChiroTouch (folder prms/chiro-1-chirotouch) or Jane (prms/chiro-2-jane),
 * privateAI-design-30 §8. Extends finance/rcm explicitly (finance -> rcm -> chiro, 3 levels).
 * This pack holds what is known now: the file kinds of design-30 §3 and the owner's file-name prefixes (§8.3): CT-* and
 * JANE-* (PRMS reports), CTPAY-* / JANEPAY-* / CASHPRAC-* (card, payout and auto-debit processors), ERA-*.835, BANK-ST-*,
 * PI-CASES-*, CAREPLANS-*. Hints only propose a kind; the owner confirms the recipe.
 * Not here yet, on purpose: `reconcile` and `sourceConfigs`. They need the ChiroTouch and Jane export layouts, which are
 * UNVERIFIED (no published headers; design-30 §3), and the owner's answers in design-30 §10. They are added with the
 * layouts/chirotouch and layouts/jane adapters, each value as { value, verified, basis }.
 */
import type { DomainPack } from "../../../../core/ports.ts";

export const FINANCE_RCM_CHIRO: DomainPack = {
  id: "finance/rcm/chiro",
  title: "Chiropractic RCM: ChiroTouch or Jane reports, ERA 835, card/payout/auto-debit processors, Bank of America, PI cases, care plans",
  extends: "finance/rcm",
  kinds: ["ledger", "remittance", "deposit_detail", "processor", "bank", "patient_list", "coverage", "ar_aging", "pi_case", "prepay_plan", "adjustments", "other"],
  kindHints: [
    ["remittance", /^era[-_ ]|\.835$|remit/i],
    ["processor", /^(ctpay|janepay|cashprac)[-_ ]/i],
    ["pi_case", /^pi[-_ ]cases/i],
    ["prepay_plan", /^careplans|care.?plan|package|membership/i],
    ["bank", /^bank[-_ ]st/i],
    ["ar_aging", /aging/i],
    ["coverage", /insur.*polic|polic.*insur|coverage|insurers/i],
    ["patient_list", /patient/i],
    ["deposit_detail", /deposit|payments.?refunds|cash.?out/i],
    ["ledger", /day.?sheet|transaction|ledger/i],
    ["adjustments", /adjust|write.?off/i],
    ["bank", /bank|stmt|statement/i],
  ],
  flowOrder: ["ledger", "remittance", "deposit_detail", "processor", "bank"],
  excludeFromFlow: ["adjustments", "patient_list", "coverage", "ar_aging", "pi_case", "prepay_plan"],
  defaultMeasure: { ledger: "net", remittance: "abs", deposit_detail: "inflows", processor: "inflows", bank: "inflows", patient_list: "net",
    coverage: "net", ar_aging: "net", pi_case: "abs", prepay_plan: "abs", adjustments: "abs", other: "net" },
};

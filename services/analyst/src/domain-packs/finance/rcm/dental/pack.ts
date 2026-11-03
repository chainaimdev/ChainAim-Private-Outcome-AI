/**
 * finance/rcm/dental: dental practices on Curve Hero banking with Bank of America (first build, Phase 4a). Extends
 * finance/rcm explicitly; adds the deposit reconciliation config (method groups, lag windows, payer aliases), which holds
 * only values from the owner's samples and the owner-approved generator, each with its basis; and (Phase 4a.2) the
 * financing source config, header-only and marked unverified.
 */
import type { DomainPack } from "../../../../core/ports.ts";

export const FINANCE_RCM_DENTAL: DomainPack = {
  id: "finance/rcm/dental",
  title: "Dental RCM: Curve Hero ledger and deposit detail, Bank of America statement, patient list",
  extends: "finance/rcm",
  reconcile: "domain-packs/finance/rcm/dental/reconcile.json",
  // Phase 4a.2: patient-financing exports (CareCredit, Cherry, HFD); every rule in it is UNVERIFIED until real-format rows arrive.
  sourceConfigs: { financing: "domain-packs/finance/rcm/dental/financing.json" },
};

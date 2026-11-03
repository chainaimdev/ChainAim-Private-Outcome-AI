/**
 * CareCredit export (Phase 4a.2): header signature read from the owner's header-only GLOBAL-CareCredit.csv (6 named columns,
 * then empty header cells, which are tolerated). Name is never loaded. Rules (dates, amounts, Type -> kind, bank amount) come
 * from the pack's financing config; all UNVERIFIED until real-format rows arrive (DESIGN/xrplh-25 §13).
 */
import type { SourceAdapter } from "../../core/ports.ts";
import { loadFinancing } from "./load.ts";
import { CARECREDIT_LAYOUT } from "./layouts.ts";
import { FINANCING_COLUMNS, detectLayout } from "./spec.ts";

export const CARECREDIT: SourceAdapter = {
  id: "financing/carecredit",
  title: "CareCredit export (financing; rules UNVERIFIED)",
  columns: FINANCING_COLUMNS,
  detect: (lines) => detectLayout(CARECREDIT_LAYOUT, lines),
  load(db, table, path, opt) { return loadFinancing(this.id, CARECREDIT_LAYOUT, db, table, path, opt); },
};

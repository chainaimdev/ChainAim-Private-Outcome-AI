/**
 * HFD export (Phase 4a.2): header signature read from the owner's header-only GLOBAL-HFD.csv ("Bank Account Last 4" appears
 * twice, so the file is read by position). Applicant, bank-account and routing digits are never loaded. Rules come from the
 * pack's financing config; all UNVERIFIED until real-format rows arrive (DESIGN/xrplh-25 §13).
 */
import type { SourceAdapter } from "../../core/ports.ts";
import { loadFinancing } from "./load.ts";
import { HFD_LAYOUT } from "./layouts.ts";
import { FINANCING_COLUMNS, detectLayout } from "./spec.ts";

export const HFD: SourceAdapter = {
  id: "financing/hfd",
  title: "HFD export (financing; rules UNVERIFIED)",
  columns: FINANCING_COLUMNS,
  detect: (lines) => detectLayout(HFD_LAYOUT, lines),
  load(db, table, path, opt) { return loadFinancing(this.id, HFD_LAYOUT, db, table, path, opt); },
};

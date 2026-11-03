/** The built-in source adapters (file layouts). Only main.ts (the composition root) and tools import this file. */
import type { SourceAdapter } from "../core/ports.ts";
import { BOFA_STATEMENT } from "./bank/bofa.ts";
import { CURVE_DEPOSIT_DETAIL } from "./pms/curve-hero/deposit-detail.ts";
import { CURVE_LEDGER } from "./pms/curve-hero/ledger.ts";
import { CURVE_PATIENT_LIST } from "./pms/curve-hero/patient-list.ts";
import { CURVE_PROCEDURES } from "./pms/curve-hero/procedures.ts";
import { CARECREDIT } from "./financing/carecredit.ts";
import { CHERRY } from "./financing/cherry.ts";
import { HFD } from "./financing/hfd.ts";

export const BUILT_IN_SOURCES: readonly SourceAdapter[] = [BOFA_STATEMENT, CURVE_DEPOSIT_DETAIL, CURVE_LEDGER, CURVE_PATIENT_LIST, CURVE_PROCEDURES, CARECREDIT, CHERRY, HFD];

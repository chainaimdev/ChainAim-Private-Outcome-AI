/**
 * The built-in domain packs. Only main.ts (the composition root) imports this file; core and engines never do.
 * Add a pack here and give it an explicit `extends` (DESIGN/xrplh-24 §5.3: finance -> rcm -> dental | chiro, at most 3 levels).
 */
import type { DomainPack } from "../core/ports.ts";
import { FINANCE_GENERIC } from "./finance/pack.ts";
import { FINANCE_RCM } from "./finance/rcm/pack.ts";
import { FINANCE_RCM_DENTAL } from "./finance/rcm/dental/pack.ts";
import { FINANCE_RCM_CHIRO } from "./finance/rcm/chiro/pack.ts";

export const DEFAULT_PACK = FINANCE_GENERIC.id;
export const BUILT_IN_PACKS: readonly DomainPack[] = [FINANCE_GENERIC, FINANCE_RCM, FINANCE_RCM_DENTAL, FINANCE_RCM_CHIRO];

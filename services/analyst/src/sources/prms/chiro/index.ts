/** The chiro source adapters (privateAI-design-30 §11, CHIRO-1b-2 stage 2), one per layout in layouts.ts. */
import type { SourceAdapter } from "../../../core/ports.ts";
import { chiroAdapter } from "./load.ts";
import { CHIRO_LAYOUTS } from "./layouts.ts";

export const CHIRO_SOURCES: readonly SourceAdapter[] = CHIRO_LAYOUTS.map(chiroAdapter);

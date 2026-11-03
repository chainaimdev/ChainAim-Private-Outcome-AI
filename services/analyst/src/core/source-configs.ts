/**
 * Reads a resolved pack's sourceConfigs (Phase 4a.2): key -> JSON file under the config root, parsed and handed to source
 * adapters as SourceOptions.configs. Core never interprets the content; each adapter validates its own slice. A path that
 * leaves the config root, a missing file or bad JSON is an error naming the pack and the key (never silently skipped).
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ResolvedPack } from "./ports.ts";

export function readSourceConfigs(pack: Pick<ResolvedPack, "id" | "sourceConfigs">, configRoot: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const root = resolve(configRoot);
  for (const [key, rel] of Object.entries(pack.sourceConfigs ?? {})) {
    const path = resolve(root, rel);
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`pack ${pack.id}: sourceConfigs.${key} (${rel}) is outside the config root`);
    let text: string;
    try { text = readFileSync(path, "utf8").replace(/^\uFEFF/, ""); } catch (e) { throw new Error(`pack ${pack.id}: sourceConfigs.${key}: cannot read ${rel} (${(e as Error).message})`); }
    try { out[key] = JSON.parse(text); } catch (e) { throw new Error(`pack ${pack.id}: sourceConfigs.${key}: ${rel} is not valid JSON (${(e as Error).message})`); }
  }
  return out;
}

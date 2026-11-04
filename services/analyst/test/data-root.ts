/**
 * Where the tests find the owner's git-ignored dental data (Phase 4c): DENTAL_DATA_ROOT, default <repo>/sample-data/prms/dent-prms-c-sample.
 * SAMPLES = the owner's anonymized real-format exports; SET(name) = a generated set folder (tools/dental-synth) under it.
 */
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const env = process.env.DENTAL_DATA_ROOT?.trim();
export const DATA_ROOT = env ? (isAbsolute(env) ? env : resolve(REPO, env)) : join(REPO, "sample-data", "prms", "dent-prms-c-sample");
export const SAMPLES = join(DATA_ROOT, "sample-prms-fin");
export const SET = (...parts: string[]): string => join(DATA_ROOT, ...parts);

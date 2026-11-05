/**
 * The REAL near-watch HTTP server (chainaim-adminUI-NEAR services/near-watch/src/server.ts, the class its main.ts runs),
 * started in this process from its own code on a free loopback port, with an in-memory store and its own Roads and
 * LiveOps, so the console's job feed (test-console/console/job-feed.ts, adminUI architecture-adminui-jobs.md ARCH-205)
 * posts to the parser and store that run in production. near-watch has no runtime dependencies (node:sqlite is built
 * in), so nothing is installed. Where its checkout is: locateNearWatch below (env, config/local/repos.json, sibling).
 * The same launcher as test-console/test/near-watch-server.ts, kept in this unit: check-deps forbids scripts (the
 * gateway unit) importing test-console.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// ---- locate near-watch (privateAI-design-31 §4). Keep this block identical in scripts/test/near-watch-server.ts and
// test-console/test/near-watch-server.ts (check-deps forbids one importing the other; scripts/test/near-watch-locate.test.ts
// compares them). Order: 1. env NEAR_WATCH_DIR, 2. config/local/repos.json "nearWatchDir" (per PC, git-ignored; copy
// config/local/repos.example.json), 3. the sibling folder ../chainaim-adminUI-NEAR. A relative path is resolved from this
// repository's root, never from the current folder. Not found: the tests that need it are skipped with the reason, unless
// REQUIRE_NEAR_WATCH=1 (then they fail with the same reason).
export type NearWatchLocation = { dir: string; source: string; found: boolean };
export function locateNearWatch(root: string = ROOT, env: Record<string, string | undefined> = process.env): NearWatchLocation {
  const fromRoot = (p: string) => (isAbsolute(p) ? resolve(p) : resolve(root, p));
  const fromEnv = env.NEAR_WATCH_DIR?.trim();
  let dir: string, source: string;
  if (fromEnv) { dir = fromRoot(fromEnv); source = "env NEAR_WATCH_DIR"; }
  else {
    const file = join(root, "config", "local", "repos.json");
    let fromFile: string | undefined;
    if (existsSync(file)) {
      let cfg: { nearWatchDir?: unknown };
      try { cfg = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { throw new Error(`config/local/repos.json is not valid JSON: ${(e as Error).message}`); }
      if (cfg.nearWatchDir !== undefined && (typeof cfg.nearWatchDir !== "string" || !cfg.nearWatchDir.trim())) throw new Error("config/local/repos.json: nearWatchDir must be a non-empty path (absolute, or relative to the repository root)");
      fromFile = typeof cfg.nearWatchDir === "string" ? cfg.nearWatchDir.trim() : undefined;
    }
    if (fromFile) { dir = fromRoot(fromFile); source = "config/local/repos.json nearWatchDir"; }
    else { dir = resolve(root, "..", "chainaim-adminUI-NEAR", "services", "near-watch"); source = "default: the sibling folder ../chainaim-adminUI-NEAR"; }
  }
  return { dir, source, found: existsSync(join(dir, "src", "server.ts")) };
}
export const nearWatchMissing = (loc: NearWatchLocation): string =>
  `near-watch is not at ${loc.dir} (from ${loc.source}): set "nearWatchDir" in config/local/repos.json (copy config/local/repos.example.json) or the env NEAR_WATCH_DIR`;
/** node:test option for the tests that need near-watch: false (run) when found or REQUIRE_NEAR_WATCH=1, else the skip reason. */
export function nearWatchSkip(loc: NearWatchLocation = NEAR_WATCH, env: Record<string, string | undefined> = process.env): string | false {
  return loc.found || env.REQUIRE_NEAR_WATCH === "1" ? false : nearWatchMissing(loc);
}
export const NEAR_WATCH = locateNearWatch();
export const NEAR_WATCH_DIR = NEAR_WATCH.dir;
// ---- end locate near-watch
export const INGEST_KEY = "job-feed-test-ingest-key-0123456789";
const ADMIN_KEY = "job-feed-test-admin-key-0123456789ab";
/** The token contract near-watch counts here: the recorded testnet USDC (it reads no chain in these tests). */
const CONTRACT = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

export type NearWatch = {
  /** POST target for the job feed. */
  ingestUrl: string;
  base: string;
  adminKey: string;
  store: { getJob(id: string): { state: string; steps: unknown; breakdown: unknown; amount: string | null; totalUsd: string | null } | undefined; hasJobs(): boolean };
  liveOps: { jobs: { counters: { events: number; repeats: number } }; counters: { refused: number } };
  close: () => Promise<void>;
};

export async function startNearWatch(): Promise<NearWatch> {
  if (!NEAR_WATCH.found) throw new Error(nearWatchMissing(NEAR_WATCH));
  const mod = async (name: string) => import(pathToFileURL(join(NEAR_WATCH_DIR, "src", name)).href);
  const [{ Bus }, { LiveOps }, { Roads }, { WatchServer }, { Store }] = await Promise.all(["events.ts", "liveops.ts", "roads.ts", "server.ts", "store.ts"].map(mod));
  const network = "testnet";
  const payTo = "chainaim-payto-seller.testnet";
  const watchlist = [{ network, label: "paywall", role: "payto", address: payTo, source: "paywall" }];
  const store = new Store(":memory:");
  const bus = new Bus();
  const roads = new Roads(store, bus, { usdcContract: CONTRACT, decimals: 6, watched: new Map([[network, new Set([payTo])]]), payTo: new Map([[network, new Set([payTo])]]) });
  const liveOps = new LiveOps(store, bus, {
    networks: [network], caips: { "near:testnet": network }, watchlist, graceBlocks: 5, lowCalls: 0, reconcileSec: 3600, reconcileBatch: 100,
    metricsWindowSec: 3600, alertEverySec: 60, paywallLogFile: null, paywallLogPollMs: 1000,
  });
  const server = new WatchServer(
    { adminKey: ADMIN_KEY, networks: [network], watchlist, sseReplay: 10, sseHeartbeatSec: 30, sseMaxClients: 4, version: "job-feed-test", startedAt: Date.now(), ingestKey: INGEST_KEY },
    store, bus, roads, liveOps,
  );
  const addr = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    ingestUrl: `${base}/ingest/job`, base, adminKey: ADMIN_KEY, store, liveOps,
    close: async () => { liveOps.stop(); await server.close(); store.close(); },
  };
}

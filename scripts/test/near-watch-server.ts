/**
 * The REAL near-watch HTTP server (chainaim-adminUI-NEAR services/near-watch/src/server.ts, the class its main.ts runs),
 * started in this process from its own code on a free loopback port, with an in-memory store and its own Roads and
 * LiveOps, so the console's job feed (test-console/console/job-feed.ts, adminUI architecture-adminui-jobs.md ARCH-205)
 * posts to the parser and store that run in production. near-watch has no runtime dependencies (node:sqlite is built
 * in), so nothing is installed. Its checkout is the sibling folder ../chainaim-adminUI-NEAR, or NEAR_WATCH_DIR.
 * The same launcher as test-console/test/near-watch-server.ts, kept in this unit: check-deps forbids scripts (the
 * gateway unit) importing test-console.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const NEAR_WATCH_DIR = resolve(process.env.NEAR_WATCH_DIR ?? join(ROOT, "..", "chainaim-adminUI-NEAR", "services", "near-watch"));
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
  if (!existsSync(join(NEAR_WATCH_DIR, "src", "server.ts"))) throw new Error(`near-watch is not at ${NEAR_WATCH_DIR}: check out chainaim-adminUI-NEAR beside this repo or set NEAR_WATCH_DIR`);
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

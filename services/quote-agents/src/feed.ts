/**
 * Agent-call feed: every call quote-agents answers (or refuses) is also sent, as one small record, to the admin UI's
 * near-watch (chainaim-adminUI-NEAR services/near-watch/src/agent-calls.ts: POST /ingest/agent, ingest key).
 *
 *   {v:1, event:"agent_call", ts, tenant|null, alias|null, path, status, ms, source|null, requestId|null, code|null}
 *
 * Ids, a path, a status, a duration and a source only: never a request or an answer (no SKU, price, budget, cost or
 * message). Fire and forget: a slow or dead feed never delays or fails an answer; a failure is logged at most once a
 * minute. Off unless --feed-url is set and the key variable (--feed-key-env, default NEAR_WATCH_INGEST_KEY) has a value.
 */
import type { Fetch } from "./synthesize.ts";

export type FeedConfig = { url: string; key: string; timeoutMs: number };
export type AgentCallRecord = {
  v: 1; event: "agent_call"; ts: string; tenant: string | null; alias: string | null; path: string; status: number; ms: number;
  source: "rules" | "ai" | null; requestId: string | null; code: string | null;
};

const TENANT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PATH = /^\/?[a-z0-9][a-z0-9\/._-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const pick = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);

/** The record near-watch accepts, from what quote-agents logged; fields that would not pass its strict parser are dropped. */
export function agentCallRecord(fields: { tenant?: unknown; alias?: unknown; path?: unknown; status: number; ms: number; source?: unknown; requestId?: unknown; code?: unknown }, now = new Date()): AgentCallRecord {
  return {
    v: 1,
    event: "agent_call",
    ts: now.toISOString(),
    tenant: pick(fields.tenant, TENANT),
    alias: pick(fields.alias, ALIAS),
    path: pick(fields.path, PATH) ?? "/unknown",
    status: fields.status,
    ms: Math.max(0, Math.min(600_000, Math.round(fields.ms))),
    source: fields.source === "rules" || fields.source === "ai" ? fields.source : null,
    requestId: pick(fields.requestId, REQUEST_ID),
    code: pick(fields.code, CODE),
  };
}

export function createFeed(cfg: FeedConfig | null, f: Fetch, warn: (message: string) => void = () => {}): { send(r: AgentCallRecord): void } | null {
  if (!cfg) return null;
  const url = `${cfg.url}/ingest/agent`;
  let lastWarn = 0;
  return {
    send(r) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      void f(url, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": cfg.key }, body: JSON.stringify(r), signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await res.body?.cancel();
        })
        .catch((e: unknown) => {
          if (Date.now() - lastWarn < 60_000) return;
          lastWarn = Date.now();
          warn(`agent-call feed to ${cfg.url} failed: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message}`);
        })
        .finally(() => clearTimeout(timer));
    },
  };
}

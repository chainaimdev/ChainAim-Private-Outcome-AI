/**
 * Payment log sink (live ops, Phase 2): hands each payment_settled line to
 * ledger-watch without ever holding up the paid response.
 *
 *   url   POST the line to ledger-watch's /ingest/claim with the ingest key
 *         (x-ingest-key), abandoned after timeoutMs; at most maxInflight POSTs at
 *         once, beyond that the line is dropped and counted. A failure is counted
 *         and reported on the paywall's own log at most once a minute, never with
 *         the key or the line.
 *   file  append the line to a file (one write stream, so lines stay whole and in
 *         order); ledger-watch follows it with --paywall-log-file. A write error
 *         is reported once; later lines are still tried.
 * Both may be on at once: the file then holds every line even when a POST is
 * dropped, and ledger-watch keys claims by transaction hash, so a line that
 * arrives by both roads is counted once.
 *
 * send() never throws and never returns a promise to wait on.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PaymentLogConfig } from "./config.ts";

export type SinkStats = { sent: number; failed: number; dropped: number; written: number; writeErrors: number };

export type PaymentSink = {
  send(line: string): void;
  stats(): SinkStats;
  /** Wait for POSTs in flight and close the file. */
  close(): Promise<void>;
};

export type SinkDeps = {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
};

export function createSink(config: PaymentLogConfig, deps: SinkDeps = {}): PaymentSink {
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((line: string) => console.error(line));
  const now = deps.now ?? Date.now;
  const stats: SinkStats = { sent: 0, failed: 0, dropped: 0, written: 0, writeErrors: 0 };
  const inflight = new Set<Promise<void>>();
  let lastReport = Number.NEGATIVE_INFINITY;

  const report = (what: string): void => {
    const t = now();
    if (t - lastReport < 60_000) return;
    lastReport = t;
    log(JSON.stringify({ ts: new Date(t).toISOString(), event: "payment_log_sink", problem: what, ...stats }));
  };

  let stream: WriteStream | null = null;
  if (config.file) {
    const path = resolve(config.file);
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
    stream.on("error", (e: Error) => {
      stats.writeErrors += 1;
      report(`cannot write the payment log file: ${e.message}`);
    });
  }

  const post = (line: string): void => {
    if (!config.url) return;
    if (inflight.size >= config.maxInflight) {
      stats.dropped += 1;
      report("too many payment log POSTs in flight; a line was dropped");
      return;
    }
    const p = doFetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-key": config.key ?? "" },
      body: line,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
      .then(async (r) => {
        await r.body?.cancel().catch(() => undefined);
        if (r.ok) stats.sent += 1;
        else {
          stats.failed += 1;
          report(`ledger-watch answered HTTP ${r.status}`);
        }
      })
      .catch((e: unknown) => {
        stats.failed += 1;
        report(`ledger-watch did not answer: ${e instanceof Error ? e.name : "error"}`);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  return {
    send(line: string): void {
      try {
        if (stream && !stream.destroyed) {
          stream.write(`${line}\n`);
          stats.written += 1;
        }
        post(line);
      } catch (e) {
        stats.failed += 1;
        report(`payment log sink error: ${(e as Error).message}`);
      }
    },
    stats: () => ({ ...stats }),
    async close(): Promise<void> {
      await Promise.allSettled([...inflight]);
      const s = stream;
      if (s && !s.destroyed) await new Promise<void>((done) => s.end(() => done()));
    },
  };
}

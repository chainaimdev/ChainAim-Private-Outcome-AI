/**
 * Run log for "Ask across files" (privateAI-design-31 §3). One JSON line per question, in <dir>/crossask-YYYY-MM-DD.jsonl,
 * so a run can be read back later (by the owner, or by Claude from the repo folder) instead of being lost when the page
 * re-renders. Modes (--run-log):
 *   off   nothing is written.
 *   meta  no data values: question, folder, models, the schema the query model was given (headers only), every SQL attempt and its error, result columns, row count, how many
 *         answer figures were checked / not found, warnings, what was sent to a model. Safe on real data.
 *   full  meta plus the result rows (first --run-log-max-rows), the answer, the figures not found and their possible
 *         derivations, and each model reply's text. For synthetic data: rows and replies can hold patient data.
 * Files older than --run-log-keep-days are removed when the server starts and when the day changes; only files named
 * crossask-YYYY-MM-DD.jsonl in that folder are ever touched. A write failure is reported to the caller, never thrown.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const RUN_LOG_MODES = ["off", "meta", "full"] as const;
export type RunLogMode = (typeof RUN_LOG_MODES)[number];
export type RunLogOptions = { mode: RunLogMode; dir: string; maxRows: number; keepDays: number };

/** What the server knows about one question (the crossAsk input and its result, or the error). */
export type RunInput = { folder: string; question: string; model: string; answerModel?: string; phrase: string; userSql: boolean };
type Out = {
  schema?: string; attempts?: { sql?: string | null; error?: string | null }[]; sql?: string | null;
  result?: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null;
  answer?: string | null; unverified?: string[]; derivations?: Record<string, string>; warnings?: string[]; error?: string;
  served?: { text?: string; model?: string; zone?: string }[]; sentToModel?: { step: string; chars: number; hasData: boolean }[];
};

const FILE = /^crossask-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The record for one run (pure). */
export function runRecord(id: string, at: Date, mode: Exclude<RunLogMode, "off">, maxRows: number, input: RunInput, out: Out | null, error?: string, ms?: number): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    id, ts: at.toISOString(), mode, ms: ms ?? null, folder: input.folder, question: input.question, model: input.model,
    answerModel: input.answerModel ?? null, phrase: input.phrase, userSql: input.userSql,
    schema: out?.schema ?? null, // column names and relations only (what the query model is given): no data values
    attempts: (out?.attempts ?? []).map((a) => ({ sql: a.sql ?? null, error: a.error ?? null })), sql: out?.sql ?? null,
    result: out?.result ? { columns: out.result.columns, rowCount: out.result.rows.length, truncated: out.result.truncated } : null,
    answer: out?.answer == null ? null : { chars: out.answer.length, figuresNotFound: out.unverified?.length ?? 0, derived: Object.keys(out.derivations ?? {}).length },
    warnings: out?.warnings ?? [], error: error ?? out?.error ?? null,
    served: (out?.served ?? []).map((s) => ({ model: s.model ?? null, zone: s.zone ?? null })), sentToModel: out?.sentToModel ?? [],
  };
  if (mode === "full" && out) {
    if (out.result) (rec.result as Record<string, unknown>).rows = out.result.rows.slice(0, maxRows);
    if (out.answer != null) Object.assign(rec.answer as Record<string, unknown>, { text: out.answer, notFound: out.unverified ?? [], derivations: out.derivations ?? {} });
    rec.served = (out.served ?? []).map((s) => ({ model: s.model ?? null, zone: s.zone ?? null, text: s.text ?? null }));
  }
  return rec;
}

export class RunLog {
  private pruned = "";
  readonly opt: RunLogOptions;
  private readonly now: () => Date;
  constructor(opt: RunLogOptions, now: () => Date = () => new Date()) {
    this.opt = opt; this.now = now;
    if (!RUN_LOG_MODES.includes(opt.mode)) throw new Error(`--run-log must be one of ${RUN_LOG_MODES.join(", ")}, got ${opt.mode}`);
    if (!Number.isInteger(opt.maxRows) || opt.maxRows < 0) throw new Error(`--run-log-max-rows must be an integer >= 0, got ${opt.maxRows}`);
    if (!Number.isInteger(opt.keepDays) || opt.keepDays < 1) throw new Error(`--run-log-keep-days must be an integer >= 1, got ${opt.keepDays}`);
    if (opt.mode !== "off") this.prune();
  }

  /** Removes run files older than keepDays (by the date in the name). Returns the names removed. */
  prune(): string[] {
    const today = this.now();
    this.pruned = day(today);
    const cutoff = day(new Date(today.getTime() - this.opt.keepDays * 86_400_000));
    let names: string[];
    try { names = readdirSync(this.opt.dir); } catch { return []; }
    const gone: string[] = [];
    for (const n of names) {
      const m = FILE.exec(n);
      if (m && m[1] < cutoff) { try { rmSync(join(this.opt.dir, n)); gone.push(n); } catch { /* left for the next prune */ } }
    }
    return gone;
  }

  /** Appends one run. Returns its id and file, or null when the mode is off; { error } when the write failed. */
  write(input: RunInput, out: Out | null, error?: string, ms?: number): { id: string; mode: RunLogMode; file: string } | { error: string } | null {
    if (this.opt.mode === "off") return null;
    const at = this.now();
    if (day(at) !== this.pruned) this.prune();
    const id = `${at.toISOString().slice(0, 19).replace(/:/g, "")}-${randomBytes(2).toString("hex")}`;
    const file = `crossask-${day(at)}.jsonl`;
    try {
      mkdirSync(this.opt.dir, { recursive: true });
      appendFileSync(join(this.opt.dir, file), JSON.stringify(runRecord(id, at, this.opt.mode, this.opt.maxRows, input, out, error, ms)) + "\n", "utf8");
      return { id, mode: this.opt.mode, file };
    } catch (e) {
      return { error: `run log not written: ${(e as Error).message}` };
    }
  }
}

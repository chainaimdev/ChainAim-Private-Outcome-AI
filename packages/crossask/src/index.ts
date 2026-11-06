/**
 * A question across the CSV/TSV files of one folder, answered with DuckDB first and a model only where it helps:
 *
 *   1. relations  the analyst loads the folder and finds how the files relate (relate.ts): headers, types, overlaps.
 *   2. query      a model writes ONE SELECT from the headers and relations only (no data values are sent), or the
 *                 person gives the query (sql), and then no model is called for it.
 *   3. run        the analyst runs it on the typed tables with file access locked (sqlrun.ts); on an error the model
 *                 gets the error (values blanked) and may try again, sqlRetries times.
 *   4. answer     phrase "llm": the question and the result (at most answerMaxRows rows) go to the model, through the
 *                 gateway, which masks personal data and applies its zone rules (e.g. --phi-zones local), and the
 *                 numbers in the answer are checked against the result. phrase "none": the result table is the answer
 *                 and nothing but headers ever left this PC.
 *
 * Pure: the analyst and the model are passed in, so the console (server.ts, /crossask) and the terminal
 * (scripts/ask.ts) run the same steps, and the tests run them without a network.
 */
import { verifyAnswer, type MoneyVerifyResult } from "./verify.ts";
import { deriveFigure } from "./derive.ts";

/** What an answer's figures are checked against: the computed result AND the user's own question. A figure the user typed
 * ("could it cover an installment of 20,368?") is not something the model made up, so quoting it back is not flagged. */
export function answerEvidence(question: string, table: string): string { return `Question: ${question}\n${table}`; }

export type Msg = { role: "system" | "user" | "assistant"; content: string };
/** usage (ARCH-102): the provider's token counts for this call, from the gateway reply; undefined when the reply has none. */
/**
 * entityCounts / residual (adminUI ARCH-204): what the gateway masked in this call, kinds and counts only, from its
 * x-chainaim-entity-counts / x-chainaim-residual headers (sent only with the gateway's --expose-entity-counts on);
 * absent when the header is absent or malformed.
 */
export type ChatReply = {
  text: string; model?: string; zone?: string; usage?: { promptTokens: number; completionTokens: number };
  entityCounts?: Record<string, number>; residual?: "pass" | "refused";
  /** NEAR AI attestation evidence (PLAN-private-ai-nearai-attestation.md ARCH-411), from the gateway's ARCH-408 headers; absent otherwise. */
  attest?: AttestEvidence;
};
/**
 * What the console hands ca-attest for one call (ARCH-411): the provider's chat id (absent when the gateway had none), the
 * served model id, SHA-256 of the exact request and response bytes, and calledAt = the time just BEFORE this client sent the
 * request (a report only counts if it arrived before that). Ids, hashes and a time only.
 */
export type AttestEvidence = { chatId?: string; servedModel: string; requestSha256: string; responseSha256: string; calledAt: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** The four x-chainaim attestation headers (gateway server.ts ATTEST_HEADERS) -> AttestEvidence, or undefined when absent or malformed. */
export function parseAttestHeaders(get: (name: string) => string | null, calledAt: string): AttestEvidence | undefined {
  const servedModel = get("x-chainaim-served-model");
  const req = get("x-chainaim-req-sha256");
  const resp = get("x-chainaim-resp-sha256");
  if (!servedModel || servedModel.length > 200 || !req || !resp || !SHA256_HEX.test(req) || !SHA256_HEX.test(resp)) return undefined;
  const id = get("x-chainaim-provider-id");
  return { ...(id && PROVIDER_ID.test(id) ? { chatId: id } : {}), servedModel, requestSha256: req, responseSha256: resp, calledAt };
}
export type CrossAskDeps = {
  /** POST to the analyst route; resolves with the JSON body, throws Error(message) on a non-2xx answer. */
  analyst: (route: "relations" | "sql", body: Record<string, unknown>) => Promise<any>;
  /** One chat completion through the gateway (or the paywall). */
  chat: (messages: Msg[], model: string) => Promise<ChatReply>;
  /** Monotonic milliseconds (e.g. performance.now). Given: the result carries timings (ARCH-204); absent: it does not. */
  clock?: () => number;
};
/**
 * Whole milliseconds per step (adminUI ARCH-204): the analyst's relations, every query model call, every SQL run, the
 * answer model call (absent when no answer model was called, e.g. phrase "none"). callsMs: one entry per `served`
 * reply, same order. files: tables the analyst loaded.
 */
export type CrossAskTimings = { relationsMs: number; queryMs: number; sqlMs: number; answerMs?: number; callsMs: number[]; files: number };

const ENTITY_KIND = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** x-chainaim-entity-counts: a JSON object of entity kind -> non-negative integer, or undefined. */
function parseEntityCounts(header: string | null): Record<string, number> | undefined {
  if (!header || header.length > 4096) return undefined;
  let v: unknown;
  try { v = JSON.parse(header); } catch { return undefined; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!ENTITY_KIND.test(k) || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return undefined;
    out[k] = n;
  }
  return out;
}
/** x-chainaim-residual: pass | refused, or undefined. */
function parseResidual(header: string | null): "pass" | "refused" | undefined {
  return header === "pass" || header === "refused" ? header : undefined;
}
export type CrossAskInput = { folder: string; question: string; model: string; /** Model for the worded answer (default: model). A local one keeps the result rows on this PC. */ answerModel?: string; phrase: "llm" | "none"; sqlRetries: number; answerMaxRows: number; sql?: string };
export type Attempt = { sql: string; error?: string };
/**
 * Joins that multiply rows: an ON clause comparing the two columns of a relation the analyst found to be many-to-many
 * (link "category", or cardinality many-to-many), with both tables in the query. Seen live 2026-10-24: receipts joined to
 * sales orders on Customer ID, every total about 117 times too big. Approximate (reads the SQL text), so it warns rather
 * than proves; aggregates joined on such a column (GROUP BY first) are not flagged when the join is between subqueries.
 */
export type RelationLike = { a: { table: string; column: string }; b: { table: string; column: string }; link: string; cardinality: string };
export function fanOutJoins(sql: string, relations: readonly RelationLike[]): string[] {
  const q = sql.replace(/\s+/g, " ");
  const mentions = (t: string) => new RegExp(`(from|join)\\s+"?${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?(\\s|$|,|\\))`, "i").test(q);
  const ons = [...q.matchAll(/\bon\b(.*?)(?=\b(join|where|group|order|limit|having|union|left|right|inner|full|cross|select)\b|$)/gi)].map((m) => m[1]);
  const out: string[] = [];
  for (const r of relations) {
    if (r.link !== "category" && r.cardinality !== "many-to-many") continue;
    if (!mentions(r.a.table) || !mentions(r.b.table)) continue;
    const ca = `"${r.a.column}"`, cb = `"${r.b.column}"`;
    const hit = ons.some((on) => (ca === cb ? on.split(ca).length - 1 >= 2 : on.includes(ca) && on.includes(cb)));
    if (hit) out.push(`${r.a.table}."${r.a.column}" = ${r.b.table}."${r.b.column}" is many-to-many: each row is repeated, so counts and sums are multiplied`);
  }
  return [...new Set(out)];
}

export type CrossAskResult = {
  question: string; schema: string; relations: unknown[]; attempts: Attempt[];
  sql: string | null; result: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null;
  answer: string | null; unverified: string[]; served: ChatReply[]; sentToModel: { step: string; chars: number; hasData: boolean }[];
  /** For each figure in unverified that simple arithmetic on the result gives exactly: what it equals (deriveFigure). A hint, not a check. */
  derivations: Record<string, string>;
  /** Problems with the result that the number check cannot see (e.g. a join that multiplies rows). */
  warnings: string[];
  error?: string;
  /** Only when deps.clock is given (ARCH-204). */
  timings?: CrossAskTimings;
};

export const SQL_SYSTEM = [
  "You write DuckDB SQL for a question about the tables below.",
  "Reply with exactly one SELECT (or WITH ... SELECT) statement inside a ```sql block, and nothing else.",
  "Use only the listed tables and columns. Write every column name in double quotes exactly as listed.",
  "To combine files, join ONLY on relations marked key; for VARCHAR keys compare upper(trim(a.\"x\")) = upper(trim(b.\"y\")).",
  "Never join two tables on a relation marked category or many-to-many: every row would be repeated and counts and sums multiplied.",
  "When you need totals from two tables that share only such a column, aggregate each table first (GROUP BY that column) and join the aggregates.",
  "Prefer aggregates (count, sum, avg, min, max with GROUP BY) to listing rows; when you list rows, add LIMIT 50.",
  "Round money to 2 decimals. Never read files, change settings or use comments.",
].join("\n");
export const ANSWER_SYSTEM = [
  "Answer the question in plain words using ONLY the result table given: one short sentence per row, or a short summary.",
  "Quote numbers exactly as they appear in the result. Do not comment on how the result was computed.",
  "If the result does not answer the question, say so and say what is missing.",
  // No placeholder example here (see above).
].join("\n");

/** The query in a model reply: a ```sql block, any ``` block, or the reply itself when it starts with SELECT/WITH. */
export function extractSql(text: string): string | null {
  const block = text.match(/```(?:sql|duckdb)?\s*\n?([\s\S]*?)```/i);
  const q = (block ? block[1] : text).trim();
  const start = q.search(/\b(with|select)\b/i);
  if (start === -1) return null;
  return q.slice(start).trim().replace(/;\s*$/, "") || null;
}

/** The result as a small pipe table, at most maxRows rows. */
export function resultText(r: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }, maxRows: number): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v)).replace(/[|\r\n]+/g, " ");
  const lines = [r.columns.join(" | ")];
  for (const row of r.rows.slice(0, maxRows)) lines.push(r.columns.map((c) => cell(row[c])).join(" | "));
  const more = r.rows.length > maxRows || r.truncated;
  if (more) lines.push(`(only the first ${Math.min(maxRows, r.rows.length)} rows are shown)`);
  return lines.join("\n");
}

export async function crossAsk(input: CrossAskInput, deps: CrossAskDeps): Promise<CrossAskResult> {
  if (typeof input.question !== "string" || !input.question.trim()) throw new Error("question is required");
  // Step timings (ARCH-204), only with deps.clock: whole ms, added up per step even when a call fails.
  const clock = deps.clock;
  const t: CrossAskTimings | undefined = clock ? { relationsMs: 0, queryMs: 0, sqlMs: 0, callsMs: [], files: 0 } : undefined;
  let lastMs = 0;
  const timed = async <T>(fn: () => Promise<T>, add: (ms: number) => void): Promise<T> => {
    if (!clock) return fn();
    const s = clock();
    try { return await fn(); } finally { lastMs = Math.round(clock() - s); add(lastMs); }
  };
  const rel = await timed(() => deps.analyst("relations", { folder: input.folder }), (ms) => { t!.relationsMs += ms; });
  const out: CrossAskResult = { question: input.question, schema: rel.schema, relations: rel.relations, attempts: [], sql: null, result: null, answer: null, unverified: [], served: [], sentToModel: [], warnings: [], derivations: {} };
  if (t) { t.files = Array.isArray(rel.tables) ? rel.tables.length : 0; out.timings = t; }
  const messages: Msg[] = [{ role: "system", content: SQL_SYSTEM }, { role: "user", content: `${rel.schema}\n\nQuestion: ${input.question.trim()}` }];
  let sql: string | null = input.sql?.trim() || null;
  for (let attempt = 0; attempt <= input.sqlRetries; attempt++) {
    if (!input.sql) {
      out.sentToModel.push({ step: attempt ? "query (retry)" : "query", chars: messages.reduce((n, m) => n + m.content.length, 0), hasData: false });
      let reply: ChatReply;
      try { reply = await timed(() => deps.chat(messages, input.model), (ms) => { t!.queryMs += ms; }); }
      catch (e) { out.error = `the model that writes the query (${input.model}) failed: ${(e as Error).message}`; return out; }
      out.served.push(reply);
      t?.callsMs.push(lastMs);
      sql = extractSql(reply.text);
      if (!sql) { out.attempts.push({ sql: "", error: "the model did not reply with a query" }); messages.push({ role: "assistant", content: reply.text }, { role: "user", content: "Reply with one SELECT statement in a ```sql block only." }); continue; }
      messages.push({ role: "assistant", content: "```sql\n" + sql + "\n```" });
    }
    try {
      const r = await timed(() => deps.analyst("sql", { folder: input.folder, sql }), (ms) => { t!.sqlMs += ms; });
      out.sql = sql; out.result = { columns: r.columns, rows: r.rows, truncated: r.truncated };
      const fan = fanOutJoins(sql!, rel.relations ?? []);
      out.warnings = fan.map((w) => `join: ${w}`);
      if (fan.length && !input.sql && attempt < input.sqlRetries) {
        out.attempts.push({ sql: sql!, error: `the query joins on a many-to-many relation (${fan.join("; ")})` });
        messages.push({ role: "user", content: `That query is wrong: ${fan.join("; ")}. Join only on relations marked key, or aggregate each table first and join the aggregates. Reply with one SELECT statement in a \`\`\`sql block only.` });
        continue;
      }
      // No rows is a valid answer, but often a wrong condition (seen live: "posting_date > due_date" for "overdue"):
      // the model gets one more look while retries remain; the last result stands either way.
      if (r.rows.length === 0 && !input.sql && attempt < input.sqlRetries) {
        out.attempts.push({ sql: sql!, error: "the query ran but returned no rows" });
        messages.push({ role: "user", content: "That query ran but returned no rows. Check each WHERE condition against what the columns mean; where a column lists its values, use them (e.g. a status value). Reply with one SELECT statement in a ```sql block only." });
        continue;
      }
      out.attempts.push({ sql: sql! });
      break;
    } catch (e) {
      const error = (e as Error).message;
      out.attempts.push({ sql: sql!, error });
      if (input.sql) break; // the person's own query: report the error, no model
      const repeated = out.attempts.slice(0, -1).some((a) => a.sql === sql);
      messages.push({ role: "user", content: `That query failed: ${error}\n${repeated ? "It is the same query as before. Write a different, simpler one: no WITHIN GROUP, check that every parenthesis is closed. " : ""}Fix it. Reply with one SELECT statement in a \`\`\`sql block only.` });
    }
  }
  if (!out.result) { out.error = out.attempts.at(-1)?.error ?? "no query ran"; return out; }
  if (input.phrase === "llm" && out.result.rows.length === 0) {
    out.answer = "The query returned no rows, so there is nothing to word; no model was asked."; // a model asked to word an empty table invents one
    return out;
  }
  if (input.phrase === "llm") {
    const table = resultText(out.result, input.answerMaxRows);
    const ask: Msg[] = [{ role: "system", content: ANSWER_SYSTEM }, { role: "user", content: `Question: ${input.question.trim()}\n\nResult:\n${table}` }]; // no SQL: it led a small model to review the query instead of answering
    out.sentToModel.push({ step: "answer", chars: ask.reduce((n, m) => n + m.content.length, 0), hasData: true });
    // The result is already computed here; a failed answer step keeps it and says why, instead of losing it.
    let reply: ChatReply;
    try { reply = await timed(() => deps.chat(ask, input.answerModel || input.model), (ms) => { t!.answerMs = ms; }); }
    catch (e) { out.error = `the result is below, but the worded answer failed: ${(e as Error).message}`; return out; }
    out.served.push(reply);
    t?.callsMs.push(lastMs);
    out.answer = reply.text.trim();
    out.unverified = verifyAnswer(out.answer, answerEvidence(input.question, table)).notFound;
    for (const f of out.unverified) { const d = deriveFigure(f, out.result); if (d) out.derivations[f] = d; }
    // A placeholder left in the answer (e.g. "$<PHONE>.07": the gateway masked an amount and the model did not copy the
    // placeholder exactly, so it could not be restored) hides a value: never report that answer as fully checked.
    for (const p of out.answer.match(/<[A-Z][A-Z_]*(?:_\d+)?>|\[CARD REMOVED\]/g) ?? []) if (!out.unverified.includes(p)) out.unverified.push(p);
  }
  return out;
}

// ---- the real analyst and gateway, shared by the console and the terminal script ------------------------------
async function errorOf(r: Response): Promise<string> {
  const text = await r.text();
  try { const j = JSON.parse(text); return String(j.error?.message ?? j.error ?? text); } catch { return text.slice(0, 300) || `HTTP ${r.status}`; }
}

/** The analyst over HTTP (http://127.0.0.1:8740 by default). */
export function analystClient(url: string, timeoutMs: number): (route: string, body: Record<string, unknown>) => Promise<any> {
  const base = url.replace(/\/+$/, "");
  return async (route, body) => {
    let r: Response;
    try { r = await fetch(`${base}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error((e as Error).name === "TimeoutError" ? `analyst /${route}: no answer within ${timeoutMs} ms` : `the analyst is not running at ${base}: start test-console\\start-analyst.cmd and keep its window open`); }
    if (!r.ok) throw new Error(`analyst /${route}: ${await errorOf(r)}`);
    return r.json();
  };
}

/** One chat completion through the gateway (it masks, routes by zone and restores); the served model and zone come from its x-chainaim-* headers. */
/** maxTokens (optional) caps the answer; omitted from the request when unset, so callers without it send exactly what they sent before. */
export function gatewayChat(opts: { url: string; key: string; timeoutMs: number; maxTokens?: number }): CrossAskDeps["chat"] {
  const base = opts.url.replace(/\/+$/, "");
  return async (messages, model) => {
    let r: Response;
    const calledAt = new Date().toISOString(); // ARCH-411: before the request leaves
    try {
      r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) }), signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) { throw new Error((e as Error).name === "TimeoutError" ? `gateway: no answer within ${opts.timeoutMs} ms` : `the gateway is not reachable at ${base}: start the stack (test-console\\stack.ps1)`); }
    if (!r.ok) throw new Error(`gateway: ${await errorOf(r)}`);
    const j = await r.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const reply: ChatReply = { text: String(j.choices?.[0]?.message?.content ?? ""), model: r.headers.get("x-chainaim-model") ?? undefined, zone: r.headers.get("x-chainaim-zone") ?? undefined };
    const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
    if (count(j.usage?.prompt_tokens) && count(j.usage?.completion_tokens)) reply.usage = { promptTokens: j.usage!.prompt_tokens as number, completionTokens: j.usage!.completion_tokens as number };
    // ARCH-204: only when the gateway sent them (--expose-entity-counts on); a malformed header leaves the field out.
    const entityCounts = parseEntityCounts(r.headers.get("x-chainaim-entity-counts"));
    if (entityCounts) reply.entityCounts = entityCounts;
    const residual = parseResidual(r.headers.get("x-chainaim-residual"));
    if (residual) reply.residual = residual;
    // ARCH-411: only for a deployment the gateway attests (NEAR AI); every other reply is exactly as before.
    const attest = parseAttestHeaders((n) => r.headers.get(n), calledAt);
    if (attest) reply.attest = attest;
    return reply;
  };
}

// ---- reconcile explanation (Phase 4b-3): code reconciles, the model explains, the analyst checks every figure ----------
export type ExplainDeps = {
  /** POST to the analyst route; resolves with the JSON body, throws Error(message) on a non-2xx answer. */
  analyst: (route: "reconcile" | "evidence" | "verify", body: Record<string, unknown>) => Promise<any>;
  chat: CrossAskDeps["chat"];
};
export type ExplainInput = { folder: string; model: string; pack?: string; budget?: number; question?: string };
export type ExplainResult = {
  runId: string; answer: string; model?: string; zone?: string; exceptions: number; evidenceChars: number;
  verify: MoneyVerifyResult & { verified: boolean };
  /** What left the analyst for the model: the step and its size (the text itself went through the gateway's masking). */
  sentToModel: { step: string; chars: number }[];
};
export const EXPLAIN_QUESTION = "Explain this deposit reconciliation for the practice's office manager: what did not reconcile, why, how much, and which payments or bank rows to check first.";
export const EXPLAIN_SYSTEM = [
  "You explain a deposit reconciliation that code has already computed. Use ONLY facts and figures from the EVIDENCE.",
  "Never compute, round or estimate a new figure; copy amounts exactly as written (two decimals).",
  "Every directional amount in the evidence is signed as bank minus Curve: a minus sign means money missing from the bank",
  "(say short, missing or below), a plus sign means extra money in the bank (say over, extra or above). Keep that direction.",
  "Name each exception by its code, date, amount and payment IDs or bank rows. Items marked watch are timing, not loss.",
  "Plain sentences, no tables. If the evidence shows no exceptions, say that everything reconciled.",
].join(" ");

export async function explainReconcile(input: ExplainInput, deps: ExplainDeps): Promise<ExplainResult> {
  const rec = await deps.analyst("reconcile", { folder: input.folder, ...(input.pack ? { pack: input.pack } : {}) });
  if (typeof rec?.runId !== "string") throw new Error("analyst /reconcile returned no runId");
  const ev = await deps.analyst("evidence", { runId: rec.runId, ...(input.budget ? { budget: input.budget } : {}) });
  const user = `${input.question ?? EXPLAIN_QUESTION}\n\nEVIDENCE:\n${ev.text}`;
  const reply = await deps.chat([{ role: "system", content: EXPLAIN_SYSTEM }, { role: "user", content: user }], input.model);
  const v = await deps.analyst("verify", { runId: rec.runId, answer: reply.text, evidence: ev.text });
  const verified = v.notFound.length === 0 && (v.signMismatch ?? []).length === 0 && (v.signUnclear ?? []).length === 0;
  return {
    runId: rec.runId, answer: reply.text, model: reply.model, zone: reply.zone, exceptions: (rec.exceptions ?? []).length, evidenceChars: ev.text.length,
    verify: { checked: v.checked, notFound: v.notFound, signMismatch: v.signMismatch ?? [], signUnclear: v.signUnclear ?? [], verified },
    sentToModel: [{ step: "explain", chars: EXPLAIN_SYSTEM.length + user.length }],
  };
}

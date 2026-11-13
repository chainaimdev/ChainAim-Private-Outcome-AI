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
import { createHash } from "node:crypto";
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
  /** privateAI-design-41 ARCH-697: what left for this call (the gateway's x-chainaim-egress, --expose-egress on); hashes, counts, a host. */
  egress?: EgressEntry;
  /** ARCH-697: why a present x-chainaim-egress header was not taken (unknown member, bad value); the console logs it. */
  egressRefused?: string;
};

/**
 * privateAI-design-41 ARCH-697: one call's egress as the gateway reports it: the destination host (of the deployment's
 * baseUrl, optional :port), the catalog zone, SHA-256 and length of the exact bytes sent, entity kind -> count masked in
 * them, the residual check (pass, or off when the gateway runs without it) and the data class. Never content.
 */
export type EgressEntry = { destination: string; zone: string; sentSha256: string; sentBytes: number; masked: Record<string, number>; residual: "pass" | "off"; dataClass: "PHI" | "PCI" | "PII" | "none" };
export const EGRESS_FIELDS = ["v", "destination", "zone", "sentSha256", "sentBytes", "masked", "residual", "dataClass"] as const;
export const EGRESS_HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;
export const EGRESS_KIND = /^[A-Z_]{1,40}$/;
/**
 * ARCH-697: the x-chainaim-egress header, member by member (an allowlist: an unknown member, a missing one or a bad value
 * is refused by name, and the call then has no egress entry). Absent header: { }.
 */
export function parseEgressHeader(header: string | null): { egress?: EgressEntry; refused?: string } {
  if (header === null) return {};
  if (header.length > 2048) return { refused: "the header is longer than 2048 characters" };
  let v: unknown;
  try { v = JSON.parse(header); } catch { return { refused: "the header is not JSON" }; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { refused: "the header is not a JSON object" };
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(EGRESS_FIELDS as readonly string[]).includes(k)) return { refused: `unknown member ${k.slice(0, 40)}` };
  for (const k of EGRESS_FIELDS) if (!(k in o)) return { refused: `member ${k} is missing` };
  if (o.v !== 1) return { refused: "v must be 1" };
  if (typeof o.destination !== "string" || !EGRESS_HOST.test(o.destination)) return { refused: "destination must be a host name" };
  if (typeof o.zone !== "string" || !/^[a-z][a-z-]{0,39}$/.test(o.zone)) return { refused: "zone must be a zone name" };
  if (typeof o.sentSha256 !== "string" || !SHA256_HEX.test(o.sentSha256)) return { refused: "sentSha256 must be 64 lowercase hex characters" };
  if (typeof o.sentBytes !== "number" || !Number.isSafeInteger(o.sentBytes) || o.sentBytes < 0) return { refused: "sentBytes must be a whole number >= 0" };
  if (typeof o.masked !== "object" || o.masked === null || Array.isArray(o.masked)) return { refused: "masked must be an object of kind -> count" };
  const masked: Record<string, number> = {};
  for (const [k, n] of Object.entries(o.masked as Record<string, unknown>)) {
    if (!EGRESS_KIND.test(k) || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return { refused: "masked must map entity kinds to whole numbers >= 0" };
    masked[k] = n;
  }
  if (o.residual !== "pass" && o.residual !== "off") return { refused: "residual must be pass or off" };
  if (o.dataClass !== "PHI" && o.dataClass !== "PCI" && o.dataClass !== "PII" && o.dataClass !== "none") return { refused: "dataClass must be PHI, PCI, PII or none" };
  return { egress: { destination: o.destination, zone: o.zone, sentSha256: o.sentSha256, sentBytes: o.sentBytes, masked, residual: o.residual, dataClass: o.dataClass } };
}
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
export type CrossAskInput = { folder: string; question: string; model: string; /** Model for the worded answer (default: model). A local one keeps the result rows on this PC. */ answerModel?: string; phrase: "llm" | "none"; sqlRetries: number; answerMaxRows: number; sql?: string;
  /** Characters of the query prompt (every message's text) at most: older failed attempts are left out first (fitPrompt). Absent:
   * no limit (the gateway refuses more than 48,000 characters, keys of the JSON body included, so a caller sets this lower). */
  maxPromptChars?: number;
  /** Characters of the answer prompt (every message's text) at most: result rows are left out from the end, and the prompt says
   * how many are shown, until it fits; when not even one row fits, no model is asked and the result is kept with an error.
   * Absent: no limit. An estimate prices the answer call at this size (privateAI-design-34 ARCH-638), so a run sends no more. */
  answerMaxPromptChars?: number;
  /** A failed query's error text fed back to the model is cut to this many characters (DuckDB binder errors list every candidate
   * column). Absent: not cut. */
  retryErrorMaxChars?: number;
  /** Also check whole numbers under 100 in the worded answer (verify.ts smallNumbers; owner 2026-11-07, tab 03 "Calculated, NOT
   * made up by the AI"). The result's row count passes too, when the result is complete. Absent/false: the old rule. */
  checkSmallNumbers?: boolean };
export type Attempt = { sql: string; error?: string };
/**
 * The query prompt within maxChars characters of message text: the system prompt and the table list + question are always sent;
 * after them the most recent attempts (a model reply and the feedback on it, in pairs), oldest left out first, and the latest
 * feedback names how many were left out. When even the latest attempt does not fit, its feedback is cut. null: the system
 * prompt and the table list + question alone are over the limit (nothing can be sent). Live 2026-11-06: a ChiroTouch SQL-fix
 * retry reached 58,063 characters and the gateway refused it.
 */
export function fitPrompt(messages: readonly Msg[], maxChars: number): Msg[] | null {
  const size = (ms: readonly Msg[]) => ms.reduce((n, m) => n + m.content.length, 0);
  const head = messages.slice(0, 2), tail = messages.slice(2);
  if (size(head) > maxChars) return null;
  if (size(messages) <= maxChars) return messages.map((m) => ({ ...m }));
  const pairs: Msg[][] = [];
  for (let i = 0; i < tail.length; i += 2) pairs.push(tail.slice(i, i + 2));
  let kept: Msg[][] = [];
  for (let i = pairs.length - 1; i >= 0; i--) { if (size(head) + size(kept.flat()) + size(pairs[i]) + 120 > maxChars && kept.length) break; kept = [pairs[i], ...kept]; }
  const dropped = pairs.length - kept.length;
  const out = [...head.map((m) => ({ ...m })), ...kept.flat().map((m) => ({ ...m }))];
  const last = out[out.length - 1];
  if (dropped && last.role === "user") last.content = `(${dropped} earlier failed attempt(s) left out to keep the request small.)\n${last.content}`;
  const over = size(out) - maxChars;
  if (over > 0) { // the latest attempt alone is too big: cut its feedback (then its query) from the end
    for (let i = out.length - 1; i >= 2 && size(out) > maxChars; i--) {
      const room = out[i].content.length - (size(out) - maxChars) - 20;
      out[i].content = room > 0 ? `${out[i].content.slice(0, room)} ...(cut)` : "(cut to keep the request small)";
    }
    if (size(out) > maxChars) return null;
  }
  return out;
}
/**
 * Joins that multiply rows: an ON clause comparing the two columns of a relation the analyst found to be many-to-many
 * (link "category", or cardinality many-to-many), with both tables in the query. Seen live 2026-10-24: receipts joined to
 * sales orders on Customer ID, every total about 117 times too big. Approximate (reads the SQL text), so it warns rather
 * than proves. Judged per scope (the outer query, each WITH body and each parenthesised subquery): a table counts in a scope
 * when the scope reads it, or reads a WITH name / subquery that passes the table's rows through unchanged; a WITH body or
 * subquery with GROUP BY or DISTINCT does not pass rows through (one row per group), so joining aggregates is not flagged.
 * Live 2026-11-06: smb Receivables vs payables grouped each table by "Terms" first and was wrongly warned.
 */
export type RelationLike = { a: { table: string; column: string }; b: { table: string; column: string }; link: string; cardinality: string };
type Scope = { id: string; text: string; grouped: boolean };
/** The SQL as scopes: every parenthesised SELECT / WITH body becomes its own scope, replaced in its parent by " __subN ". */
function sqlScopes(sql: string): Scope[] {
  const scopes: Scope[] = [];
  const strip = (text: string, id: string): void => {
    let out = "", q = "";
    for (let i = 0; i < text.length; i++) {
      if (q) { out += text[i]; if (text[i] === q) q = ""; continue; } // inside '...' or "...": copied as is
      if (text[i] === "'" || text[i] === '"') { q = text[i]; out += text[i]; continue; }
      if (text[i] === "(" && /^\s*(select|with)\b/i.test(text.slice(i + 1))) {
        let depth = 1, k = i + 1, quote = "";
        for (; k < text.length && depth; k++) {
          const ch = text[k];
          if (quote) { if (ch === quote) quote = ""; continue; }
          if (ch === "'" || ch === '"') quote = ch; else if (ch === "(") depth++; else if (ch === ")") depth--;
        }
        const sub = `__sub${scopes.length + 1000}`; // reserved before recursing, so ids are unique
        scopes.push({ id: sub, text: "", grouped: false });
        strip(text.slice(i + 1, k - 1), sub);
        out += ` ${sub} `;
        i = k - 1;
      } else out += text[i];
    }
    const at = scopes.findIndex((x) => x.id === id);
    const sc = { id, text: out, grouped: /\bgroup\s+by\b|\bselect\s+distinct\b/i.test(out) };
    if (at === -1) scopes.push(sc); else scopes[at] = sc;
  };
  strip(sql.replace(/\s+/g, " "), "__main");
  return scopes;
}
export function fanOutJoins(sql: string, relations: readonly RelationLike[]): string[] {
  const scopes = sqlScopes(sql);
  const byId = new Map(scopes.map((x) => [x.id, x]));
  const main = byId.get("__main")!;
  // WITH names -> their body's scope ("name AS __subN" in the outer text)
  const cte = new Map<string, string>();
  for (const x of scopes) for (const m of x.text.matchAll(/("[^"]+"|[A-Za-z_][\w]*)\s+as\s+(__sub\d+)/gi)) cte.set(m[1].replace(/"/g, "").toLowerCase(), m[2]);
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reads = (text: string, name: string) => new RegExp(`(from|join)\\s+"?${esc(name)}"?(\\s|$|,|\\))`, "i").test(text);
  /** Does this scope see the rows of table t (directly, or through an ungrouped WITH body / subquery)? */
  const sees = (sc: Scope, t: string, depth = 0): boolean => {
    if (depth > 20) return false;
    if (reads(sc.text, t)) return true;
    for (const m of sc.text.matchAll(/(from|join)\s+("[^"]+"|[A-Za-z_][\w]*)/gi)) {
      const name = m[2].replace(/"/g, "").toLowerCase();
      const target = name.startsWith("__sub") ? byId.get(name) : cte.has(name) ? byId.get(cte.get(name)!) : undefined;
      if (target && !target.grouped && sees(target, t, depth + 1)) return true;
    }
    return false;
  };
  const out: string[] = [];
  for (const sc of [main, ...scopes.filter((x) => x !== main)]) {
    const ons = [...sc.text.matchAll(/\bon\b(.*?)(?=\b(join|where|group|order|limit|having|union|left|right|inner|full|cross|select)\b|$)/gi)].map((m) => m[1]);
    if (!ons.length) continue;
    for (const r of relations) {
      if (r.link !== "category" && r.cardinality !== "many-to-many") continue;
      if (!sees(sc, r.a.table) || !sees(sc, r.b.table)) continue;
      const ca = `"${r.a.column}"`, cb = `"${r.b.column}"`;
      const hit = ons.some((on) => (ca === cb ? on.split(ca).length - 1 >= 2 : on.includes(ca) && on.includes(cb)));
      if (hit) out.push(`${r.a.table}."${r.a.column}" = ${r.b.table}."${r.b.column}" is many-to-many: each row is repeated, so counts and sums are multiplied`);
    }
  }
  return [...new Set(out)];
}

export type CrossAskResult = {
  question: string; schema: string; relations: unknown[]; attempts: Attempt[];
  sql: string | null; result: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null;
  answer: string | null; unverified: string[]; served: ChatReply[]; sentToModel: { step: string; chars: number; bytes: number; hasData: boolean }[];
  /** For each figure in unverified that simple arithmetic on the result gives exactly: what it equals (deriveFigure). A hint, not a check. */
  derivations: Record<string, string>;
  /** Problems with the result that the number check cannot see (e.g. a join that multiplies rows). */
  warnings: string[];
  error?: string;
  /** Only when deps.clock is given (ARCH-204). */
  timings?: CrossAskTimings;
};

/**
 * A failed query that named a column the table does not have (DuckDB binder: 'Table "s" does not have a column named "x"',
 * 'Referenced column "x" not found in FROM clause'): the retry names the real columns of the tables the query used, so the
 * model picks a listed column instead of guessing another (owner calibration run 2026-11-12: nemotron guessed ERPNext
 * field names three times in a row). Table names only from the query's FROM / JOIN; at most 80 columns a table; nothing
 * but names already in the schema the model was sent. Not a match: no hint.
 */
const MAX_HINT_COLUMNS = 80;
function columnHint(error: string, sql: string, tables: unknown): string | undefined {
  if (!Array.isArray(tables)) return undefined;
  const known = new Map<string, string[]>();
  for (const t of tables) if (t && typeof t === "object" && typeof (t as { table?: unknown }).table === "string" && Array.isArray((t as { columns?: unknown }).columns))
    known.set((t as { table: string }).table.toLowerCase(), ((t as { columns: { name?: unknown }[] }).columns).map((c) => c?.name).filter((n): n is string => typeof n === "string"));
  if (!known.size) return undefined;
  const aliasMiss = error.match(/Table "([^"]+)" does not have a column named "([^"]+)"/);
  const refMiss = error.match(/Referenced column "([^"]+)" not found/);
  if (!aliasMiss && !refMiss) return undefined;
  // FROM / JOIN <table> [AS] <alias>, the table optionally quoted
  const used = new Map<string, string>(); // alias or name (lower case) -> table (lower case)
  for (const m of sql.matchAll(/\b(?:from|join)\s+"?([A-Za-z_][\w]*)"?(?:\s+(?:as\s+)?"?([A-Za-z_]\w*)"?)?/gi)) {
    const table = m[1].toLowerCase();
    if (!known.has(table)) continue;
    used.set(table, table);
    if (m[2] && !/^(on|where|join|left|right|inner|outer|full|cross|group|order|limit|using|natural)$/i.test(m[2])) used.set(m[2].toLowerCase(), table);
  }
  const list = (table: string) => `${table} has only these columns: ${known.get(table)!.slice(0, MAX_HINT_COLUMNS).map((c) => `"${c}"`).join(", ")}${known.get(table)!.length > MAX_HINT_COLUMNS ? ", ..." : ""}`;
  if (aliasMiss) {
    const table = used.get(aliasMiss[1].toLowerCase());
    return table ? `"${aliasMiss[2]}" is not a column of ${table}. ${list(table)}.` : undefined;
  }
  const tablesUsed = [...new Set(used.values())];
  return tablesUsed.length ? `"${refMiss![1]}" is not a column of any table the query reads. ${tablesUsed.map(list).join(". ")}.` : undefined;
}

export const SQL_SYSTEM = [
  "You write DuckDB SQL for a question about the tables below.",
  "Reply with exactly one SELECT (or WITH ... SELECT) statement inside a ```sql block, and nothing else.",
  "Use only the listed tables and columns. Write every column name in double quotes exactly as listed.",
  "A column that is not in a table's list does not exist in that table, whatever the source system usually calls it (an export renames and drops fields): use the listed column that means it.",
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

/** UTF-8 bytes of the messages' contents, what chars counts in UTF-16 units: the cost model's bytesPerChar and tokensPerByte
 *  are calibrated from these two (privateAI-design-34 ARCH-635). Sizes only, never the text. */
const ENC = new TextEncoder();
const utf8Bytes = (ms: readonly Msg[]): number => ms.reduce((n, m) => n + ENC.encode(m.content).length, 0);

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
      const send = input.maxPromptChars ? fitPrompt(messages, input.maxPromptChars) : messages;
      if (!send) {
        out.error = `the table list and the question are ${messages[0].content.length + messages[1].content.length} characters, over the ${input.maxPromptChars} a query request may have: pick fewer files or a smaller folder`;
        return out;
      }
      out.sentToModel.push({ step: attempt ? "query (retry)" : "query", chars: send.reduce((n, m) => n + m.content.length, 0), bytes: utf8Bytes(send), hasData: false });
      let reply: ChatReply;
      try { reply = await timed(() => deps.chat(send, input.model), (ms) => { t!.queryMs += ms; }); }
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
      const fed = input.retryErrorMaxChars && error.length > input.retryErrorMaxChars ? `${error.slice(0, input.retryErrorMaxChars)} ...(error cut)` : error;
      if (input.sql) break; // the person's own query: report the error, no model
      const repeated = out.attempts.slice(0, -1).some((a) => a.sql === sql);
      const hint = columnHint(error, sql ?? "", rel.tables);
      messages.push({ role: "user", content: `That query failed: ${fed}\n${hint ? `${hint}\n` : ""}${repeated ? "It is the same query as before. Write a different, simpler one: no WITHIN GROUP, check that every parenthesis is closed. " : ""}Fix it. Reply with one SELECT statement in a \`\`\`sql block only.` });
    }
  }
  if (!out.result) { out.error = out.attempts.at(-1)?.error ?? "no query ran"; return out; }
  if (input.phrase === "llm" && out.result.rows.length === 0) {
    out.answer = "The query returned no rows, so there is nothing to word; no model was asked."; // a model asked to word an empty table invents one
    return out;
  }
  if (input.phrase === "llm") {
    // no SQL: it led a small model to review the query instead of answering
    const askOf = (rows: number): { table: string; ask: Msg[] } => {
      const table = resultText(out.result!, rows);
      return { table, ask: [{ role: "system", content: ANSWER_SYSTEM }, { role: "user", content: `Question: ${input.question.trim()}\n\nResult:\n${table}` }] };
    };
    const chars = (ms: readonly Msg[]) => ms.reduce((n, m) => n + m.content.length, 0);
    let rows = Math.min(input.answerMaxRows, out.result.rows.length);
    let fit = askOf(rows);
    const cap = input.answerMaxPromptChars;
    if (cap !== undefined) {
      while (rows > 1 && chars(fit.ask) > cap) fit = askOf(--rows);
      if (chars(fit.ask) > cap) {
        out.error = `the result is below, but no worded answer was asked for: the question and one result row are ${chars(fit.ask)} characters, over the ${cap} an answer request may have`;
        return out;
      }
    }
    const { table, ask } = fit;
    out.sentToModel.push({ step: "answer", chars: chars(ask), bytes: utf8Bytes(ask), hasData: true });
    // The result is already computed here; a failed answer step keeps it and says why, instead of losing it.
    let reply: ChatReply;
    try { reply = await timed(() => deps.chat(ask, input.answerModel || input.model), (ms) => { t!.answerMs = ms; }); }
    catch (e) { out.error = `the result is below, but the worded answer failed: ${(e as Error).message}`; return out; }
    out.served.push(reply);
    t?.callsMs.push(lastMs);
    out.answer = reply.text.trim();
    const small = input.checkSmallNumbers ? { smallNumbers: true, ...(out.result.truncated ? {} : { rowCount: out.result.rows.length }) } : {};
    out.unverified = verifyAnswer(out.answer, answerEvidence(input.question, table), small).notFound;
    for (const f of out.unverified) { const d = deriveFigure(f, out.result); if (d) out.derivations[f] = d; }
    // A placeholder left in the answer (e.g. "$<PHONE>.07": the gateway masked an amount and the model did not copy the
    // placeholder exactly, so it could not be restored) hides a value: never report that answer as fully checked.
    for (const p of out.answer.match(/<[A-Z][A-Z_]*(?:_\d+)?>|\[CARD REMOVED\]/g) ?? []) if (!out.unverified.includes(p)) out.unverified.push(p);
  }
  return out;
}

/**
 * The figures line of tab 03 (owner-approved wording 2026-11-07), decided from a result:
 *   "calculated"  every number in the AI's explanation is in the result, or (owner decision) is a figure the AI worked out that
 *                 exact arithmetic on the result reproduces to the cent (derivations): shown green, those figures with a note
 *   "review"      any number not found and not reproduced, or a placeholder left in the answer: shown as the review warning
 *   null          no AI explanation (phrase none, no rows, or the answer step failed): no line
 */
export type FiguresVerdict = { verdict: "calculated" | "review" | null; derived: string[]; unmatched: string[] };
export const FIGURES_TEXT = {
  calculated: "Calculated, NOT made up by the AI. AI only explains.",
  review: "Review before use: AI explanation may differ from the figures below.",
  link: "Show where each number came from",
} as const;
export function figuresVerdict(r: Pick<CrossAskResult, "answer" | "served" | "unverified" | "derivations" | "sentToModel">): FiguresVerdict {
  const explained = r.answer !== null && r.sentToModel.some((s) => s.step === "answer");
  if (!explained) return { verdict: null, derived: [], unmatched: [] };
  const derived = r.unverified.filter((f) => r.derivations[f] !== undefined);
  const unmatched = r.unverified.filter((f) => r.derivations[f] === undefined);
  return { verdict: unmatched.length ? "review" : "calculated", derived, unmatched };
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
/**
 * onSent (privateAI-design-41 ARCH-699): when given and the reply carries an egress entry, the exact bytes sent are fetched
 * from the gateway (GET /internal/egress/<sentSha256>, gateway key) and handed over only when their SHA-256 matches; for the
 * owner's "download what was sent" on this PC. A failed fetch only leaves them out.
 */
export function gatewayChat(opts: { url: string; key: string; timeoutMs: number; maxTokens?: number; onSent?: (sentSha256: string, bytes: Uint8Array) => void }): CrossAskDeps["chat"] {
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
    // privateAI-design-41 ARCH-697: only when the gateway sent it (--expose-egress on); a refused header leaves no entry.
    const eg = parseEgressHeader(r.headers.get("x-chainaim-egress"));
    if (eg.egress) reply.egress = eg.egress;
    if (eg.refused) reply.egressRefused = eg.refused;
    if (eg.egress && opts.onSent) await fetchSent(base, opts.key, eg.egress.sentSha256, opts.timeoutMs, opts.onSent);
    return reply;
  };
}

/** ARCH-699: the kept bytes of one call, checked against their hash; nothing on a failure (the download is then absent). */
async function fetchSent(base: string, key: string, sha: string, timeoutMs: number, onSent: (sentSha256: string, bytes: Uint8Array) => void): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/internal/egress/${sha}`, { headers: { authorization: `Bearer ${key}` }, signal: ac.signal });
    if (!r.ok) { await r.body?.cancel(); return; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") === sha) onSent(sha, bytes);
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
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

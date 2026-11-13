/**
 * The console's side of NEAR AI model attestation (PLAN-private-ai-nearai-attestation.md ARCH-411). Off unless
 * --attest-url is set (and that needs --paid-jobs on: only a quoted job is checked). After a job is quoted, start() asks
 * ca-attest (POST /verify) about every model call of the job that carries attestation evidence (ChatReply.attest, from the
 * gateway's ARCH-408 headers); calls without it (local, OpenRouter, Bedrock) are not_applicable. It is never awaited by a
 * request: ca-attest slow, down or refusing never blocks or fails a job; the job's attestation then says unavailable.
 *
 * Never text: what is sent and kept is ids, model ids, hashes, times, addresses, booleans and reasons.
 */
import type { ChatReply } from "../../packages/crossask/src/index.ts";

export type AttestFlags = { "attest-url"?: string; "attest-timeout-ms"?: string; "attest-keep"?: string };
export type AttestClientConfig = { url: string; timeoutMs: number; keep: number };

/** undefined without --attest-url; otherwise the checked configuration, or an Error naming the flag. */
export function attestConfig(flags: AttestFlags, paidJobsOn: boolean): AttestClientConfig | undefined {
  const url = flags["attest-url"];
  if (url === undefined || url === "") return undefined;
  if (!paidJobsOn) throw new Error("--attest-url needs --paid-jobs on: only quoted jobs are attested");
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`--attest-url must be a URL (e.g. http://attest:8770), got ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`--attest-url must be http or https, got ${u.protocol}`);
  const int = (name: "attest-timeout-ms" | "attest-keep", fallback: string, min: number, max: number): number => {
    const raw = flags[name] ?? fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, got ${raw}`);
    return n;
  };
  return { url: url.replace(/\/+$/, ""), timeoutMs: int("attest-timeout-ms", "20000", 1000, 300_000), keep: int("attest-keep", "500", 1, 100_000) };
}

/**
 * privateAI-design-39 ARCH-685: what a paid job must show about NEAR AI attestation before it is delivered.
 * off: no attestation rule; evidence (default, the rule before design-39): an estimate that said attested is void when a
 * call lacks the gateway's evidence; verified: ca-attest's verdict is awaited and must be verified on every call.
 */
export const PAY_ONLY_ATTESTED_MODES = ["off", "evidence", "verified"] as const;
export type PayOnlyAttestedMode = (typeof PAY_ONLY_ATTESTED_MODES)[number];
export type PayOnlyAttestedFlags = { "pay-only-attested"?: string; "pay-only-attested-deadline-ms"?: string };
export type PayOnlyAttested = { mode: PayOnlyAttestedMode; deadlineMs: number };

/** The checked --pay-only-attested settings; verified needs --attest-url (attestOn), or start-up stops naming it. */
export function payOnlyAttestedConfig(flags: PayOnlyAttestedFlags, attestOn: boolean): PayOnlyAttested {
  const mode = flags["pay-only-attested"] ?? "evidence";
  if (!(PAY_ONLY_ATTESTED_MODES as readonly string[]).includes(mode)) throw new Error(`--pay-only-attested must be off, evidence or verified, got ${mode}`);
  const rawDeadline = flags["pay-only-attested-deadline-ms"] ?? "30000";
  const deadlineMs = Number(rawDeadline);
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 240_000) throw new Error(`--pay-only-attested-deadline-ms must be a whole number from 1000 to 240000, got ${rawDeadline}`);
  if (mode === "verified" && !attestOn) throw new Error("--pay-only-attested verified needs --attest-url: the verdict comes from ca-attest");
  return { mode: mode as PayOnlyAttestedMode, deadlineMs };
}

/** Verified mode's rule: ca-attest says verified and every model call carried evidence (a job with no model call is not proven). */
export function privacyProven(a: JobAttestation, served: readonly ChatReply[]): boolean {
  return a.summary === "verified" && served.length > 0 && served.every((s) => s.attest !== undefined);
}

export type CallStatus ="verified" | "unverified" | "unavailable" | "not_applicable";
/** One model call of the job, in run order (index = position in CrossAskResult.served). */
export type CallAttestation = {
  index: number; model: string | null; status: CallStatus; reason: string | null;
  servedModel: string | null; chatId: string | null; signatureKind: string | null; signingAlgo: string | null; signingAddress: string | null;
  reportFetchedAt: string | null; tdx: boolean | null; gpu: boolean | null; signature: boolean | null; hashes: boolean | null;
  /** Fix 4: ca-attest's signature evidence (judge.ts evidenceOf): the signed text (model id + two hashes) and the signature hex. */
  signedText: string | null; signatureHex: string | null;
};
/** verified: every attested call verified; partly: some; not_applicable: the job made no attested call. */
export type JobSummary = "verified" | "partly" | "unverified" | "unavailable" | "not_applicable" | "pending";
export type JobAttestation = { jobId: string; summary: JobSummary; at: string; calls: CallAttestation[] };

const empty = (index: number, model: string | null, status: CallStatus, reason: string | null): CallAttestation => ({
  index, model, status, reason, servedModel: null, chatId: null, signatureKind: null, signingAlgo: null, signingAddress: null,
  reportFetchedAt: null, tdx: null, gpu: null, signature: null, hashes: null, signedText: null, signatureHex: null,
});

export function summarize(calls: readonly CallAttestation[]): Exclude<JobSummary, "pending"> {
  const attested = calls.filter((c) => c.status !== "not_applicable");
  if (attested.length === 0) return "not_applicable";
  const ok = attested.filter((c) => c.status === "verified").length;
  if (ok === attested.length) return "verified";
  if (ok > 0) return "partly";
  return attested.some((c) => c.status === "unverified") ? "unverified" : "unavailable";
}

type VerifyResult = Omit<CallAttestation, "index" | "model"> & { status: "verified" | "unverified" | "unavailable" };
const MAX_PER_REQUEST = 16; // ca-attest's --max-calls default

/** Asks ca-attest about a job's calls in the background and keeps the newest `keep` results in memory. */
export class AttestClient {
  private readonly cfg: AttestClientConfig;
  private readonly log: (line: string) => void;
  private readonly onDone: ((a: JobAttestation) => void) | undefined;
  private readonly now: () => number;
  private readonly results = new Map<string, JobAttestation>();
  private inflight = 0;
  constructor(cfg: AttestClientConfig, log: (line: string) => void = (l) => console.log(l), onDone?: (a: JobAttestation) => void, now: () => number = Date.now) {
    this.cfg = cfg;
    this.log = log;
    this.onDone = onDone;
    this.now = now;
  }

  /** The job's attestation so far: pending while ca-attest is being asked; undefined for a job never started here. */
  get(jobId: string): JobAttestation | undefined { return this.results.get(jobId); }

  /** Starts the check for one quoted job; returns at once and never throws. */
  start(jobId: string, served: readonly ChatReply[]): void {
    // durationMs in the job_attested log line: from asking ca-attest to its verdict (the design-39 latency figure).
    const began = this.now();
    const iso = new Date(began).toISOString();
    this.store({ jobId, summary: "pending", at: iso, calls: served.map((s, i) => empty(i, s.model ?? null, s.attest ? "unavailable" : "not_applicable", s.attest ? "checking" : null)) });
    this.inflight += 1;
    this.run(jobId, served)
      .then((a) => {
        this.store(a);
        this.log(JSON.stringify({ ts: a.at, route: "attest", event: "job_attested", jobId, summary: a.summary, durationMs: this.now() - began, calls: a.calls.map((c) => ({ index: c.index, status: c.status, reason: c.reason })) }));
        this.onDone?.(a);
      })
      .finally(() => { this.inflight -= 1; });
  }

  /**
   * privateAI-design-39 ARCH-686 (--pay-only-attested verified): the same check as start(), awaited, bounded by deadlineMs
   * overall (each POST stays bounded by --attest-timeout-ms). Resolves with the verdict, or with the pending result when the
   * deadline passes first; never throws. The verdict is stored (the receipt and GET /jobs/<id>/attestation read it) and logged
   * as job_attested; a result that lands after the deadline is still stored and logged. onDone is not called here: the caller
   * calls announce() once the job is quoted, so the job feed sends job_attested after job_quoted (it needs the job's calls).
   */
  async verifyNow(jobId: string, served: readonly ChatReply[], deadlineMs: number): Promise<JobAttestation> {
    const began = this.now();
    const pending: JobAttestation = { jobId, summary: "pending", at: new Date(began).toISOString(), calls: served.map((s, i) => empty(i, s.model ?? null, s.attest ? "unavailable" : "not_applicable", s.attest ? "checking" : null)) };
    this.store(pending);
    this.inflight += 1;
    const checked = this.run(jobId, served).then((a) => {
      this.store(a);
      this.log(JSON.stringify({ ts: a.at, route: "attest", event: "job_attested", jobId, summary: a.summary, durationMs: this.now() - began, calls: a.calls.map((c) => ({ index: c.index, status: c.status, reason: c.reason })) }));
      return a;
    });
    void checked.finally(() => { this.inflight -= 1; });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<JobAttestation>((resolve) => { timer = setTimeout(() => resolve(pending), deadlineMs); });
    try { return await Promise.race([checked, deadline]); }
    finally { clearTimeout(timer); }
  }

  /** Hands a job's finished verdict to onDone (the job feed); nothing while it is pending or unknown. */
  announce(jobId: string): void {
    const a = this.results.get(jobId);
    if (a && a.summary !== "pending") this.onDone?.(a);
  }

  /** Resolves when every check started so far has finished (tests and shutdown). */
  async idle(): Promise<void> { while (this.inflight > 0) await new Promise((r) => setTimeout(r, 10)); }

  private store(a: JobAttestation): void {
    this.results.delete(a.jobId);
    this.results.set(a.jobId, a);
    while (this.results.size > this.cfg.keep) this.results.delete(this.results.keys().next().value!);
  }

  private async run(jobId: string, served: readonly ChatReply[]): Promise<JobAttestation> {
    const calls: CallAttestation[] = served.map((s, i) => empty(i, s.model ?? null, "not_applicable", null));
    const asked = served.map((s, i) => ({ i, a: s.attest })).filter((x): x is { i: number; a: NonNullable<ChatReply["attest"]> } => x.a !== undefined);
    for (let k = 0; k < asked.length; k += MAX_PER_REQUEST) {
      const chunk = asked.slice(k, k + MAX_PER_REQUEST);
      const body = { calls: chunk.map(({ a }) => ({ ...(a.chatId ? { chatId: a.chatId } : {}), servedModel: a.servedModel, requestSha256: a.requestSha256, responseSha256: a.responseSha256, calledAt: a.calledAt })) };
      let results: VerifyResult[] | undefined;
      let failure = "";
      try {
        const r = await fetch(`${this.cfg.url}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.timeoutMs) });
        const j = (await r.json().catch(() => null)) as { results?: unknown } | null;
        if (r.ok && Array.isArray(j?.results) && j.results.length === chunk.length) results = j.results as VerifyResult[];
        else failure = `attest service: HTTP ${r.status}`;
      } catch (e) {
        failure = (e as Error).name === "TimeoutError" ? "attest service: no answer in time" : "attest service: unreachable";
      }
      chunk.forEach(({ i, a }, n) => {
        const v = results?.[n];
        calls[i] = v && (v.status === "verified" || v.status === "unverified" || v.status === "unavailable")
          ? { index: i, model: served[i].model ?? null, status: v.status, reason: v.reason ?? null, servedModel: v.servedModel ?? a.servedModel, chatId: v.chatId ?? null, signatureKind: v.signatureKind ?? null, signingAlgo: v.signingAlgo ?? null, signingAddress: v.signingAddress ?? null, reportFetchedAt: v.reportFetchedAt ?? null, tdx: v.tdx ?? null, gpu: v.gpu ?? null, signature: v.signature ?? null, hashes: v.hashes ?? null, signedText: typeof v.signedText === "string" ? v.signedText : null, signatureHex: typeof v.signatureHex === "string" ? v.signatureHex : null }
          : { ...empty(i, served[i].model ?? null, "unavailable", failure || "attest service: malformed answer"), servedModel: a.servedModel, chatId: a.chatId ?? null };
      });
    }
    return { jobId, summary: summarize(calls), at: new Date(this.now()).toISOString(), calls };
  }
}

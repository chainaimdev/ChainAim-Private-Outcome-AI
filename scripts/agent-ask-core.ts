/**
 * desk.ps1 -AgentAsk (privateAI-design-32 step C): one tab 03 agent run from the terminal, no browser. Pure parts here
 * (template pick, the run body, the step lines, the result table), so scripts/test/agent-ask.test.ts can check them; the
 * CLI is scripts/agent-ask.ts. The run goes through the console API exactly as the page does (POST /agent/crossask, the
 * same relay, the same agent, the same policy, payment and receipt check), so the terminal and tab 03 cannot drift apart.
 */

/** A dataset as GET <console>/datasets lists it (only the fields used here). */
export type ListedDataset = {
  id: string; label: string; engine: string; folder: string; exists: boolean; allowed: boolean;
  templates: { label: string; q: string; sql?: string }[]; sets: { name: string; files: string[] }[]; defaultSubfolder: string | null;
};

/**
 * queryModel: the model that writes the SQL (tab 03's "Writes the query"); absent or "default" = the console's default, as
 * before. A template with an exact query (sql) needs no query model, so it is not sent then.
 */
export type AskChoice = { dataset: string; template: string; question?: string; set?: string; answerModel: string; queryModel?: string };

/** The run body for POST /agent/crossask, or a plain reason. `defaultAnswerModel` is the console's (GET /gateway/models). */
export function buildRun(tenant: string, list: readonly ListedDataset[], c: AskChoice, defaultAnswerModel: string | null):
  { run: Record<string, string>; datasetLabel: string; templateLabel: string | null } | { error: string } {
  const d = list.find((x) => x.id === c.dataset);
  if (!d) return { error: `no dataset ${c.dataset} (known: ${list.map((x) => x.id).join(", ")})` };
  if (d.engine !== "crossask") return { error: `dataset ${d.id} is a ${d.engine} dataset; -AgentAsk runs crossask datasets (as tab 03's AI agent does), e.g. smb-fin-1` };
  if (!d.exists || !d.allowed) return { error: `dataset ${d.id}: its folder ${d.folder} is ${!d.exists ? "missing" : "outside allowedRoots (config/data-sources.json)"}` };
  let folder = d.folder;
  if (d.sets.length) {
    const want = c.set || d.defaultSubfolder || d.sets[0].name;
    if (!d.sets.some((s) => s.name === want)) return { error: `dataset ${d.id} has no set ${want} (sets: ${d.sets.map((s) => s.name).join(", ")})` };
    const sep = folder.includes("\\") ? "\\" : "/";
    folder = folder.replace(/[\\/]+$/, "") + sep + want.split("/").join(sep);
  }
  let question: string, sql: string | undefined, templateLabel: string | null = null;
  if (c.question && c.question.trim()) {
    question = c.question.trim();
  } else {
    if (d.templates.length === 0) return { error: `dataset ${d.id} has no templates; pass -AgentQuestion "..."` };
    const n = /^\d+$/.test(c.template) ? Number(c.template) : NaN;
    const t = Number.isInteger(n) ? d.templates[n - 1] : d.templates.find((x) => x.label.toLowerCase() === c.template.toLowerCase());
    if (!t) return { error: `dataset ${d.id} has no template ${c.template} (1 to ${d.templates.length}: ${d.templates.map((x, i) => `${i + 1} "${x.label}"`).join(", ")})` };
    question = t.q;
    sql = t.sql;
    templateLabel = t.label;
  }
  const answerModel = c.answerModel === "default" ? defaultAnswerModel : c.answerModel === "none" ? null : c.answerModel;
  if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return { error: `answer model must be default, none or provider/name, got ${answerModel}` };
  const queryModel = c.queryModel && c.queryModel !== "default" ? c.queryModel : null;
  if (queryModel && !/^[\w.-]+\/[\w.:-]+$/.test(queryModel)) return { error: `query model must be default or provider/name, got ${queryModel}` };
  return {
    run: {
      tenant, folder, question, phrase: answerModel ? "llm" : "none", datasetId: d.id,
      ...(queryModel && !sql ? { model: queryModel } : {}),
      ...(answerModel ? { answerModel } : {}), ...(sql ? { sql } : {}), ...(templateLabel ? { templateLabel } : {}),
    },
    datasetLabel: d.label, templateLabel,
  };
}

/** One server-sent event frame -> {type, data}; undefined for a frame without an event name. */
export function parseFrame(frame: string): { type: string; data: Record<string, unknown> } | undefined {
  const type = /^event: (.+)$/m.exec(frame)?.[1];
  if (!type) return undefined;
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}") as Record<string, unknown>; } catch { data = {}; }
  return { type, data };
}

const CHECK: Record<string, (c: { limit: string; value: string }) => string> = {
  not_expired: () => "quote still valid", attested_route: () => "attested route", max_per_job: (c) => `at most ${c.limit} a job (quote ${c.value})`,
  daily_cap: (c) => `${c.limit} a day (with this job ${c.value})`, auto_approve: (c) => `pays by itself up to ${c.limit}`,
  // privateAI-design-39 ARCH-688
  require_attestation: (c) => `attestation ${c.limit} or stronger (signed: ${c.value})`,
};

/** The terminal line for one step, worded as tab 03's step list (actor tag first); undefined for released (shown as a table). */
export function stepLine(tenant: string, type: string, d: Record<string, unknown>): string | undefined {
  const A = `[Agent ${tenant}]`;
  switch (type) {
    case "masked": {
      const found = Object.entries((d.counts ?? {}) as Record<string, number>);
      return found.length ? `${A} Question masked before the agent's model saw it: ${found.map(([k, n]) => `${k} x${n}`).join(", ")}` : `${A} Question checked before the agent's model saw it: nothing to mask`;
    }
    case "tool_called": return `${A} The agent asked ChainAim to run the job`;
    case "job_ran": return `[ChainAim] Job run and held (id ${String(d.jobId).slice(0, 8)}…); the result stays hidden until paid`;
    // privateAI-design-34 ARCH-642: estimate first, nothing run before the payment.
    case "estimated": return `[ChainAim] Estimated from the job's sizes (id ${String(d.jobId).slice(0, 8)}…): nothing has run yet; it runs only after the payment`;
    case "quoted": return `[ChainAim] Quoted ${Number(d.totalUsd)} USDC on ${String(d.network)} to ${String(d.payTo)}`;
    // privateAI-design-33 ARCH-630: ChainAim's signed quote, checked by the agent with the pinned AP2 key.
    case "quote_signed": return `${A} Quote signed by ChainAim OK · key id ${String(d.kid).slice(0, 8)}… · price, payee and network match`;
    case "policy": {
      const checks = Array.isArray(d.checks) ? (d.checks as { check: string; limit: string; value: string; ok: boolean }[]).filter((c) => CHECK[c.check]).map((c) => `${CHECK[c.check](c)} ${c.ok ? "OK" : "NO"}`) : [];
      const dec = d.decision === "pay" ? "pay OK" : d.decision === "refuse" ? "refused" : `${String(d.decision)} (not paid)`;
      return `${A} Spending policy: ${dec} · ${checks.join(" · ")}`;
    }
    // privateAI-design-36 ARCH-666/668: the agent's checkout mandate, and ChainAim's signer's check of it (from its receipt).
    case "mandate_signed": return `${A} Checkout mandate signed OK · tenant key ${String(d.kid).slice(0, 8)}… · permits exactly this signed quote, for this payment only`;
    case "mandate_verified": return d.ok ? `[ChainAim] Mandate verified by ChainAim's signer OK (before the job ran; recorded in the receipt) · ${String(d.sha256).slice(0, 12)}…` : `[ChainAim] Mandate NOT confirmed by the receipt: ${String(d.reason)}`;
    case "signed": return `${A} Payment signed by ${String(d.account)} (ChainAim's relayer pays the gas)`;
    case "settled": return `[NEAR] Settled on NEAR · transaction ${String(d.transaction)} (${nearblocks(String(d.network), String(d.transaction))})`;
    case "released": return undefined;
    // privateAI-design-37 ARCH-677: paid upfront, the run was refused, ChainAim's signer refunded it.
    // privateAI-design-39 ARCH-689: d.privacy = refused because NEAR AI attestation was not proven (ca-attest's summary).
    case "refund_pending": return `[ChainAim] ${d.privacy ? `Refused: privacy not proven (${String(d.privacy)})` : "Run refused after the payment"}: refund pending (invoice ${String(d.invoiceId ?? "?")})`;
    case "refunded": return `[ChainAim] ${d.privacy ? `Refused: privacy not proven (${String(d.privacy)}) -> refunded OK` : "Refunded OK"} (record signed by ChainAim, verified by the agent) · transaction ${String(d.refundTx)} (${nearblocks(String(d.network), String(d.refundTx))})`;
    case "receipt_verified": return `${A} Agent verified the receipt OK · signed by the pinned key ${String(d.keyId).slice(0, 8)}… · result, job and amount${d.settled ? " and transaction" : ""} match${d.settled ? "" : " (settlement not attached yet)"}`;
    case "receipt_failed": return `${A} Receipt check FAILED: ${String(d.reason)} (the payment stands)`;
    case "done": return "Done";
    case "refused": return `Not paid${typeof d.code === "string" ? ` [${d.code}]` : ""}: ${String(d.reason)}`;
    case "error": return `Error: ${String(d.reason)}${d.transaction ? ` (transaction ${String(d.transaction)})` : ""}`;
    default: return `[${type}]`;
  }
}

export function nearblocks(network: string, tx: string): string {
  return `https://${network === "near:mainnet" ? "" : "testnet."}nearblocks.io/txns/${tx}`;
}

/** The released result as text: the worded answer (when there is one) and the table, at most maxRows rows. */
export function resultText(released: unknown, maxRows: number): string {
  const r = released as { result?: { columns?: unknown; rows?: unknown } | null; answer?: unknown } | null;
  const out: string[] = [];
  if (typeof r?.answer === "string" && r.answer.trim()) out.push("Answer:", ...r.answer.trim().split(/\r?\n/).map((l) => `  ${l}`));
  const cols = Array.isArray(r?.result?.columns) ? (r!.result!.columns as unknown[]).map(String) : [];
  const rows = Array.isArray(r?.result?.rows) ? (r!.result!.rows as unknown[]) : [];
  if (cols.length) {
    const cell = (row: unknown, c: string, i: number) => {
      const v = Array.isArray(row) ? row[i] : (row as Record<string, unknown>)?.[c];
      return v === null || v === undefined ? "" : String(v);
    };
    const shown = rows.slice(0, maxRows);
    const width = cols.map((c, i) => Math.min(40, Math.max(c.length, ...shown.map((row) => cell(row, c, i).length))));
    const line = (vals: string[]) => "  " + vals.map((v, i) => v.slice(0, 40).padEnd(width[i])).join("  ");
    out.push(`Result (${rows.length} row(s)${rows.length > shown.length ? `, first ${shown.length} shown` : ""}):`, line(cols), line(width.map((w) => "-".repeat(w))), ...shown.map((row) => line(cols.map((c, i) => cell(row, c, i)))));
  }
  return out.join("\n");
}


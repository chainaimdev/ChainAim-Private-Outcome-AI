/**
 * Job Evidence Receipts on the console (privateAI-design-32 ARCH-613 builder, ARCH-614 key, ARCH-615 store, ARCH-616
 * settlement). Uses packages/receipt for canonical JSON, hashes and Ed25519; this file adds what only the console knows:
 * the dataset folder's files, the job's model calls, and where receipts are kept.
 *
 * A receipt holds ids, sizes, hashes and amounts only: never a question, a row, an answer, a path outside the dataset
 * folder or a key. Receipts are kept in memory and as <receipt-dir>/<jobId>.json (git-ignored runtime/), so a buyer can
 * still fetch one after the console restarts. Off unless --receipts on.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ChatReply } from "../../packages/crossask/src/index.ts";
import { USDC_DECIMALS } from "../../packages/crossask/src/cost.ts";
import type { HeldJob } from "./jobs.ts";
import type { JobAttestation } from "./attest.ts";
import type { SignerApi } from "../../packages/signer/src/index.ts";
import { remoteReceiptSigner } from "./signer-client.ts";
import {
  addSettlement,
  canonicalJson,
  filesRoot,
  SETTLEMENT_FLOWS,
  resultSha256,
  sha256Hex,
  signerFromEnv,
  signReceipt,
  type ReceiptCall,
  type ReceiptEgress,
  type ReceiptEconomics,
  type ReceiptFile,
  type ReceiptMandate,
  type ReceiptSigner,
  type Settlement,
  type SettlementFlow,
  type SignedReceipt,
} from "../../packages/receipt/src/index.ts";

export type ReceiptFlags = { receipts?: string; "receipt-key-env"?: string; "receipt-dir"?: string; "receipt-max-files"?: string };
export type ReceiptConfig = { signer: ReceiptSigner; dir: string; maxFiles: number };

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** undefined with --receipts off (the default); otherwise the signer and folder, or an Error naming what to set. */
export function receiptConfig(flags: ReceiptFlags, env: Record<string, string | undefined>, paidJobsOn: boolean): ReceiptConfig | undefined {
  const mode = flags.receipts ?? "off";
  if (mode !== "on" && mode !== "off") throw new Error(`--receipts must be on or off, got ${mode}`);
  if (mode === "off") return undefined;
  if (!paidJobsOn) throw new Error("--receipts on needs --paid-jobs on (a receipt is for a paid job)");
  const keyEnv = flags["receipt-key-env"] ?? "RECEIPT_SIGNING_KEY";
  if (!ENV_NAME.test(keyEnv)) throw new Error(`--receipt-key-env must be an environment variable name, got ${keyEnv}`);
  const raw = flags["receipt-max-files"] ?? "500";
  const maxFiles = Number(raw);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) throw new Error(`--receipt-max-files must be a whole number from 1 to 100000, got ${raw}`);
  const dir = flags["receipt-dir"] ?? join("runtime", "receipts");
  return { signer: signerFromEnv(env, keyEnv), dir, maxFiles };
}

/**
 * privateAI-design-36 ARCH-663: with --signer remote the receipt key is in ca-control-signer, never here: the config carries
 * only its public half (from the signer's /.well-known/keys) and the folder. --receipt-key-env belongs to --signer local.
 */
export function receiptConfigRemote(flags: ReceiptFlags, paidJobsOn: boolean, publicKey: { keyId: string; publicKeyPem: string } | undefined): ReceiptConfig | undefined {
  const mode = flags.receipts ?? "off";
  if (mode !== "on" && mode !== "off") throw new Error(`--receipts must be on or off, got ${mode}`);
  if (mode === "off") return undefined;
  if (!paidJobsOn) throw new Error("--receipts on needs --paid-jobs on (a receipt is for a paid job)");
  if (flags["receipt-key-env"] !== undefined) throw new Error("--receipt-key-env is for --signer local: with --signer remote the receipt key stays in ca-control-signer");
  if (!publicKey) throw new Error("--receipts on: ca-control-signer publishes no receipt key");
  const raw = flags["receipt-max-files"] ?? "500";
  const maxFiles = Number(raw);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) throw new Error(`--receipt-max-files must be a whole number from 1 to 100000, got ${raw}`);
  return { signer: remoteReceiptSigner(publicKey), dir: flags["receipt-dir"] ?? join("runtime", "receipts"), maxFiles };
}

/** SHA-256 of one file, streamed (data files can be large). */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * Every regular file under `folder` (names relative to it, "/" separators, sorted), with its size and SHA-256. Links are
 * not followed. More than maxFiles files is refused rather than truncated, so a receipt never silently covers part of
 * a dataset. skipDir: sub-folders left out by name (the console passes the data config's hideFolders, e.g. "_*", so the
 * analyst's work folder, which changes on every run, is not committed to).
 */
export async function datasetFiles(folder: string, maxFiles: number, skipDir: (name: string) => boolean = () => false): Promise<ReceiptFile[]> {
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) walk(p); }
      else if (e.isFile()) {
        paths.push(p);
        if (paths.length > maxFiles) throw new Error(`the dataset folder has more than ${maxFiles} files (--receipt-max-files); no receipt was made`);
      }
    }
  };
  walk(folder);
  const files: ReceiptFile[] = [];
  for (const p of paths.sort()) files.push({ name: relative(folder, p).split(sep).join("/"), bytes: statSync(p).size, sha256: await fileSha256(p) });
  if (files.length === 0) throw new Error("the dataset folder has no files; no receipt was made");
  return files;
}

/**
 * One receipt call per model call of the job, in run order. statusOf gives ca-attest's verdict for a call that carries
 * attestation evidence (pending when not judged yet); a call without evidence is "none" and carries no hashes.
 */
export function receiptCalls(served: readonly ChatReply[], statusOf: (index: number) => "verified" | "failed" | "pending"): ReceiptCall[] {
  return served.map((s, i): ReceiptCall => {
    const base = { servedModel: s.attest?.servedModel ?? s.model ?? "unknown", ...(s.zone ? { zone: s.zone } : {}) };
    if (!s.attest) return { ...base, attestStatus: "none" };
    return { ...base, ...(s.attest.chatId ? { chatId: s.attest.chatId } : {}), reqSha256: s.attest.requestSha256, respSha256: s.attest.responseSha256, attestStatus: statusOf(i) };
  });
}

/**
 * privateAI-design-41 ARCH-697: the receipt's egress, one entry per call in run order, from each reply's egress (the
 * gateway's x-chainaim-egress). Only when EVERY call has one (checkBody wants one per call): a gateway without
 * --expose-egress, or a refused header on any call, gives no egress member (the job log names a refused header).
 */
export function receiptEgress(served: readonly ChatReply[]): ReceiptEgress[] | undefined {
  if (served.length === 0 || served.some((s) => s.egress === undefined)) return undefined;
  return served.map((s, i): ReceiptEgress => ({ call: i, ...s.egress! }));
}

export type ReceiptInput = {
  jobId: string;
  quoteId: string;
  counterOf?: string;
  reduced?: string[];
  route: string;
  datasetId: string;
  /** The dataset folder, hashed now; or `files`, hashed earlier (when the job ran). One of the two is required. */
  folder?: string;
  files?: ReceiptFile[];
  templateLabel?: string;
  sql: string;
  /** Exactly what the paywall releases to the buyer. */
  result: unknown;
  served: readonly ChatReply[];
  attestStatusOf: (index: number) => "verified" | "failed" | "pending";
  amountUnits: string;
  usdcDecimals: number;
  priceUsd: string;
  quoteBasis: Record<string, string | number | boolean>;
  actualUsd?: string;
  /** privateAI-design-40 ARCH-690: the money trail (economicsOf). */
  economics?: ReceiptEconomics;
  /** ARCH-692: SHA-256 of the canonical JSON of the job's final attestation bundle (evidenceBundleOf). */
  evidenceBundleSha256?: string;
  /** ARCH-631: the signed quote's merchant_authorization hash (--ap2 on only). */
  merchantAuthSha256?: string;
  /** privateAI-design-36 ARCH-668: the checkout mandate ChainAim's signer verified before the run. */
  mandate?: ReceiptMandate;
  createdAt: string;
};

/** What a remote-signed receipt carries beside its body: the signer re-checks both against the body (ARCH-668). */
export type ReceiptBinding = { signer: SignerApi; ap2?: { checkout: Record<string, unknown>; merchant_authorization: string }; mandate?: string };

/**
 * The receipt body from the job's ids, hashes and amounts, signed in this process (cfg.signer, --signer local) or, with
 * `bind`, by ChainAim's signer (ARCH-663), which checks the body against its allowlist and the signed quote and mandate.
 */
export async function buildReceipt(input: ReceiptInput, cfg: ReceiptConfig, bind?: ReceiptBinding): Promise<SignedReceipt> {
  if (input.files === undefined && input.folder === undefined) throw new Error("a receipt needs the dataset folder or its files");
  const files = input.files ?? (await datasetFiles(input.folder!, cfg.maxFiles));
  const body = {
      receiptId: sha256Hex(`${input.jobId}:${input.quoteId}:${input.createdAt}`).slice(0, 32),
      jobId: input.jobId,
      quoteId: input.quoteId,
      ...(input.counterOf !== undefined ? { counterOf: input.counterOf, reduced: input.reduced ?? [] } : {}),
      route: input.route,
      datasetId: input.datasetId,
      files,
      filesRoot: filesRoot(files),
      ...(input.templateLabel ? { templateLabel: input.templateLabel } : {}),
      sqlSha256: sha256Hex(input.sql),
      resultSha256: resultSha256(input.result),
      calls: receiptCalls(input.served, input.attestStatusOf),
      ...(receiptEgress(input.served) ? { egress: receiptEgress(input.served) } : {}),
      ...(input.evidenceBundleSha256 ? { evidenceBundleSha256: input.evidenceBundleSha256 } : {}),
      ...(input.merchantAuthSha256 ? { merchantAuthSha256: input.merchantAuthSha256 } : {}),
      ...(input.mandate ? { mandate: input.mandate } : {}),
      price: {
        amountUnits: input.amountUnits,
        usdcDecimals: input.usdcDecimals,
        priceUsd: input.priceUsd,
        quoteBasis: input.quoteBasis,
        ...(input.actualUsd !== undefined ? { actualUsd: input.actualUsd } : {}),
        ...(input.economics !== undefined ? { economics: input.economics } : {}),
      },
      createdAt: input.createdAt,
      v: 1 as const,
    };
  if (bind) return bind.signer.signReceipt({ body, ...(bind.ap2 ? { ap2: bind.ap2 } : {}), ...(bind.mandate ? { mandate: bind.mandate } : {}) });
  return signReceipt(body, cfg.signer);
}

const JOB_ID = /^[0-9a-f]{32}$/;

/** Signed receipts by job id: memory first, then <dir>/<jobId>.json. Written atomically (temp file, then rename). */
export class ReceiptStore {
  private readonly mem = new Map<string, SignedReceipt>();
  private readonly quotes = new Map<string, { checkout: Record<string, unknown>; merchant_authorization: string }>();
  private readonly mandates = new Map<string, string>();
  private readonly attestations = new Map<string, JobAttestation>();
  private readonly cfg: ReceiptConfig;

  constructor(cfg: ReceiptConfig) {
    this.cfg = cfg;
    mkdirSync(cfg.dir, { recursive: true });
  }

  publicKeyPem(): string {
    return this.cfg.signer.publicKeyPem;
  }

  private path(jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new Error("jobId must be 32 lowercase hex characters");
    return join(this.cfg.dir, `${jobId}.json`);
  }

  private write(r: SignedReceipt): void {
    const p = this.path(r.body.jobId);
    writeFileSync(`${p}.tmp`, JSON.stringify(r, null, 2));
    renameSync(`${p}.tmp`, p);
    this.mem.set(r.body.jobId, r);
  }

  put(r: SignedReceipt): void {
    if (this.get(r.body.jobId)) throw new Error("a receipt for this job already exists");
    this.write(r);
  }

  get(jobId: string): SignedReceipt | undefined {
    const m = this.mem.get(jobId);
    if (m) return m;
    const p = this.path(jobId);
    if (!existsSync(p)) return undefined;
    const r = JSON.parse(readFileSync(p, "utf8")) as SignedReceipt;
    this.mem.set(jobId, r);
    return r;
  }

  /**
   * privateAI-design-33 ARCH-631: the signed quote ({checkout, merchant_authorization}) the receipt's merchantAuthSha256
   * points at, kept beside it as <dir>/<jobId>.ap2.json so a buyer can download and check both together
   * (desk.ps1 -VerifyReceipt). Ids, hashes and amounts only, like the receipt.
   */
  putQuote(jobId: string, ap2: { checkout: Record<string, unknown>; merchant_authorization: string }): void {
    const p = `${this.path(jobId).replace(/\.json$/, "")}.ap2.json`;
    writeFileSync(`${p}.tmp`, JSON.stringify(ap2, null, 2));
    renameSync(`${p}.tmp`, p);
    this.quotes.set(jobId, ap2);
  }

  getQuote(jobId: string): { checkout: Record<string, unknown>; merchant_authorization: string } | undefined {
    const m = this.quotes.get(jobId);
    if (m) return m;
    const p = `${this.path(jobId).replace(/\.json$/, "")}.ap2.json`;
    if (!existsSync(p)) return undefined;
    const q = JSON.parse(readFileSync(p, "utf8")) as { checkout: Record<string, unknown>; merchant_authorization: string };
    this.quotes.set(jobId, q);
    return q;
  }

  /**
   * ARCH-668: the checkout mandate presentation the receipt's mandate.sha256 points at, kept beside it as
   * <dir>/<jobId>.mandate.json, so one download lets anyone re-check it (scripts/verify-receipt.ts). A token, no content.
   */
  putMandate(jobId: string, mandate: string): void {
    const p = `${this.path(jobId).replace(/\.json$/, "")}.mandate.json`;
    writeFileSync(`${p}.tmp`, JSON.stringify({ mandate }, null, 2));
    renameSync(`${p}.tmp`, p);
    this.mandates.set(jobId, mandate);
  }

  getMandate(jobId: string): string | undefined {
    const m = this.mandates.get(jobId);
    if (m) return m;
    const p = `${this.path(jobId).replace(/\.json$/, "")}.mandate.json`;
    if (!existsSync(p)) return undefined;
    const v = (JSON.parse(readFileSync(p, "utf8")) as { mandate?: unknown }).mandate;
    if (typeof v !== "string") return undefined;
    this.mandates.set(jobId, v);
    return v;
  }

  /**
   * privateAI-design-40 ARCH-692: the attestation bundle the receipt's evidenceBundleSha256 commits to, kept beside it as
   * <dir>/<jobId>.attestation.json, so the download carries it and anyone can re-hash it. Verdicts, addresses, hashes only.
   */
  putAttestation(jobId: string, bundle: JobAttestation): void {
    const p = `${this.path(jobId).replace(/\.json$/, "")}.attestation.json`;
    writeFileSync(`${p}.tmp`, JSON.stringify(bundle, null, 2));
    renameSync(`${p}.tmp`, p);
    this.attestations.set(jobId, bundle);
  }

  getAttestation(jobId: string): JobAttestation | undefined {
    const m = this.attestations.get(jobId);
    if (m) return m;
    const p = `${this.path(jobId).replace(/\.json$/, "")}.attestation.json`;
    if (!existsSync(p)) return undefined;
    const a = JSON.parse(readFileSync(p, "utf8")) as JobAttestation;
    this.attestations.set(jobId, a);
    return a;
  }

  /** ARCH-663: stores the receipt ChainAim's signer settled, once, in place of the unsettled one with the same signature. */
  putSettled(r: SignedReceipt): SignedReceipt {
    const cur = this.get(r.body.jobId);
    if (!cur) throw new Error("no receipt for this job");
    if (cur.settlement) throw new Error("this receipt already carries a settlement");
    if (cur.sig.value !== r.sig.value || !r.settlement) throw new Error("the settled receipt is not this job's receipt");
    this.write(r);
    return r;
  }

  /** Appends the settlement (ARCH-616) once; a second settlement for the same job is refused. */
  settle(jobId: string, settlement: Settlement): SignedReceipt {
    const r = this.get(jobId);
    if (!r) throw new Error("no receipt for this job");
    const s = addSettlement(r, settlement, this.cfg.signer);
    this.write(s);
    return s;
  }
}

/** The settlement fields the paywall posts with a release notice, checked field by field; undefined when absent or malformed. */
export function parseSettlement(body: unknown, now: () => number = Date.now): Settlement | undefined {
  const b = body as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null) return undefined;
  if (typeof b.transaction !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(b.transaction)) return undefined;
  if (typeof b.network !== "string" || !/^near:(testnet|mainnet)$/.test(b.network)) return undefined;
  if (typeof b.invoiceId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(b.invoiceId)) return undefined;
  const payer = b.payer === null || b.payer === undefined ? null : typeof b.payer === "string" && /^[a-z0-9._-]{2,64}$/.test(b.payer) ? b.payer : undefined;
  if (payer === undefined) return undefined;
  // privateAI-design-40 ARCH-691: which x402 flow moved the money, when the paywall says; another value is malformed.
  if (b.flow !== undefined && !(SETTLEMENT_FLOWS as readonly unknown[]).includes(b.flow)) return undefined;
  return { network: b.network, transaction: b.transaction, invoiceId: b.invoiceId, payer, settledAt: new Date(now()).toISOString(), ...(b.flow !== undefined ? { flow: b.flow as SettlementFlow } : {}) };
}

/**
 * The result exactly as the buyer receives it: the paywall's release handler sends the held result with c.json
 * (services/paywall/src/app.ts release), so keys holding undefined are dropped. The receipt hashes this, not the object
 * in memory, so sha256(canonical JSON of the released body) == resultSha256 for the buyer.
 */
export function releasedResult(result: unknown): unknown {
  return JSON.parse(JSON.stringify(result));
}

const DATASET_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * The receipt's dataset id: the id the page or agent named (config/datasets.json id) when it is well formed; otherwise a
 * hash of the folder's resolved path, so no folder or path name ever enters a receipt.
 */
export function datasetIdOf(named: unknown, resolvedFolder: string): string {
  if (typeof named === "string" && DATASET_ID.test(named)) return named;
  return `folder-${sha256Hex(resolvedFolder).slice(0, 16)}`;
}

const TEMPLATE_LABEL = /^[\x20-\x7E]{1,120}$/;
/** A template label from the page (config/datasets.json templates[].label): printable ASCII, at most 120 characters; else none. */
export function templateLabelOf(named: unknown): string | undefined {
  return typeof named === "string" && TEMPLATE_LABEL.test(named.trim()) ? named.trim() : undefined;
}

/** The route of a job that calls no model: an exact query worded by no model (phrase none). */
export const NO_MODEL_ROUTE = "analyst-only";

/**
 * A job's route (quote, AP2 checkout, receipt): the models it calls, each once, in call order, joined by "+"; NO_MODEL_ROUTE
 * when it calls none. Built from the calls themselves, never from the request's model fields: an exact-SQL template carries a
 * query model that nothing calls (ARCH-644), and a route naming it would claim a model that never saw the data.
 */
export function routeOf(models: readonly string[]): string {
  const once = [...new Set(models)];
  return once.length ? once.join("+") : NO_MODEL_ROUTE;
}

/**
 * The models a finished crossask run called, in call order, from its own step log (sentToModel): each query step called the
 * query model, the answer step the answer model (the query model when none is set). A run's served[] names the provider's
 * model id, not the catalog id the price and the attestable list use, so the steps are the source here.
 */
export function calledModels(r: { model: string; answerModel?: string }, steps: readonly { step: string }[]): string[] {
  return steps.map((s) => (s.step === "answer" ? r.answerModel || r.model : r.model));
}

/**
 * ca-attest's verdict per call index, in the receipt's terms: verified -> verified, unverified -> failed, anything not
 * judged (still checking, ca-attest unreachable, attestation off) -> pending. Never "verified" without ca-attest saying so.
 */
export function attestStatusFrom(a: JobAttestation | undefined): (index: number) => "verified" | "failed" | "pending" {
  return (i) => {
    const s = a?.calls[i]?.status;
    return s === "verified" ? "verified" : s === "unverified" ? "failed" : "pending";
  };
}

/**
 * privateAI-design-40 ARCH-692: the job's attestation bundle and its hash, once ca-attest's verdict is final (any summary
 * but pending); undefined while pending or with attestation off, and the receipt is then signed without the hash. The
 * bundle is the JobAttestation as JSON carries it (verdicts, signing addresses, the signed text of model id + hashes, the
 * signature hex): no prompt or answer text. Hash = SHA-256 of its canonical JSON.
 */
export function evidenceBundleOf(a: JobAttestation | undefined): { bundle: JobAttestation; sha256: string } | undefined {
  if (!a || a.summary === "pending") return undefined;
  const bundle = JSON.parse(JSON.stringify(a)) as JobAttestation;
  return { bundle, sha256: sha256Hex(canonicalJson(bundle)) };
}

export type ReleaseReceiptDeps = {
  store: ReceiptStore;
  cfg: ReceiptConfig;
  /** ca-attest's result for the job when attestation is on (attest.ts AttestClient.get). */
  attestation?: (jobId: string) => JobAttestation | undefined;
  now?: () => number;
  /** ARCH-663: ChainAim's signer (in-process or ca-control-signer); absent = signed with cfg.signer in this process. */
  signer?: SignerApi;
};

/**
 * ARCH-615 / ARCH-616, called when the paywall tells the console a job was released: builds and signs the receipt from
 * what was held, stores it, and appends the settlement from the release notice when the notice carries one. undefined
 * for a job held without a receipt (receipts were off when it was quoted). Throws when the receipt cannot be made; the
 * caller logs the job id and reason only.
 */
export async function receiptOnRelease(deps: ReleaseReceiptDeps, jobId: string, job: HeldJob, notice: unknown): Promise<SignedReceipt | undefined> {
  const hold = job.receipt;
  if (!hold) return undefined;
  const now = deps.now ?? Date.now;
  const attestation = deps.attestation?.(jobId);
  const evidence = evidenceBundleOf(attestation);
  const receipt = await buildReceipt(
    {
      jobId,
      quoteId: hold.quoteId,
      // privateAI-design-43 ARCH-722: a counter-offer names the offer it countered and what it reduced.
      ...(hold.counterOf !== undefined ? { counterOf: hold.counterOf, reduced: hold.reduced ?? [] } : {}),
      route: hold.route,
      datasetId: hold.datasetId,
      files: hold.files,
      ...(hold.templateLabel ? { templateLabel: hold.templateLabel } : {}),
      sql: hold.sql,
      result: releasedResult(job.result),
      served: job.result.served,
      attestStatusOf: attestStatusFrom(attestation),
      amountUnits: job.amount,
      usdcDecimals: USDC_DECIMALS,
      priceUsd: hold.priceUsd,
      quoteBasis: hold.quoteBasis,
      ...(hold.actualUsd !== undefined ? { actualUsd: hold.actualUsd } : {}),
      ...(hold.economics !== undefined ? { economics: hold.economics } : {}),
      ...(evidence ? { evidenceBundleSha256: evidence.sha256 } : {}),
      ...(job.ap2 ? { merchantAuthSha256: job.ap2.merchantAuthSha256 } : {}),
      ...(job.mandate ? { mandate: job.mandate.ref } : {}),
      createdAt: new Date(now()).toISOString(),
    },
    deps.cfg,
    deps.signer ? { signer: deps.signer, ...(job.ap2 ? { ap2: { checkout: job.ap2.checkout, merchant_authorization: job.ap2.merchantAuthorization } } : {}), ...(job.mandate ? { mandate: job.mandate.presentation } : {}) } : undefined,
  );
  deps.store.put(receipt);
  if (job.ap2) deps.store.putQuote(jobId, { checkout: job.ap2.checkout, merchant_authorization: job.ap2.merchantAuthorization });
  if (job.mandate) deps.store.putMandate(jobId, job.mandate.presentation);
  if (evidence) deps.store.putAttestation(jobId, evidence.bundle);
  const settlement = parseSettlement(notice, now);
  if (!settlement) return receipt;
  if (deps.signer) return deps.store.putSettled(await deps.signer.settle({ receipt, settlement }));
  return deps.store.settle(jobId, settlement);
}

/**
 * NEAR JSON-RPC for the paywall's own reads (the USDC contract check at start).
 * Same pattern as services/chain-query/src/adapters/near.ts: one JSON-RPC
 * object per POST, because nearcore rejects batches with HTTP 400
 * (docs.near.org/api/rpc/providers), a primary URL then a fallback, and a time
 * limit on each POST. Verification and settlement go through @x402/near's own
 * signer (src/near/facilitator.ts), not through this file.
 *
 * A QuickNode URL carries its token in the path, so a URL is only ever shown
 * as its scheme and host (redactUrl).
 */

/** The scheme and host of a URL, without the path, query or credentials that may hold a token. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid URL)";
  }
}

export class NearRpcError extends Error {
  /** true when another endpoint may answer (no answer, timeout, HTTP 5xx or 429). */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export type NearRpcOptions = {
  urls: readonly string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type NearRpc = {
  call(method: string, params: unknown): Promise<unknown>;
  /** A contract view method (query/call_function at final finality), its JSON result parsed. */
  view(contract: string, method: string, args: Record<string, unknown>): Promise<unknown>;
};

export function createNearRpc(options: NearRpcOptions): NearRpc {
  const doFetch = options.fetchImpl ?? fetch;
  if (options.urls.length === 0) throw new Error("no NEAR RPC URL is configured");

  async function post(url: string, body: string): Promise<unknown> {
    let r: Response;
    try {
      r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? `no answer within ${options.timeoutMs} ms` : "not reachable";
      throw new NearRpcError(`${redactUrl(url)}: ${why}`, true);
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      throw new NearRpcError(`${redactUrl(url)}: HTTP ${r.status}`, r.status >= 500 || r.status === 429);
    }
    try {
      return await r.json();
    } catch {
      throw new NearRpcError(`${redactUrl(url)}: the answer is not JSON`, false);
    }
  }

  async function call(method: string, params: unknown): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: "chainaim-paywall", method, params });
    const errors: string[] = [];
    for (const url of options.urls) {
      let reply: { result?: unknown; error?: { name?: string; message?: string; cause?: { name?: string; info?: unknown } } };
      try {
        reply = (await post(url, body)) as typeof reply;
      } catch (e) {
        errors.push((e as Error).message);
        if (e instanceof NearRpcError && e.retryable) continue;
        break;
      }
      if (reply?.error) {
        const cause = reply.error.cause?.name ?? reply.error.name ?? "error";
        throw new NearRpcError(`${method}: ${cause}${reply.error.cause?.info ? ` ${JSON.stringify(reply.error.cause.info)}` : reply.error.message ? ` ${reply.error.message}` : ""}`, false);
      }
      if (reply?.result === undefined) throw new NearRpcError(`${method}: the answer has no result`, false);
      return reply.result;
    }
    throw new NearRpcError(errors.join("; "), false);
  }

  async function view(contract: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    const r = (await call("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
    })) as { result?: unknown; error?: unknown };
    if (r.error !== undefined) throw new NearRpcError(`${contract}.${method}: ${String(r.error)}`, false);
    if (!Array.isArray(r.result)) throw new NearRpcError(`${contract}.${method}: the result holds no bytes`, false);
    const text = Buffer.from(r.result as number[]).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new NearRpcError(`${contract}.${method}: the result is not JSON`, false);
    }
  }

  return { call, view };
}

/** One JSON POST with a timeout; injectable so the adapters are tested without a network. */
export type Rpc = (url: string, body: unknown, timeoutMs: number) => Promise<any>;

export class RpcError extends Error {
  /** true when another endpoint may succeed (network failure, timeout, HTTP 5xx or 429). */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

export const httpJson: Rpc = async (url, body, timeoutMs) => {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new RpcError((e as Error).name === "TimeoutError" ? `${url}: no answer within ${timeoutMs} ms` : `${url}: not reachable (${(e as Error).message})`, true);
  }
  if (!r.ok) throw new RpcError(`${url}: HTTP ${r.status}`, r.status >= 500 || r.status === 429);
  try { return await r.json(); } catch { throw new RpcError(`${url}: the answer is not JSON`, false); }
};

/** Tries each URL in order; moves on only for retryable failures. */
export async function firstAnswer(rpc: Rpc, urls: string[], body: unknown, timeoutMs: number): Promise<any> {
  const errors: string[] = [];
  for (const u of urls) {
    try { return await rpc(u, body, timeoutMs); }
    catch (e) { errors.push((e as Error).message); if (!(e instanceof RpcError && e.retryable)) break; }
  }
  throw new RpcError(errors.join("; ") || "no RPC endpoint configured", false);
}

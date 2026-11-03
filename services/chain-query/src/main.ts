/**
 * chain-query: read-only chain queries for the test console's "Blockchain queries" twisty (DESIGN/xrplh-28 §3.4).
 *
 *   node src/main.ts [--registry PATH] [--profile PATH] [--host 127.0.0.1] [--port 8750] [--timeout-ms 8000] [--validate]
 *
 *   --registry   chain registry (default <repo>/config/chains/networks.json); re-read on every request, so edits need no restart
 *   --profile    per-PC choices, git-ignored (default <repo>/config/local/chain-profile.json; optional): selected chain/env
 *   --validate   ping every environment, list every source that still has placeholders, exit 0/1 (no server)
 *
 *   GET /healthz
 *   GET /chains                                         chains, environments, capabilities, sources (ready / missing fields)
 *   GET /vaults?chain=&env=[&source=all|<id>]           { results: [{ source, rows, error? }] }
 *   GET /loan-terms?chain=&env=[&source=]               same shape, loan-term rows
 *   GET /export?kind=vaults|loan-terms&chain=&env=[&source=]   text/csv of the rows (for crossask / a spreadsheet)
 *
 * Holds no keys, signs and submits nothing, calls no model. Never prints the profile's addresses.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadRegistry, RegistryError, toCsv } from "../../../packages/chain-contracts/src/index.ts";
import { nearAdapter } from "./adapters/near.ts";
import { httpJson } from "./adapters/rpc.ts";
import { xrplAdapter } from "./adapters/xrpl.ts";
import { chainsSummary, query, validate, type Adapters, type Kind } from "./core.ts";

const { values: f } = parseArgs({
  args: process.argv.slice(2), strict: true,
  options: {
    registry: { type: "string", default: fileURLToPath(new URL("../../../config/chains/networks.json", import.meta.url)) },
    profile: { type: "string", default: fileURLToPath(new URL("../../../config/local/chain-profile.json", import.meta.url)) },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8750" },
    "timeout-ms": { type: "string", default: "8000" },
    validate: { type: "boolean", default: false },
  },
});
const PORT = Number(f.port), TIMEOUT = Number(f["timeout-ms"]);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`--port must be 1-65535, got ${f.port}`);
if (!Number.isInteger(TIMEOUT) || TIMEOUT < 500) throw new Error(`--timeout-ms must be a whole number >= 500, got ${f["timeout-ms"]}`);
if (!["127.0.0.1", "::1", "localhost"].includes(f.host!)) throw new Error("--host must be a loopback address: chain-query is for this PC only");

const adapters: Adapters = { xrpl: xrplAdapter(httpJson, TIMEOUT), near: nearAdapter(httpJson, TIMEOUT) };
function selected(): { chain?: string; env?: string } | null {
  try { const t = readFileSync(f.profile!, "utf8"); return (JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).selected ?? null); } catch { return null; }
}

if (f.validate) process.exit(await validate(loadRegistry(f.registry!), adapters, (l) => process.stdout.write(l + "\n")));

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
};
createServer(async (req, res) => {
  try {
    if (req.method !== "GET") return json(res, 405, { error: "GET only" });
    const u = new URL(req.url ?? "/", "http://local");
    if (u.pathname === "/healthz") return json(res, 200, { ok: true, service: "chain-query" });
    const reg = loadRegistry(f.registry!);
    if (u.pathname === "/chains") return json(res, 200, chainsSummary(reg, selected()));
    const chain = u.searchParams.get("chain") ?? "", env = u.searchParams.get("env") ?? "", source = u.searchParams.get("source") ?? undefined;
    if (u.pathname === "/vaults" || u.pathname === "/loan-terms") {
      if (!chain || !env) return json(res, 400, { error: "chain and env are required" });
      return json(res, 200, await query(reg, adapters, u.pathname.slice(1) as Kind, chain, env, source));
    }
    if (u.pathname === "/export") {
      const kind = u.searchParams.get("kind") as Kind;
      if (kind !== "vaults" && kind !== "loan-terms") return json(res, 400, { error: "kind must be vaults or loan-terms" });
      if (!chain || !env) return json(res, 400, { error: "chain and env are required" });
      const out = await query(reg, adapters, kind, chain, env, source);
      const rows = out.results.flatMap((r) => r.rows.map((x) => ({ ...x, ...Object.fromEntries(Object.entries(x.extra ?? {}).map(([k, v]) => [`x_${k}`, v])) })));
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${chain}-${env}-${kind}.csv"`, "cache-control": "no-store" });
      return res.end(toCsv(rows));
    }
    return json(res, 404, { error: "unknown route" });
  } catch (e) {
    return json(res, e instanceof RegistryError ? 400 : 500, { error: (e as Error).message });
  }
}).listen(PORT, f.host, () => process.stdout.write(`chain-query on http://${f.host}:${PORT} (registry ${f.registry}); read-only, no keys\n`));

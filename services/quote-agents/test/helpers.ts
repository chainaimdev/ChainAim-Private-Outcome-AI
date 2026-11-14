/** Shared test helpers for quote-agents (privateAI-design-44 §7): the real sample data and real local HTTP servers. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantData } from "../src/data.ts";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DATA_ROOT = join(REPO, "sample-data", "quote");
export const TENANTS = join(REPO, "config", "quote-tenants.json");
export const PROMPTS = join(REPO, "config", "quote-prompts");
export const AS_OF = "2026-11-16";
export const jupiter = () => loadTenantData(join(DATA_ROOT, "jupiter-knitting"));
export const JUPITER_LEI = "3358004DXAMRWRUIYJ05";
export const TOMMY_LEI = "54930012QJWZMYHNJW95";

export type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
/** Start a local HTTP server on a free port; the handler gets each request with its body read. */
export async function listen(handler: (seen: Seen, res: ServerResponse) => void | Promise<void>): Promise<{ url: string; seen: Seen[]; close: () => Promise<void>; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    seen.push(s);
    await handler(s, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

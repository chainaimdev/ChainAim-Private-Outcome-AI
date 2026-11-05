// adminUI architecture-adminui-jobs.md ARCH-204: gatewayChat carries the gateway's masking counts (kinds and counts
// only) when it sends them, and crossAsk records whole-millisecond step timings when given a clock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crossAsk, gatewayChat, type CrossAskDeps } from "../src/index.ts";

let headers: Record<string, string> = {};
const gw: Server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "x-chainaim-model": "local/small", "x-chainaim-zone": "local", ...headers });
    res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});
const gwUrl = await new Promise<string>((ok) => gw.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(gw.address() as AddressInfo).port}`)));
after(() => new Promise<void>((ok) => gw.close(() => ok())));
const chat = gatewayChat({ url: gwUrl, key: "k", timeoutMs: 5000 });

test("ARCH-204: entity counts and residual from the gateway's headers", async () => {
  headers = { "x-chainaim-entity-counts": '{"PERSON":3,"EMAIL_ADDRESS":1}', "x-chainaim-residual": "pass" };
  const r = await chat([{ role: "user", content: "q" }], "local/small");
  assert.deepEqual(r.entityCounts, { PERSON: 3, EMAIL_ADDRESS: 1 });
  assert.equal(r.residual, "pass");
  headers = { "x-chainaim-entity-counts": "{}" };
  assert.deepEqual((await chat([{ role: "user", content: "q" }], "local/small")).entityCounts, {});
});

test("ARCH-204: absent headers leave both fields out (the reply is as before)", async () => {
  headers = {};
  const r = await chat([{ role: "user", content: "q" }], "local/small");
  assert.deepEqual(Object.keys(r).sort(), ["model", "text", "usage", "zone"]);
});

test("ARCH-204: a malformed header leaves the field out", async () => {
  for (const bad of ["not json", "[1,2]", '{"PERSON":-1}', '{"PERSON":1.5}', '{"PERSON":"3"}', '{"a b":1}', "null", `{"P":${"9".repeat(30)}}`, "{" + '"K":1,'.repeat(1000) + '"K":1}']) {
    headers = { "x-chainaim-entity-counts": bad, "x-chainaim-residual": "maybe" };
    const r = await chat([{ role: "user", content: "q" }], "local/small");
    assert.equal(r.entityCounts, undefined, bad.slice(0, 40));
    assert.equal(r.residual, undefined);
  }
});

/** The analyst and the model as crossAsk sees them, over a clock that moves a fixed step per call. */
function deps(withClock: boolean): CrossAskDeps & { now: number } {
  const d = {
    now: 0,
    analyst: async (route: "relations" | "sql") => {
      d.now += route === "relations" ? 40 : 7;
      return route === "relations" ? { schema: "t(a INTEGER)", relations: [], tables: [{ name: "t" }, { name: "u" }] } : { columns: ["a"], rows: [{ a: 1 }], truncated: false };
    },
    chat: async (messages: { content: string }[]) => {
      d.now += 100;
      return { text: messages[0].content.startsWith("You write") ? "```sql\nSELECT a FROM t\n```" : "One.", model: "local/small", zone: "local" };
    },
    ...(withClock ? { clock: () => d.now } : {}),
  };
  return d;
}
const input = { folder: "f", question: "how many?", model: "local/small", sqlRetries: 1, answerMaxRows: 10 };

test("ARCH-204: timings present with phrase llm", async () => {
  const r = await crossAsk({ ...input, phrase: "llm" }, deps(true));
  assert.deepEqual(r.timings, { relationsMs: 40, queryMs: 100, sqlMs: 7, answerMs: 100, callsMs: [100, 100], files: 2 });
  assert.equal(r.served.length, r.timings!.callsMs.length);
});

test("ARCH-204: answerMs absent with phrase none; no timings without a clock", async () => {
  const none = await crossAsk({ ...input, phrase: "none" }, deps(true));
  assert.deepEqual(none.timings, { relationsMs: 40, queryMs: 100, sqlMs: 7, callsMs: [100], files: 2 });
  const plain = await crossAsk({ ...input, phrase: "llm" }, deps(false));
  assert.equal("timings" in plain, false);
});

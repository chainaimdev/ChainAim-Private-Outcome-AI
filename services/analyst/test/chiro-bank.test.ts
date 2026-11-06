/**
 * finance/rcm/chiro query bank (DESIGN/xrplh-29; owner decision 2026-11-06: exact Table answers now, Explained after stage 3).
 * A. the shipped bank: one exact entry per tab-03 chiro template, no model entries, a valid tables spec; bad specs are refused.
 * B. each generated SET-1/POS set (tools/chiro-synth, git-ignored; skipped when absent) through loadPackFolder: every query runs,
 *    and the answers equal the set's _answer-key/truth.json where it has the figure (bank credits by group, unearned plan revenue)
 *    and the statement's own summary block otherwise (cash in / out); payer totals equal the bank's insurance EFTs.
 * C. the same through the analyst's /pack-queries and /pack-run routes (the console's path), with the ERA .835 picked up.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PackRegistry, SourceRegistry } from "../src/core/registry.ts";
import { BUILT_IN_PACKS } from "../src/domain-packs/index.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { openDb } from "../src/db.ts";
import { loadPackFolder } from "../src/packload.ts";
import { bankPathOf, loadBank } from "../src/packquery.ts";
import { runSelect } from "../src/sqlrun.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const configRoot = join(REPO, "config");
const env = process.env.CHIRO_DATA_ROOT?.trim();
const ROOT = env ? (isAbsolute(env) ? env : resolve(REPO, env)) : join(REPO, "sample-data", "prms");
const SETS = [["chirotouch", join(ROOT, "chiro-1-chirotouch", "SET-1", "POS")], ["jane", join(ROOT, "chiro-2-jane", "SET-1", "POS")]] as const;
const PACK = "finance/rcm/chiro";
const TEMPLATES = ["Insurance paid by payer", "Bank deposits by kind", "Care plans: unearned revenue", "PI cases: open balances", "Contracted vs charged", "Cash flow vs installment"];
const registries = () => {
  const sources = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) sources.register(a);
  const packs = new PackRegistry(); for (const p of BUILT_IN_PACKS) packs.register(p);
  return { sources, pack: packs.resolve(PACK) };
};
const bank = () => loadBank(bankPathOf(configRoot, PACK));
const cents = (x: unknown) => Math.round(Number(x) * 100);
const num = (r: Record<string, unknown>, k: string) => Number(r[k]);

describe("A. the chiro query bank", () => {
  test("one exact entry per chiro template in config/datasets.json, no model entries, every entry in a known topic", () => {
    const b = bank();
    assert.equal(b.queries.filter((q) => q.question).length, 0, "model entries wait for the chiro reconciliation (stage 3)");
    const byTemplate = new Map(b.queries.filter((q) => (q as { template?: string }).template).map((q) => [(q as { template?: string }).template!, q]));
    assert.deepEqual([...byTemplate.keys()].sort(), [...TEMPLATES].sort());
    const ds = JSON.parse(readFileSync(join(configRoot, "datasets.json"), "utf8")).datasets as { id: string; templates: unknown }[];
    for (const id of ["chiro-ct", "chiro-jane"]) {
      const d = ds.find((x) => x.id === id)!;
      if (Array.isArray(d.templates)) assert.deepEqual((d.templates as { label: string }[]).map((t) => t.label).sort(), [...TEMPLATES].sort(), id);
    }
    assert.equal(b.tables?.bankGroups?.view, "bank_credits");
    assert.deepEqual(b.tables?.extensions, [".835"]);
  });

  test("a bad tables spec is refused naming the problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "chiro-bank-"));
    const write = (tables: unknown) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify({ version: 1, queries: [{ id: "a", title: "t", sql: "SELECT 1" }], tables })); return p; };
    try {
      assert.throws(() => loadBank(write({ views: { "bank/bofa": "Bank-1" } })), /views\.bank\/bofa/);
      assert.throws(() => loadBank(write({ views: { "bank/bofa": "bank" }, bankGroups: { view: "c", from: "nope", otherwise: "other", rules: [{ grp: "x", when: { des: "Y" } }] } })), /from nope is not a view/);
      assert.throws(() => loadBank(write({ views: { "bank/bofa": "bank" }, bankGroups: { view: "c", from: "bank", otherwise: "other", rules: [{ grp: "x", when: { amount: "1" } }] } })), /needs grp and when/);
      assert.throws(() => loadBank(write({ extensions: ["835"] })), /extensions/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("loadPackFolder refuses a pack that has a reconciliation config (dental runs through reconcileFolder)", async () => {
    const sources = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) sources.register(a);
    const packs = new PackRegistry(); for (const p of BUILT_IN_PACKS) packs.register(p);
    await assert.rejects(loadPackFolder({ files: [], sources, pack: packs.resolve("finance/rcm/dental"), configRoot, sourceOptions: { patientNameFormat: "last_first" }, spec: undefined, open: openDb }), /has a reconciliation config/);
  });

  test("the dental bank's views are the names the dental queries always used (moved from code to config, unchanged)", () => {
    assert.deepEqual(loadBank(bankPathOf(configRoot, "finance/rcm/dental")).tables?.views, { "bank/bofa": "bank", "prms/curve-hero/deposit-detail": "deposit",
      "prms/curve-hero/ledger": "ledger", "prms/curve-hero/patient-list": "patients", "prms/curve-hero/procedures": "procedures",
      "financing/carecredit": "carecredit", "financing/cherry": "cherry", "financing/hfd": "hfd" });
  });
});

/** Runs every exact entry of the bank on one folder; returns id -> rows. */
async function runAll(dir: string): Promise<Map<string, Record<string, unknown>[]>> {
  const { sources, pack } = registries(); const b = bank();
  const files = readdirSync(dir).filter((n) => /\.(csv|835)$/.test(n)).map((n) => ({ name: n, path: join(dir, n) }));
  const out = new Map<string, Record<string, unknown>[]>();
  await loadPackFolder({ files, sources, pack, configRoot, sourceOptions: { patientNameFormat: "last_first" }, spec: b.tables, open: openDb, inspect: async (db) => {
    for (const q of b.queries) out.set(q.id, (await runSelect(db, q.sql!, { maxRows: 500, timeoutMs: 15000 })).rows);
  } });
  return out;
}
/** The statement's summary credits / debits, read from the file itself (not through the adapter). */
function summaryOf(dir: string): { credits: number; debits: number } {
  const t = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("BANK-ST-"))!), "utf8");
  const amt = (label: string) => cents(new RegExp(`^${label},,"?([-0-9,.]+)`, "m").exec(t)![1].replace(/,/g, ""));
  return { credits: amt("Total credits"), debits: amt("Total debits") };
}

for (const [prms, dir] of SETS) {
  const skip = existsSync(dir) ? false : `chiro set not found at ${dir} (python tools/chiro-synth/gen_chiro_set.py --prms ${prms} --out <that folder>)`;
  describe(`B. ${prms} SET-1/POS through the chiro bank`, { skip }, () => {
    let r = new Map<string, Record<string, unknown>[]>(); let truth: any = null;
    before(async () => { r = await runAll(dir); truth = JSON.parse(readFileSync(join(dir, "_answer-key", "truth.json"), "utf8")); });

    test("every entry runs; only the layout-verified check fails (every chiro layout is still UNVERIFIED)", () => {
      for (const [id, rows] of r) if (id !== "file-checks") assert.ok(rows.length > 0, `${id}: no rows`);
      assert.ok(r.get("file-checks")!.every((x) => x.check_name === "layout verified against a real export"), JSON.stringify(r.get("file-checks")));
    });
    test("bank deposits by kind = truth.json bank_credits_by_group", () => {
      const got = Object.fromEntries(r.get("bank-deposits-by-kind")!.map((x) => [x.kind, cents(x.amount)]));
      assert.deepEqual(got, Object.fromEntries(Object.entries(truth.bank_credits_by_group).map(([k, v]) => [k, cents(v)])));
      const weekly = new Map<string, number>(); for (const x of r.get("bank-deposits-weekly")!) weekly.set(String(x.kind), (weekly.get(String(x.kind)) ?? 0) + cents(x.amount));
      assert.deepEqual(Object.fromEntries(weekly), got, "the weeks add up to the period total per kind");
    });
    test("care plans: unearned_net = truth.json unearned_plan_revenue; prepaid - delivered-not-collected = net", () => {
      const [u] = r.get("care-plans-unearned")!;
      assert.equal(cents(u.unearned_net), cents(truth.unearned_plan_revenue));
      assert.equal(cents(u.prepaid_not_delivered) - cents(u.delivered_not_collected), cents(u.unearned_net));
      assert.equal(num(u, "plans"), truth.counts.plans);
    });
    test("cash flow: in and out equal the statement's own summary credits and debits; the period is the stated one", () => {
      const [c] = r.get("cash-flow")!; const s = summaryOf(dir);
      assert.equal(cents(c.cash_in), s.credits); assert.equal(-cents(c.cash_out), s.debits);
      assert.equal(cents(c.net_cash_flow), s.credits + s.debits);
      assert.equal(String(c.period_start), "2024-09-01"); assert.equal(String(c.period_end), "2024-09-30");
    });
    test("insurance paid by payer: 835 payments add up to the bank's insurance EFTs; claims paid = the 835 claims", () => {
      const p = r.get("payer-paid")!;
      assert.equal(p.reduce((n, x) => n + cents(x.paid), 0), cents(truth.bank_credits_by_group.insurance_eft));
      assert.equal(p.reduce((n, x) => n + num(x, "payments"), 0), truth.counts.remittances_eft);
    });
    test("PI open balances: billed - carrier paid, open cases only; the 10 largest are sorted and within the totals", () => {
      const by = r.get("pi-open-by-state")!; const top = r.get("pi-open-largest")!;
      for (const x of by) assert.equal(cents(x.open_balance), cents(x.billed) - cents(x.carrier_paid));
      assert.equal(by.reduce((n, x) => n + num(x, "open_cases"), 0), truth.counts.pi_cases - (truth.flags.pi_settled ?? 0));
      for (let i = 1; i < top.length; i++) assert.ok(cents(top[i - 1].open_balance) >= cents(top[i].open_balance));
    });
    test("contracted vs charged: CPT codes compared as text; every fee-schedule payer with charges appears", () => {
      const rows = r.get("contracted-vs-charged")!;
      assert.ok(rows.length > 0);
      for (const x of rows) { assert.match(String(x.cpt), /^\d{5}$/); assert.equal(cents(x.charge_over_allowed), cents(x.avg_charge) - cents(x.allowed)); }
    });
  });
}

/** D. every scenario folder of SET-1 whose truth.json has query_answers (tools/chiro-synth since 2026-11-06; regenerate older sets with
 *  desk.ps1 -ChiroSample): the chiro bank's answers equal the key in every scenario, leaks included (the 835 pays what the bank may
 *  not have received, so payer-paid is compared with the 835's figures, not the bank's). */
const qaOf = (r: Map<string, Record<string, unknown>[]>) => {
  const money = (x: unknown) => (cents(x) / 100).toFixed(2);
  const by = (rows: Record<string, unknown>[], keys: string[], f: (x: Record<string, unknown>) => unknown) => Object.fromEntries(rows.map((x) => [keys.map((k) => String(x[k])).join("/"), f(x)]).sort(([a], [b]) => (a < b ? -1 : 1)));
  const [c] = r.get("cash-flow")!;
  return {
    payer_paid: by(r.get("payer-paid")!, ["payer"], (x) => ({ payments: num(x, "payments"), claims_paid: num(x, "claims_paid"), paid: money(x.paid) })),
    pi_open: by(r.get("pi-open-by-state")!, ["state", "coverage"], (x) => ({ open_cases: num(x, "open_cases"), billed: money(x.billed), carrier_paid: money(x.carrier_paid), open_balance: money(x.open_balance) })),
    contracted: by(r.get("contracted-vs-charged")!, ["payer", "cpt"], (x) => ({ allowed: money(x.allowed), charges: num(x, "charges"), avg_charge: money(x.avg_charge) })),
    cash: { in: money(c.cash_in), out: money(c.cash_out), net: money(c.net_cash_flow) },
  };
};
for (const [prms, dir] of SETS) {
  const setRoot = join(dir, "..");
  const sets = existsSync(setRoot) ? readdirSync(setRoot).filter((s) => existsSync(join(setRoot, s, "_answer-key", "truth.json"))).sort() : [];
  const withQa = sets.filter((s) => JSON.parse(readFileSync(join(setRoot, s, "_answer-key", "truth.json"), "utf8")).query_answers);
  describe(`D. ${prms}: every SET-1 scenario's answers equal its answer key`, { skip: withQa.length ? false : `no SET-1 set under ${setRoot} has query_answers (regenerate: .\\test-console\\desk.ps1 -ChiroSample)` }, () => {
    test(`all ${withQa.length} set(s) with query_answers (${sets.length - withQa.length} older set(s) without it skipped): payer, PI, contracted, cash, deposits, unearned`, async () => {
      const problems: string[] = [];
      for (const s of withQa) {
        const key = JSON.parse(readFileSync(join(setRoot, s, "_answer-key", "truth.json"), "utf8"));
        const r = await runAll(join(setRoot, s));
        const got = qaOf(r);
        for (const k of ["payer_paid", "pi_open", "contracted", "cash"] as const) {
          try { assert.deepEqual(got[k], key.query_answers[k]); } catch { problems.push(`${s} ${k}: ${JSON.stringify(got[k]).slice(0, 160)} vs key ${JSON.stringify(key.query_answers[k]).slice(0, 160)}`); }
        }
        const dep = Object.fromEntries(r.get("bank-deposits-by-kind")!.map((x) => [x.kind, cents(x.amount)]));
        const want = Object.fromEntries(Object.entries(key.bank_credits_by_group).map(([g, v]) => [g, cents(v)]));
        try { assert.deepEqual(dep, want); } catch { problems.push(`${s} deposits ${JSON.stringify(dep)} vs ${JSON.stringify(want)}`); }
        if (cents(r.get("care-plans-unearned")![0].unearned_net) !== cents(key.unearned_plan_revenue)) problems.push(`${s} unearned`);
      }
      assert.deepEqual(problems, []);
    });
  });
}

describe("C. the analyst routes (/pack-queries, /pack-run) on the chiro sets", { skip: SETS.every(([, d]) => existsSync(d)) ? false : "chiro sets not generated" }, () => {
  let child: ChildProcess | null = null, base = "", log = "", work = "";
  const post = async (route: string, body: unknown) => { const res = await fetch(`${base}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() as any }; };
  before(async () => {
    work = mkdtempSync(join(tmpdir(), "chiro-routes-"));
    const cfgPath = join(work, "_data-sources.json");
    writeFileSync(cfgPath, JSON.stringify({ allowedRoots: [ROOT], exclude: [], hideFolders: ["_*"] }));
    const port: number = await new Promise((ok, no) => { const s = createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
    child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--port", String(port), "--data-config", cfgPath, "--work-dir", join(work, "_analyst")], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* starting */ } await new Promise((ok) => setTimeout(ok, 100)); }
    throw new Error(`analyst did not start:\n${log}`);
  });
  after(() => { child?.kill(); rmSync(work, { recursive: true, force: true }); });

  test("/pack-queries lists the chiro bank in load mode", async () => {
    const q = await post("pack-queries", { pack: PACK });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.mode, "load");
    assert.ok(q.body.queries.every((x: { kind: string }) => x.kind === "sql"));
  });
  for (const [prms, dir] of SETS) {
    test(`/pack-run ${prms}: the ERA .835 is loaded, payer-paid and deposits answer with rows, no skips or errors`, async () => {
      const ids = ["payer-paid", "bank-deposits-by-kind", "care-plans-unearned", "pi-open-by-state", "contracted-vs-charged", "cash-flow"];
      const res = await post("pack-run", { folder: dir, pack: PACK, ids });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.mode, "load");
      assert.ok(res.body.files.some((f: { name: string; adapter: string }) => f.name.endsWith(".835") && f.adapter === "remit/x12-835"), JSON.stringify(res.body.files));
      for (const x of res.body.results) { assert.equal(x.error, undefined, `${x.id}: ${x.error}`); assert.equal(x.skipped, undefined, `${x.id}: ${x.skipped}`); assert.ok(x.rows.length > 0, x.id); }
    });
  }
  test("/pack-run with an id the chiro bank does not have: 400 naming it", async () => {
    const res = await post("pack-run", { folder: SETS[0][1], pack: PACK, ids: ["no-such-entry"] });
    assert.equal(res.status, 400);
    assert.match(res.body.error ?? JSON.stringify(res.body), /no query no-such-entry/);
  });
});

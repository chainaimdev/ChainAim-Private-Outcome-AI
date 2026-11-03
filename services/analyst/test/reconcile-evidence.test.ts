/**
 * Phase 4b-3: the reconcile evidence pack, the strict money check and the explain flow.
 *  A. reconcileEvidenceOf on hand-built reports (pure): signs per the pack's directions, no raw bank descriptions, budget
 *     narrowing that never drops an exception, refusal when the exceptions alone do not fit, unknown codes refused.
 *  B. L6 + L7 against a running analyst (needs DuckDB): every scenario of the dental generator (in memory, seed 1) goes through
 *     /reconcile -> /evidence -> /verify. L6: every planted exception is in the pack with its code, date, signed amount and
 *     payment IDs; a correct explanation verifies; a flipped direction, a flipped sign, an invented amount and a 3-decimal
 *     amount land in the right list. L7: no generator first or last name and no raw bank description in any pack.
 *  C. scripts/reconcile-explain.ts end to end against a stand-in gateway: Bearer key sent, nothing identifying in the
 *     request, exit 0 when verified and 1 when the stand-in model flips a direction.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { moneyText, reconcileEvidenceOf } from "../src/reconcile-evidence.ts";
import type { EvidenceConfig } from "../src/engines/deposit-match.ts";
import type { ReconcileReport } from "../src/reconcile.ts";
import { verifyMoney } from "../../../packages/crossask/src/verify.ts";
import { FIRST, LAST, SCENARIOS, defaultFlags, generate } from "../src/synth/dental-gen.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const EV: EvidenceConfig = JSON.parse(readFileSync(here("../../../config/domain-packs/finance/rcm/dental/reconcile.json"), "utf8")).evidence;
const signOf = (code: string) => (EV.directions[code] === "negative" ? "-" : EV.directions[code] === "positive" ? "+" : "");

// ---------------------------------------------------------------- A. pure
const report = (exceptions: ReconcileReport["exceptions"], matched = 30): ReconcileReport => ({
  pack: "finance/rcm/dental", packChain: ["finance-generic", "finance/rcm", "finance/rcm/dental"], checksFailed: 0,
  files: [{ name: "BankDep-Det-X.csv", adapter: "pms/curve-hero/deposit-detail", rows: 10, checks: [{ name: "unique id+provider", ok: true, detail: "" }] }],
  exceptions,
  result: { ledgerToDeposit: null, totals: { card_processor: { curveCents: 1234567, matchedCents: 1230000 } },
    depositToBank: { matched: Array.from({ length: matched }, (_, i) => ({ bankRow: 10 + i, bankDate: "2024-09-03", cents: 10000 + i, group: "card_processor", payer: null,
      curveDate: "2024-09-02", lagDays: 1, paymentIds: [String(300001 + i)], aliasBasis: null })) as any,
      unmatchedCurve: [], unmatchedBank: [{ row: 99, date: "2024-09-23", cents: 22700, description: "ZELLE FROM JANE Q DOE", kind: "ach", originator: "JANE Q DOE", des: null, trace: null, group: "insurance_eft", payer: "MH" }],
      unmappedMethods: [], unaliasedAch: [], otherCredits: [] } },
});
const X = (code: string, cents: number, extra: Partial<ReconcileReport["exceptions"][number]> = {}) =>
  ({ code, severity: "exception" as const, group: "card_processor", payer: null, date: "2024-09-12", cents, paymentIds: ["300123"], bankRows: [], detail: `detail of ${code}`, ...extra });

describe("A. reconcile evidence (pure)", () => {
  test("signs follow the pack's directions: short -, over +, neutral unsigned; watch items kept", () => {
    const t = reconcileEvidenceOf(report([X("CASH_SHORT", 4500), X("DEPOSIT_OVER", 1200), X("REF_MISMATCH", 48900), X("HFD_LAG", 70000, { severity: "watch" })]), EV, 16000).text;
    assert.match(t, /CASH_SHORT .*amount -45\.00 \(bank below Curve\)/);
    assert.match(t, /DEPOSIT_OVER .*amount \+12\.00 \(bank above Curve\)/);
    assert.match(t, /REF_MISMATCH .*amount 489\.00 \(no bank difference\)/);
    assert.match(t, /HFD_LAG \| watch .*amount -700\.00/);
  });
  test("no raw bank description: BANK_UNPOSTED shows its bank row's kind and payer code, never the description or originator", () => {
    const t = reconcileEvidenceOf(report([X("BANK_UNPOSTED", 22700, { bankRows: [99], paymentIds: [], detail: "ZELLE FROM JANE Q DOE" })]), EV, 16000).text;
    assert.match(t, /BANK_UNPOSTED .*amount \+227\.00 .*bank rows 99 \(ach, payer MH\)/);
    assert.doesNotMatch(t, /JANE|DOE|ZELLE/);
  });
  test("narrows the match trail, then the file checks, and never drops an exception", () => {
    const rep = report(Array.from({ length: 6 }, (_, i) => X("DEPOSIT_SHORT", 1000 + i)), 200);
    const full = reconcileEvidenceOf(rep, EV, 100000, 200);
    const tight = reconcileEvidenceOf(rep, EV, full.chars - 500, 200);
    assert.ok(tight.trailShown < full.trailShown && tight.exceptionsShown === 6 && tight.chars <= full.chars - 500);
    assert.throws(() => reconcileEvidenceOf(rep, EV, 300, 200), /exceptions are never dropped/);
  });
  test("a cause code with no configured direction is refused, not guessed", () => {
    assert.throws(() => reconcileEvidenceOf(report([X("NEW_CODE", 100)]), EV, 16000), /no direction configured for cause code\(s\) NEW_CODE/);
  });
  test("the pack and verifyMoney agree: a correct sentence per exception verifies, a flipped one is caught", () => {
    const t = reconcileEvidenceOf(report([X("CASH_SHORT", 4500), X("BANK_UNPOSTED", 22700, { bankRows: [99], paymentIds: [] })]), EV, 16000).text;
    assert.deepEqual(verifyMoney("The ATM deposit on 2024-09-12 was short by $45.00. An extra bank credit of $227.00 has no Curve posting.", t).signMismatch, []);
    assert.deepEqual(verifyMoney("The ATM deposit was over by $45.00.", t).signMismatch, ["$45.00"]);
  });
});

// ---------------------------------------------------------------- B, C. against a running analyst (DuckDB; PC)
const NAME = new RegExp(`\\b(${[...FIRST, ...LAST].join("|")})\\b`);
const RAW_BANK = /\b(DES:|INDN:|CO ID:|PMT INFO|BKOFAMERICA|PAYCHEX|GLOBAL PAYMENTS)/;
/** What a careful model would say: one sentence per exception, direction word from the sign, figures copied. */
function standInAnswer(evidence: string, flip = false): string {
  const out: string[] = [];
  for (const line of evidence.split("\n")) {
    const m = /^\d+\. (\w+) .*?(?:date (\S+))? .*amount ([+-]?)([\d,]+\.\d\d)/.exec(line);
    if (!m) continue;
    const [, code, date, sg, mag] = m;
    const word = sg === "-" ? (flip ? "over" : "short") : sg === "+" ? (flip ? "short" : "extra") : "involving";
    out.push(`${code}${date ? ` on ${date}` : ""}: ${word} $${mag}.`);
  }
  return out.length ? out.join("\n") : "Everything reconciled; there are no exceptions.";
}

describe("B/C. L6 + L7 through the analyst routes, and the explain script", () => {
  let root = "", child: ChildProcess | null = null, base = "", log = "";
  const sets = new Map<string, { folder: string; truth: any }>();
  const post = async (route: string, body: unknown) => { const r = await fetch(`${base}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  before(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "reconcile-evidence-")));
    for (const scenario of SCENARIOS) {
      const folder = join(root, "sets", scenario);
      const set = generate(defaultFlags(folder, { scenario, seed: 1, leak_seed: 1 }));
      for (const [rel, text] of set.files) { const p = join(folder, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); }
      sets.set(scenario, { folder, truth: set.truth });
    }
    const cfgPath = join(root, "_data-sources.json");
    writeFileSync(cfgPath, JSON.stringify({ allowedRoots: [join(root, "sets")], exclude: [], hideFolders: ["_*"] }));
    const port: number = await new Promise((ok, no) => { const s = createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
    child = spawn(process.execPath, [here("../src/main.ts"), "--port", String(port), "--data-config", cfgPath, "--work-dir", join(root, "_analyst"), "--runs-in-memory", "3"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`analyst did not start:\n${log}`);
  });
  after(() => { child?.kill(); rmSync(root, { recursive: true, force: true }); });

  for (const scenario of SCENARIOS) {
    test(`L6 + L7 ${scenario}: every planted exception in the pack, signed; explanations verified or caught; no names`, async () => {
      const { folder, truth } = sets.get(scenario)!;
      const rec = await post("reconcile", { folder });
      assert.equal(rec.status, 200, JSON.stringify(rec.body));
      assert.match(rec.body.runId, /^\d{8}T\d{6}-[0-9a-f]{8}$/);
      const ev = await post("evidence", { runId: rec.body.runId });
      assert.equal(ev.status, 200, JSON.stringify(ev.body));
      const text: string = ev.body.text;
      const lines = text.split("\n");
      for (const x of truth.expected_exceptions) {
        const amount = `amount ${signOf(x.code)}${moneyText(x.cents)}`;
        const hit = lines.find((l) => l.includes(` ${x.code} `) && l.includes(`date ${x.date}`) && l.includes(amount) && x.payment_ids.every((id: number) => l.includes(String(id))));
        assert.ok(hit, `L6: ${x.code} ${x.date} ${amount} ${x.payment_ids.join(";")} not in the pack:\n${text}`);
      }
      assert.equal(ev.body.exceptionsShown, rec.body.exceptions.length);
      assert.doesNotMatch(text, NAME, "L7: a person's name is in the evidence");
      assert.doesNotMatch(text, RAW_BANK, "L7: a raw bank description is in the evidence");
      const good = await post("verify", { runId: rec.body.runId, answer: standInAnswer(text), evidence: text });
      assert.deepEqual([good.body.kind, good.body.notFound, good.body.signMismatch, good.body.signUnclear], ["reconcile", [], [], []], standInAnswer(text));
      if (truth.expected_exceptions.some((x: any) => signOf(x.code))) {
        const bad = await post("verify", { runId: rec.body.runId, answer: standInAnswer(text, true), evidence: text });
        assert.ok(bad.body.signMismatch.length > 0, `a flipped direction must be caught:\n${standInAnswer(text, true)}`);
      }
      const odd = await post("verify", { runId: rec.body.runId, answer: "The deposit was short by $9,876.54, and by -1.005 elsewhere.", evidence: text });
      assert.deepEqual(odd.body.notFound, ["$9,876.54", "-1.005"]);
    });
  }

  test("routes: with --runs-in-memory 3 the oldest reconcile run is evicted, and /evidence then answers 404", async () => {
    const ids: string[] = [];
    for (const s of ["pos", "neg-all", "neg-hfd-lag", "neg-cash-short"]) ids.push((await post("reconcile", { folder: sets.get(s)!.folder })).body.runId);
    const gone = await post("evidence", { runId: ids[0] });
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /unknown or expired runId/);
  });

  test("C. reconcile-explain.ts with a stand-in gateway: key sent, nothing identifying sent, exit 0 verified / 1 flipped", async () => {
    let flip = false; const seen: { auth: string; body: string }[] = [];
    const gw: Server = createServer((req, res) => {
      let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
        seen.push({ auth: String(req.headers.authorization), body });
        const user = JSON.parse(body).messages.find((m: any) => m.role === "user").content as string;
        const answer = standInAnswer(user.slice(user.indexOf("EVIDENCE:")), flip);
        res.writeHead(200, { "content-type": "application/json", "x-chainaim-model": "stand-in/model", "x-chainaim-zone": "local" });
        res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      });
    });
    const gport: number = await new Promise((ok) => gw.listen(0, "127.0.0.1", () => ok((gw.address() as { port: number }).port)));
    try {
      const run = () => new Promise<{ status: number | null; out: string }>((ok) => {
        const c = spawn(process.execPath, [here("../scripts/reconcile-explain.ts"), "--folder", sets.get("neg-all")!.folder, "--analyst", base, "--gateway", `http://127.0.0.1:${gport}`,
          "--key-env", "RECON_TEST_GW_KEY", "--json"], { env: { ...process.env, RECON_TEST_GW_KEY: "test-key-not-a-secret" } });
        let out = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; }); c.on("close", (status) => ok({ status, out }));
      });
      const okRun = await run();
      assert.equal(okRun.status, 0, okRun.out);
      assert.equal(JSON.parse(okRun.out).verify.verified, true);
      assert.equal(seen[0].auth, "Bearer test-key-not-a-secret");
      assert.doesNotMatch(seen[0].body, NAME); assert.doesNotMatch(seen[0].body, RAW_BANK);
      flip = true;
      const badRun = await run();
      assert.equal(badRun.status, 1, badRun.out);
      assert.ok(JSON.parse(badRun.out).verify.signMismatch.length > 0);
    } finally { gw.close(); }
  });
});

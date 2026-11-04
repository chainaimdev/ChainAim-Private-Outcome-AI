/** privateAI-design-30 §6.3: scripts/era-to-csv.ts (--in <file.835> --out <dir>), pure Node. Fixture: test/era-fixture.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chiroEra } from "./era-fixture.ts";

const script = fileURLToPath(new URL("../scripts/era-to-csv.ts", import.meta.url));
const run = (...a: string[]) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8", timeout: 60000 });
const withDir = (f: (dir: string) => void) => { const dir = mkdtempSync(join(tmpdir(), "era-")); try { f(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test("writes five CSVs (header + rows in cents) and exits 0 when every check passes", () => withDir((dir) => {
  const input = join(dir, "ERA-SET1-POS.835"); writeFileSync(input, chiroEra({ newline: true }));
  const out = run("--in", input, "--out", join(dir, "csv"), "--json");
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.equal(j.failed, 0); assert.equal(j.version, "005010X221A1");
  assert.deepEqual(readdirSync(join(dir, "csv")).sort(), ["ERA-SET1-POS-adjustments.csv", "ERA-SET1-POS-claims.csv", "ERA-SET1-POS-lines.csv", "ERA-SET1-POS-payments.csv", "ERA-SET1-POS-plb.csv"]);
  const claims = readFileSync(join(dir, "csv", "ERA-SET1-POS-claims.csv"), "utf8").trim().split("\r\n");
  assert.equal(claims[0], "st_control,trace,claim_seq,patient_control_no,status,charge_cents,paid_cents,patient_resp_cents,filing_indicator,payer_claim_no,facility_code,frequency,period_start,period_end");
  assert.equal(claims.length, 6);
  assert.equal(claims[1], "0001,EFT0001,1,V1001,1,15000,9500,2000,CI,PCN-A1,,,2026-09-01,");
  const adj = readFileSync(join(dir, "csv", "ERA-SET1-POS-adjustments.csv"), "utf8").trim().split("\r\n");
  assert.equal(adj.length, 10); assert.equal(adj[5], "2,1,line,CO,97,4500,");
  assert.equal(readFileSync(join(dir, "csv", "ERA-SET1-POS-lines.csv"), "utf8").includes("DOE"), false);
}));

test("--prefix and --tables choose the files; the default out folder is the input's folder", () => withDir((dir) => {
  const input = join(dir, "x.835"); writeFileSync(input, chiroEra());
  assert.equal(run("--in", input, "--prefix", "ERA-A", "--tables", "payments,plb").status, 0);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".csv")).sort(), ["ERA-A-payments.csv", "ERA-A-plb.csv"]);
  assert.equal(readFileSync(join(dir, "ERA-A-plb.csv"), "utf8").trim().split("\r\n")[1], "0001,EFT0001,1234567893,2026-12-31,L6,INT1,-250");
}));

test("an unbalanced file: files still written, exit 1 naming the check; --allow-unbalanced exits 0", () => withDir((dir) => {
  const input = join(dir, "bad.835"); writeFileSync(input, chiroEra({}, (s) => s.map((x) => x.replace("BPR*I*97.50", "BPR*I*95.00"))));
  const out = run("--in", input, "--out", dir);
  assert.equal(out.status, 1); assert.match(out.stdout, /FAIL payment balances/);
  assert.ok(readdirSync(dir).includes("bad-claims.csv"));
  assert.equal(run("--in", input, "--out", dir, "--allow-unbalanced").status, 0);
}));

test("usage errors exit 2: no --in, unknown table, a file that is not an 835", () => withDir((dir) => {
  assert.equal(run().status, 2);
  const input = join(dir, "x.835"); writeFileSync(input, chiroEra());
  const t = run("--in", input, "--tables", "claims,nope"); assert.equal(t.status, 2); assert.match(t.stderr, /unknown table nope/);
  const csv = join(dir, "bank.csv"); writeFileSync(csv, "Date,Description,Amount\n");
  const n = run("--in", csv); assert.equal(n.status, 2); assert.match(n.stderr, /not an X12 interchange/);
}));

/**
 * tools/smb-synth (2026-11-06): the generator writes the smb-fin-1 receivables and payables tied to the bank statement, and
 * the independent verifier passes them and catches a tampered row. Runs the real Python scripts in a temporary folder with a
 * copy-shaped bank statement (no sample-data needed); skipped when no Python 3 is on PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GEN = fileURLToPath(new URL("../../tools/smb-synth/gen_ar_ap.py", import.meta.url));
const VERIFY = fileURLToPath(new URL("../../tools/smb-synth/verify_ar_ap.py", import.meta.url));
const PY = ["python", "python3"].find((p) => spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"]).status === 0);

const BANK = [
  "SECTION,DATE,DESCRIPTION,AMOUNT,BALANCE",
  'HEADER,,"Statement Period: Oct 01, 2026 to Oct 15, 2026",,',
  "DEPOSITS,10/04/2026,DIRECT DEPOSIT - ACME CORP DES:EDI PYMNT,1500.00,3950.50",
  "DEBITS_OTHER,10/10/2026,ELECTRIC UTILITY PAYMENT ONLINE,-85.40,3817.25",
].join("\n") + "\n";

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "smb-synth-"));
  writeFileSync(join(dir, "sample_bofa_full_statement.csv"), BANK);
  return dir;
}
const run = (script: string, args: string[]) => spawnSync(PY!, [script, ...args], { encoding: "utf8" });

test("gen writes both files and the key, ties the ACME deposit to one invoice, and the verifier passes", { skip: !PY && "no Python 3 on PATH" }, () => {
  const dir = folder();
  try {
    const g = run(GEN, ["--out-dir", dir, "--seed", "7"]);
    assert.equal(g.status, 0, g.stderr + g.stdout);
    const ar = readFileSync(join(dir, "AR-OPEN-INVOICES.csv"), "utf8").trim().split(/\r?\n/);
    assert.equal(ar[0], "Invoice No,Customer,Invoice Date,Due Date,Terms,Amount,Paid,Open Balance,Days Past Due,Aging Bucket");
    assert.equal(ar.length, 1 + 8);
    assert.equal(ar.filter((l) => /^INV-\d+,ACME CORP,.*,1500\.00,/.test(l)).length, 1, "the deposit pays exactly one ACME invoice");
    const key = JSON.parse(readFileSync(join(dir, "_answer-key", "ar-ap-key.json"), "utf8"));
    assert.equal(key.payables.count, 7);
    assert.equal(key.netPositionCents, key.receivables.openCents - key.payables.openCents);
    assert.deepEqual(key.bankTies.map((t: any) => [t.customer, t.paidCents]), [["ACME CORP", 150000]]);
    // Cash flow vs installment (owner 2026-11-07): the dated statement rows by month, the HEADER row (no date) left out.
    assert.deepEqual(key.bankCashByMonth, { "2026-10": { cash_in: 150000, cash_out: 8540, net_cash_flow: 141460 } });
    const v = run(VERIFY, ["--dir", dir]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /ALL CHECKS PASS: 8 invoices, 7 bills, as of 10\/15\/2026/);
    // A wrong monthly figure in the key is caught by the verifier's own re-adding of the statement.
    const keyPath = join(dir, "_answer-key", "ar-ap-key.json");
    const good = readFileSync(keyPath, "utf8");
    writeFileSync(keyPath, JSON.stringify({ ...key, bankCashByMonth: { "2026-10": { cash_in: 150000, cash_out: 8541, net_cash_flow: 141459 } } }));
    const bad = run(VERIFY, ["--dir", dir]);
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, /FAIL  bankCashByMonth .* != the statement by month/);
    writeFileSync(keyPath, good);
    // Same seed, same files.
    const before = readFileSync(join(dir, "AP-OPEN-BILLS.csv"), "utf8");
    assert.equal(run(GEN, ["--out-dir", dir, "--seed", "7", "--force"]).status, 0);
    assert.equal(readFileSync(join(dir, "AP-OPEN-BILLS.csv"), "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the verifier catches a tampered open balance; the generator refuses to overwrite without --force and bad flags", { skip: !PY && "no Python 3 on PATH" }, () => {
  const dir = folder();
  try {
    assert.equal(run(GEN, ["--out-dir", dir]).status, 0);
    assert.equal(run(GEN, ["--out-dir", dir]).status, 2, "files exist, no --force");
    assert.equal(run(GEN, ["--out-dir", dir, "--force", "--as-of", "2026-10-15"]).status, 2);
    assert.equal(run(GEN, ["--out-dir", dir, "--force", "--min-amount", "500", "--max-amount", "100"]).status, 2);
    const p = join(dir, "AP-OPEN-BILLS.csv");
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    const cells = lines[1].split(",");
    cells[7] = (Number(cells[7]) + 1).toFixed(2); // Open Balance no longer Amount - Paid, and the total no longer the key's
    lines[1] = cells.join(",");
    writeFileSync(p, lines.join("\n"));
    const v = run(VERIFY, ["--dir", dir]);
    assert.equal(v.status, 1, v.stdout);
    assert.match(v.stdout, /FAIL  AP-OPEN-BILLS\.csv line 2 .*!= Open Balance/);
    assert.match(v.stdout, /open total .* answer key says/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

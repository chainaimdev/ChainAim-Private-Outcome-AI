"""Re-read a generated set by header and check it reconciles against its answer key.
POS: every banked payment in exactly one bank credit. NEG: the IDs in truth.json affected_payment_ids are in no exact
match, every other banked ID in exactly one, and exactly unmatched_bank_credits bank credits match nothing.
Usage: python verify_set.py --dir SET-2/POS --tag SET1-POS"""
import argparse, csv, re, json
from decimal import Decimal as D
from collections import defaultdict
ap = argparse.ArgumentParser(); ap.add_argument("--dir", required=True); ap.add_argument("--tag", required=True)
A = ap.parse_args(); d, t = A.dir, A.tag
def rd(p): return list(csv.reader(open(p, encoding="utf-8-sig", newline="")))
dep = rd(f"{d}/BankDep-Det-{t}.csv"); led = rd(f"{d}/Per-Sum-{t}.csv"); bank = rd(f"{d}/BANK-ST-{t}.csv")
em = list(csv.DictReader(open(f"{d}/_answer-key/expected-matches.csv", newline="")))
truth = json.load(open(f"{d}/_answer-key/truth.json"))
affected = set(truth.get("affected_payment_ids", [])); unmatched_bank = truth.get("unmatched_bank_credits", 0)
ok = True
def fail(m):
    global ok; ok = False; print("FAIL", m)
# deposit by ID
H = dep[0]; dep_amt = defaultdict(D); dep_type = {}
for r in dep[1:]:
    x = dict(zip(H, r)); dep_amt[int(x["ID"])] += D(x["Amount"]); dep_type[int(x["ID"])] = x["Payment Type"]
# ledger by ID (header-based), sign rule
H = led[0]; led_amt = defaultdict(D); led_kind = {}
for r in led[1:]:
    x = dict(zip(H, r)); m = re.match(r"(\w+) #(\d+)(?:, (.+?))?(?: - (\d+))?$", x["Details"])
    if not m: fail(f"unparsed Details {x['Details']}"); continue
    led_amt[int(m[2])] += D(x["Amount"]); led_kind[int(m[2])] = (m[1], (m[3] or "").strip())
for i, a in dep_amt.items():
    k = led_kind.get(i)
    if not k: fail(f"dep id {i} not in ledger"); continue
    exp = led_amt[i] if k[0] == "Deposit" else -led_amt[i]
    if exp != a: fail(f"id {i} dep {a} vs ledger {led_amt[i]}")
    if k[1] != dep_type[i]: fail(f"id {i} method {k[1]} vs {dep_type[i]}")
# bank: preamble totals + running balance
hdr = next(i for i, r in enumerate(bank) if r[:2] == ["Date", "Description"])
num = lambda s: D(s.replace(",", "")) if s else D(0)
opening = num(bank[1][2]); cr = num(bank[2][2]); db = num(bank[3][2]); end = num(bank[4][2])
if opening + cr + db != end: fail("preamble does not foot")
bal = opening; c = D(0); dd = D(0); credits = []
for r in bank[hdr+2:]:
    a = num(r[2]); bal += a; c += a if a > 0 else 0; dd += a if a < 0 else 0
    if bal != num(r[3]): fail(f"running balance {r[:4]}")
    if a > 0: credits.append((r[0], r[1], a))
if (c, dd, bal) != (cr, db, end): fail("detail does not equal preamble")
# expected matches: each banked id exactly once, sums equal bank credit
seen = defaultdict(int)
for m in em:
    ids = [int(x) for x in m["curve_payment_ids"].split(";")]
    for i in ids: seen[i] += 1
    s = sum(dep_amt[i] for i in ids)
    if s != D(m["curve_total"]): fail(f"match {m['bank_date']} sum {s} != {m['curve_total']}")
    if D(m["bank_amount"]) != s - D(m["fee"]): fail(f"bank amount {m['bank_amount']}")
    if (m["bank_date"], m["bank_description"], D(m["bank_amount"])) not in credits: fail(f"credit not in bank: {m['bank_description'][:40]}")
    if m["trace"] and f"TRN*1*{m['trace']}*" not in m["bank_description"]: fail("trace not in description")
for i in dep_amt:
    want = 0 if i in affected else 1
    if seen[i] != want: fail(f"dep id {i} matched {seen[i]} times, expected {want}")
if len(em) + unmatched_bank != len(credits): fail(f"{len(credits)} bank credits vs {len(em)} expected matches + {unmatched_bank} unmatched")
import sys
print("ALL CHECKS PASS" if ok else "FAILED", json.dumps(dict(deposit_ids=len(dep_amt), ledger_ids=len(led_amt), bank_credits=len(credits), matches=len(em), unmatched_bank=unmatched_bank, exceptions=len(truth.get("expected_exceptions", [])))))
sys.exit(0 if ok else 1)

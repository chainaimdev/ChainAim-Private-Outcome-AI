#!/usr/bin/env python3
"""
Re-reads the receivables and payables written by gen_ar_ap.py by column name (independently of it) and checks them against
their own rules, the answer key and the bank statement. Exit 0 = ALL CHECKS PASS, 1 = a check failed (each printed),
2 = usage error.

  python tools/smb-synth/verify_ar_ap.py [--dir sample-data/smb-fin/statements] [--bank sample_bofa_full_statement.csv]

Checks, per file: the exact column header; unique document numbers; Open Balance = Amount - Paid and > 0; Paid >= 0;
Due Date = Date + Terms ("Net N"); Days Past Due = max(0, as-of - Due Date) with as-of from the answer key; the Aging
Bucket of those days. Totals: count, open total and per-bucket totals equal _answer-key/ar-ap-key.json; netPositionCents =
receivables open - payables open. Bank (unless --bank none): every "DIRECT DEPOSIT - <NAME> DES:" credit has exactly one
invoice to <NAME> whose Paid equals the credit, listed in the key's bankTies.
"""
import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime, timedelta

FMT = "%m/%d/%Y"
FILES = {
    "receivables": ("AR-OPEN-INVOICES.csv", ["Invoice No", "Customer", "Invoice Date", "Due Date", "Terms", "Amount", "Paid", "Open Balance", "Days Past Due", "Aging Bucket"]),
    "payables": ("AP-OPEN-BILLS.csv", ["Bill No", "Vendor", "Bill Date", "Due Date", "Terms", "Amount", "Paid", "Open Balance", "Days Past Due", "Aging Bucket"]),
}


def cents(t):
    t = t.strip().replace(",", "")
    m = re.fullmatch(r"(-?)(\d*)(?:\.(\d{1,2}))?", t)
    if not m or (m[2] == "" and not m[3]):
        raise ValueError(f"not an amount: {t!r}")
    v = int(m[2] or 0) * 100 + int((m[3] or "").ljust(2, "0"))
    return -v if m[1] else v


def expected_bucket(days):
    return "Current" if days <= 0 else "1-30" if days <= 30 else "31-60" if days <= 60 else "61-90" if days <= 90 else "91+"


def main(argv):
    p = argparse.ArgumentParser(description="Verify the synthetic receivables and payables of the small-business sample.")
    p.add_argument("--dir", default=os.path.join("sample-data", "smb-fin", "statements"))
    p.add_argument("--bank", default="sample_bofa_full_statement.csv", help='relative to --dir unless absolute; "none" = skip')
    a = p.parse_args(argv)
    key_path = os.path.join(a.dir, "_answer-key", "ar-ap-key.json")
    if not os.path.isfile(key_path):
        print(f"verify_ar_ap: no answer key at {key_path}: run gen_ar_ap.py first", file=sys.stderr)
        return 2
    with open(key_path, encoding="utf-8") as fh:
        key = json.load(fh)
    as_of = datetime.strptime(key["asOf"], FMT)
    problems = []
    open_total = {}
    docs = {}
    for part, (name, cols) in FILES.items():
        path = os.path.join(a.dir, name)
        if not os.path.isfile(path):
            problems.append(f"{name}: missing")
            continue
        with open(path, encoding="utf-8-sig", newline="") as fh:
            rd = csv.reader(fh)
            header = next(rd, [])
            body = [dict(zip(header, r)) for r in rd]
        if header != cols:
            problems.append(f"{name}: header {header} is not {cols}")
            continue
        num, date_col, who = cols[0], cols[2], cols[1]
        seen, by, total = set(), {}, 0
        for i, r in enumerate(body, start=2):
            where = f"{name} line {i} ({r[num]})"
            if r[num] in seen:
                problems.append(f"{where}: duplicate number")
            seen.add(r[num])
            amount, paid, open_ = cents(r["Amount"]), cents(r["Paid"]), cents(r["Open Balance"])
            if paid < 0 or open_ != amount - paid or open_ <= 0:
                problems.append(f"{where}: Amount {r['Amount']} - Paid {r['Paid']} != Open Balance {r['Open Balance']} (or not open)")
            m = re.fullmatch(r"Net (\d+)", r["Terms"])
            if not m:
                problems.append(f"{where}: Terms {r['Terms']!r} is not 'Net N'")
                continue
            due = datetime.strptime(r[date_col], FMT) + timedelta(days=int(m[1]))
            if r["Due Date"] != due.strftime(FMT):
                problems.append(f"{where}: Due Date {r['Due Date']} != {date_col} + {m[1]} days ({due.strftime(FMT)})")
            dpd = max(0, (as_of - due).days)
            if r["Days Past Due"] != str(dpd):
                problems.append(f"{where}: Days Past Due {r['Days Past Due']} != {dpd}")
            if r["Aging Bucket"] != expected_bucket(dpd):
                problems.append(f"{where}: Aging Bucket {r['Aging Bucket']} != {expected_bucket(dpd)}")
            by[r["Aging Bucket"]] = by.get(r["Aging Bucket"], 0) + open_
            total += open_
        docs[part] = body
        open_total[part] = total
        k = key.get(part, {})
        if k.get("count") != len(body):
            problems.append(f"{name}: {len(body)} rows, answer key says {k.get('count')}")
        if k.get("openCents") != total:
            problems.append(f"{name}: open total {total} cents, answer key says {k.get('openCents')}")
        if k.get("byBucketCents") != dict(sorted(by.items())):
            problems.append(f"{name}: bucket totals {dict(sorted(by.items()))}, answer key says {k.get('byBucketCents')}")
    if len(open_total) == 2 and key.get("netPositionCents") != open_total["receivables"] - open_total["payables"]:
        problems.append(f"netPositionCents {key.get('netPositionCents')} != {open_total['receivables'] - open_total['payables']}")

    if a.bank != "none":
        bank = a.bank if os.path.isabs(a.bank) else os.path.join(a.dir, a.bank)
        if not os.path.isfile(bank):
            problems.append(f"bank statement missing: {bank} (use --bank none to skip)")
        else:
            with open(bank, encoding="utf-8-sig", newline="") as fh:
                credits = []
                for r in csv.DictReader(fh):
                    m = re.match(r"DIRECT DEPOSIT - (.+?) DES:", (r.get("DESCRIPTION") or "").strip())
                    if (r.get("SECTION") or "").strip() == "DEPOSITS" and m:
                        credits.append((m[1].strip(), cents(r["AMOUNT"])))
            ties = {(t["customer"], t["paidCents"]) for t in key.get("bankTies", [])}
            for payer, amount in credits:
                hits = [r for r in docs.get("receivables", []) if r["Customer"] == payer and cents(r["Paid"]) == amount]
                if len(hits) != 1:
                    problems.append(f"bank deposit {payer} {amount} cents: {len(hits)} invoice(s) paid by exactly it, expected 1")
                if (payer, amount) not in ties:
                    problems.append(f"bank deposit {payer} {amount} cents: not in the answer key's bankTies")
            if len(ties) != len(credits):
                problems.append(f"answer key lists {len(ties)} bank ties, the statement has {len(credits)} direct deposits")

    for x in problems:
        print(f"FAIL  {x}")
    if problems:
        print(f"{len(problems)} check(s) failed")
        return 1
    print(f"ALL CHECKS PASS: {len(docs.get('receivables', []))} invoices, {len(docs.get('payables', []))} bills, as of {key['asOf']}, "
          f"net position {key['netPositionCents'] / 100:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

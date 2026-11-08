#!/usr/bin/env python3
"""
Synthetic open receivables and payables for the small-business sample (sample-data/smb-fin/statements), so the tab 03
template "Receivables vs payables: need a loan?" has data to answer from (2026-11-06; before this the folder held only a
bank statement, which cannot show who owes whom). Generic, documented layout: it copies no accounting product's export.
Every generated name ends in (SYN); the only other name is the payer of a bank deposit, taken from the statement itself.
Deterministic for a --seed.

  python tools/smb-synth/gen_ar_ap.py [--out-dir sample-data/smb-fin/statements] [--bank sample_bofa_full_statement.csv]
      [--as-of 10/15/2026] [--invoices 8] [--bills 7] [--seed 1] [--min-amount 250] [--max-amount 4000] [--force]

Writes into --out-dir:
  AR-OPEN-INVOICES.csv  Invoice No, Customer, Invoice Date, Due Date, Terms, Amount, Paid, Open Balance, Days Past Due, Aging Bucket
  AP-OPEN-BILLS.csv     Bill No, Vendor, Bill Date, Due Date, Terms, Amount, Paid, Open Balance, Days Past Due, Aging Bucket
  _answer-key/ar-ap-key.json   counts and open totals (cents) per file and aging bucket, the net position (receivables
                        open minus payables open), the invoices tied to bank deposits and bankCashByMonth: the bank
                        statement's cash per month ("YYYY-MM": {cash_in, cash_out, net_cash_flow}, cents, cash_out positive),
                        for the "Cash flow vs installment" template (owner 2026-11-07). The folder starts with "_", so the
                        console never lists it (hideFolders) and the analyst never reads it as data.
Rules: Open Balance = Amount - Paid > 0 (open items only); Due Date = Invoice/Bill Date + Terms ("Net N" days);
Days Past Due = max(0, as-of - Due Date); Aging Bucket: Current (0), 1-30, 31-60, 61-90, 91+.
--bank (relative to --out-dir unless absolute; "none" = no tie): each DEPOSITS row "DIRECT DEPOSIT - <NAME> DES:..." becomes
one invoice to <NAME>, partly paid by exactly that deposit, dated before it, so receivables and the statement agree.
--invoices counts these tied invoices too. bankCashByMonth counts every statement row whose DATE is MM/DD/YYYY (the
HEADER and SUMMARY rows carry none): AMOUNT > 0 is cash in, < 0 cash out; {} with --bank none or no statement.
Dates are MM/DD/YYYY like the statement; amounts have two decimals.
Exit 0 = written, 2 = usage error (including existing files without --force).
"""
import argparse
import csv
import json
import os
import random
import re
import sys
from datetime import datetime, timedelta

FMT = "%m/%d/%Y"
AR_COLS = ["Invoice No", "Customer", "Invoice Date", "Due Date", "Terms", "Amount", "Paid", "Open Balance", "Days Past Due", "Aging Bucket"]
AP_COLS = ["Bill No", "Vendor", "Bill Date", "Due Date", "Terms", "Amount", "Paid", "Open Balance", "Days Past Due", "Aging Bucket"]
CUSTOMERS = ["NORTHWIND TRADING (SYN)", "BLUE HARBOR CAFE (SYN)", "CEDAR LANE CLINIC (SYN)", "SUMMIT BUILDERS (SYN)",
             "RIVERSIDE SCHOOL DISTRICT (SYN)", "HILLTOP EVENTS (SYN)", "GREENFIELD FARMS (SYN)", "HARBORVIEW HOTEL (SYN)"]
VENDORS = ["OFFICE SUPPLY DEPOT (SYN)", "METRO ELECTRIC UTILITY (SYN)", "CITYWIDE INSURANCE (SYN)", "PRIME PAPER CO (SYN)",
           "LOGISTICS EXPRESS (SYN)", "TECH SERVICES LLC (SYN)", "LANDLORD PROPERTIES (SYN)", "CLEANING CREW INC (SYN)"]
TERMS = [15, 30, 45]
AR_FILE, AP_FILE, KEY_DIR, KEY_FILE = "AR-OPEN-INVOICES.csv", "AP-OPEN-BILLS.csv", "_answer-key", "ar-ap-key.json"


class Usage(Exception):
    pass


def cents(t):
    t = t.strip().replace(",", "")
    m = re.fullmatch(r"(-?)(\d*)(?:\.(\d{1,2}))?", t)
    if not m or (m[2] == "" and not m[3]):
        raise ValueError(f"not an amount: {t!r}")
    v = int(m[2] or 0) * 100 + int((m[3] or "").ljust(2, "0"))
    return -v if m[1] else v


def money(c):
    return f"{c // 100}.{c % 100:02d}"


def bucket(days):
    if days <= 0:
        return "Current"
    if days <= 30:
        return "1-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return "91+"


def bank_deposits(path):
    """(payer, date, cents) for every DIRECT DEPOSIT credit in the statement's DEPOSITS section."""
    with open(path, encoding="utf-8-sig", newline="") as fh:
        r = list(csv.DictReader(fh))
    out = []
    for row in r:
        if (row.get("SECTION") or "").strip() != "DEPOSITS":
            continue
        m = re.match(r"DIRECT DEPOSIT - (.+?) DES:", (row.get("DESCRIPTION") or "").strip())
        if m:
            out.append((m[1].strip(), datetime.strptime(row["DATE"].strip(), FMT), cents(row["AMOUNT"])))
    return out


def bank_cash_by_month(path):
    """{"YYYY-MM": {cash_in, cash_out, net_cash_flow}} in cents over every dated statement row (cash_out positive)."""
    with open(path, encoding="utf-8-sig", newline="") as fh:
        r = list(csv.DictReader(fh))
    out = {}
    for row in r:
        try:
            when = datetime.strptime((row.get("DATE") or "").strip(), FMT)
        except ValueError:
            continue
        c = cents(row["AMOUNT"])
        m = out.setdefault(when.strftime("%Y-%m"), {"cash_in": 0, "cash_out": 0, "net_cash_flow": 0})
        if c > 0:
            m["cash_in"] += c
        elif c < 0:
            m["cash_out"] -= c
        m["net_cash_flow"] += c
    return dict(sorted(out.items()))


def row(number, name, issued, terms, amount, paid, as_of):
    due = issued + timedelta(days=terms)
    dpd = max(0, (as_of - due).days)
    return [number, name, issued.strftime(FMT), due.strftime(FMT), f"Net {terms}", money(amount), money(paid), money(amount - paid), str(dpd), bucket(dpd)]


def summary(rows):
    by = {}
    for r in rows:
        by[r[9]] = by.get(r[9], 0) + cents(r[7])
    return {"count": len(rows), "openCents": sum(cents(r[7]) for r in rows), "byBucketCents": dict(sorted(by.items()))}


def main(argv):
    p = argparse.ArgumentParser(description="Synthetic open receivables and payables for sample-data/smb-fin/statements.")
    p.add_argument("--out-dir", default=os.path.join("sample-data", "smb-fin", "statements"))
    p.add_argument("--bank", default="sample_bofa_full_statement.csv")
    p.add_argument("--as-of", default="10/15/2026", help="MM/DD/YYYY, the statement's end by default")
    p.add_argument("--invoices", type=int, default=8)
    p.add_argument("--bills", type=int, default=7)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--min-amount", type=int, default=250, help="whole dollars")
    p.add_argument("--max-amount", type=int, default=4000, help="whole dollars")
    p.add_argument("--force", action="store_true", help="overwrite existing files")
    try:
        a = p.parse_args(argv)
    except SystemExit:
        raise Usage("see the usage above")
    try:
        as_of = datetime.strptime(a.as_of, FMT)
    except ValueError:
        raise Usage(f"--as-of must be MM/DD/YYYY, got {a.as_of}")
    if not 1 <= a.invoices <= 500 or not 1 <= a.bills <= 500:
        raise Usage("--invoices and --bills must be 1-500")
    if not 1 <= a.min_amount < a.max_amount <= 1_000_000:
        raise Usage("--min-amount and --max-amount must be 1 <= min < max <= 1000000")
    if not os.path.isdir(a.out_dir):
        raise Usage(f"--out-dir {a.out_dir} is not a folder")
    targets = [os.path.join(a.out_dir, AR_FILE), os.path.join(a.out_dir, AP_FILE), os.path.join(a.out_dir, KEY_DIR, KEY_FILE)]
    if not a.force and any(os.path.exists(t) for t in targets):
        raise Usage(f"files exist in {a.out_dir}; add --force to overwrite (same --seed gives the same files)")

    ties, cash = [], {}
    if a.bank != "none":
        bank = a.bank if os.path.isabs(a.bank) else os.path.join(a.out_dir, a.bank)
        if os.path.isfile(bank):
            ties = bank_deposits(bank)
            cash = bank_cash_by_month(bank)
        else:
            print(f"NOTE: no bank statement at {bank}: receivables are not tied to deposits")
    if len(ties) > a.invoices:
        raise Usage(f"--invoices {a.invoices} is fewer than the {len(ties)} bank deposits to tie")

    rng = random.Random(a.seed)
    amt = lambda: rng.randint(a.min_amount * 100, a.max_amount * 100)
    ar, tied = [], []
    for i, (payer, when, paid) in enumerate(ties):
        issued = when - timedelta(days=rng.randint(10, 30))
        terms = rng.choice(TERMS)
        number = f"INV-{1001 + i}"
        ar.append(row(number, payer, issued, terms, paid + amt(), paid, as_of))
        tied.append({"invoice": number, "customer": payer, "depositDate": when.strftime(FMT), "paidCents": paid})
    for i in range(len(ties), a.invoices):
        amount = amt()
        paid = (amount * rng.choice([30, 40, 50]) // 100) if rng.random() < 0.25 else 0
        ar.append(row(f"INV-{1001 + i}", CUSTOMERS[i % len(CUSTOMERS)], as_of - timedelta(days=rng.randint(0, 100)), rng.choice(TERMS), amount, paid, as_of))
    ap = []
    for i in range(a.bills):
        amount = amt()
        paid = (amount * rng.choice([30, 50]) // 100) if rng.random() < 0.2 else 0
        ap.append(row(f"BILL-{2001 + i}", VENDORS[i % len(VENDORS)], as_of - timedelta(days=rng.randint(0, 80)), rng.choice(TERMS), amount, paid, as_of))

    os.makedirs(os.path.join(a.out_dir, KEY_DIR), exist_ok=True)
    for path, cols, rows in ((targets[0], AR_COLS, ar), (targets[1], AP_COLS, ap)):
        with open(path, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(cols)
            w.writerows(rows)
    sr, sp = summary(ar), summary(ap)
    key = {"tool": "smb-synth/gen_ar_ap.py", "seed": a.seed, "asOf": a.as_of, "receivables": sr, "payables": sp,
           "netPositionCents": sr["openCents"] - sp["openCents"], "bankTies": tied, "bankCashByMonth": cash}
    with open(targets[2], "w", encoding="utf-8", newline="\n") as fh:
        json.dump(key, fh, indent=2)
        fh.write("\n")
    print(f"wrote {AR_FILE} ({sr['count']} open invoices, {money(sr['openCents'])}), {AP_FILE} ({sp['count']} open bills, "
          f"{money(sp['openCents'])}), {KEY_DIR}/{KEY_FILE}; {len(tied)} invoice(s) tied to bank deposits; as of {a.as_of}, seed {a.seed}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Usage as e:
        print(f"gen_ar_ap: {e}", file=sys.stderr)
        sys.exit(2)

#!/usr/bin/env python3
"""
Re-reads a generated chiro set by column header (independently of gen_chiro_set.py) and checks it against itself and its
answer key. Exit 0 = ALL CHECKS PASS, 1 = a check failed (each printed), 2 = usage error.

  python tools/chiro-synth/verify_chiro_set.py --dir <set folder> --tag SET1-POS [--compare <same set, other PRMS>]

Checks: BofA summary adds up and every running balance follows; every bank credit is in expected-matches.csv once, with the
same date, amount and group; each insurance EFT carries an 835 TRN whose BPR02 total equals the credit; every ERA claim in
CLP04 equals its lines; card batches (CTPAY / JANEPAY payouts) equal their bank credits; PRMS payments = deposit report;
care-plan collections = card plan payments + Cash Practice debits; the answer key's group totals equal the bank.
--compare: the same --seed written for the other PRMS has a byte-identical ERA and the same canonical transactions.
"""
import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict


def cents(t):
    t = t.strip().replace(",", "")
    m = re.fullmatch(r"(-?)(\d*)(?:\.(\d{1,2}))?", t)
    if not m or (m[2] == "" and not m[3]):
        raise ValueError(f"not an amount: {t!r}")
    v = int(m[2] or 0) * 100 + int((m[3] or "").ljust(2, "0"))
    return -v if m[1] else v


def rd(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.reader(fh))


def rows(path):
    r = rd(path)
    return [dict(zip(r[0], x)) for x in r[1:]]


def era(path):
    text = open(path, encoding="utf-8").read()
    el, seg = text[3], text[105]
    segs = [s.strip().split(el) for s in text.split(seg) if s.strip()]
    pays, cur, claim = {}, None, None
    bad = []
    for e in segs:
        if e[0] == "ST":
            cur = dict(bpr=None, trace=None, clp=0)
        elif e[0] == "BPR":
            cur["bpr"] = cents(e[2])
        elif e[0] == "TRN":
            cur["trace"] = e[2]
        elif e[0] == "CLP":
            claim = dict(id=e[1], clp04=cents(e[4]), svc=0)
            cur["clp"] += claim["clp04"]
            cur.setdefault("claims", []).append(claim)
        elif e[0] == "SVC":
            claim["svc"] += cents(e[3])
        elif e[0] == "SE":
            pays[cur["trace"]] = cur
    for p in pays.values():
        for c in p.get("claims", []):
            if c["svc"] != c["clp04"]:
                bad.append(f"claim {c['id']}: lines {c['svc']} vs CLP04 {c['clp04']}")
    return pays, bad


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--compare", help="the same set written for the other PRMS")
    a = ap.parse_args(argv)
    d, t = a.dir, a.tag
    if not os.path.isdir(d):
        ap.error(f"no folder {d}")
    fails = []
    fail = fails.append
    truth = json.load(open(os.path.join(d, "_answer-key", "truth.json")))
    prms = truth["prms"]

    # bank statement
    b = rd(os.path.join(d, f"BANK-ST-{t}.csv"))
    summ = {r[0].split(" as of")[0]: cents(r[2]) for r in b[1:5]}
    hdr = next(i for i, r in enumerate(b) if r[:4] == ["Date", "Description", "Amount", "Running Bal."])
    det = b[hdr + 2:]
    bal = cents(b[hdr + 1][3])
    credits = []
    cr = dr = 0
    for i, r in enumerate(det):
        amt = cents(r[2])
        bal += amt
        if bal != cents(r[3]):
            fail(f"bank line {hdr + 3 + i}: running balance {r[3]} vs computed {bal}")
        cr += amt if amt > 0 else 0
        dr += amt if amt < 0 else 0
        if amt > 0:
            credits.append(dict(line=hdr + 3 + i, date=r[0], cents=amt, desc=r[1]))
    if summ["Beginning balance"] + summ["Total credits"] + summ["Total debits"] != summ["Ending balance"]:
        fail("bank summary does not add up")
    if (cr, dr) != (summ["Total credits"], summ["Total debits"]):
        fail(f"bank detail credits/debits {cr}/{dr} vs summary {summ['Total credits']}/{summ['Total debits']}")

    # answer key covers every credit once
    em = rows(os.path.join(d, "_answer-key", "expected-matches.csv"))
    by_line = {int(x["bank_line"]): x for x in em}
    group_sum = defaultdict(int)
    for c in credits:
        x = by_line.pop(c["line"], None)
        if not x:
            fail(f"bank credit line {c['line']} ({c['desc'][:40]}) is not in expected-matches.csv")
            continue
        if cents(x["amount"]) != c["cents"]:
            fail(f"bank line {c['line']}: answer key amount {x['amount']} vs bank {c['cents']}")
        group_sum[x["group"]] += c["cents"]
        c["group"], c["refs"] = x["group"], x["refs"].split(";")
    for line in by_line:
        fail(f"answer key line {line} has no bank credit")
    for g, v in truth["bank_credits_by_group"].items():
        if cents(v) != group_sum.get(g, 0):
            fail(f"truth.json {g} {v} vs bank {group_sum.get(g, 0)}")

    # ERA vs insurance EFTs
    pays, bad = era(os.path.join(d, f"ERA-{t}.835"))
    for x in bad:
        fail(x)
    eft = [c for c in credits if c.get("group") == "insurance_eft"]
    for c in eft:
        m = re.search(r"TRN\*1\*([^*\\]+)", c["desc"])
        p = pays.get(m[1] if m else None)
        if not p:
            fail(f"EFT line {c['line']}: no 835 payment with its TRN")
        elif p["bpr"] != c["cents"] or p["clp"] != c["cents"]:
            fail(f"EFT line {c['line']}: bank {c['cents']} vs BPR02 {p['bpr']} vs sum(CLP04) {p['clp']}")
    if len(eft) != len(pays):
        fail(f"{len(pays)} ERA payments vs {len(eft)} insurance EFT credits")

    # processor batches vs bank
    card = {c["refs"][0]: c for c in credits if c.get("group") == "card_processor"}
    if prms == "chirotouch":
        batches = {x["Batch ID"]: cents(x["Net"]) for x in rows(os.path.join(d, f"CTPAY-{t}.csv"))}
    else:
        po = rows(os.path.join(d, f"JANEPAY-PAYOUTS-{t}.csv"))
        batches = {}
        for x in po:
            if x["Payout Status"] == "paid":
                batches.setdefault(("payout", x["Date Deposited"], cents(x["Payout Amount"])), 0)
        paid = sorted((k[1], k[2]) for k in batches)
        bank_card = sorted((c["date"], c["cents"]) for c in card.values())
        if paid != bank_card:
            fail(f"Jane payouts marked paid {len(paid)} vs card credits in the bank {len(bank_card)} (dates/amounts differ)")
        batches = None
    if batches is not None:
        for bid, c in card.items():
            if batches.get(bid) != c["cents"]:
                fail(f"card credit line {c['line']}: batch {bid} net {batches.get(bid)} vs bank {c['cents']}")

    # PRMS payments vs deposit report; care plans
    tx_name = f"CT-DAYSHEET-{t}.csv" if prms == "chirotouch" else f"JANE-TRANSACTIONS-{t}.csv"
    tx = rows(os.path.join(d, tx_name))
    dep_name = f"CT-DEPOSITS-{t}.csv" if prms == "chirotouch" else f"JANE-PAYMENTS-REFUNDS-FEES-{t}.csv"
    dep = rows(os.path.join(d, dep_name))
    tx_pay = -sum(cents(x["Amount"]) for x in tx if x["Type"] == "Payment")
    dep_sum = sum(cents(x["Amount"]) for x in dep)
    if tx_pay != dep_sum:
        fail(f"{tx_name} payments {tx_pay} vs {dep_name} {dep_sum}")
    plans = rows(os.path.join(d, f"CAREPLANS-{t}.csv"))
    plan_tx = -sum(cents(x["Amount"]) for x in tx if x["Type"] == "Payment" and (x.get("Visit") or x.get("Invoice", "")).startswith("PL"))
    if plan_tx != sum(cents(x["Collected"]) for x in plans):
        fail(f"care-plan payments in {tx_name} {plan_tx} vs CAREPLANS collected {sum(cents(x['Collected']) for x in plans)}")
    for x in plans:
        earned = cents(x["Price"]) * int(x["Visits Used"]) // int(x["Visits Bought"])
        if cents(x["Earned"]) != earned or cents(x["Unearned"]) != cents(x["Collected"]) - earned:
            fail(f"plan {x['Plan ID']}: earned/unearned do not follow price x used / bought")
    if prms == "chirotouch":
        cp = rows(os.path.join(d, f"CASHPRAC-{t}.csv"))
        auto = sum(cents(x["Collected"]) for x in plans if x["Payment"] == "autodebit")
        if sum(cents(x["Amount"]) for x in cp) != auto:
            fail(f"CASHPRAC debits vs auto-debit plan collections {auto}")

    # cross-PRMS: same seed -> same events
    if a.compare:
        other = json.load(open(os.path.join(a.compare, "_answer-key", "truth.json")))
        ot = other["set"] + "-" + other["scenario"].upper()
        if open(os.path.join(d, f"ERA-{t}.835"), "rb").read() != open(os.path.join(a.compare, f"ERA-{ot}.835"), "rb").read():
            fail("ERA differs between the two PRMS folders")
        o_tx = rows(os.path.join(a.compare, f"CT-DAYSHEET-{ot}.csv" if other["prms"] == "chirotouch" else f"JANE-TRANSACTIONS-{ot}.csv"))
        key = lambda xs: sorted((tuple(x.values())[0], tuple(x.values())[1], tuple(x.values())[4], tuple(x.values())[5], tuple(x.values())[8]) for x in xs
                                if not (tuple(x.values())[4] == "Payment" and tuple(x.values())[2].startswith("PL")))
        if key(tx) != key(o_tx):
            fail("charges, insurance payments and adjustments differ between the two PRMS folders (care-plan payments excluded)")
        for k in ("visits", "claims", "remittances_eft", "remittances_check", "plans", "pi_cases"):
            if truth["counts"][k] != other["counts"][k]:
                fail(f"count {k}: {truth['counts'][k]} vs {other['counts'][k]}")

    for f in fails:
        print("FAIL", f)
    print(f"{'ALL CHECKS PASS' if not fails else f'{len(fails)} CHECK(S) FAILED'} ({prms} {t}: {len(credits)} bank credits, {len(pays)} ERA payments)")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())

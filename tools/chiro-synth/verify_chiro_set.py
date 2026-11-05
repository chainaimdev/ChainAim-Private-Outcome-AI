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

NEG sets (truth.json expected_exceptions): every bank credit's 'expect' (match | exception:<LEAK>) agrees with the leaks, the
generic checks allow exactly the planted differences, and each leak is checked in the files where a reviewer would see it
(check_leaks below). With --compare, both PRMS must have the same findings (code, group, date, cents) apart from leaks that
are not applicable to one of them.
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
    """-> ({trace: payment}, problems). payment: bpr, trace, clp (sum CLP04), claims [{id, status, clp04, clp05, filing, svc,
    lines [{code, mods, charge, paid, cas [(group, carc, cents)], allowed}]}]."""
    text = open(path, encoding="utf-8").read()
    el, seg, comp = text[3], text[105], text[104]
    segs = [s.strip().split(el) for s in text.split(seg) if s.strip()]
    pays, cur, claim, line = {}, None, None, None
    bad = []
    for e in segs:
        if e[0] == "ST":
            cur = dict(bpr=None, trace=None, clp=0)
        elif e[0] == "BPR":
            cur["bpr"] = cents(e[2])
        elif e[0] == "TRN":
            cur["trace"] = e[2]
        elif e[0] == "CLP":
            claim = dict(id=e[1], status=e[2], clp04=cents(e[4]), clp05=cents(e[5] or "0"), filing=e[6], svc=0, lines=[])
            cur["clp"] += claim["clp04"]
            cur.setdefault("claims", []).append(claim)
            line = None
        elif e[0] == "SVC":
            proc = e[1].split(comp)
            line = dict(code=proc[1], mods=proc[2:], charge=cents(e[2]), paid=cents(e[3]), cas=[], allowed=None)
            claim["svc"] += line["paid"]
            claim["lines"].append(line)
        elif e[0] == "CAS" and line is not None:
            for i in range(2, len(e) - 1, 3):
                if e[i]:
                    line["cas"].append((e[1], e[i], cents(e[i + 1])))
        elif e[0] == "AMT" and e[1] == "B6" and line is not None:
            line["allowed"] = cents(e[2])
        elif e[0] == "SE":
            pays[cur["trace"]] = cur
    for p in pays.values():
        for c in p.get("claims", []):
            if c["svc"] != c["clp04"]:
                bad.append(f"claim {c['id']}: lines {c['svc']} vs CLP04 {c['clp04']}")
    return pays, bad


# Independent copy of the leak list (design-30 §10 #10), so a generator change cannot silently drop a leak from the key.
ALL_LEAKS = ["UNDEPOSITED_CHECK", "EFT_MISSING", "BANK_UNPOSTED", "CARD_BATCH_SHORT", "CASH_SHORT", "POSTED_TWICE", "REF_MISMATCH",
             "MCR_AT_MISSING", "MAINT_NO_ABN", "PR_NOT_TRANSFERRED", "VISIT_CAP", "BUNDLED_97140", "CONTRACT_UNDERPAY",
             "PI_REDUCTION", "PREPAY_UNEARNED", "AUTODEBIT_RETURNED"]


def scan_unplanted(leak, d, t, prms, pays, tx, fail):
    """Reverse direction: every anomaly visible in the files must be explained by a planted leak (catches an answer key that
    forgets a leak, and a generator that plants something the key does not say)."""
    T = [list(x.values()) for x in tx]
    refs = lambda *codes: {r for c in codes if c in leak for r in leak[c]["refs"]}
    fee = {(x["Payer Code"], x["CPT"]): cents(x["Allowed"]) for x in rows(os.path.join(d, f"FEESCHED-{t}.csv"))}
    denied = refs("MCR_AT_MISSING", "MAINT_NO_ABN", "BUNDLED_97140")
    for r in T:
        if r[4] == "Adjustment" and r[5].startswith("CO-") and r[5] != "CO-45" and r[2] not in denied:
            fail(f"unplanted: {r[5]} write-off on {r[2]}")
        if r[5] == "WO-PR-119" and r[2] not in refs("VISIT_CAP"):
            fail(f"unplanted: WO-PR-119 on {r[2]}")
        if r[5] == "Manual EOB" and r[2] not in refs("POSTED_TWICE"):
            fail(f"unplanted: manual EOB post on {r[2]}")
        if r[4] == "Charge" and r[5] == "PLAN" and r[2] not in refs("PREPAY_UNEARNED"):
            fail(f"unplanted: upfront plan charge {r[2]}")
    patient_paid = {r[2] for r in T if r[4] == "Payment" and r[10] == "PATIENT"}
    explained = {r for x in leak.values() for r in x["refs"]}
    name_to_code = {}
    for x in rows(os.path.join(d, f"FEESCHED-{t}.csv")):
        name_to_code[x["Payer"]] = x["Payer Code"]
    visit_payer = {r[2]: name_to_code.get(r[10]) for r in T if r[4] == "Payment" and r[5] == "ERA"}
    for p in pays.values():
        for c in p.get("claims", []):
            if c["clp05"] > 0 and c["id"] not in patient_paid and c["id"] not in explained:
                fail(f"unplanted: ERA claim {c['id']} has patient responsibility {c['clp05']} and no patient payment")
            code = visit_payer.get(c["id"])
            for ln in c["lines"]:
                if code and ln["allowed"] and ln["allowed"] < fee.get((code, ln["code"]), 0) and c["id"] not in refs("CONTRACT_UNDERPAY"):
                    fail(f"unplanted: ERA claim {c['id']} {ln['code']} allowed {ln['allowed']} below the fee schedule")
    for case in rows(os.path.join(d, f"PI-CASES-{t}.csv")):
        if case["Status"] == "settled":
            gap = cents(case["Prior Balance"]) + cents(case["Billed"]) - cents(case["Carrier Paid"]) - cents(case["Settlement Received"]) - cents(case["Reduction"])
            if gap and case["Case ID"] not in refs("PI_REDUCTION"):
                fail(f"unplanted: PI case {case['Case ID']} settlement gap {gap}")
    if prms == "chirotouch":
        for x in rows(os.path.join(d, f"CASHPRAC-{t}.csv")):
            if x["Type"] != "Debit" and x["Reference"] not in refs("AUTODEBIT_RETURNED"):
                fail(f"unplanted: Cash Practice {x['Type']} {x['Reference']}")


def ymd(iso):
    y, m, d = iso.split("-")
    return f"{int(m)}/{int(d)}/{y}"


def check_leaks(leak, d, t, prms, credits, pays, tx, dep_by_id, fail):
    """Each planted leak must be visible in the files, read independently of the generator. tx rows are the PRMS day sheet /
    transactions (same column order in both PRMS: Date, Patient, Visit|Invoice, Provider, Type, Code|Item, Modifiers, Units,
    Amount, Reference, Payer)."""
    if not leak:
        return
    T = [list(x.values()) for x in tx]
    fee = {(x["Payer Code"], x["CPT"]): cents(x["Allowed"]) for x in rows(os.path.join(d, f"FEESCHED-{t}.csv"))}
    claims = {c["id"]: (p, c) for p in pays.values() for c in p.get("claims", [])}
    in_bank = {r for c in credits for r in c.get("refs", [])} | {c.get("trn") for c in credits}
    by_trn = {c.get("trn"): c for c in credits if c.get("trn")}

    def claim_of(code, x):
        pc = claims.get(x["refs"][0])
        if not pc:
            fail(f"{code}: claim {x['refs'][0]} is not in the ERA")
        return pc

    for code, x in leak.items():
        c0 = x["cents"]
        if code == "UNDEPOSITED_CHECK":
            r = dep_by_id.get(x["refs"][0])
            if not r or r["method"] != "Check" or r["cents"] != c0:
                fail(f"{code}: payment {x['refs'][0]} is not a {c0}-cent check in the deposit report")
            if x["refs"][0] in in_bank:
                fail(f"{code}: payment {x['refs'][0]} is listed in a bank credit")
        elif code == "EFT_MISSING":
            trn = x["refs"][0]
            if trn not in pays or pays[trn]["bpr"] != c0:
                fail(f"{code}: ERA has no {c0}-cent payment with TRN {trn}")
            if trn in by_trn:
                fail(f"{code}: TRN {trn} is in the bank")
            if not any(r["method"] == "EFT" and r["ref"] == trn for r in dep_by_id.values()):
                fail(f"{code}: the PRMS deposit report does not post TRN {trn}")
        elif code == "BANK_UNPOSTED":
            trn = x["refs"][0]
            if by_trn.get(trn, {}).get("cents") != c0 or trn in pays or any(r["ref"] == trn for r in dep_by_id.values()):
                fail(f"{code}: no {c0}-cent bank EFT with TRN {trn} that is absent from the ERA and the PRMS")
        elif code == "CARD_BATCH_SHORT":
            if sum(1 for c in credits if c.get("expect") == "exception:CARD_BATCH_SHORT") != 1:
                fail(f"{code}: expected exactly one short card credit")
        elif code == "CASH_SHORT":
            if sum(1 for c in credits if c.get("expect") == "exception:CASH_SHORT") != 1:
                fail(f"{code}: expected exactly one short ATM credit")
        elif code == "POSTED_TWICE":
            pays_v = [r for r in T if r[2] == x["refs"][0] and r[4] == "Payment" and r[10] != "PATIENT"]  # insurance posts only
            kinds = sorted(r[5] for r in pays_v)
            if kinds != ["ERA", "Manual EOB"] or any(cents(r[8]) != -c0 for r in pays_v):
                fail(f"{code}: visit {x['refs'][0]} payments {kinds} are not one ERA post and one manual EOB post of {c0}")
            pc = claim_of(code, x)
            if pc and pc[1]["clp04"] != c0:
                fail(f"{code}: ERA paid {pc[1]['clp04']} vs {c0}")
            if by_trn.get(x["refs"][1], {}).get("cents") != pays.get(x["refs"][1], {}).get("bpr"):
                fail(f"{code}: the bank EFT for TRN {x['refs'][1]} is not the ERA total (one credit expected)")
        elif code == "REF_MISMATCH":
            era_trn, bank_trn = x["refs"]
            if pays.get(era_trn, {}).get("bpr") != c0 or by_trn.get(bank_trn, {}).get("cents") != c0 or bank_trn in pays:
                fail(f"{code}: expected ERA TRN {era_trn} and bank TRN {bank_trn}, both {c0}, bank TRN not in the ERA")
        elif code in ("MCR_AT_MISSING", "MAINT_NO_ABN"):
            pc = claim_of(code, x)
            if pc:
                c = pc[1]
                ln = next((l for l in c["lines"] if l["code"] in ("98940", "98941", "98942") and "AT" not in l["mods"]), None)
                want_gz = code == "MAINT_NO_ABN"
                if c["filing"] != "MB" or not ln or ln["paid"] != 0 or ("GZ" in ln["mods"]) != want_gz or not any(g == "CO" for g, _, _ in ln["cas"]):
                    fail(f"{code}: ERA claim {x['refs'][0]} has no denied Medicare CMT line without AT{' with GZ' if want_gz else ''} and a CO adjustment")
                elif fee.get(("MEDICAREB", ln["code"])) != c0:
                    fail(f"{code}: {c0} is not the fee-schedule Medicare allowed for {ln['code']}")
                elif not any(r[2] == x["refs"][0] and r[4] == "Adjustment" and r[5].startswith("CO-") and r[5] != "CO-45" and cents(r[8]) == -ln["charge"] for r in T):
                    fail(f"{code}: the PRMS has no write-off of the denied {ln['code']} for {x['refs'][0]}")
        elif code == "PR_NOT_TRANSFERRED":
            pc = claim_of(code, x)
            if pc and pc[1]["clp05"] != c0:
                fail(f"{code}: ERA CLP05 {pc[1]['clp05']} vs {c0}")
            if any(r[2] == x["refs"][0] and r[4] == "Payment" and r[10] == "PATIENT" for r in T):
                fail(f"{code}: the PRMS has a patient payment for {x['refs'][0]}")
        elif code == "VISIT_CAP":
            pc = claim_of(code, x)
            if pc and not any(("PR", "119", c0) in l["cas"] and l["paid"] == 0 for l in pc[1]["lines"]):
                fail(f"{code}: ERA claim {x['refs'][0]} has no unpaid line with PR-119 {c0}")
            if not any(r[2] == x["refs"][0] and r[5] == "WO-PR-119" and cents(r[8]) == -c0 for r in T):
                fail(f"{code}: the PRMS has no WO-PR-119 write-off of {c0} for {x['refs'][0]}")
        elif code == "BUNDLED_97140":
            pc = claim_of(code, x)
            if pc:
                ln = next((l for l in pc[1]["lines"] if l["code"] == "97140"), None)
                if not ln or "59" in ln["mods"] or ("CO", "97", ln["charge"]) not in ln["cas"] or ln["paid"] != 0:
                    fail(f"{code}: ERA claim {x['refs'][0]} has no 97140 line without 59 denied CO-97")
                elif fee.get((x["payer"], "97140")) != c0:
                    fail(f"{code}: {c0} is not the fee-schedule allowed for {x['payer']} 97140")
        elif code == "CONTRACT_UNDERPAY":
            pc = claim_of(code, x)
            if pc:
                ln = pc[1]["lines"][0]
                if ln["allowed"] is None or fee.get((x["payer"], ln["code"]), 0) - ln["allowed"] != c0:
                    fail(f"{code}: ERA allowed {ln['allowed']} for {ln['code']} is not {c0} below the fee schedule {fee.get((x['payer'], ln['code']))}")
        elif code == "PI_REDUCTION":
            case = next((r for r in rows(os.path.join(d, f"PI-CASES-{t}.csv")) if r["Case ID"] == x["refs"][0]), None)
            if not case:
                fail(f"{code}: case {x['refs'][0]} is not in PI-CASES")
            else:
                gap = cents(case["Prior Balance"]) + cents(case["Billed"]) - cents(case["Carrier Paid"]) - cents(case["Settlement Received"]) - cents(case["Reduction"])
                if gap != c0 or case["Reduction Approved"] == "yes" or case["Status"] != "settled":
                    fail(f"{code}: case {x['refs'][0]} unexplained settlement gap {gap} vs {c0} (approved={case['Reduction Approved']!r})")
        elif code == "PREPAY_UNEARNED":
            plan = next((r for r in rows(os.path.join(d, f"CAREPLANS-{t}.csv")) if r["Plan ID"] == x["refs"][0]), None)
            charge = [r for r in T if r[2] == x["refs"][0] and r[4] == "Charge" and r[5] == "PLAN"]
            if not plan or cents(plan["Unearned"]) != c0:
                fail(f"{code}: CAREPLANS unearned for {x['refs'][0]} is not {c0}")
            elif len(charge) != 1 or cents(charge[0][8]) != cents(plan["Price"]):
                fail(f"{code}: the PRMS has no single upfront PLAN charge of the plan price for {x['refs'][0]}")
        elif code == "AUTODEBIT_RETURNED":
            ret = [r for r in rows(os.path.join(d, f"CASHPRAC-{t}.csv")) if r["Reference"] == x["refs"][0] and r["Type"] == "Return"]
            if len(ret) != 1 or cents(ret[0]["Amount"]) != -c0:
                fail(f"{code}: CASHPRAC has no Return of {c0} for {x['refs'][0]}")
            if not any(r[9] == x["refs"][0] and r[4] == "Payment" for r in T):
                fail(f"{code}: the return was imported (ChiroTouch no longer shows payment {x['refs'][0]})")
            if x["refs"][0] in in_bank:
                fail(f"{code}: payment {x['refs'][0]} is listed in a bank credit")
        else:
            fail(f"unknown leak code {code} in truth.json")


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
    exc = truth.get("expected_exceptions", [])
    leak = {}
    for x in exc:
        if x["code"] in leak:
            fail(f"truth.json lists {x['code']} twice")
        leak[x["code"]] = x

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
        c["group"], c["refs"], c["expect"] = x["group"], x["refs"].split(";"), x.get("expect", "match")
        if c["expect"] != "match" and c["expect"].split(":", 1)[-1] not in leak:
            fail(f"bank line {c['line']}: answer key expects {c['expect']}, which truth.json does not plant")
    for line in by_line:
        fail(f"answer key line {line} has no bank credit")
    flagged = sum(1 for c in credits if c.get("expect", "match") != "match")
    if flagged != truth.get("unmatched_bank_credits", 0):
        fail(f"{flagged} bank credits expected as exceptions vs truth.json unmatched_bank_credits {truth.get('unmatched_bank_credits', 0)}")
    for g, v in truth["bank_credits_by_group"].items():
        if cents(v) != group_sum.get(g, 0):
            fail(f"truth.json {g} {v} vs bank {group_sum.get(g, 0)}")

    # ERA vs insurance EFTs
    pays, bad = era(os.path.join(d, f"ERA-{t}.835"))
    for x in bad:
        fail(x)
    eft = [c for c in credits if c.get("group") == "insurance_eft"]
    unposted = leak.get("BANK_UNPOSTED", {}).get("refs", [None])[0]
    renamed = dict([leak["REF_MISMATCH"]["refs"][::-1]]) if "REF_MISMATCH" in leak else {}  # bank TRN -> ERA TRN
    seen = set()
    for c in eft:
        m = re.search(r"TRN\*1\*([^*\\]+)", c["desc"])
        c["trn"] = m[1] if m else None
        p = pays.get(renamed.get(c["trn"], c["trn"]))
        if not p:
            if c["trn"] != unposted:
                fail(f"EFT line {c['line']}: no 835 payment with its TRN {c['trn']} and not the planted BANK_UNPOSTED credit")
        elif p["bpr"] != c["cents"] or p["clp"] != c["cents"]:
            fail(f"EFT line {c['line']}: bank {c['cents']} vs BPR02 {p['bpr']} vs sum(CLP04) {p['clp']}")
        else:
            seen.add(p["trace"])
    missing = {t for t in pays if t not in seen}
    want = {leak["EFT_MISSING"]["refs"][0]} if "EFT_MISSING" in leak else set()
    if missing != want:
        fail(f"ERA payments with no EFT credit {sorted(missing)} vs planted EFT_MISSING {sorted(want)}")

    # processor batches vs bank
    card = {c["refs"][0]: c for c in credits if c.get("group") == "card_processor"}
    short_day = {}
    if "CARD_BATCH_SHORT" in leak:
        y, mo, dd = leak["CARD_BATCH_SHORT"]["date"].split("-")
        short_day[f"{int(mo)}/{int(dd)}/{y}"] = leak["CARD_BATCH_SHORT"]["cents"]
    if prms == "chirotouch":
        ctpay = rows(os.path.join(d, f"CTPAY-{t}.csv"))
        batches = {x["Batch ID"]: cents(x["Net"]) - short_day.get(x["Batch Date"], 0) for x in ctpay}
        if short_day and not any(x["Batch Date"] in short_day for x in ctpay):
            fail("CARD_BATCH_SHORT: no CT Payments batch on the planted day")
    else:
        po = rows(os.path.join(d, f"JANEPAY-PAYOUTS-{t}.csv"))
        batches = {}
        for x in po:
            if x["Payout Status"] == "paid":
                batches.setdefault(("payout", x["Date Deposited"], cents(x["Payout Amount"]) - short_day.get(x["Date Created"], 0)), 0)
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
        if sum(cents(x["Amount"]) for x in cp if x["Type"] == "Debit") != auto:
            fail(f"CASHPRAC debits vs auto-debit plan collections {auto}")

    # every ATM / auto-debit credit = the deposit-report payments it lists, minus a planted cash shortfall
    dep_rows = [dict(id=x.get("Payment ID") or x.get("Invoice number"), method=x.get("Method") or x.get("Payment method"),
                     ref=x.get("Reference") or x.get("Reference number", ""), cents=cents(x["Amount"]), date=x["Date"]) for x in dep]
    dep_by_id = {x["id"]: x for x in dep_rows}
    cash_short = leak.get("CASH_SHORT")
    for c in credits:
        if c.get("group") not in ("branch_atm_deposit", "autodebit"):
            continue
        listed = [dep_by_id.get(i) for i in c["refs"]]
        if None in listed:
            fail(f"bank line {c['line']}: a listed payment is not in {dep_name}")
            continue
        short = 0
        if c["expect"] == "exception:CASH_SHORT" and not cash_short:
            fail(f"bank line {c['line']}: expected as CASH_SHORT, but truth.json plants no CASH_SHORT")
        elif c["expect"] == "exception:CASH_SHORT":
            short = cash_short["cents"]
            y, mo, dd = cash_short["date"].split("-")
            if any(x["date"] != f"{int(mo)}/{int(dd)}/{y}" for x in listed):
                fail(f"CASH_SHORT: bank line {c['line']} lists payments from another day than {cash_short['date']}")
        if sum(x["cents"] for x in listed) - short != c["cents"]:
            fail(f"bank line {c['line']}: {c['group']} credit {c['cents']} vs listed payments {sum(x['cents'] for x in listed)} minus shortfall {short}")
    check_leaks(leak, d, t, prms, credits, pays, tx, dep_by_id, fail)
    scan_unplanted(leak, d, t, prms, pays, tx, fail)
    sc = truth["scenario"]
    want = [] if sc == "pos" else [c for c in ALL_LEAKS if c not in truth.get("not_applicable", [])] if sc == "neg-all" else [sc[4:].upper().replace("-", "_")]
    if sorted(leak) != sorted(want):
        fail(f"scenario {sc}: answer key plants {sorted(leak)} vs expected {sorted(want)}")
    if sc == "neg-all" and prms == "chirotouch" and truth.get("not_applicable"):
        fail("ChiroTouch neg-all must plant every leak")

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
        skip = set(truth.get("not_applicable", [])) | set(other.get("not_applicable", []))
        f = lambda xs: sorted((x["code"], x["group"], x["date"], x["cents"]) for x in xs if x["code"] not in skip)
        if f(exc) != f(other.get("expected_exceptions", [])):
            fail("the two PRMS folders have different findings (code, group, date, cents)")

    for f in fails:
        print("FAIL", f)
    print(f"{'ALL CHECKS PASS' if not fails else f'{len(fails)} CHECK(S) FAILED'} ({prms} {t}: {len(credits)} bank credits, {len(pays)} ERA payments)")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())

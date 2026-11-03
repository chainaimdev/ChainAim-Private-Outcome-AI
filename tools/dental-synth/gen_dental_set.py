#!/usr/bin/env python3
"""
Synthetic dental practice data set generator (Curve Hero exports + Bank of America statement).

Layouts are copied header-for-header from the user's samples in (Phase 4c, 2026-11-03)
  CreditSeal\\data\\pms\\dent-pms-c-sample\\sample-pms-fin\\
    BankDep-Det-Sim-Sample-5-fin-csv.csv   -> BankDep-Det-<SET>-<SCEN>.csv      (Curve payments / bank deposit detail)
    Per-Sum-Sample-7-anon-fin-csv.csv      -> Per-Sum-<SET>-<SCEN>.csv          (Curve transaction ledger)
    LOCS-patientlist-sample-3-fin-csv.csv  -> SPR-patientlist-<SET>-<SCEN>.csv  (patient list, with the Patient key)
    BANK-ST-JUL-OCT-2024-sample.csv        -> BANK-ST-<SET>-<SCEN>.csv          (BofA download, 4 columns, preamble totals)
Patients are keyed PTn in every Curve file (ledger Patient, deposit RP, patient list Patient); the name columns
(Patient-LM / Patient-FM, Responsible Party, Full Name) carry SYNTHETIC names so consumers can prove they never load them.
plus an answer key in _answer-key/ (truth.json, expected-matches.csv).

All names, IDs, amounts, payer IDs and bank descriptions are SYNTHETIC.

Scenario 'pos' (positive): every Curve payment that should reach the bank does, in full, within the lag window.
Other scenarios (planted leaks) are not implemented yet and are rejected explicitly.

Modelling choices that are ASSUMPTIONS (not verified against Curve / BofA / Global Payments):
  * Patient card and HFD payments are posted as 'Deposit #id, <method>' (+) and applied as
    'Payment #id, Account Credit' (-)  -- pattern seen in the ledger sample.
  * Cash is posted directly as 'Payment #id, Cash' (-).
  * Visa, Mastercard, HFD and Ins VCC settle together in one daily Global Payments credit
    ('GB PY DES:GLOBAL DEP', the form in the owner's bank sample), --card-lag-days after posting (HFD via Global Payments per user).
  * Card fees: --card-fee-mode monthly -> gross daily deposits + one 'GLOBAL STL' debit in the next month;
               --card-fee-mode daily-net -> each daily deposit is net of fees, no STL debit.
  * Insurance EFT (Direct Deposit): one bank ACH per payer remittance, credited on the remit date,
    posted in Curve the next day. Description carries 'PMT INFO:TRN*1*<trace>*<payer id>'.
  * Insurance checks and cash posted on day d are deposited together at an ATM on day d+1.
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import random
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def D(x):
    return Decimal(str(x)).quantize(CENT, ROUND_HALF_UP)


# ---------------------------------------------------------------- reference data (synthetic)
FIRST = ["Ana", "Brian", "Carla", "Daniel", "Elena", "Frank", "Gloria", "Hector", "Irene", "James", "Karen",
         "Luis", "Maria", "Nadia", "Oscar", "Paula", "Quinn", "Rosa", "Samuel", "Tanya", "Victor", "Wendy",
         "Xavier", "Yolanda", "Zach", "Aaron", "Bianca", "Carlos", "Diana", "Edwin", "Fatima", "George",
         "Hannah", "Ivan", "Julia", "Kevin", "Linda", "Marcus", "Nina", "Omar", "Priya", "Raj", "Sofia",
         "Thomas", "Uma", "Vera", "Will", "Yusuf"]
LAST = ["Alvarez", "Baker", "Castillo", "Dorsey", "Ellis", "Flores", "Grant", "Hughes", "Ibarra", "Jensen",
        "Keller", "Lopez", "Morales", "Nolan", "Ortega", "Patel", "Quinlan", "Rivera", "Santos", "Turner",
        "Underwood", "Vasquez", "Walsh", "Young", "Zimmer", "Abbott", "Brennan", "Coleman", "Delgado",
        "Espinoza", "Fischer", "Gomez", "Hart", "Irving", "Jacobs", "Kim", "Larson", "Mendez", "Nguyen",
        "Osei", "Price", "Ramos", "Shah", "Torres", "Vega", "Ward"]

# curve payer code, patient-list plan name, method, bank originator (EFT only), weight, medicaid?
PAYERS = [
    ("MH", "MassHealth Dental", "Direct Deposit", "COMM OF MASS", 28, True),
    ("DentaQuest", "DentaQuest MassHealth", "Direct Deposit", "DENTAQUEST", 7, True),
    ("HUSKY", "HUSKY Health CTDHP", "Direct Deposit", "STATE OF CONN DSS", 7, True),
    ("DELTA DENTAL MA(COVERSME.COM)", "Delta Dental of MA PPO", "Direct Deposit", "DELTA DENTAL MA", 7, False),
    ("ANTHEM BCBS", "Anthem BCBS Dental", "Direct Deposit", "ANTHEM BLUE CROSS", 6, False),
    ("AET", "Aetna Dental PPO", "Insurance Check", None, 6, False),
    ("CCS", "CCS Dental", "Ins VCC", None, 7, False),
    ("Cigna", "Cigna Dental PPO", "Ins VCC", None, 6, False),
    ("UHC DUAL COMPLETE", "UHC Dual Complete Dental", "Ins VCC", None, 5, False),
    ("UC", "UnitedHealthcare Dental", "Ins VCC", None, 4, False),
]
FEES = [42, 58, 75, 85, 99, 110, 120, 143, 164, 191, 227, 285, 318, 364, 418, 478, 535, 608, 729, 857,
        1187, 1460, 1600, 1937, 2144, 3200]
EXPENSES = [  # (description template, min, max)
    ("HENRY SCHEIN {md} PURCHASE 800-472-4346 NY DEBIT CARD *4410", 150, 3500),
    ("PATTERSON DENTAL {md} PURCHASE 800-328-5536 MN DEBIT CARD *4410", 120, 2800),
    ("DENTAL LAB EXPRESS {md} PURCHASE 860-555-0199 CT DEBIT CARD *4410", 200, 1800),
    ("EVERSOURCE DES:BILLPAY ID:EV{rid} INDN:{legal} CO ID:1060000000 WEB", 300, 900),
    ("COMCAST BUSINESS {md} PURCHASE 800-391-3000 PA DEBIT CARD *4410", 180, 260),
]


# ---------------------------------------------------------------- formatting
def mdy(d):  # 9/1/2024
    return f"{d.month}/{d.day}/{d.year}"


def mdy0(d):  # 09/01/2024
    return d.strftime("%m/%d/%Y")


def amt_min(x):  # ledger / bank style: 120, 47.7, 65.73, -50
    x = D(x)
    s = f"{x:.2f}"
    if s.endswith("00"):
        s = s[:-3]
    elif s.endswith("0"):
        s = s[:-1]
    return s


def amt_bank(x):  # bank amount: '1,069.50' if |x| >= 1000 else minimal decimals
    x = D(x)
    return f"{x:,.2f}" if abs(x) >= 1000 else amt_min(x)


def amt_bal(x):
    return f"{D(x):,.2f}"


def csv_text(rows, bom):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerows(rows)
    return (chr(0xFEFF) if bom else "") + buf.getvalue()  # UTF-8 BOM, as in the Curve exports


# ---------------------------------------------------------------- generator
# ---------------------------------------------------------------- NEG scenarios (planted leaks)
# Each leak is planted AFTER the base set is built, with its own random stream (--leak-seed), so the base set is
# byte-for-byte the POS set and only the leak differs. neg-all plants every leak on separate days/payments.
LEAKS = ["UNDEPOSITED_CHECK", "EFT_MISSING", "CARD_BATCH_SHORT", "CASH_SHORT", "REF_MISMATCH", "POSTED_TWICE", "BANK_UNPOSTED", "HFD_LAG"]
SCENARIOS = ["pos", "neg-all"] + ["neg-" + c.lower().replace("_", "-") for c in LEAKS]
CARD = ("Visa", "Mastercard", "HFD", "Ins VCC")
ATM = ("Cash", "Insurance Check")


def scenario_leaks(scenario):
    if scenario == "pos":
        return []
    if scenario == "neg-all":
        return list(LEAKS)
    return [scenario[4:].upper().replace("-", "_")]


def plant_leaks(a, leaks, events, remits, patients):
    lrng = random.Random(a.seed * 1000003 + a.leak_seed)
    lag = dt.timedelta(days=a.card_lag_days)
    total = lambda e: sum((v for _, v in e["rows"]), D(0)) if e["kind"] == "InsPayment" else e["amount"]
    banked = [e for e in events if e.get("banked")]
    card_days, atm_days = defaultdict(list), defaultdict(list)
    for e in banked:
        (card_days if e["method"] in CARD else atm_days if e["method"] in ATM else defaultdict(list))[e["date"]].append(e)
    plan = dict(card_short={}, broken_card={}, cash_short={}, broken_atm={}, exceptions=[], affected=set(), unmatched_bank=0, extras=[])
    used_card, used_atm, used_ids = set(), set(), set()
    next_id = max(e["id"] for e in events) + 1

    def exc(code, group, date, cents, ids, severity="exception", payer=None, detail=""):
        plan["exceptions"].append(dict(code=code, severity=severity, group=group, date=date.isoformat(), cents=int(cents), payment_ids=sorted(ids), payer=payer, detail=detail))

    def pick(xs, what):
        if not xs:
            raise SystemExit(f"cannot plant {what}: no candidate left in this set (try another --seed or a longer --days)")
        return lrng.choice(xs)

    def short_for(day_events, cap):
        singles = {total(e) for e in day_events}
        for _ in range(1000):
            x = D(lrng.uniform(1.0, float(cap)))
            if x > 0 and x not in singles:
                return x
        raise SystemExit("cannot pick a short amount that differs from every single payment of the day")

    for leak in leaks:
        if leak == "UNDEPOSITED_CHECK":
            e = pick([x for x in banked if x["kind"] == "InsPayment" and x["method"] == "Insurance Check" and x["date"] not in used_atm], leak)
            e["undeposited"] = True; used_atm.add(e["date"]); used_ids.add(e["id"])
            others = [x for x in atm_days[e["date"]] if x is not e]
            plan["broken_atm"][e["date"] + dt.timedelta(days=1)] = True
            plan["affected"] |= {x["id"] for x in atm_days[e["date"]]}
            plan["unmatched_bank"] += 1 if others else 0
            exc(leak, "branch_atm_deposit", e["date"], total(e) * 100, [e["id"]], detail="posted insurance check left out of the next ATM deposit")
        elif leak == "EFT_MISSING":
            r = pick([x for x in remits if x["method"] == "Direct Deposit" and not x.get("eft_missing")], leak)
            r["eft_missing"] = True
            ids = [x["id"] for x in r["payments"]]
            plan["affected"] |= set(ids)
            exc(leak, "insurance_eft", r["post"], sum((total(x) for x in r["payments"]), D(0)) * 100, ids, payer=r["code"], detail="remittance posted in Curve, no bank credit")
        elif leak == "CARD_BATCH_SHORT":
            day = pick(sorted(d for d in card_days if d not in used_card), leak); used_card.add(day)
            short = short_for(card_days[day], a.short_max)
            plan["card_short"][day + lag] = short; plan["broken_card"][day + lag] = True
            plan["affected"] |= {x["id"] for x in card_days[day]}; plan["unmatched_bank"] += 1
            exc(leak, "card_processor", day, short * 100, [], detail="card settlement credit lower than the day's card payments")
        elif leak == "CASH_SHORT":
            cands = sorted(d for d, es in atm_days.items() if d not in used_atm and sum((total(x) for x in es if x["method"] == "Cash"), D(0)) > D("1.01"))
            day = pick(cands, leak); used_atm.add(day)
            cash = sum((total(x) for x in atm_days[day] if x["method"] == "Cash"), D(0))
            short = short_for(atm_days[day], min(a.short_max, float(cash - D("0.01"))))
            plan["cash_short"][day + dt.timedelta(days=1)] = short; plan["broken_atm"][day + dt.timedelta(days=1)] = True
            plan["affected"] |= {x["id"] for x in atm_days[day]}; plan["unmatched_bank"] += 1
            exc(leak, "branch_atm_deposit", day, short * 100, [], detail="ATM deposit short of the day's cash")
        elif leak == "REF_MISMATCH":
            e = pick([x for x in banked if x["kind"] == "InsPayment" and x["method"] == "Insurance Check" and x["id"] not in used_ids], leak)
            used_ids.add(e["id"])
            new = e["ref"]
            while new == e["ref"]:
                new = f"{lrng.randrange(10**7, 10**8)}"
            e["dep_ref"] = new
            exc(leak, "branch_atm_deposit", e["date"], total(e) * 100, [e["id"]], detail=f"ledger reference {e['ref']} vs deposit detail Ref. ID {new}")
        elif leak == "POSTED_TWICE":
            e = pick([x for x in banked if x["kind"] == "Deposit" and x["method"] in ("Visa", "Mastercard") and x["date"] not in used_card], leak)
            used_card.add(e["date"])
            dup = dict(e, id=next_id, dup_of=e["id"], ext=f"S{lrng.randrange(10**12, 10**13):013d}")
            app = dict(kind="Payment", p=e["p"], prov=e["prov"], amount=e["amount"], method="Account Credit", banked=False, id=next_id + 1, date=e["date"])
            next_id += 2
            events += [dup, app]
            plan["broken_card"][e["date"] + lag] = True
            plan["affected"] |= {x["id"] for x in card_days[e["date"]]} | {dup["id"]}; plan["unmatched_bank"] += 1
            exc(leak, "card_processor", e["date"], e["amount"] * 100, [e["id"], dup["id"]], detail="same patient, amount and card posted twice; one settlement")
        elif leak == "BANK_UNPOSTED":
            mh_days = {r["remit"] for r in remits if r["code"] == "MH"}
            days = sorted({x["date"] for x in banked} - mh_days)
            day = pick([d for d in days if d.weekday() < 5], leak)
            sums = {total(x) for x in banked}
            amt = D(lrng.uniform(100, 900))
            while amt in sums:
                amt = D(lrng.uniform(100, 900))
            plan["extras"].append(("MH", day, amt)); plan["unmatched_bank"] += 1
            exc(leak, "insurance_eft", day, amt * 100, [], payer="MH", detail="EFT credit in the bank with no Curve posting")
        elif leak == "HFD_LAG":
            e = pick([x for x in banked if x["kind"] == "Deposit" and x["method"] == "HFD" and x["date"] not in used_card], leak)
            used_card.add(e["date"]); e["hfd_lag"] = True
            others = [x for x in card_days[e["date"]] if x is not e]
            if others:
                plan["broken_card"][e["date"] + lag] = True; plan["unmatched_bank"] += 1
            plan["affected"] |= {x["id"] for x in card_days[e["date"]]}; plan["unmatched_bank"] += 1
            plan["extras"].append(("HFD", e["date"] + lag + dt.timedelta(days=a.hfd_lag_extra_days), e["amount"]))
            exc(leak, "card_processor", e["date"], e["amount"] * 100, [e["id"]], severity="watch",
                detail=f"HFD funding {a.hfd_lag_extra_days} day(s) after the card lag window, as its own credit")

    def extra_credits(a, payer_ids):
        out = []
        for kind, day, amt in plan["extras"]:
            if kind == "HFD":
                out.append((day, f"GB PY DES:GLOBAL DEP ID:{a.merchant_id} INDN:{a.practice_name} CO ID:N400000000 CCD", amt))
            else:
                pid = payer_ids[kind]
                payer = next(p for p in PAYERS if p[0] == kind)
                out.append((day, f"{payer[3]} DES:HCCLAIMPMT ID:{lrng.randrange(10**9, 10**10)} INDN:{a.legal_name} CO ID:{pid} CCD "
                                 f"PMT INFO:TRN*1*{lrng.randrange(10**14, 10**15)}*{pid}\\", amt))
        return out
    plan["extra_credits"] = extra_credits
    return plan


def generate(a):
    leaks = scenario_leaks(a.scenario)
    rng = random.Random(a.seed)
    start = dt.date.fromisoformat(a.start)
    end = start + dt.timedelta(days=a.days - 1)
    bank_end = end + dt.timedelta(days=a.bank_tail_days)
    providers = [f"PV{i}" for i in range(1, a.providers + 1)]

    # patients -------------------------------------------------------------
    combos = [(f, l) for f in FIRST for l in LAST]
    if a.patients > len(combos):
        raise SystemExit(f"--patients max is {len(combos)}")
    rng.shuffle(combos)
    weights = [p[4] for p in PAYERS]
    patients = []
    for i, (f, l) in enumerate(combos[: a.patients], start=1):
        ins = None if rng.random() < a.self_pay_share else rng.choices(PAYERS, weights)[0]
        sec = None
        if ins and not ins[5] and rng.random() < 0.08:
            sec = rng.choice([p for p in PAYERS if p is not ins and not p[5]])
        patients.append(dict(key=f"PT{i}", first=f, last=l, dd=rng.choice(providers),
                             ins=ins, sec=sec, status="Active" if rng.random() < 0.93 else "Inactive"))
    active = [p for p in patients if p["status"] == "Active"]

    # remittance calendars: payer pays on one weekday each week -------------
    remit_wd = {p[0]: rng.randrange(0, 5) for p in PAYERS}
    payer_ids = {p[0]: f"1{rng.randrange(10**8, 10**9)}" for p in PAYERS}  # synthetic ACH company ids

    def next_remit(code, after):
        d = after
        while d.weekday() != remit_wd[code]:
            d += dt.timedelta(days=1)
        return d

    # events: (date, sortkey, dict) -> ids assigned chronologically ---------
    ev = []

    def add(date, **kw):
        ev.append([date, len(ev), kw])
        return kw

    claims_by_remit = defaultdict(list)  # (payer code, remit date) -> [(patient, prov, amount)]
    last_inv_day = end - dt.timedelta(days=a.claim_lag_days + 7 + 2)
    d = start
    while d <= last_inv_day:
        for _ in range(rng.randint(a.min_invoices_day, a.max_invoices_day)):
            p = rng.choice(active)
            prov = p["dd"] if rng.random() < 0.7 else rng.choice(providers)
            if rng.random() < a.zero_invoice_share:
                add(d, kind="Invoice", p=p, prov=prov, amount=D(0))
                continue
            fee = D(rng.choice(FEES))
            add(d, kind="Invoice", p=p, prov=prov, amount=fee)
            pt_resp = fee
            if p["ins"]:
                code, _, method, _, _, medicaid = p["ins"]
                if medicaid:
                    ins_paid = D(fee * Decimal(str(rng.uniform(0.45, 0.75)))).quantize(Decimal("1"))
                    adj_type, pt_resp = "Credit Adjustment", D(0)
                    writeoff = fee - ins_paid
                else:
                    allowed = D(fee * Decimal(str(rng.uniform(0.6, 0.88)))).quantize(Decimal("1"))
                    ins_paid = D(allowed * Decimal(str(rng.choice([0.5, 0.8, 1.0]))))
                    adj_type, writeoff, pt_resp = "PPO Write-off", fee - allowed, allowed - ins_paid
                remit = next_remit(code, d + dt.timedelta(days=a.claim_lag_days))
                claims_by_remit[(code, remit)].append((p, prov, ins_paid, writeoff, adj_type))
            if pt_resp > 0:
                r = rng.random()
                if r < a.cash_share:
                    add(d, kind="Payment", p=p, prov=prov, amount=pt_resp, method="Cash", banked=True)
                else:
                    method = "HFD" if pt_resp >= 500 and rng.random() < 0.5 else rng.choice(["Visa", "Visa", "Mastercard"])
                    add(d, kind="Deposit", p=p, prov=prov, amount=pt_resp, method=method,
                        ext=f"S{rng.randrange(10**12, 10**13):013d}" if method != "HFD" else "", banked=True)
                    add(d, kind="Payment", p=p, prov=prov, amount=pt_resp, method="Account Credit", banked=False)
        d += dt.timedelta(days=1)

    # insurance payments: one payment id per (patient, remit); one row per provider
    remits = []
    for (code, remit), items in sorted(claims_by_remit.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        payer = next(p for p in PAYERS if p[0] == code)
        method = payer[2]
        post = remit + dt.timedelta(days=1) if method == "Direct Deposit" else (
            remit + dt.timedelta(days=3) if method == "Insurance Check" else remit)
        if post > end:
            raise SystemExit("internal: posting fell outside window; widen --days")
        ref = f"{rng.randrange(10**7, 10**8)}" if method == "Insurance Check" else ""
        trace = f"{rng.randrange(10**14, 10**15)}" if method == "Direct Deposit" else ""
        by_pt = defaultdict(lambda: defaultdict(lambda: [D(0), D(0), None]))
        for p, prov, paid, wo, adj in items:
            cell = by_pt[p["key"]][prov]
            cell[0] += paid
            cell[1] += wo
            cell[2] = adj
        rec = dict(code=code, method=method, remit=remit, post=post, ref=ref, trace=trace, payments=[])
        for pkey, provs in by_pt.items():
            p = next(x for x in patients if x["key"] == pkey)
            pay = add(post, kind="InsPayment", p=p, rows=[(pv, v[0]) for pv, v in provs.items()],
                      method=method, payer=code, ref=ref, banked=True, remit=rec)
            rec["payments"].append(pay)
            for pv, v in provs.items():
                if v[1] > 0:
                    add(post, kind="Adjustment", p=p, prov=pv, amount=v[1], adj=v[2])
        remits.append(rec)

    ev.sort(key=lambda e: (e[0], e[1]))
    nid = a.first_id
    for e in ev:
        e[2]["id"] = nid
        e[2]["date"] = e[0]
        nid += 1
    events = [e[2] for e in ev]
    plan = plant_leaks(a, leaks, events, remits, patients) if leaks else None

    # ---------------------------------------------------------------- Curve files
    def nm_ledger(p):
        return f"{p['last']}, {p['first']}"

    def nm_rp(p):
        return f"{p['first']} {p['last']}"

    ledger, dep = [], []
    for e in events:
        p = e["p"]
        base = [p["key"], p["last"], p["first"], p["dd"]]
        k = e["kind"]
        if k == "Invoice":
            ledger.append((p, [mdy(e["date"]), f"Invoice #{e['id']}", *base, e["prov"], a.clinic, a.clinic, amt_min(e["amount"])]))
        elif k == "Adjustment":
            ledger.append((p, [mdy(e["date"]), f"Adjustment #{e['id']}, {e['adj']}", *base, e["prov"], a.clinic, a.clinic, amt_min(-e["amount"])]))
        elif k == "Deposit":
            ledger.append((p, [mdy(e["date"]), f"Deposit #{e['id']}, {e['method']}", *base, e["prov"], a.clinic, a.clinic, amt_min(e["amount"])]))
            dep.append((p, [mdy(e["date"]), e["id"], "Office posted", e["method"], "", e["ext"], nm_rp(p), p["key"], nm_rp(p), e["prov"], a.clinic, amt_min(e["amount"])]))
        elif k == "Payment":
            ledger.append((p, [mdy(e["date"]), f"Payment #{e['id']}, {e['method']}", *base, e["prov"], a.clinic, a.clinic, amt_min(-e["amount"])]))
            if e["banked"]:
                dep.append((p, [mdy(e["date"]), e["id"], "Office posted", e["method"], "", "", nm_rp(p), p["key"], nm_rp(p), e["prov"], a.clinic, amt_min(e["amount"])]))
        elif k == "InsPayment":
            det = f"Payment #{e['id']}, {e['method']}" + (f" - {e['ref']}" if e["ref"] else "")
            for pv, v in e["rows"]:
                ledger.append((p, [mdy(e["date"]), det, *base, pv, a.clinic, a.clinic, amt_min(-v)]))
                dep.append((p, [mdy(e["date"]), e["id"], "Office posted", e["method"], e.get("dep_ref", e["ref"]), "", e["payer"], p["key"], nm_rp(p), pv, a.clinic, amt_min(v)]))
    ledger.sort(key=lambda r: (r[0]["last"].lower(), r[0]["first"].lower()))
    dep.sort(key=lambda r: (r[0]["first"].lower(), r[0]["last"].lower()))

    L_HDR = ["Date", "Details", "Patient", "Patient-LM", "Patient-FM", "Default dentist", "Provider of service", "Clinic", "Posted at clinic", "Amount"]
    D_HDR = ["Date", "ID", "Payment Posted By", "Payment Type", "Ref. ID", "Ext. ID", "Payer", "RP", "Responsible Party", "Provider", "Posted At Clinic", "Amount"]
    P_HDR = ["Patient", "Full Name", "Status", "Preferred Clinic", "Default Doctor", "Prim. Insurance Plan", "Sec. Insurance Plan"]
    pfmt = nm_ledger if a.patient_name_format == "last_first" else nm_rp
    plist = [[p["key"], pfmt(p), p["status"], a.practice_name, p["dd"], p["ins"][1] if p["ins"] else "", p["sec"][1] if p["sec"] else ""]
             for p in sorted(patients, key=lambda p: (p["last"].lower(), p["first"].lower()))]

    # ---------------------------------------------------------------- bank
    bank = []  # (date, order, description, amount, match dict or None)
    matches = []
    gp = defaultdict(list)  # settle date -> events
    atm = defaultdict(list)
    card_fee_base = D(0)
    for e in events:
        if not e.get("banked") or e.get("dup_of") or e.get("hfd_lag") or e.get("undeposited"):
            continue  # NEG: a second posting is never banked; a late HFD funds on its own; an undeposited check stays in the office
        m = e["method"]
        if m in ("Visa", "Mastercard", "HFD", "Ins VCC"):
            gp[e["date"] + dt.timedelta(days=a.card_lag_days)].append(e)
        elif m in ("Cash", "Insurance Check"):
            atm[e["date"] + dt.timedelta(days=1)].append(e)

    def ev_total(e):
        return sum((v for _, v in e["rows"]), D(0)) if e["kind"] == "InsPayment" else e["amount"]

    fee_rate = Decimal(str(a.card_fee_pct)) / 100
    for sd, es in sorted(gp.items()):
        gross = sum((ev_total(e) for e in es), D(0))
        fee = D(gross * fee_rate)
        card_fee_base += gross
        amount = gross - fee if a.card_fee_mode == "daily-net" else gross
        if plan:
            amount -= plan["card_short"].get(sd, D(0))
        desc = f"GB PY DES:GLOBAL DEP ID:{a.merchant_id} INDN:{a.practice_name} CO ID:N400000000 CCD"
        bank.append([sd, 1, desc, amount])
        if plan and plan["broken_card"].get(sd):
            continue
        matches.append(dict(bank_date=sd, description=desc, bank_amount=amount, group="card_processor",
                            curve_ids=sorted({e["id"] for e in es}), curve_total=gross,
                            fee=fee if a.card_fee_mode == "daily-net" else D(0)))
    seq = 1941
    for sd, es in sorted(atm.items()):
        total = sum((ev_total(e) for e in es), D(0))
        desc = f"BKOFAMERICA ATM {sd.strftime('%m/%d')} #{seq:09d} DEPOSIT MAIN ST ANYTOWN CT CKCD 4135770000004410"
        seq += 1
        bank.append([sd, 1, desc, total - (plan["cash_short"].get(sd, D(0)) if plan else D(0))])
        if plan and plan["broken_atm"].get(sd):
            continue
        matches.append(dict(bank_date=sd, description=desc, bank_amount=total, group="branch_atm_deposit",
                            curve_ids=sorted({e["id"] for e in es}), curve_total=total, fee=D(0)))
    for r in remits:
        if r["method"] != "Direct Deposit" or r.get("eft_missing"):
            continue
        payer = next(p for p in PAYERS if p[0] == r["code"])
        total = sum((ev_total(e) for e in r["payments"]), D(0))
        payer_id = payer_ids[r["code"]]
        desc = (f"{payer[3]} DES:HCCLAIMPMT ID:{rng.randrange(10**9, 10**10)} INDN:{a.legal_name} "
                f"CO ID:{payer_id} CCD PMT INFO:TRN*1*{r['trace']}*{payer_id}\\")
        bank.append([r["remit"], 1, desc, total])
        matches.append(dict(bank_date=r["remit"], description=desc, bank_amount=total, group="insurance_eft",
                            payer=r["code"], trace=r["trace"], curve_ids=sorted(e["id"] for e in r["payments"]),
                            curve_total=total, fee=D(0)))
    if plan:
        for bd, desc, amount in plan["extra_credits"](a, payer_ids):
            bank.append([bd, 1, desc, amount])
    if a.card_fee_mode == "monthly" and card_fee_base > 0:
        fd = end + dt.timedelta(days=2)
        fee = D(card_fee_base * fee_rate)
        bank.append([fd, 2, f"GB PY DES:GLOBAL STL ID:{a.merchant_id} INDN:{a.practice_name} CO ID:N400000000 CCD", -fee])
    # operating expenses (not part of reconciliation)
    d = start
    chk = 3001
    while d <= bank_end:
        if d.day == 1:
            bank.append([d, 3, f"Check {chk}", -D(a.rent)]); chk += 1
        if d.day in (15, 30):
            bank.append([d, 3, f"PAYCHEX INC. DES:PAYROLL ID:PX{rng.randrange(10**8, 10**9)} INDN:{a.legal_name} CO ID:1160000000 CCD", -D(rng.uniform(a.payroll * 0.95, a.payroll * 1.05))])
            bank.append([d, 3, f"PAYCHEX TPS DES:TAXES ID:{rng.randrange(10**8, 10**9)} INDN:{a.legal_name} CO ID:1160000000 CCD", -D(rng.uniform(a.payroll * 0.08, a.payroll * 0.1))])
        if rng.random() < 0.35:
            t, lo, hi = rng.choice(EXPENSES)
            bank.append([d, 3, t.format(md=(d - dt.timedelta(days=1)).strftime("%m/%d"), rid=rng.randrange(10**6, 10**7), legal=a.legal_name), -D(rng.uniform(lo, hi))])
        d += dt.timedelta(days=1)
    bank.sort(key=lambda b: (b[0], b[1]))

    opening = D(a.opening_balance)
    bal = opening
    rows = [[mdy(start), f"Beginning balance as of {mdy0(start)}", "", amt_bal(bal)]]
    credits = debits = D(0)
    for bd, _, desc, amount in bank:
        bal += amount
        credits += amount if amount > 0 else 0
        debits += amount if amount < 0 else 0
        rows.append([mdy(bd), desc, amt_bank(amount), amt_bal(bal)])
    pre = [["Description", "", "Summary Amt.", ""],
           [f"Beginning balance as of {mdy0(start)}", "", amt_bal(opening), amt_bal(opening)],
           ["Total credits", "", amt_bal(credits), amt_bal(credits)],
           ["Total debits", "", amt_bal(debits), amt_bal(debits)],
           [f"Ending balance as of {mdy0(bank_end)}", "", amt_bal(bal), amt_bal(bal)],
           ["", "", "", ""],
           ["Date", "Description", "Amount", "Running Bal."]]
    assert opening + credits + debits == bal

    # ---------------------------------------------------------------- write
    tag = f"{a.set_name}-{a.scenario.upper()}"
    os.makedirs(os.path.join(a.out, "_answer-key"), exist_ok=True)
    files = {
        f"BankDep-Det-{tag}.csv": csv_text([D_HDR] + [r for _, r in dep], True),
        f"Per-Sum-{tag}.csv": csv_text([L_HDR] + [r for _, r in ledger], True),
        f"SPR-patientlist-{tag}.csv": csv_text([P_HDR] + plist, True),
        f"BANK-ST-{tag}.csv": csv_text(pre + rows, False),
    }
    for name, text in files.items():
        with open(os.path.join(a.out, name), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)

    posted_by_group = defaultdict(lambda: D(0))
    group_of = {"Visa": "card_processor", "Mastercard": "card_processor", "HFD": "card_processor",
                "Ins VCC": "card_processor", "Cash": "branch_atm_deposit", "Insurance Check": "branch_atm_deposit",
                "Direct Deposit": "insurance_eft"}
    for e in events:
        if e.get("banked") and not e.get("dup_of"):
            posted_by_group[group_of[e["method"]]] += ev_total(e)
    banked_by_group = defaultdict(lambda: D(0))
    for m in matches:
        banked_by_group[m["group"]] += m["curve_total"]
    truth = dict(
        generator="gen_dental_set.py", seed=a.seed, scenario=a.scenario, set=a.set_name,
        synthetic=True, curve_window=[start.isoformat(), end.isoformat()],
        bank_window=[start.isoformat(), bank_end.isoformat()],
        flags={k: v for k, v in vars(a).items()},
        counts=dict(patients=len(patients), ledger_rows=len(ledger), deposit_rows=len(dep),
                    bank_rows=len(rows) - 1, bank_credits_matched=len(matches)),
        posted_to_bank_by_group={k: str(v) for k, v in posted_by_group.items()},
        matched_in_bank_by_group={k: str(v) for k, v in banked_by_group.items()},
        card_fee_mode=a.card_fee_mode,
        bank_totals=dict(opening=str(opening), credits=str(credits), debits=str(debits), ending=str(bal)),
        expected_exceptions=plan["exceptions"] if plan else [],
        affected_payment_ids=sorted(plan["affected"]) if plan else [],
        unmatched_bank_credits=plan["unmatched_bank"] if plan else 0,
        leak_seed=a.leak_seed,
        notes=("POS: every banked Curve payment is in exactly one bank credit; Account Credit rows are internal and never banked."
               if not plan else "NEG: planted leaks in expected_exceptions; affected_payment_ids are in no exact match; "
               "unmatched_bank_credits bank credits match nothing exactly. Leaks use their own random stream (--leak-seed), so the base set equals POS."),
    )
    if not plan:
        assert all(posted_by_group[g] == banked_by_group[g] for g in posted_by_group)
    with open(os.path.join(a.out, "_answer-key", "truth.json"), "w", encoding="utf-8") as fh:
        json.dump(truth, fh, indent=2, default=str)
    with open(os.path.join(a.out, "_answer-key", "expected-matches.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, lineterminator="\r\n")
        w.writerow(["bank_date", "bank_description", "bank_amount", "group", "payer", "trace", "curve_payment_ids", "curve_total", "fee"])
        for m in sorted(matches, key=lambda m: m["bank_date"]):
            w.writerow([mdy(m["bank_date"]), m["description"], f"{m['bank_amount']:.2f}", m["group"], m.get("payer", ""),
                        m.get("trace", ""), ";".join(map(str, m["curve_ids"])), f"{m['curve_total']:.2f}", f"{m['fee']:.2f}"])
    return truth


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output folder")
    ap.add_argument("--set-name", default="SET1")
    ap.add_argument("--scenario", default="pos", choices=SCENARIOS, help="pos, neg-all (every leak, on separate days) or neg-<leak>")
    ap.add_argument("--leak-seed", type=int, default=1, help="seed of the leak stream (NEG only; the base set always uses --seed)")
    ap.add_argument("--hfd-lag-extra-days", type=int, default=5, help="HFD_LAG: days the late HFD funding comes after --card-lag-days")
    ap.add_argument("--short-max", type=float, default=50.0, help="CARD_BATCH_SHORT / CASH_SHORT: largest short amount")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--start", default="2024-09-01", help="first Curve date (ISO)")
    ap.add_argument("--days", type=int, default=30, help="Curve window length")
    ap.add_argument("--bank-tail-days", type=int, default=10, help="bank window extends past Curve window")
    ap.add_argument("--patients", type=int, default=260)
    ap.add_argument("--providers", type=int, default=4)
    ap.add_argument("--clinic", default="S1")
    ap.add_argument("--self-pay-share", type=float, default=0.25)
    ap.add_argument("--cash-share", type=float, default=0.12, help="share of patient portions paid in cash")
    ap.add_argument("--zero-invoice-share", type=float, default=0.08)
    ap.add_argument("--min-invoices-day", type=int, default=6)
    ap.add_argument("--max-invoices-day", type=int, default=12)
    ap.add_argument("--claim-lag-days", type=int, default=5, help="min days invoice -> payer remit")
    ap.add_argument("--first-id", type=int, default=300001)
    ap.add_argument("--card-lag-days", type=int, default=1)
    ap.add_argument("--card-fee-pct", type=float, default=2.9)
    ap.add_argument("--card-fee-mode", default="monthly", choices=["monthly", "daily-net"])
    ap.add_argument("--merchant-id", default="8700000000001")
    ap.add_argument("--practice-name", default="MAPLE GROVE DENTAL")
    ap.add_argument("--legal-name", default="MGD PC")
    ap.add_argument("--opening-balance", type=float, default=120000.00)
    ap.add_argument("--rent", type=float, default=6200.00)
    ap.add_argument("--payroll", type=float, default=28000.00)
    ap.add_argument("--patient-name-format", default="last_first", choices=["last_first", "first_last"],
                    help="'Full Name' format in the patient list (unknown from the sample)")
    a = ap.parse_args()
    t = generate(a)
    print(json.dumps(dict(counts=t["counts"], posted=t["posted_to_bank_by_group"],
                          matched=t["matched_in_bank_by_group"], bank=t["bank_totals"]), indent=2))


if __name__ == "__main__":
    main()

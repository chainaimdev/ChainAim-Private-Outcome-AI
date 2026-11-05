#!/usr/bin/env python3
"""
Synthetic US chiropractic practice data set generator (privateAI-design-30 §8, §11-12): ChiroTouch or Jane exports, ERA 835,
Bank of America statement, fee schedule, personal-injury cases and care plans, plus an answer key in _answer-key/.

One canonical model (patients, visits, claims, remittances, patient payments, deposits) is written out in the layout family
of the chosen PRMS (--prms chirotouch | jane), so the same --seed gives the same business events in both folders.

Layout status (design-30 §3, rule { value, verified, basis }):
  VERIFIED   BANK-ST-*  Bank of America CSV: same writer conventions as tools/dental-synth (owner's BofA samples), including the
                        insurance EFT form '<ORIG> DES:HCCLAIMPMT ... PMT INFO:TRN*1*<trace>*<id>\\', 'GB PY DES:GLOBAL DEP' card
                        credits and 'BKOFAMERICA ATM ... DEPOSIT' branch deposits.
             ERA-*.835  ASC X12N 835 5010, element layout per services/analyst/src/sources/remit/x12-835-parse.ts (public companion
                        guides); every file is re-read by that parser in the tests.
  PARTIAL    JANE-PAYMENTS-REFUNDS-FEES-*, JANEPAY-PAYOUTS-*: column names from Jane's public report guides (design-30 §1),
                        not from a real export.
  UNVERIFIED CT-* (patients, day sheet, deposits), CTPAY-*, CASHPRAC-*, JANE-PATIENTS-*, JANE-TRANSACTIONS-*: canonical layouts
                        until the owner supplies header lines; the Jane payout and Cash Practice bank descriptions.
  OWNER-DEF  FEESCHED-*, PI-CASES-*, CAREPLANS-*: no standard export exists (design-30 §3).

Modelling choices that are ASSUMPTIONS (flags where they are numbers):
  * Payer mix (design-30 §10 #2): --commercial-share 45 --medicare-share 20 --medicaid-share 5 --pi-share 15 --prepay-share 15.
  * Payers are synthetic except the bank originators reused from the dental sample (COMM OF MASS, STATE OF CONN DSS,
    ANTHEM BLUE CROSS). MassHealth / HUSKY / commercial / Medicare pay by 835 + EFT; auto PI carriers by paper check.
  * Remittance: each insurance payer runs one payment a week on --era-weekday (Friday); a claim is paid on the first such day at
    least --adjudication-days after the visit; the EFT is credited on BPR16 (payment date) and posted in the PRMS next day.
  * Copay (commercial, PR-3) and Medicare coinsurance (20%, PR-2) are collected at the visit.
  * Medicare visits carry only 98940-98942 with modifier AT (active care); non-covered services are not billed in POS.
  * Card payments: ChiroTouch -> CT Payments (Global Payments) daily batch, credited --card-lag-days later, gross;
    Jane -> Jane Payments payout of the day's card payments net of --jane-fee-bps + --jane-fee-fixed-cents, deposited
    --jane-payout-days business days later (Jane guide: 2-business-day rolling US schedule).
  * Cash and patient/attorney/PI checks posted on day d go to one ATM deposit on the next bank day.
  * Care plans: --plan-visits visits for --plan-price; ChiroTouch: paid in full by card or by Cash Practice monthly auto-debit
    (--autodebit-share), Jane: paid in full by card. Plan revenue is unearned until visits are used (design-30 §12: no MA/CT
    rule found; pro-rata refund is the design rule).
  * PI (design-30 §12): MA -> PIP ($8,000 limit; $2,000 medical cap when the patient has health insurance); CT -> optional
    MedPay. Cases start with a letter of protection; a settled case records billed, received and the approved reduction.

Scenarios (chiro_leaks.py): 'pos' (everything reconciles), 'neg-<leak>' (one leak) and 'neg-all' (all 16 on separate claims,
remittances, payments and days; AUTODEBIT_RETURNED is ChiroTouch-only, so Jane neg-all has 15). Leaks draw from their own
random stream (--leak-seed), so the rest of a NEG set equals POS; the answer key lists every expected exception.
  ASSUMPTION: --at-missing-cas / --gz-cas default CO-50. Sources say a CMT line without AT is denied as maintenance
  (Noridian JF chiropractic claim submission requirements) and GZ lines are auto-denied (Palmetto GBA acute treatment page);
  neither page names the CARC, so it is a flag.
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import random
from collections import defaultdict

from chiro_leaks import SCENARIOS, LeakPlan, scenario_leaks
CPT_FEE = {"98940": 6000, "98941": 7500, "98942": 9000, "97140": 5000, "97110": 4500, "97012": 3000, "99203": 15000, "72100": 8500}
MEDICARE_ALLOWED = {"98940": 3050, "98941": 4300, "98942": 5500}
# code, name, class, state, payment route, bank originator, payer id (N1*PR04), CLP06, copay cents, allowed % of charge
PAYERS = [
    ("BCBSMA", "BLUE CROSS BLUE SHIELD OF MA (SYN)", "commercial", "MA", "eft", "BCBS MA SYN", "SYN0001", "CI", 2500, 80),
    ("ANTHEMCT", "ANTHEM BCBS CT (SYN)", "commercial", "CT", "eft", "ANTHEM BLUE CROSS", "SYN0002", "BL", 3000, 78),
    ("AETNA", "AETNA (SYN)", "commercial", "ANY", "eft", "AETNA SYN", "SYN0003", "CI", 2000, 75),
    ("MEDICAREB", "MEDICARE PART B (SYN)", "medicare", "ANY", "eft", "MEDICARE B SYN", "SYN0004", "MB", 0, 0),
    ("MASSHEALTH", "MASSHEALTH (SYN)", "medicaid", "MA", "eft", "COMM OF MASS", "SYN0005", "MC", 0, 60),
    ("HUSKY", "HUSKY HEALTH (SYN)", "medicaid", "CT", "eft", "STATE OF CONN DSS", "SYN0006", "MC", 0, 60),
    ("AUTOPIPMA", "AUTO CARRIER PIP MA (SYN)", "pi", "MA", "check", None, None, None, 0, 100),
    ("AUTOMEDPAYCT", "AUTO CARRIER MEDPAY CT (SYN)", "pi", "CT", "check", None, None, None, 0, 100),
]
PAYER = {p[0]: p for p in PAYERS}
FIRST = ["Ana", "Brian", "Carla", "Daniel", "Elena", "Frank", "Gloria", "Hector", "Irene", "James", "Karen", "Luis", "Maria",
         "Nadia", "Oscar", "Paula", "Quinn", "Rosa", "Samuel", "Tanya", "Victor", "Wendy", "Xavier", "Yolanda", "Zach"]
LAST = ["Alvarez", "Baker", "Castillo", "Dorsey", "Ellis", "Flores", "Grant", "Hughes", "Ibarra", "Jensen", "Keller", "Lopez",
        "Morales", "Nolan", "Ortega", "Patel", "Quinlan", "Rivera", "Santos", "Turner", "Vasquez", "Walsh", "Young", "Zimmer"]
ATTORNEYS = ["SYN LAW GROUP A", "SYN INJURY LAW B", "SYN TRIAL ATTORNEYS C"]


# ---------------------------------------------------------------- formatting
def mdy(d):
    return f"{d.month}/{d.day}/{d.year}"


def mdy0(d):
    return d.strftime("%m/%d/%Y")


def money(c):  # integer cents -> '1234.50'
    s = "-" if c < 0 else ""
    c = abs(c)
    return f"{s}{c // 100}.{c % 100:02d}"


def x12amt(c):  # integer cents -> X12 R type: '150', '19.5', '0'
    t = money(c)
    return t.rstrip("0").rstrip(".") if "." in t else t


def amt_bank(c):  # bank amount: '1,069.50' if |x| >= 1000 else minimal decimals (dental writer convention)
    if abs(c) >= 100000:
        return f"{'-' if c < 0 else ''}{abs(c) // 100:,}.{abs(c) % 100:02d}"
    t = money(c)
    return t[:-3] if t.endswith(".00") else t[:-1] if t.endswith("0") else t


def amt_bal(c):
    return f"{'-' if c < 0 else ''}{abs(c) // 100:,}.{abs(c) % 100:02d}"


def csv_text(rows, bom):
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\r\n").writerows(rows)
    return (chr(0xFEFF) if bom else "") + buf.getvalue()


def bank_day(d):  # next weekday on or after d
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


def add_business_days(d, n):
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


# ---------------------------------------------------------------- canonical model
def build(a, leaks=None):
    rng = random.Random(a.seed)
    start = dt.date.fromisoformat(a.start)
    end = start + dt.timedelta(days=a.days - 1)
    workdays = [start + dt.timedelta(days=i) for i in range(a.days) if (start + dt.timedelta(days=i)).weekday() < 5]
    providers = [f"DC{i + 1}" for i in range(a.providers)]
    shares = [("commercial", a.commercial_share), ("medicare", a.medicare_share), ("medicaid", a.medicaid_share),
              ("pi", a.pi_share), ("prepay", a.prepay_share)]
    if sum(s for _, s in shares) <= 0:
        raise SystemExit("gen_chiro_set: the payer shares must add up to more than 0")

    patients = []
    for i in range(a.patients):
        cls = rng.choices([c for c, _ in shares], [s for _, s in shares])[0]
        state = rng.choice(["MA", "CT"])
        if cls == "commercial":
            payer = rng.choice([p[0] for p in PAYERS if p[2] == "commercial" and p[3] in (state, "ANY")])
        elif cls == "medicare":
            payer = "MEDICAREB"
        elif cls == "medicaid":
            payer = "MASSHEALTH" if state == "MA" else "HUSKY"
        elif cls == "pi":
            payer = "AUTOPIPMA" if state == "MA" else "AUTOMEDPAYCT"
        else:
            payer = None
        patients.append(dict(id=f"CH{i + 1}", first=rng.choice(FIRST), last=rng.choice(LAST), cls=cls, state=state, payer=payer,
                             provider=rng.choice(providers), health_ins=(cls == "pi" and rng.random() < 0.5)))

    visits, charges, pay_events, plans = [], [], [], []
    vno = 0
    for p in patients:
        n = rng.randint(a.min_visits, a.max_visits)
        days = sorted(rng.sample(workdays, min(n, len(workdays))))
        if p["cls"] == "prepay":
            plan = dict(id=f"PL{len(plans) + 1}", patient=p["id"], start=days[0], visits_bought=a.plan_visits, price=a.plan_price, method="card")
            plans.append(plan)
        for k, d in enumerate(days):
            vno += 1
            v = dict(id=f"V{vno:05d}", patient=p["id"], date=d, provider=p["provider"], cls=p["cls"], payer=p["payer"], lines=[])
            if p["cls"] == "medicare":
                v["lines"].append(dict(cpt=rng.choice(["98940", "98941", "98942"]), mods=["AT"]))
            else:
                v["lines"].append(dict(cpt=rng.choice(["98940", "98941", "98941", "98942"]), mods=[]))
                if k == 0 and p["cls"] != "prepay":
                    v["lines"].append(dict(cpt="99203", mods=["25"]))
                if p["cls"] in ("commercial", "pi") and rng.random() < 0.5:
                    v["lines"].append(dict(cpt=rng.choice(["97140", "97110", "97012"]), mods=["59"]))  # distinct from the CMT, so not bundled in POS
            for ln in v["lines"]:
                ln["charge"] = CPT_FEE[ln["cpt"]]
            if p["cls"] == "prepay":
                v["plan"] = plan["id"]
                for ln in v["lines"]:
                    ln["charge"] = a.plan_price // a.plan_visits if ln is v["lines"][0] else 0
            visits.append(v)

    # ChiroTouch: the first ceil(plans x --autodebit-share %) plans pay by Cash Practice auto-debit (no random draw, so both PRMS
    # keep the same event stream; at least one when the share is above 0)
    if a.prms == "chirotouch" and a.autodebit_share > 0:
        for pl in plans[:max(1, -(-len(plans) * a.autodebit_share // 100))]:
            pl["method"] = "autodebit"

    # fee schedule (contracted allowed per payer + CPT)
    fees = []
    for code, name, cls, *_rest in PAYERS:
        pct = PAYER[code][9]
        for cpt, fee in CPT_FEE.items():
            if cls == "medicare":
                if cpt in MEDICARE_ALLOWED:
                    fees.append((code, cpt, MEDICARE_ALLOWED[cpt]))
            else:
                fees.append((code, cpt, fee * pct // 100))
    allowed = {(c, cpt): amt for c, cpt, amt in fees}

    # insurance adjudication (835 payers) and patient responsibility collected at the visit
    claims, collect = [], []
    for v in visits:
        pay = PAYER.get(v["payer"]) if v["payer"] else None
        if not pay:
            continue
        lines, pr_left = [], 0
        copay = pay[8] if pay[2] == "commercial" else 0
        for i, ln in enumerate(v["lines"]):
            al = allowed[(pay[0], ln["cpt"])]
            adj = []
            if ln["charge"] - al:
                adj.append(("CO", "45", ln["charge"] - al))
            pr = 0
            if pay[2] == "commercial" and i == 0:
                pr = min(copay, al)
                adj.append(("PR", "3", pr)) if pr else None
            elif pay[2] == "medicare":
                pr = al * 20 // 100
                adj.append(("PR", "2", pr))
            lines.append(dict(cpt=ln["cpt"], mods=ln["mods"], charge=ln["charge"], allowed=al, paid=al - pr, adj=adj, pr=pr))
            pr_left += pr
        claim = dict(visit=v["id"], patient=v["patient"], payer=pay[0], dos=v["date"], lines=lines,
                     charge=sum(l["charge"] for l in lines), paid=sum(l["paid"] for l in lines), pr=pr_left, route=pay[4])
        claims.append(claim)
        # the method draw happens whenever the POS claim has patient responsibility, so a leak never shifts the main stream
        collect.append((claim, v, rng.choices(["card", "cash", "check"], [65, 25, 10])[0] if pr_left else None))

    def eft_paid_on(c):  # deterministic payment day of an EFT claim (no draw), None when after the period or paid by check
        if c["route"] != "eft":
            return None
        due = c["dos"] + dt.timedelta(days=a.adjudication_days)
        while due.weekday() != a.era_weekday:
            due += dt.timedelta(days=1)
        return due if due <= end else None

    if leaks:
        leaks.apply_claims(claims, {v["id"]: v for v in visits}, PAYER, eft_paid_on, allowed)
    for claim, v, method in collect:
        cents = claim["pr"] - claim.get("pr_writeoff", 0)
        if method and cents > 0 and not claim.get("pr_not_transferred"):
            pay_events.append(dict(kind="patient", date=v["date"], patient=v["patient"], visit=v["id"], cents=cents, method=method))

    # remittance runs: EFT payers weekly on --era-weekday; PI carriers pay by check
    remits = []
    for c in claims:
        due = c["dos"] + dt.timedelta(days=a.adjudication_days)
        if c["route"] == "eft":
            while due.weekday() != a.era_weekday:
                due += dt.timedelta(days=1)
        else:
            due = bank_day(due + dt.timedelta(days=rng.randint(0, 6)))
        c["paid_on"] = due if due <= end else None
    # MA PIP (design-30 §12): with health insurance, PIP pays medical expenses up to --pip-health-cap-cents per person; the rest
    # goes to the health plan (not modelled) and stays unpaid by the carrier here.
    paid_pip = defaultdict(int)
    pats = {p["id"]: p for p in patients}
    for c in sorted(claims, key=lambda c: c["dos"]):
        p = pats[c["patient"]]
        if c["payer"] == "AUTOPIPMA" and p["health_ins"] and c["paid_on"]:
            if paid_pip[p["id"]] + c["paid"] > a.pip_health_cap_cents:
                c["paid_on"], c["over_pip_cap"] = None, True
            else:
                paid_pip[p["id"]] += c["paid"]
    seq = 0
    by_run = defaultdict(list)
    for c in claims:
        if c["paid_on"]:
            by_run[(c["payer"], c["paid_on"], c["route"])].append(c)
    for (payer, day, route), cs in sorted(by_run.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        seq += 1
        trace = f"{a.seed % 1000:03d}{day.strftime('%m%d')}{seq:04d}{rng.randrange(1000, 9999)}" if route == "eft" else f"{rng.randrange(100000, 999999)}"
        remits.append(dict(no=seq, payer=payer, date=day, route=route, trace=trace, claims=cs, cents=sum(c["paid"] for c in cs)))
        if route == "check":
            pay_events.append(dict(kind="pi_check", date=day + dt.timedelta(days=1), patient=None, visit=None, cents=sum(c["paid"] for c in cs),
                                   method="check", ref=trace, payer=payer))

    # care plans: payment events
    for pl in plans:
        if pl["method"] == "card":
            pay_events.append(dict(kind="plan", date=pl["start"], patient=pl["patient"], visit=None, plan=pl["id"], cents=pl["price"], method="card"))
        else:
            inst = pl["price"] // a.plan_months
            pl["installments"] = []
            d = pl["start"]
            for _ in range(a.plan_months):
                if d > end:
                    break
                pl["installments"].append((d, inst))
                pay_events.append(dict(kind="plan", date=d, patient=pl["patient"], visit=None, plan=pl["id"], cents=inst, method="autodebit"))
                d = (d.replace(day=1) + dt.timedelta(days=32)).replace(day=min(pl["start"].day, 28))
        pl["visits_used"] = sum(1 for v in visits if v.get("plan") == pl["id"])

    # PI cases (one per PI patient); a settlement for --pi-settled cases, by attorney check, with an approved reduction
    pi_cases = []
    for p in patients:
        if p["cls"] != "pi":
            continue
        billed = sum(c["charge"] for c in claims if c["patient"] == p["id"])
        received = sum(c["paid"] for c in claims if c["patient"] == p["id"] and c["paid_on"])
        pi_cases.append(dict(id=f"PI{len(pi_cases) + 1}", patient=p["id"], state=p["state"], coverage="PIP" if p["state"] == "MA" else "MedPay",
                             payer=p["payer"], attorney=rng.choice(ATTORNEYS), lop=start - dt.timedelta(days=rng.randint(30, 300)),
                             billed=billed, carrier_paid=received, health_ins=p["health_ins"], status="open", settled_on=None, settled=0, reduction=0, approved=""))
    for case in rng.sample(pi_cases, min(a.pi_settled, len(pi_cases))):
        prior = rng.randrange(150000, 600000)  # earlier, pre-period balance on the lien (synthetic)
        balance = prior + case["billed"] - case["carrier_paid"]
        reduction = balance * rng.choice([10, 15, 20, 25]) // 100
        case.update(status="settled", settled_on=bank_day(start + dt.timedelta(days=rng.randint(5, a.days - 5))), settled=balance - reduction,
                    reduction=reduction, approved="yes", prior_balance=prior)
        pay_events.append(dict(kind="attorney", date=case["settled_on"], patient=case["patient"], visit=None, cents=case["settled"], method="check",
                               ref=f"{rng.randrange(1000, 9999)}", case=case["id"]))

    pay_events.sort(key=lambda e: (e["date"], e["kind"], e.get("patient") or ""))
    for i, e in enumerate(pay_events):
        e["id"] = f"P{i + 1:05d}"
    m = dict(start=start, end=end, patients=patients, visits=visits, claims=claims, remits=remits, plans=plans, pi=pi_cases,
             pay=pay_events, fees=fees, providers=providers)
    if leaks:
        leaks.apply_model(m, PAYER, add_business_days)
    return m


# ---------------------------------------------------------------- deposits and bank
def eft_desc(a, pay, trace, draw):
    return (f"{pay[5]} DES:HCCLAIMPMT ID:{draw} INDN:{a.legal_name} CO ID:{pay[6]} CCD "
            f"PMT INFO:TRN*1*{trace}*{pay[6]}\\")


def deposits_and_bank(a, m, rng, plan=None):
    """-> credits (date, order, description, cents, group, refs, expect), debits, card batches. 'expect' is 'match' or
    'exception:<LEAK>' for a credit that a planted leak changed (answer key)."""
    end = m["end"]
    credits = []
    for r in m["remits"]:
        if r["route"] != "eft":
            continue
        pay = PAYER[r["payer"]]
        draw = rng.randrange(10**9, 10**10)  # drawn even when the credit is left out, so later descriptions stay the POS ones
        if r.get("eft_missing") or r["cents"] <= 0:
            continue
        trace = r.get("bank_trace", r["trace"])
        credits.append((r["date"], 1, eft_desc(a, pay, trace, draw), r["cents"], "insurance_eft", [trace],
                        "exception:REF_MISMATCH" if "bank_trace" in r else "match"))
    if plan:
        lr = plan.rng("BANK_UNPOSTED:bank")
        for payer, day, cents, trace in plan.extra_efts:
            credits.append((day, 1, eft_desc(a, PAYER[payer], trace, lr.randrange(10**9, 10**10)), cents, "insurance_eft", [trace], "exception:BANK_UNPOSTED"))
    card_short = plan.card_short if plan else {}
    cash_short = plan.cash_short if plan else {}
    card_by_day, atm_by_day, auto_by_day = defaultdict(list), defaultdict(list), defaultdict(list)
    for e in m["pay"]:
        (card_by_day if e["method"] == "card" else auto_by_day if e["method"] == "autodebit" else atm_by_day)[e["date"]].append(e)
    batches = []
    for day in sorted(card_by_day):
        es = card_by_day[day]
        gross = sum(e["cents"] for e in es)
        if a.prms == "chirotouch":
            bdate, fee = bank_day(day + dt.timedelta(days=a.card_lag_days)), 0
            desc = f"GB PY DES:GLOBAL DEP ID:{a.merchant_id} INDN:{a.practice_name} CO ID:N400000000 CCD"
        else:
            bdate = add_business_days(day, a.jane_payout_days) if day.weekday() < 5 else add_business_days(bank_day(day), a.jane_payout_days)
            fee = sum(e["cents"] * a.jane_fee_bps // 10000 + a.jane_fee_fixed_cents for e in es)
            desc = f"JANE APP DES:PAYOUT ID:{rng.randrange(10**9, 10**10)} INDN:{a.practice_name} CO ID:SYNJANE001 CCD"
        bid = f"B{day.strftime('%m%d')}{len(batches) + 1:03d}"
        batches.append(dict(id=bid, day=day, bank_date=bdate, n=len(es), gross=gross, fee=fee, net=gross - fee, ids=[e["id"] for e in es]))
        for e in es:
            e["batch"] = bid
        if bdate <= end:
            short = card_short.get(day, 0)
            credits.append((bdate, 2, desc, gross - fee - short, "card_processor", [bid], "exception:CARD_BATCH_SHORT" if short else "match"))
    for day in sorted(auto_by_day):
        es = auto_by_day[day]
        bdate = add_business_days(day, a.autodebit_days)
        if bdate <= end:
            desc = f"CASH PRACTICE DES:AUTODEBIT ID:{rng.randrange(10**8, 10**9)} INDN:{a.practice_name} CO ID:SYNCP00001 CCD"
            kept = [e for e in es if not e.get("returned")]
            if kept:
                credits.append((bdate, 2, desc, sum(e["cents"] for e in kept), "autodebit", [e["id"] for e in kept],
                                "exception:AUTODEBIT_RETURNED" if len(kept) < len(es) else "match"))
    seqn = 0
    for day in sorted(atm_by_day):
        es = atm_by_day[day]
        bdate = bank_day(day + dt.timedelta(days=1))
        seqn += 1
        if bdate <= end:
            desc = f"BKOFAMERICA ATM {bdate.strftime('%m/%d')} #{seqn:09d} DEPOSIT MAIN ST ANYTOWN MA CKCD 4135770000004410"
            kept = [e for e in es if not e.get("undeposited")]
            short = cash_short.get(day, 0)
            if kept:
                expect = "exception:CASH_SHORT" if short else "exception:UNDEPOSITED_CHECK" if len(kept) < len(es) else "match"
                credits.append((bdate, 3, desc, sum(e["cents"] for e in kept) - short, "branch_atm_deposit", [e["id"] for e in kept], expect))
    debits = []
    d = m["start"]
    while d <= end:
        if d.weekday() == 4 and (d.day <= 7 or 15 <= d.day <= 21):
            debits.append((d, 4, f"PAYCHEX INC. DES:PAYROLL ID:PX{rng.randrange(10**8, 10**9)} INDN:{a.legal_name} CO ID:1160000000 CCD", -rng.randrange(a.payroll * 95 // 100, a.payroll * 105 // 100)))
        if d.day == 3:
            debits.append((d, 4, f"SYN PROPERTY MGMT DES:RENT ID:{rng.randrange(10**6, 10**7)} INDN:{a.legal_name} CO ID:1000000001 WEB", -a.rent))
        d += dt.timedelta(days=1)
    return credits, debits, batches


# ---------------------------------------------------------------- 835 writer
def era_835(a, m):
    el, comp, seg = "*", ":", "~"
    def S(*f):
        return el.join(str(x) for x in f)
    pad = lambda s, n: s.ljust(n)[:n]
    eft = [r for r in m["remits"] if r["route"] == "eft"]
    first = eft[0]["date"] if eft else m["start"]
    isa = S("ISA", "00", pad("", 10), "00", pad("", 10), "ZZ", pad("SYNCLEARING", 15), "ZZ", pad(a.practice_id, 15), first.strftime("%y%m%d"), "1200", "^", "00501",
            f"{a.seed % 10**9:09d}", "0", "T", comp)
    out = [S("GS", "HP", "SYNCLEARING", a.practice_id, first.strftime("%Y%m%d"), "1200", "1", "X", "005010X221A1")]
    for r in eft:
        pay = PAYER[r["payer"]]
        st = f"{r['no']:04d}"
        body = [S("ST", "835", st),
                S("BPR", "I", x12amt(r["cents"]), "C", "ACH", "CCP", "01", "999999999", "DA", "000000000", "1" + pay[6][-9:].rjust(9, "0"), "", "01", "888888888", "DA", "000000000", r["date"].strftime("%Y%m%d")),
                S("TRN", "1", r["trace"], "1" + pay[6][-9:].rjust(9, "0")), S("DTM", "405", r["date"].strftime("%Y%m%d")),
                S("N1", "PR", pay[1], "XV", pay[6]), S("N1", "PE", a.practice_name, "XX", a.npi), S("LX", "1")]
        pats = {p["id"]: p for p in m["patients"]}
        for c in r["claims"]:
            p = pats[c["patient"]]
            body += [S("CLP", c["visit"], "4" if c["paid"] == 0 else "1", x12amt(c["charge"]), x12amt(c["paid"]), x12amt(c["pr"]), pay[7], f"PCN{c['visit'][1:]}"),
                     S("NM1", "QC", "1", p["last"].upper(), p["first"].upper(), "", "", "", "MI", f"SYN{p['id']}"),
                     S("DTM", "232", c["dos"].strftime("%Y%m%d"))]
            for i, ln in enumerate(c["lines"]):
                body += [S("SVC", comp.join(["HC", ln["cpt"]] + ln["mods"]), x12amt(ln["charge"]), x12amt(ln["paid"]), "", "1"),
                         S("DTM", "472", c["dos"].strftime("%Y%m%d"))]
                for g, carc, cents in ln["adj"]:
                    body.append(S("CAS", g, carc, x12amt(cents)))
                body += [S("REF", "6R", f"{c['visit']}-{i + 1}"), S("AMT", "B6", x12amt(ln["allowed"]))]
        body.append(S("SE", len(body) + 1, st))
        out += body
    out += [S("GE", len(eft), "1"), S("IEA", "1", f"{a.seed % 10**9:09d}")]
    assert len(isa) == 105, len(isa)
    return isa + seg + "\n" + "\n".join(s + seg for s in out) + "\n"


# ---------------------------------------------------------------- writers
def write_set(a, m, credits, debits, batches, plan=None):
    tag = f"{a.set_name}-{a.scenario.upper()}"
    pats = {p["id"]: p for p in m["patients"]}
    payer_name = lambda code: PAYER[code][1] if code else "SELF / CARE PLAN"
    method_name = {"card": "Credit Card", "cash": "Cash", "check": "Check", "autodebit": "Auto-Debit"}
    files = {}

    # bank statement (verified layout)
    bank = sorted(credits + debits, key=lambda b: (b[0], b[1], b[2]))
    opening, bal, cr, dr = a.opening_balance, a.opening_balance, 0, 0
    rows = [[mdy(m["start"]), f"Beginning balance as of {mdy0(m['start'])}", "", amt_bal(bal)]]
    bank_rows = []
    for b in bank:
        bal += b[3]
        cr += b[3] if b[3] > 0 else 0
        dr += b[3] if b[3] < 0 else 0
        rows.append([mdy(b[0]), b[2], amt_bank(b[3]), amt_bal(bal)])
        bank_rows.append((len(rows) + 7, b))  # file line: 7 preamble lines, then the beginning-balance row
    pre = [["Description", "", "Summary Amt.", ""], [f"Beginning balance as of {mdy0(m['start'])}", "", amt_bal(opening), amt_bal(opening)],
           ["Total credits", "", amt_bal(cr), amt_bal(cr)], ["Total debits", "", amt_bal(dr), amt_bal(dr)],
           [f"Ending balance as of {mdy0(m['end'])}", "", amt_bal(bal), amt_bal(bal)], ["", "", "", ""], ["Date", "Description", "Amount", "Running Bal."]]
    assert opening + cr + dr == bal
    files[f"BANK-ST-{tag}.csv"] = csv_text(pre + rows, False)
    files[f"ERA-{tag}.835"] = era_835(a, m)
    files[f"FEESCHED-{tag}.csv"] = csv_text([["Payer Code", "Payer", "CPT", "Allowed"]] + [[c, PAYER[c][1], cpt, money(x)] for c, cpt, x in m["fees"]], False)
    files[f"PI-CASES-{tag}.csv"] = csv_text([["Case ID", "Patient ID", "State", "Coverage", "Carrier", "Attorney", "LOP Date", "Billed", "Carrier Paid",
                                              "Has Health Insurance", "Status", "Settled Date", "Prior Balance", "Settlement Received", "Reduction", "Reduction Approved"]] +
                                            [[c["id"], c["patient"], c["state"], c["coverage"], payer_name(c["payer"]), c["attorney"], mdy(c["lop"]), money(c["billed"]),
                                              money(c["carrier_paid"]), "yes" if c["health_ins"] else "no", c["status"], mdy(c["settled_on"]) if c["settled_on"] else "",
                                              money(c.get("prior_balance", 0)), money(c["settled"]), money(c.get("reduction_recorded", c["reduction"])), c["approved"]] for c in m["pi"]], False)
    files[f"CAREPLANS-{tag}.csv"] = csv_text([["Plan ID", "Patient ID", "Start Date", "Visits Bought", "Price", "Payment", "Visits Used", "Collected", "Earned", "Unearned"]] +
                                             [[pl["id"], pl["patient"], mdy(pl["start"]), pl["visits_bought"], money(pl["price"]), pl["method"], pl["visits_used"],
                                               money(collected := sum(e["cents"] for e in m["pay"] if e.get("plan") == pl["id"])),
                                               money(earned := pl["price"] * pl["visits_used"] // pl["visits_bought"]), money(collected - earned)] for pl in m["plans"]], False)

    # PRMS transactions (charges, payments, adjustments), canonical columns
    tx = []
    upfront = {pl["id"] for pl in m["plans"] if pl.get("revenue_upfront")}
    for pl in m["plans"]:
        if pl["id"] in upfront:  # PREPAY_UNEARNED: the whole plan price posted as one charge at purchase
            tx.append([pl["start"], pl["patient"], pl["id"], pats[pl["patient"]]["provider"], "Charge", "PLAN", "", 1, pl["price"], "", "CARE PLAN " + pl["id"]])
    for v in m["visits"]:
        if v.get("plan") in upfront:
            continue
        for ln in v["lines"]:
            if ln["charge"]:
                tx.append([v["date"], v["patient"], v["id"], v["provider"], "Charge", ln["cpt"], "+".join(ln["mods"]), 1, ln["charge"], "", payer_name(v["payer"]) if v["payer"] else "CARE PLAN " + v.get("plan", "")])
    for r in m["remits"]:
        post = r["date"] + dt.timedelta(days=1)
        for c in r["claims"]:
            if c["paid"]:
                tx.append([post, c["patient"], c["visit"], pats[c["patient"]]["provider"], "Payment", "ERA" if r["route"] == "eft" else "Insurance Check", "", "", -c["paid"], r["trace"], payer_name(r["payer"])])
            co = defaultdict(int)
            for ln in c["lines"]:
                for g, carc, x in ln["adj"]:
                    if g == "CO":
                        co[carc] += x
            for carc in sorted(co, key=lambda k: (k != "45", k)):
                tx.append([post, c["patient"], c["visit"], pats[c["patient"]]["provider"], "Adjustment", f"CO-{carc}", "", "", -co[carc], r["trace"], payer_name(r["payer"])])
            if c.get("pr_writeoff"):  # VISIT_CAP: PR-119 written off instead of billed to the patient
                tx.append([post, c["patient"], c["visit"], pats[c["patient"]]["provider"], "Adjustment", "WO-PR-119", "", "", -c["pr_writeoff"], r["trace"], payer_name(r["payer"])])
            if c.get("posted_twice"):  # POSTED_TWICE: a manual EOB post of the same claim payment
                tx.append([post, c["patient"], c["visit"], pats[c["patient"]]["provider"], "Payment", "Manual EOB", "", "", -c["paid"], r["trace"], payer_name(r["payer"])])
    for e in m["pay"]:
        if e["kind"] in ("patient", "plan", "attorney"):
            tx.append([e["date"], e["patient"], e.get("visit") or e.get("plan") or e.get("case"), pats[e["patient"]]["provider"], "Payment",
                       method_name[e["method"]], "", "", -e["cents"], e["id"], "ATTORNEY " + e["case"] if e["kind"] == "attorney" else "PATIENT"])
    tx.sort(key=lambda t: (t[0], t[2] or "", t[4]))
    deposits = [[e["date"], e["id"], method_name[e["method"]], payer_name(e.get("payer")) if e["kind"] == "pi_check" else ("ATTORNEY" if e["kind"] == "attorney" else "PATIENT"),
                 e.get("ref") or e.get("batch") or "", e["cents"], e.get("patient") or ""] for e in m["pay"]]
    for r in m["remits"]:
        if r["route"] == "eft":
            deposits.append([r["date"] + dt.timedelta(days=1), f"E{r['no']:04d}", "EFT", payer_name(r["payer"]), r["trace"], r["cents"], ""])
        for c in r["claims"]:
            if c.get("posted_twice"):
                deposits.append([r["date"] + dt.timedelta(days=1), f"M{r['no']:04d}", "Manual EOB", payer_name(r["payer"]), r["trace"], c["paid"], ""])
    deposits.sort(key=lambda d: (d[0], d[1]))

    if a.prms == "chirotouch":
        files[f"CT-PATIENTS-{tag}.csv"] = csv_text([["Patient ID", "Last Name", "First Name", "Primary Insurance", "Payer Class", "State", "Provider"]] +
                                                   [[p["id"], p["last"], p["first"], payer_name(p["payer"]) if p["payer"] else "", p["cls"], p["state"], p["provider"]] for p in m["patients"]], False)
        files[f"CT-DAYSHEET-{tag}.csv"] = csv_text([["Date", "Patient ID", "Visit", "Provider", "Type", "Code", "Modifiers", "Units", "Amount", "Reference", "Payer"]] +
                                                   [[mdy(t[0])] + t[1:8] + [money(t[8])] + t[9:] for t in tx], False)
        files[f"CT-DEPOSITS-{tag}.csv"] = csv_text([["Date", "Payment ID", "Method", "Payer", "Reference", "Amount", "Patient ID"]] +
                                                   [[mdy(d[0]), d[1], d[2], d[3], d[4], money(d[5]), d[6]] for d in deposits], False)
        files[f"CTPAY-{tag}.csv"] = csv_text([["Batch Date", "Batch ID", "Transactions", "Gross", "Fees", "Net", "Settlement Date"]] +
                                             [[mdy(b["day"]), b["id"], b["n"], money(b["gross"]), money(b["fee"]), money(b["net"]), mdy(b["bank_date"])] for b in batches], False)
        cp = [(e["date"], e["id"], "Debit", e) for e in m["pay"] if e["method"] == "autodebit"]
        cp += [(e["returned"], e["id"], "Return", e) for e in m["pay"] if e.get("returned")]  # AUTODEBIT_RETURNED
        files[f"CASHPRAC-{tag}.csv"] = csv_text([["Date", "Patient ID", "Plan ID", "Type", "Amount", "Reference"]] +
                                                [[mdy(d), e["patient"], e["plan"], typ, money(e["cents"] if typ == "Debit" else -e["cents"]), e["id"]]
                                                 for d, _, typ, e in sorted(cp, key=lambda x: (x[0], x[1], x[2]))], False)
    else:
        files[f"JANE-PATIENTS-{tag}.csv"] = csv_text([["Patient Number", "Last Name", "First Name", "Primary Policy", "Payer Class", "State", "Practitioner"]] +
                                                     [[p["id"], p["last"], p["first"], payer_name(p["payer"]) if p["payer"] else "", p["cls"], p["state"], p["provider"]] for p in m["patients"]], False)
        files[f"JANE-TRANSACTIONS-{tag}.csv"] = csv_text([["Date", "Patient Number", "Invoice", "Practitioner", "Type", "Item", "Modifiers", "Units", "Amount", "Reference", "Payer"]] +
                                                         [[mdy(t[0])] + t[1:8] + [money(t[8])] + t[9:] for t in tx], False)
        fee_of = {}
        for b in batches:
            per = {i: 0 for i in b["ids"]}
            for e in m["pay"]:
                if e["id"] in per:
                    fee_of[e["id"]] = e["cents"] * a.jane_fee_bps // 10000 + a.jane_fee_fixed_cents
        files[f"JANE-PAYMENTS-REFUNDS-FEES-{tag}.csv"] = csv_text([["Date", "Payor name", "Payment method", "Reference number", "Invoice number", "Amount", "Processing fees", "Amount paid to the clinic"]] +
                                                                  [[mdy(d[0]), d[3], d[2], d[4], d[1], money(d[5]), money(fee_of.get(d[1], 0)), money(d[5] - fee_of.get(d[1], 0))] for d in deposits], False)
        files[f"JANEPAY-PAYOUTS-{tag}.csv"] = csv_text([["Date Created", "Date Deposited", "Payout Amount", "Payout Status"]] +
                                                       [[mdy(b["day"]), mdy(b["bank_date"]), money(b["net"]), "paid" if b["bank_date"] <= m["end"] else "in_transit"] for b in batches], False)

    os.makedirs(os.path.join(a.out, "_answer-key"), exist_ok=True)
    for name, text in files.items():
        with open(os.path.join(a.out, name), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)

    matches = [dict(bank_line=line, date=b[0].isoformat(), cents=b[3], group=b[4], refs=";".join(b[5]), expect=b[6]) for line, b in bank_rows if b[3] > 0]
    with open(os.path.join(a.out, "_answer-key", "expected-matches.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, lineterminator="\r\n")
        w.writerow(["bank_line", "date", "amount", "group", "refs", "expect"])
        for x in matches:
            w.writerow([x["bank_line"], x["date"], money(x["cents"]), x["group"], x["refs"], x["expect"]])
    by_group = defaultdict(int)
    for x in matches:
        by_group[x["group"]] += x["cents"]
    unearned = sum(sum(e["cents"] for e in m["pay"] if e.get("plan") == pl["id"]) - pl["price"] * pl["visits_used"] // pl["visits_bought"] for pl in m["plans"])
    truth = dict(generator="gen_chiro_set.py", prms=a.prms, scenario=a.scenario, set=a.set_name, seed=a.seed,
                 flags={k: v for k, v in vars(a).items() if k != "out"},
                 counts=dict(patients=len(m["patients"]), visits=len(m["visits"]), claims=len(m["claims"]), remittances_eft=sum(1 for r in m["remits"] if r["route"] == "eft"),
                             remittances_check=sum(1 for r in m["remits"] if r["route"] == "check"), claims_unpaid_at_end=sum(1 for c in m["claims"] if not c["paid_on"]),
                             claims_over_pip_cap=sum(1 for c in m["claims"] if c.get("over_pip_cap")),
                             card_batches=len(batches), plans=len(m["plans"]), pi_cases=len(m["pi"]), bank_credits=len(matches)),
                 patients_by_class={c: sum(1 for p in m["patients"] if p["cls"] == c) for c in ("commercial", "medicare", "medicaid", "pi", "prepay")},
                 bank_credits_by_group={g: money(c) for g, c in sorted(by_group.items())},
                 unearned_plan_revenue=money(unearned),
                 expected_exceptions=plan.exceptions if plan else [],
                 not_applicable=plan.not_applicable if plan else [],
                 unmatched_bank_credits=sum(1 for x in matches if x["expect"] != "match"),
                 unmatched_prms_rows=sorted(plan.unmatched_prms) if plan else [],
                 watch_items=[dict(code="PI_STALE", severity="watch", group="pi_case", date=c["lop"].isoformat(), refs=[c["id"]],
                                   detail=f"open PI case, letter of protection older than {a.pi_stale_days} days at period end")
                              for c in m["pi"] if c["status"] == "open" and (m["end"] - c["lop"]).days > a.pi_stale_days],
                 leak_seed=a.leak_seed, files=sorted(files))
    with open(os.path.join(a.out, "_answer-key", "truth.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(truth, fh, indent=2, sort_keys=False, default=str)
        fh.write("\n")
    return truth


def main(argv=None):
    ap = argparse.ArgumentParser(description="Synthetic chiropractic data set (ChiroTouch or Jane + ERA 835 + BofA) with an answer key.")
    ap.add_argument("--prms", choices=["chirotouch", "jane"], required=True)
    ap.add_argument("--out", required=True, help="output folder, e.g. sample-data/prms/chiro-1-chirotouch/SET-1/POS")
    ap.add_argument("--set-name", default="SET1", help="tag in file names (default SET1)")
    ap.add_argument("--scenario", default="pos", choices=SCENARIOS, help="pos, neg-all (every leak, on separate items) or neg-<leak>")
    ap.add_argument("--leak-seed", type=int, default=1, help="seed of the leak streams (NEG only; the base set always uses --seed)")
    ap.add_argument("--short-max-cents", type=int, default=5000, help="CARD_BATCH_SHORT / CASH_SHORT: largest shortfall in cents (default 5000)")
    ap.add_argument("--unposted-min-cents", type=int, default=10000, help="BANK_UNPOSTED: smallest extra EFT in cents (default 10000)")
    ap.add_argument("--unposted-max-cents", type=int, default=90000, help="BANK_UNPOSTED: largest extra EFT in cents (default 90000)")
    ap.add_argument("--underpay-pct", type=int, default=12, help="CONTRACT_UNDERPAY: %% below the fee schedule (default 12)")
    ap.add_argument("--at-missing-cas", default="CO-50", help="MCR_AT_MISSING: CAS group-CARC of the denial, ASSUMPTION (default CO-50)")
    ap.add_argument("--gz-cas", default="CO-50", help="MAINT_NO_ABN: CAS group-CARC of the GZ denial, ASSUMPTION (default CO-50)")
    ap.add_argument("--return-days", type=int, default=2, help="AUTODEBIT_RETURNED: business days from debit to return (default 2)")
    ap.add_argument("--pi-stale-days", type=int, default=180, help="PI_STALE watch item: open case with LOP older than this at period end (default 180)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--start", default="2024-09-01")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--providers", type=int, default=3)
    ap.add_argument("--patients", type=int, default=150, help="patients seen in the period, ASSUMPTION sized for 3 DCs (default 150)")
    ap.add_argument("--min-visits", type=int, default=2)
    ap.add_argument("--max-visits", type=int, default=8)
    for k, v in (("commercial", 45), ("medicare", 20), ("medicaid", 5), ("pi", 15), ("prepay", 15)):
        ap.add_argument(f"--{k}-share", type=int, default=v, help=f"payer-class weight (default {v})")
    ap.add_argument("--adjudication-days", type=int, default=7, help="minimum days from visit to payment (default 7)")
    ap.add_argument("--era-weekday", type=int, default=4, help="weekday of the weekly payer payment run, 0=Mon (default 4=Fri)")
    ap.add_argument("--card-lag-days", type=int, default=1, help="CT Payments: days from batch to bank credit (default 1)")
    ap.add_argument("--jane-payout-days", type=int, default=2, help="Jane Payments: business days to the payout deposit (default 2)")
    ap.add_argument("--jane-fee-bps", type=int, default=275, help="Jane Payments fee in basis points, ASSUMPTION (default 275)")
    ap.add_argument("--jane-fee-fixed-cents", type=int, default=30, help="Jane Payments fixed fee per payment, ASSUMPTION (default 30)")
    ap.add_argument("--autodebit-share", type=int, default=50, help="ChiroTouch: %% of care plans (rounded up, at least 1) paid by Cash Practice auto-debit (default 50)")
    ap.add_argument("--autodebit-days", type=int, default=2, help="Cash Practice: business days from debit to bank credit, ASSUMPTION (default 2)")
    ap.add_argument("--plan-visits", type=int, default=12)
    ap.add_argument("--plan-price", type=int, default=48000, help="care plan price in cents (default 48000 = 480.00)")
    ap.add_argument("--plan-months", type=int, default=3, help="auto-debit installments per plan (default 3)")
    ap.add_argument("--pip-health-cap-cents", type=int, default=200000, help="MA PIP medical cap with health insurance (default 200000 = 2,000.00; mass.gov jury instr. 8.00)")
    ap.add_argument("--pi-settled", type=int, default=1, help="PI cases settled by attorney check in the period (default 1)")
    ap.add_argument("--opening-balance", type=int, default=4000000, help="cents (default 40,000.00)")
    ap.add_argument("--payroll", type=int, default=1200000, help="cents per semi-monthly payroll run, ASSUMPTION (default 12,000.00)")
    ap.add_argument("--rent", type=int, default=650000, help="cents (default 6,500.00)")
    ap.add_argument("--practice-name", default="SAMPLE CHIRO")
    ap.add_argument("--legal-name", default="SAMPLE CHIRO PC")
    ap.add_argument("--practice-id", default="SAMPLECHIRO")
    ap.add_argument("--npi", default="1234567893")
    ap.add_argument("--merchant-id", default="8788000000001")
    a = ap.parse_args(argv)
    if not 0 < a.underpay_pct < 100 or a.short_max_cents < 102 or not 0 < a.unposted_min_cents <= a.unposted_max_cents:
        ap.error("--underpay-pct must be 1-99, --short-max-cents >= 102, 0 < --unposted-min-cents <= --unposted-max-cents")
    if a.plan_visits <= 0 or a.plan_months <= 0 or a.min_visits < 1 or a.max_visits < a.min_visits:
        ap.error("--plan-visits, --plan-months and --min-visits must be >= 1, and --max-visits >= --min-visits")
    leaks, not_applicable = scenario_leaks(a.scenario, a.prms)
    plan = LeakPlan(a, leaks, not_applicable) if leaks else None
    m = build(a, plan)
    credits, debits, batches = deposits_and_bank(a, m, random.Random(a.seed * 7919 + 1), plan)
    t = write_set(a, m, credits, debits, batches, plan)
    print(f"gen_chiro_set: {a.prms} {a.set_name}-{a.scenario.upper()} -> {a.out}")
    print(json.dumps(t["counts"]))
    print(json.dumps(t["bank_credits_by_group"]))
    if plan:
        print(f"planted {len(t['expected_exceptions'])} leak(s): {', '.join(x['code'] for x in t['expected_exceptions'])}"
              + (f"; not applicable to {a.prms}: {', '.join(not_applicable)}" if not_applicable else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

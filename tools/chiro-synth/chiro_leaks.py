"""
Leak planting for gen_chiro_set.py (privateAI-design-30 §4, §10 #10): 16 leak types, scenario 'neg-<leak>' or 'neg-all'.

Rules (same as tools/dental-synth):
  * The base set is built first with --seed; every leak draws from its OWN random stream, seeded by (--seed, --leak-seed,
    leak code), so the business events outside a leak are the POS events and a leak never shifts another leak's pick.
  * neg-all plants every leak on a different claim / remittance / payment / day, so each finding has one cause.
  * Picks use only events that exist in BOTH PRMS layouts (the canonical model), so the same --seed and --leak-seed give the
    same findings for ChiroTouch and Jane. AUTODEBIT_RETURNED needs Cash Practice and exists for ChiroTouch only: on Jane it
    is refused by name and left out of neg-all (truth.json 'not_applicable').

Two stages, because some leaks change the ERA (and so every downstream total) and others only change what reached the bank:
  apply_claims(...)  before patient payments and remittances are built: MCR_AT_MISSING, MAINT_NO_ABN, PR_NOT_TRANSFERRED,
                     VISIT_CAP, BUNDLED_97140, CONTRACT_UNDERPAY
  apply_model(m)     after the canonical model is complete: UNDEPOSITED_CHECK, EFT_MISSING, BANK_UNPOSTED, CARD_BATCH_SHORT,
                     CASH_SHORT, POSTED_TWICE, REF_MISMATCH, PI_REDUCTION, PREPAY_UNEARNED, AUTODEBIT_RETURNED

Each expected exception: code, severity, group, date (ISO), cents, refs (ERA trace / visit / payment / case / plan IDs), payer,
detail. 'group' is the bank group for money that did (not) reach the bank, or 'remittance' / 'pi_case' / 'prepay_plan'.
"""
import datetime as dt
import random

LEAKS = ["UNDEPOSITED_CHECK", "EFT_MISSING", "BANK_UNPOSTED", "CARD_BATCH_SHORT", "CASH_SHORT", "POSTED_TWICE", "REF_MISMATCH",
         "MCR_AT_MISSING", "MAINT_NO_ABN", "PR_NOT_TRANSFERRED", "VISIT_CAP", "BUNDLED_97140", "CONTRACT_UNDERPAY",
         "PI_REDUCTION", "PREPAY_UNEARNED", "AUTODEBIT_RETURNED"]
CHIROTOUCH_ONLY = {"AUTODEBIT_RETURNED"}
CLAIM_LEAKS = ("MCR_AT_MISSING", "MAINT_NO_ABN", "PR_NOT_TRANSFERRED", "VISIT_CAP", "BUNDLED_97140", "CONTRACT_UNDERPAY")
SCENARIOS = ["pos", "neg-all"] + ["neg-" + c.lower().replace("_", "-") for c in LEAKS]


def scenario_leaks(scenario, prms):
    """-> (leaks to plant, leaks not applicable to this PRMS). Raises SystemExit for a leak the PRMS cannot have."""
    if scenario == "pos":
        return [], []
    if scenario == "neg-all":
        return [c for c in LEAKS if prms == "chirotouch" or c not in CHIROTOUCH_ONLY], [c for c in LEAKS if prms != "chirotouch" and c in CHIROTOUCH_ONLY]
    code = scenario[4:].upper().replace("-", "_")
    if code not in LEAKS:
        raise SystemExit(f"gen_chiro_set: unknown scenario {scenario} (choose from {', '.join(SCENARIOS)})")
    if code in CHIROTOUCH_ONLY and prms != "chirotouch":
        raise SystemExit(f"gen_chiro_set: {scenario} needs Cash Practice auto-debit, which only the ChiroTouch layout has")
    return [code], []


def cas_flag(text):
    g, _, carc = text.partition("-")
    if g not in ("CO", "PR", "OA", "PI") or not carc:
        raise SystemExit(f"gen_chiro_set: a CAS flag is GROUP-CARC, e.g. CO-50 (got {text!r})")
    return g, carc


class LeakPlan:
    def __init__(self, a, leaks, not_applicable):
        self.a, self.leaks, self.not_applicable = a, leaks, not_applicable
        self.exceptions = []
        self.used_claims, self.used_remits, self.used_days_atm, self.used_days_card, self.used_pay = set(), set(), set(), set(), set()
        self.card_short, self.cash_short = {}, {}      # posting day -> cents short in the bank credit
        self.extra_efts = []                           # BANK_UNPOSTED: (payer code, date, cents, trace)
        self.unmatched_prms = []                       # PRMS deposit/payment rows with no bank credit

    def rng(self, code):
        return random.Random(f"chiro-leak:{self.a.seed}:{self.a.leak_seed}:{code}")

    def exc(self, code, group, date, cents, refs, payer=None, severity="exception", detail=""):
        assert cents > 0, (code, cents)
        self.exceptions.append(dict(code=code, severity=severity, group=group, date=date.isoformat(), cents=int(cents),
                                    refs=list(refs), payer=payer, detail=detail))

    @staticmethod
    def pick(r, xs, code):
        if not xs:
            raise SystemExit(f"gen_chiro_set: cannot plant {code}: no candidate left in this set (try another --seed, --leak-seed or a longer --days)")
        return r.choice(xs)

    @staticmethod
    def recalc(c):
        c["charge"] = sum(l["charge"] for l in c["lines"])
        c["paid"] = sum(l["paid"] for l in c["lines"])
        c["pr"] = sum(l["pr"] for l in c["lines"])

    # ------------------------------------------------------------ stage 1: claims (before payments and remittances)
    def apply_claims(self, claims, visits, payers, in_period, allowed):
        """claims: canonical claims with lines; visits: id -> visit; payers: code -> PAYERS row; in_period(claim) -> payment
        date when the claim is paid by EFT inside the period, else None; allowed: (payer, cpt) -> contracted cents."""
        a = self.a
        vis = lambda c: visits[c["visit"]]
        for code in [c for c in self.leaks if c in CLAIM_LEAKS]:
            r = self.rng(code)
            free = [c for c in claims if c["visit"] not in self.used_claims and in_period(c)]
            if code in ("MCR_AT_MISSING", "MAINT_NO_ABN"):
                c = self.pick(r, [c for c in free if payers[c["payer"]][2] == "medicare"], code)
                ln, vl = c["lines"][0], vis(c)["lines"][0]
                lost = ln["allowed"]
                g, carc = cas_flag(a.at_missing_cas if code == "MCR_AT_MISSING" else a.gz_cas)
                mods = [] if code == "MCR_AT_MISSING" else ["GZ"]
                ln.update(mods=mods, allowed=0, paid=0, pr=0, adj=[(g, carc, ln["charge"])])
                vl["mods"] = list(mods)
                self.recalc(c)
                detail = (f"Medicare CMT {ln['cpt']} billed without AT, denied {g}-{carc} and written off instead of corrected and rebilled with AT; "
                          f"lost = Medicare allowed (payer 80% + patient 20%)" if code == "MCR_AT_MISSING" else
                          f"maintenance CMT {ln['cpt']} billed GZ (no ABN on file): denied {g}-{carc}, provider liable, written off; "
                          f"lost = Medicare allowed, which the patient would owe with a signed ABN (GA)")
                self.exc(code, "remittance", in_period(c), lost, [c["visit"]], payer=c["payer"], detail=detail)
            elif code == "PR_NOT_TRANSFERRED":
                c = self.pick(r, [c for c in free if c["pr"] > 0], code)
                c["pr_not_transferred"] = True
                self.exc(code, "remittance", in_period(c), c["pr"], [c["visit"]], payer=c["payer"],
                         detail="ERA patient responsibility (PR) never moved to the patient: no patient charge or payment for the visit")
            elif code == "VISIT_CAP":
                c = self.pick(r, [c for c in free if payers[c["payer"]][2] == "commercial"], code)
                ln = c["lines"][0]
                al = ln["allowed"]
                ln.update(paid=0, pr=al, adj=([("CO", "45", ln["charge"] - al)] if ln["charge"] - al else []) + [("PR", "119", al)])
                self.recalc(c)
                c["pr_writeoff"] = al
                self.exc(code, "remittance", in_period(c), al, [c["visit"]], payer=c["payer"],
                         detail=f"CARC 119 (benefit maximum reached) on {ln['cpt']}: patient responsibility written off (WO-PR-119) instead of billed to the patient")
            elif code == "BUNDLED_97140":
                c = self.pick(r, [c for c in free if payers[c["payer"]][2] == "commercial" and any(l["cpt"] == "97140" for l in c["lines"])], code)
                i = next(i for i, l in enumerate(c["lines"]) if l["cpt"] == "97140")
                ln, vl = c["lines"][i], vis(c)["lines"][i]
                lost = ln["paid"]
                ln.update(mods=[], allowed=0, paid=0, pr=0, adj=[("CO", "97", ln["charge"])])
                vl["mods"] = []
                self.recalc(c)
                self.exc(code, "remittance", in_period(c), lost, [c["visit"]], payer=c["payer"],
                         detail="97140 billed with the CMT without modifier 59: bundled CO-97 and written off; lost = contracted payment")
            elif code == "CONTRACT_UNDERPAY":
                c = self.pick(r, [c for c in free if payers[c["payer"]][2] == "commercial"], code)
                ln = c["lines"][0]
                contracted = allowed[(c["payer"], ln["cpt"])]
                short = contracted * a.underpay_pct // 100
                al = contracted - short
                copay = payers[c["payer"]][8]
                pr = min(copay, al)
                ln.update(allowed=al, pr=pr, paid=al - pr, adj=[("CO", "45", ln["charge"] - al)] + ([("PR", "3", pr)] if pr else []))
                self.recalc(c)
                self.exc(code, "remittance", in_period(c), short, [c["visit"]], payer=c["payer"],
                         detail=f"{ln['cpt']} allowed {al} cents vs fee schedule {contracted} ({a.underpay_pct}% under contract), posted as paid without appeal")
            self.used_claims.add(c["visit"])

    # ------------------------------------------------------------ stage 2: model (after ids are assigned)
    def apply_model(self, m, payers, add_business_days):
        a = self.a
        leaked_remit = {r["no"] for r in m["remits"] if any(c["visit"] in self.used_claims for c in r["claims"])}
        eft = [r for r in m["remits"] if r["route"] == "eft" and r["no"] not in leaked_remit]
        atm_days = {}
        for e in m["pay"]:
            if e["method"] in ("cash", "check"):
                atm_days.setdefault(e["date"], []).append(e)
        plan_amounts = {a.plan_price, a.plan_price // a.plan_months}

        def short_amount(r, singles, cap):
            for _ in range(2000):
                x = r.randrange(101, cap + 1) if cap > 101 else 0
                if x and x not in singles and x not in plan_amounts:
                    return x
            raise SystemExit("gen_chiro_set: cannot pick a short amount that differs from every single payment of the day (raise --short-max-cents)")

        for code in [c for c in self.leaks if c not in CLAIM_LEAKS]:
            r = self.rng(code)
            if code == "UNDEPOSITED_CHECK":
                e = self.pick(r, [e for e in m["pay"] if e["method"] == "check" and e["date"] not in self.used_days_atm], code)
                e["undeposited"] = True
                self.used_days_atm.add(e["date"]); self.used_pay.add(e["id"]); self.unmatched_prms.append(e["id"])
                self.exc(code, "branch_atm_deposit", e["date"], e["cents"], [e["id"]], payer=e.get("payer"),
                         detail=f"{e['kind']} check posted in the PRMS, left out of the next ATM deposit")
            elif code in ("EFT_MISSING", "REF_MISMATCH", "POSTED_TWICE"):
                rm = self.pick(r, [x for x in eft if x["no"] not in self.used_remits], code)
                self.used_remits.add(rm["no"])
                if code == "EFT_MISSING":
                    rm["eft_missing"] = True
                    self.unmatched_prms.append(f"E{rm['no']:04d}")
                    self.exc(code, "insurance_eft", rm["date"], rm["cents"], [rm["trace"]], payer=rm["payer"],
                             detail="835 payment posted in the PRMS, no EFT credit in the bank")
                elif code == "REF_MISMATCH":
                    new = rm["trace"]
                    while new == rm["trace"]:
                        new = rm["trace"][:-4] + f"{r.randrange(10000):04d}"
                    rm["bank_trace"] = new
                    self.exc(code, "insurance_eft", rm["date"], rm["cents"], [rm["trace"], new], payer=rm["payer"],
                             detail=f"ERA TRN {rm['trace']} vs bank TRN {new}: same payer and amount, reference differs")
                else:
                    c = self.pick(r, [c for c in rm["claims"] if c["paid"] > 0], code)
                    c["posted_twice"] = rm["no"]
                    self.unmatched_prms.append(f"M{rm['no']:04d}")
                    self.exc(code, "insurance_eft", rm["date"] + dt.timedelta(days=1), c["paid"], [c["visit"], rm["trace"]], payer=rm["payer"],
                             detail="ERA auto-post plus a manual EOB post of the same claim payment; one EFT in the bank")
            elif code == "BANK_UNPOSTED":
                payer = self.pick(r, sorted({x["payer"] for x in m["remits"] if x["route"] == "eft"}), code)
                taken = {x["date"] for x in m["remits"] if x["payer"] == payer}
                days = [m["start"] + dt.timedelta(days=i) for i in range((m["end"] - m["start"]).days + 1)]
                day = self.pick(r, [d for d in days if d.weekday() < 5 and d not in taken], code)
                sums = {x["cents"] for x in m["remits"]}
                cents = 0
                while not cents or cents in sums:
                    cents = r.randrange(a.unposted_min_cents, a.unposted_max_cents + 1)
                trace = f"{r.randrange(10**14, 10**15)}"
                self.extra_efts.append((payer, day, cents, trace))
                self.exc(code, "insurance_eft", day, cents, [trace], payer=payer, detail="EFT credit in the bank with no 835 posted in the PRMS")
            elif code == "CARD_BATCH_SHORT":
                days = {}
                for e in m["pay"]:
                    if e["method"] == "card" and e["kind"] == "patient":
                        days.setdefault(e["date"], []).append(e)
                cands = sorted(d for d, es in days.items() if d not in self.used_days_card and sum(e["cents"] for e in es) > 202)
                day = self.pick(r, cands, code)
                es = days[day]
                cents = short_amount(r, {e["cents"] for e in es}, min(a.short_max_cents, sum(e["cents"] for e in es) - 1))
                self.card_short[day] = cents
                self.used_days_card.add(day)
                self.exc(code, "card_processor", day, cents, [], detail="card settlement credit lower than the processor batch / payout for the day")
            elif code == "CASH_SHORT":
                cands = sorted(d for d, es in atm_days.items() if d not in self.used_days_atm and sum(e["cents"] for e in es if e["method"] == "cash") > 202)
                day = self.pick(r, cands, code)
                cash = sum(e["cents"] for e in atm_days[day] if e["method"] == "cash")
                cents = short_amount(r, {e["cents"] for e in atm_days[day]}, min(a.short_max_cents, cash - 1))
                self.cash_short[day] = cents
                self.used_days_atm.add(day)
                self.exc(code, "branch_atm_deposit", day, cents, [], detail="ATM deposit short of the day's cash posted in the PRMS")
            elif code == "PI_REDUCTION":
                case = self.pick(r, [c for c in m["pi"] if c["status"] == "settled"], code)
                case["reduction_recorded"], case["approved"] = 0, ""
                self.exc(code, "pi_case", case["settled_on"], case["reduction"], [case["id"]], payer=case["payer"],
                         detail="lien settled below the balance with no recorded, approved reduction")
            elif code == "PREPAY_UNEARNED":
                k = 0 if a.autodebit_share <= 0 else max(1, -(-len(m["plans"]) * a.autodebit_share // 100))
                pl = self.pick(r, [p for p in m["plans"][k:] if p["visits_used"] < p["visits_bought"]], code)
                pl["revenue_upfront"] = True
                unearned = pl["price"] - pl["price"] * pl["visits_used"] // pl["visits_bought"]
                self.exc(code, "prepay_plan", pl["start"], unearned, [pl["id"]],
                         detail="care-plan price posted as one charge (revenue) at purchase instead of per visit; unused visits are owed if refunded")
            elif code == "AUTODEBIT_RETURNED":
                cands = [e for e in m["pay"] if e["method"] == "autodebit" and add_business_days(e["date"], a.autodebit_days) <= m["end"]]
                e = self.pick(r, cands, code)
                e["returned"] = add_business_days(e["date"], a.return_days)
                self.used_pay.add(e["id"]); self.unmatched_prms.append(e["id"])
                self.exc(code, "autodebit", e["date"], e["cents"], [e["id"]],
                         detail="Cash Practice auto-debit returned; the return was not imported into ChiroTouch and no credit reached the bank")
        order = {c: i for i, c in enumerate(LEAKS)}
        self.exceptions.sort(key=lambda x: order[x["code"]])

#!/usr/bin/env python3
"""
compare_port.py (Phase 4b-2): proves the TypeScript port (services/analyst/scripts/make-dental-fixtures.ts) writes what
gen_dental_set.py writes. For every seed x leak seed x scenario x flag variant it runs both generators into separate
folders and checks:
  * every CSV byte-for-byte (BOM, CRLF and quoting included),
  * _answer-key/truth.json equal as parsed JSON with flags.out removed (it records the output folder; Python and JSON.stringify
    also format floats differently, e.g. 120000.0 vs 120000, which parsing makes equal),
  * the same exit code, stdout summary and error message when a generator refuses the flags.
Prints one line per case and a total; exit 0 only when every case matches.

  python tools/dental-synth/compare_port.py [--seeds 1-10] [--leak-seeds 1-3] [--scenarios all|pos,neg-all,...]
      [--variants all|base,...] [--node node] [--jobs 4] [--keep DIR] [--stop-on-first]
  python tools/dental-synth/compare_port.py --write-golden services/analyst/test/golden/dental-port.golden.json
      writes Python's reference outputs (random streams, str(float), Decimal operations, csv rows, and the SHA-256 of every
      CSV plus truth.json of three reference sets) so services/analyst/test/dental-synth-port.test.ts proves the port with
      no Python installed. Re-run it only when gen_dental_set.py changes.
"""
import argparse
import concurrent.futures as cf
import hashlib
import random
import struct
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PY_GEN = os.path.join(HERE, "gen_dental_set.py")
TS_GEN = os.path.join(REPO, "services", "analyst", "scripts", "make-dental-fixtures.ts")
SCENARIOS = ["pos", "neg-all", "neg-undeposited-check", "neg-eft-missing", "neg-card-batch-short", "neg-cash-short",
             "neg-ref-mismatch", "neg-posted-twice", "neg-bank-unposted", "neg-hfd-lag"]
VARIANTS = {
    "base": [],
    "daily-net": ["--card-fee-mode", "daily-net"],
    "first-last": ["--patient-name-format", "first_last"],
    "long-oct": ["--start", "2025-10-01", "--days", "45", "--bank-tail-days", "14"],
    "shares": ["--self-pay-share", "0.4", "--cash-share", "0.3", "--zero-invoice-share", "0.15", "--card-fee-pct", "3.15"],
    "lags": ["--card-lag-days", "2", "--claim-lag-days", "7", "--hfd-lag-extra-days", "9", "--short-max", "20"],
    "small": ["--patients", "60", "--providers", "2", "--min-invoices-day", "2", "--max-invoices-day", "4", "--first-id", "7"],
    "money": ["--opening-balance", "9876.54", "--rent", "4321.05", "--payroll", "15000.5", "--set-name", "SETX"],
}


def span(s):
    out = []
    for part in s.split(","):
        a, _, b = part.partition("-")
        out += list(range(int(a), int(b or a) + 1))
    return out


def run(cmd, out):
    p = subprocess.run(cmd + ["--out", out], capture_output=True, text=True)
    return p.returncode, p.stdout.replace("\r\n", "\n"), p.stderr.strip().splitlines()[-1:] if p.stderr.strip() else []


def compare(case, args, root):
    name, flags = case
    py, ts = os.path.join(root, name, "py"), os.path.join(root, name, "ts")
    rp = run([sys.executable, PY_GEN] + flags, py)
    rt = run([args.node, TS_GEN] + flags, ts)
    if rp[0] != rt[0]:
        return name, f"exit {rp[0]} vs {rt[0]}: {rp[2]} | {rt[2]}"
    if rp[0] != 0:
        return name, None if rp[2] == rt[2] else f"error message: {rp[2]} vs {rt[2]}"
    if json.loads(rp[1]) != json.loads(rt[1]):
        return name, "stdout summary differs"
    files = sorted(os.path.relpath(os.path.join(d, f), py) for d, _, fs in os.walk(py) for f in fs)
    tfiles = sorted(os.path.relpath(os.path.join(d, f), ts) for d, _, fs in os.walk(ts) for f in fs)
    if files != tfiles:
        return name, f"file lists differ: {files} vs {tfiles}"
    for rel in files:
        a, b = open(os.path.join(py, rel), "rb").read(), open(os.path.join(ts, rel), "rb").read()
        if rel.endswith("truth.json"):
            ja, jb = json.loads(a), json.loads(b)
            ja["flags"].pop("out"); jb["flags"].pop("out")
            if ja != jb:
                keys = [k for k in ja if ja.get(k) != jb.get(k)]
                return name, f"{rel}: JSON differs in {keys}"
        elif a != b:
            i = next(i for i in range(min(len(a), len(b)) + 1) if i >= min(len(a), len(b)) or a[i] != b[i])
            line = a[:i].count(b"\n") + 1
            return name, f"{rel}: first difference at byte {i} (line {line}); sizes {len(a)} vs {len(b)}"
    if not args.keep:
        shutil.rmtree(os.path.join(root, name), ignore_errors=True)
    return name, None


GOLDEN_SETS = [["--scenario", "pos", "--seed", "1"], ["--scenario", "neg-all", "--seed", "1", "--leak-seed", "1"],
               ["--scenario", "neg-all", "--seed", "4", "--leak-seed", "3", "--card-fee-mode", "daily-net", "--patient-name-format", "first_last"]]


def write_golden(path):
    from decimal import Decimal, ROUND_HALF_UP, ROUND_HALF_EVEN
    import csv as _csv, io
    fb = lambda x: struct.pack(">d", x).hex()
    g = {"python": sys.version.split()[0], "rng": [], "floats": [], "dec": [], "csv": [], "sets": []}
    seeds = [0, 1, 7, 2**32, 2**64 + 5, -17] + [s * 1000003 + l for s in (1, 2, 10) for l in (1, 3)]
    for s in seeds:
        r = random.Random(s); seq = []
        for i in range(180):
            op = i % 9
            if op == 0: seq.append(["random", fb(r.random())])
            elif op == 1: seq.append(["randrange2", 10**12, 10**13, r.randrange(10**12, 10**13)])
            elif op == 2: seq.append(["randint", 6, 12, r.randint(6, 12)])
            elif op == 3: seq.append(["choice", 1 + i % 13, r.choice(range(1 + i % 13))])
            elif op == 4: seq.append(["uniform", 0.45, 0.75, fb(r.uniform(0.45, 0.75))])
            elif op == 5: seq.append(["choices", [28, 7, 7, 7, 6, 6, 7, 6, 5, 4], r.choices(range(10), [28, 7, 7, 7, 6, 6, 7, 6, 5, 4])[0]])
            elif op == 6: x = list(range(i % 17)); r.shuffle(x); seq.append(["shuffle", i % 17, x])
            elif op == 7: seq.append(["randrange1", 37, r.randrange(37)])
            else: k = 1 + i % 70; seq.append(["getrandbits", k, str(r.getrandbits(k))])
        g["rng"].append([str(s), seq])
    r = random.Random(20261101)
    xs = [0.0, -0.0, 1e16, 1e15, 9999999999999998.0, 1e-4, 1e-5, 5e-324, 1.7976931348623157e308, 2.9, 0.1 + 0.2, 100.0, 120000.0]
    for i in range(1500):
        k = i % 3
        xs.append(r.uniform(-5000, 5000) if k == 0 else r.random() * 10 ** r.randint(-12, 22) if k == 1
                  else struct.unpack(">d", struct.pack(">Q", r.getrandbits(64)))[0])
    g["floats"] = [[fb(x), str(x)] for x in xs if x == x and abs(x) != float("inf")]
    vals = [Decimal(str(round(r.uniform(-3000, 3000), r.choice([0, 1, 2, 3, 5])))) for _ in range(300)] + [Decimal("0.00"), Decimal("-0.00"), Decimal("0"), Decimal("1E+2"), Decimal("0.0000001")]
    for i in range(1200):
        a, b = r.choice(vals), r.choice(vals); op = i % 8
        if op == 0: g["dec"].append(["add", str(a), str(b), str(a + b)])
        elif op == 1: g["dec"].append(["sub", str(a), str(b), str(a - b)])
        elif op == 2: g["dec"].append(["mul", str(a), str(b), str(a * b)])
        elif op == 3: g["dec"].append(["neg", str(a), str(-a)])
        elif op == 4:
            e, rd = r.choice([-2, 0, -1]), r.choice(["ROUND_HALF_UP", "ROUND_HALF_EVEN"])
            g["dec"].append(["quantize", str(a), e, rd, str(a.quantize(Decimal(1).scaleb(e), {"ROUND_HALF_UP": ROUND_HALF_UP, "ROUND_HALF_EVEN": ROUND_HALF_EVEN}[rd]))])
        elif op == 5: g["dec"].append(["format", str(a), f"{a:.2f}", f"{a:,.2f}"])
        elif op == 6: g["dec"].append(["cmp", str(a), str(b), (a > b) - (a < b), int(a)])
        else: g["dec"].append(["fromfloat", fb(float(a) * 0.731), str(Decimal(str(float(a) * 0.731)).quantize(Decimal("0.01"), ROUND_HALF_UP))])
    for pct in ("2.9", "3.0", "2.75", "1.99", "3.15"):
        g["dec"].append(["div", pct, "100", str(Decimal(pct) / 100)])
    F = ["", "a", "a,b", 'say "hi"', "line\nx", "cr\rx", " lead", "trail ", "\u65e5\u672c", '"', ",", "Invoice #12, Credit Adjustment"]
    for i in range(400):
        row = [r.choice(F) for _ in range(r.randint(0, 5))]
        buf = io.StringIO(); _csv.writer(buf, lineterminator="\r\n").writerow(row)
        g["csv"].append([row, buf.getvalue()])
    with tempfile.TemporaryDirectory() as tmp:
        for i, flags in enumerate(GOLDEN_SETS):
            out = os.path.join(tmp, str(i))
            subprocess.run([sys.executable, PY_GEN] + flags + ["--out", out], check=True, capture_output=True)
            files = {}
            for d, _, fs in os.walk(out):
                for f in fs:
                    rel = os.path.relpath(os.path.join(d, f), out).replace(os.sep, "/")
                    if not rel.endswith(".json"):
                        files[rel] = hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest()
            truth = json.load(open(os.path.join(out, "_answer-key", "truth.json"), encoding="utf-8"))
            truth["flags"].pop("out")
            g["sets"].append({"flags": flags, "sha256": dict(sorted(files.items())), "truth": truth})
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(g, fh, ensure_ascii=True, separators=(",", ":"))
        fh.write("\n")
    print(f"wrote {path}: {len(g['rng'])} rng seeds, {len(g['floats'])} floats, {len(g['dec'])} decimal ops, {len(g['csv'])} csv rows, {len(g['sets'])} sets")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seeds", default="1-10")
    ap.add_argument("--leak-seeds", default="1-3", help="leak seeds for NEG scenarios (POS ignores the leak stream and runs once)")
    ap.add_argument("--scenarios", default="all")
    ap.add_argument("--variants", default="all")
    ap.add_argument("--node", default="node")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--keep", default=None, help="keep both outputs under this folder (default: a temp folder, removed)")
    ap.add_argument("--stop-on-first", action="store_true")
    ap.add_argument("--write-golden", metavar="PATH", help="write Python's reference outputs for the in-suite test and exit")
    args = ap.parse_args()
    if args.write_golden:
        write_golden(args.write_golden)
        return
    scen = SCENARIOS if args.scenarios == "all" else args.scenarios.split(",")
    var = list(VARIANTS) if args.variants == "all" else args.variants.split(",")
    for s in scen:
        if s not in SCENARIOS:
            ap.error(f"unknown scenario {s}")
    for v in var:
        if v not in VARIANTS:
            ap.error(f"unknown variant {v}")
    cases = []
    for v in var:
        for s in scen:
            for seed in span(args.seeds):
                for ls in ([1] if s == "pos" else span(args.leak_seeds)):
                    cases.append((f"{v}__{s}__s{seed}__l{ls}", VARIANTS[v] + ["--scenario", s, "--seed", str(seed), "--leak-seed", str(ls)]))
    root = args.keep or tempfile.mkdtemp(prefix="compare_port_")
    bad = 0
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for name, err in ex.map(lambda c: compare(c, args, root), cases):
            if err:
                bad += 1
                print(f"DIFF  {name}: {err}", flush=True)
                if args.stop_on_first:
                    break
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    print(f"compare_port: {len(cases)} cases, {len(cases) - bad} identical, {bad} different")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

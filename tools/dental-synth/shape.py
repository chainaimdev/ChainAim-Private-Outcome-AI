#!/usr/bin/env python3
"""
shape.py (Phase 4b-2): compares the LAYOUT of a generated set with real exports, before L9 runs on a real month. It reports
differences in encoding (BOM), line endings, preamble rows, header row, column count and the per-column value shape
(empty / int / money / m/d/yyyy date / text), and never prints a value from either file: only header names, counts and
shape labels, so it is safe to run on a real export.

Files are paired by export kind (the file name prefix): BankDep-Det, Per-Sum, SPR-patientlist, BANK-ST.

  python tools/dental-synth/shape.py --real <folder> --synth <folder> [--max-rows 5000] [--min-share 0.05] [--json]

  --max-rows   non-blank rows profiled per file (default 5000); blank rows are skipped and counted
  --min-share  a shape counts for a column when at least this share of its non-empty values has it (default 0.05)
Exit 0 same layout; 1 differences found; 2 usage error.
"""
import argparse
import csv
import io
import json
import os
import re
import sys

KINDS = ["BankDep-Det", "Per-Sum", "SPR-patientlist", "BANK-ST"]
SHAPES = [("int", re.compile(r"^-?\d+$")), ("money", re.compile(r"^-?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$")),
          ("date", re.compile(r"^\d{1,2}/\d{1,2}/\d{4}$"))]


def shape(v):
    if v == "":
        return "empty"
    for name, rx in SHAPES:
        if rx.match(v):
            return name
    return "text"


def read(path, max_rows):
    raw = open(path, "rb").read()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    crlf, lf = text.count("\r\n"), text.count("\n") - text.count("\r\n")
    endings = "CRLF" if crlf and not lf else "LF" if lf and not crlf else "mixed" if crlf else "none"
    rows = list(csv.reader(io.StringIO(text)))
    # header = first row whose first cell is a known first header (BofA puts a summary block above it)
    hi = next((i for i, r in enumerate(rows) if r and r[0] in ("Date", "Full Name")), 0)
    # blank rows (every cell empty) are skipped, as the source adapters skip them; they are counted, not profiled
    rest = rows[hi + 1:]
    body = [r for r in rest if any(c.strip() for c in r)]
    return dict(bom=bom, endings=endings, preamble=hi, header=rows[hi] if rows else [], body=body[:max_rows], blank=len(rest) - len(body))


def profile(f, min_share):
    cols = len(f["header"])
    widths = sorted({len(r) for r in f["body"]})
    per = []
    for c in range(cols):
        vals = [r[c] for r in f["body"] if c < len(r)]
        nonempty = [v for v in vals if v != ""]
        counts = {}
        for v in nonempty:
            counts[shape(v)] = counts.get(shape(v), 0) + 1
        kinds = sorted(k for k, n in counts.items() if nonempty and n / len(nonempty) >= min_share)
        per.append(dict(shapes=kinds, empty_share=round(1 - len(nonempty) / len(vals), 2) if vals else 1.0))
    return dict(bom=f["bom"], endings=f["endings"], preamble_rows=f["preamble"], header=f["header"], row_widths=widths, columns=per, rows=len(f["body"]), blank_rows=f["blank"])


def find(folder, kind):
    hits = sorted(n for n in os.listdir(folder) if n.startswith(kind) and n.lower().endswith(".csv"))
    return os.path.join(folder, hits[0]) if hits else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--real", required=True)
    ap.add_argument("--synth", required=True)
    ap.add_argument("--max-rows", type=int, default=5000)
    ap.add_argument("--min-share", type=float, default=0.05)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    for d in (a.real, a.synth):
        if not os.path.isdir(d):
            ap.error(f"not a folder: {d}")
    report, diffs = {}, 0
    for kind in KINDS:
        rp, sp = find(a.real, kind), find(a.synth, kind)
        if not rp or not sp:
            report[kind] = dict(skipped=f"missing in {'real' if not rp else 'synth'}")
            continue
        r, s = profile(read(rp, a.max_rows), a.min_share), profile(read(sp, a.max_rows), a.min_share)
        out = []
        for key in ("bom", "endings", "preamble_rows", "row_widths"):
            if r[key] != s[key]:
                out.append(f"{key}: real {r[key]} / synth {s[key]}")
        if r["header"] != s["header"]:
            out.append(f"header: real {r['header']} / synth {s['header']}")
        else:
            for name, rc, sc in zip(r["header"], r["columns"], s["columns"]):
                if rc["shapes"] != sc["shapes"]:
                    out.append(f"column '{name}': real shapes {rc['shapes']} / synth {sc['shapes']}")
        diffs += len(out)
        report[kind] = dict(real=os.path.basename(rp), synth=os.path.basename(sp), rows=[r["rows"], s["rows"]], blank_rows=[r["blank_rows"], s["blank_rows"]], differences=out)
    if a.json:
        print(json.dumps(report, indent=2))
    else:
        for kind, v in report.items():
            if "skipped" in v:
                print(f"{kind}: skipped ({v['skipped']})")
                continue
            print(f"{kind}: {v['real']} vs {v['synth']} ({v['rows'][0]} / {v['rows'][1]} rows, blank skipped {v['blank_rows'][0]} / {v['blank_rows'][1]}): " + ("same layout" if not v["differences"] else f"{len(v['differences'])} difference(s)"))
            for d in v["differences"]:
                print(f"  - {d}")
    sys.exit(1 if diffs else 0)


if __name__ == "__main__":
    main()

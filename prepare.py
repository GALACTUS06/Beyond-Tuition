"""
prepare.py - College ROI Explorer: one-time data prep + analysis.

Reads the College Scorecard "Most Recent Institution-Level Data" CSV, cleans it, runs
PCA, k-means (k = 1..10), data MDS and variables' MDS ONCE, and writes data.js.
The dashboard (index.html + main.js) never recomputes any of this - it only draws it.
(Same split as Lab 2: analyze.py -> analysis.js -> main.js.)

Usage
    python prepare.py Most-Recent-Cohorts-Institution.csv
    python prepare.py Most-Recent-Cohorts-Institution.csv --state-context state_context.csv
    python prepare.py sample_scorecard.csv          # SYNTHETIC test data, see tools/make_sample_data.py

Options
    --out data.js            output file
    --min-coverage 0.75      keep an attribute only if >= this share of colleges have a value
    --max-missing 2          drop a college if it is missing more than this many attributes
    --k-max 10               largest k for k-means
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

# ----------------------------------------------------------------------------------
# Attribute pool, in priority order. The first 16 that have enough coverage are used.
# (column, label, short label for axes, format)   format: pct | usd | num | int
# Column names follow the College Scorecard data dictionary - confirm against the
# dictionary for the file you download; an attribute whose column is absent is skipped.
# ----------------------------------------------------------------------------------
POOL = [
    ("MD_EARN_WNE_P10", "Median earnings, 10 yrs after entry", "Earnings 10y", "usd"),
    ("GRAD_DEBT_MDN",   "Median debt of graduates",            "Grad debt",    "usd"),
    ("NET_PRICE",       "Average net price",                   "Net price",    "usd"),
    ("C150_4",          "Completion rate (150% time)",         "Completion",   "pct"),
    ("RET_FT4",         "Retention rate (full-time)",          "Retention",    "pct"),
    ("ADM_RATE",        "Admission rate",                      "Admit rate",   "pct"),
    ("SAT_AVG",         "Average SAT",                         "SAT avg",      "int"),
    ("UGDS",            "Undergraduate enrollment",            "Enrollment",   "int"),
    ("COSTT4_A",        "Cost of attendance (per year)",       "Cost of att.", "usd"),
    ("TUITIONFEE_IN",   "In-state tuition",                    "Tuition",      "usd"),
    ("PCTPELL",         "Share of students with Pell grants",  "Pell share",   "pct"),
    ("PCTFLOAN",        "Share of students with federal loans","Loan share",   "pct"),
    ("MD_FAMINC",       "Median family income",                "Family inc.",  "usd"),
    ("RPY_3YR_RT",      "3-year loan repayment rate",          "Repayment",    "pct"),
    ("AVGFACSAL",       "Average faculty salary (monthly)",    "Faculty sal.", "usd"),
    ("INEXPFTE",        "Instructional spending per student",  "Instr. spend", "usd"),
    # reserves, used only if one of the above fails the coverage test
    ("FIRST_GEN",       "First-generation share",              "First-gen",    "pct"),
    ("UG25ABV",         "Share of students age 25+",           "Age 25+",      "pct"),
    ("PPTUG_EF",        "Part-time share",                     "Part-time",    "pct"),
    ("CDR3",            "3-year loan default rate",            "Default rate",  "pct"),
]
REQUIRED = ["MD_EARN_WNE_P10", "GRAD_DEBT_MDN", "NET_PRICE", "C150_4"]  # the dashboard's story needs these
N_ATTR = 16

SECTORS = {1: "Public", 2: "Private nonprofit", 3: "For-profit"}
LOCALE_GROUP = {1: "City", 2: "Suburb", 3: "Town", 4: "Rural"}
REGION_NAMES = {1: "New England", 2: "Mid East", 3: "Great Lakes", 4: "Plains", 5: "Southeast",
                6: "Southwest", 7: "Rocky Mountains", 8: "Far West", 9: "Outlying Areas"}
STATE_REGION = {}
for r, sts in {
    1: "CT ME MA NH RI VT", 2: "DE DC MD NJ NY PA", 3: "IL IN MI OH WI", 4: "IA KS MN MO NE ND SD",
    5: "AL AR FL GA KY LA MS NC SC TN VA WV", 6: "AZ NM OK TX", 7: "CO ID MT UT WY",
    8: "AK CA HI NV OR WA", 9: "AS FM GU MH MP PR PW VI",
}.items():
    for s in sts.split():
        STATE_REGION[s] = r


def to_num(series):
    """Scorecard writes 'PrivacySuppressed' / 'NULL' for hidden values -> NaN."""
    return pd.to_numeric(series, errors="coerce")


def classical_mds(D, k=2):
    """Torgerson classical MDS: used as the starting point for SMACOF."""
    n = D.shape[0]
    J = np.eye(n) - np.ones((n, n)) / n
    B = -0.5 * J @ (D ** 2) @ J
    w, v = np.linalg.eigh(B)
    idx = np.argsort(w)[::-1][:k]
    return v[:, idx] * np.sqrt(np.maximum(w[idx], 1e-12))


def smacof(D, X0, iters=300, tol=1e-6):
    """Metric MDS by SMACOF (stress majorization): minimizes sum (dist(X) - D)^2."""
    n = D.shape[0]
    X = X0.copy()
    prev = None
    for _ in range(iters):
        sq = (X ** 2).sum(1)
        dist = np.sqrt(np.maximum(sq[:, None] + sq[None, :] - 2 * X @ X.T, 0))
        stress = ((dist - D) ** 2).sum() / 2
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = np.where(dist > 1e-12, D / dist, 0.0)
        B = -ratio
        np.fill_diagonal(B, 0)
        np.fill_diagonal(B, -B.sum(axis=1))
        X = B @ X / n
        if prev is not None and abs(prev - stress) / max(prev, 1e-12) < tol:
            break
        prev = stress
    return X, stress


def elbow_k(mse):
    """Elbow = point farthest from the straight line between first and last MSE."""
    ks = np.arange(1, len(mse) + 1, dtype=float)
    x = (ks - ks[0]) / (ks[-1] - ks[0])
    y = (np.array(mse) - mse[-1]) / (mse[0] - mse[-1])
    d = np.abs(x + y - 1) / math.sqrt(2)  # line from (0,1) to (1,0)
    return int(np.argmax(d)) + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default="data.js")
    ap.add_argument("--state-context", default=None)
    ap.add_argument("--min-coverage", type=float, default=0.75)
    ap.add_argument("--max-missing", type=int, default=2)
    ap.add_argument("--k-max", type=int, default=10)
    a = ap.parse_args()

    df = pd.read_csv(a.csv, dtype=str, low_memory=False)
    print("read %d rows, %d columns from %s" % (len(df), df.shape[1], a.csv))

    # ---------------- which colleges ----------------
    for c in ["CONTROL", "PREDDEG", "CURROPER", "LATITUDE", "LONGITUDE", "LOCALE"] + [p[0] for p in POOL] + ["NPT4_PUB", "NPT4_PRIV"]:
        if c in df.columns:
            df[c] = to_num(df[c])
    keep = df["CONTROL"].isin([1, 2, 3])
    if "PREDDEG" in df.columns:
        keep &= df["PREDDEG"] == 3          # predominantly bachelor's-degree granting
    else:
        print("note: no PREDDEG column, keeping all sectors/levels")
    if "CURROPER" in df.columns:
        keep &= df["CURROPER"] == 1         # currently operating
    keep &= df["LATITUDE"].notna() & df["LONGITUDE"].notna() & df["STABBR"].notna()
    df = df[keep].copy().reset_index(drop=True)
    print("after filters (bachelor's-granting, operating, has location): %d colleges" % len(df))

    # net price: public schools report NPT4_PUB, private ones NPT4_PRIV
    pub = df["NPT4_PUB"] if "NPT4_PUB" in df.columns else pd.Series(np.nan, index=df.index)
    priv = df["NPT4_PRIV"] if "NPT4_PRIV" in df.columns else pd.Series(np.nan, index=df.index)
    df["NET_PRICE"] = np.where(df["CONTROL"] == 1, pub, priv)
    df["NET_PRICE"] = pd.Series(df["NET_PRICE"]).fillna(pub).fillna(priv)

    # ---------------- which attributes ----------------
    chosen, report = [], []
    for col, label, short, fmt in POOL:
        if col not in df.columns:
            report.append((col, None, "column not in file"))
            continue
        cov = float(df[col].notna().mean())
        ok = cov >= a.min_coverage
        report.append((col, cov, "ok" if ok else "below %.0f%% coverage" % (a.min_coverage * 100)))
        if ok and len(chosen) < N_ATTR:
            chosen.append((col, label, short, fmt))
    print("\nattribute coverage:")
    for col, cov, note in report:
        print("  %-16s %s  %s" % (col, ("%5.1f%%" % (cov * 100)) if cov is not None else "   n/a", note))
    miss = [r for r in REQUIRED if r not in [c[0] for c in chosen]]
    if miss:
        sys.exit("ERROR: required attribute(s) %s missing or too sparse - check column names against the data dictionary, "
                 "or lower --min-coverage." % miss)
    if len(chosen) < 8:
        sys.exit("ERROR: only %d usable attributes." % len(chosen))
    cols = [c[0] for c in chosen]

    # ---------------- which rows: drop if too many gaps, median-fill the rest ----------------
    nmiss = df[cols].isna().sum(axis=1)
    df = df[nmiss <= a.max_missing].copy().reset_index(drop=True)
    X = df[cols].astype(float)
    filled = int(X.isna().sum().sum())
    X = X.fillna(X.median())
    n, p = X.shape
    print("\nkept %d colleges x %d attributes; %d values filled with the column median (%.2f%% of cells)" %
          (n, p, filled, 100 * filled / (n * p)))

    # ---------------- standardize + PCA (eigen-decomposition of the covariance matrix) ----------------
    mean, sd = X.mean().to_numpy(copy=True), X.std(ddof=0).to_numpy(copy=True)
    sd[sd == 0] = 1
    Z = (X.values - mean) / sd
    cov = np.cov(Z, rowvar=False)
    w, V = np.linalg.eigh(cov)
    order = np.argsort(w)[::-1]
    w, V = w[order], V[:, order]
    eigvecs = V.T.copy()                      # eigvecs[pc][attribute]
    for i in range(p):                        # sign convention: biggest loading positive (stable between runs)
        if eigvecs[i][np.argmax(np.abs(eigvecs[i]))] < 0:
            eigvecs[i] *= -1
    scores = Z @ eigvecs.T
    n_pc = min(6, p)
    print("explained variance of PC1..PC%d: %s" % (n_pc, ", ".join("%.1f%%" % (100 * w[i] / w.sum()) for i in range(n_pc))))

    # ---------------- k-means, k = 1..k_max (clusters renumbered by median earnings) ----------------
    earn = X["MD_EARN_WNE_P10"].values
    labels_all, mse = [], []
    for k in range(1, a.k_max + 1):
        km = KMeans(n_clusters=k, n_init=10, random_state=42).fit(Z)
        lab = km.labels_
        med = [np.median(earn[lab == c]) if np.any(lab == c) else np.inf for c in range(k)]
        remap = {old: new for new, old in enumerate(np.argsort(med))}
        labels_all.append([int(remap[x]) for x in lab])
        mse.append(float(km.inertia_ / n))
    k_elbow = max(2, elbow_k(mse))
    print("k-means MSE:", ", ".join("%.2f" % m for m in mse), "-> suggested k =", k_elbow)

    # ---------------- data MDS (metric, Euclidean, SMACOF) ----------------
    sq = (Z ** 2).sum(1)
    D = np.sqrt(np.maximum(sq[:, None] + sq[None, :] - 2 * Z @ Z.T, 0))
    print("running data MDS on %d x %d distances ..." % (n, n))
    dm, st = smacof(D, classical_mds(D), iters=300)
    dm = (dm - dm.mean(0)) / dm.std()
    print("  data MDS stress: %.1f" % st)

    # ---------------- variables' MDS (distance = 1 - |correlation|) ----------------
    C = np.corrcoef(Z, rowvar=False)
    Dv = 1 - np.abs(C)
    np.fill_diagonal(Dv, 0)
    vm, vst = smacof(Dv, classical_mds(Dv), iters=1000, tol=1e-9)
    print("  variables' MDS stress: %.3f" % vst)

    # ---------------- rows ----------------
    colleges = []
    for i, r in df.iterrows():
        st_ = str(r["STABBR"])
        reg = STATE_REGION.get(st_, 9)
        loc = int(r["LOCALE"]) // 10 if not pd.isna(r.get("LOCALE", np.nan)) else 0
        colleges.append({
            "id": str(r.get("UNITID", i)),
            "name": str(r["INSTNM"]),
            "city": str(r.get("CITY", "")),
            "state": st_,
            "region": REGION_NAMES[reg],
            "sector": SECTORS[int(r["CONTROL"])],
            "locale": LOCALE_GROUP.get(loc, "Unknown"),
            "lat": round(float(r["LATITUDE"]), 4),
            "lon": round(float(r["LONGITUDE"]), 4),
        })

    def rnd(arr, d):
        return np.round(arr, d).tolist()

    out = {
        "meta": {
            "source": os.path.basename(a.csv),
            "colleges": int(n), "attributes": int(p), "filledValues": filled,
            "minCoverage": a.min_coverage, "maxMissing": a.max_missing,
            "synthetic": bool(df["INSTNM"].astype(str).str.startswith("Synthetic College").all()),
        },
        "attributes": cols,
        "labels": [c[1] for c in chosen],
        "short": [c[2] for c in chosen],
        "formats": [c[3] for c in chosen],
        "categorical": ["sector", "region"],
        "colleges": colleges,
        "values": [[round(float(v), 4) for v in row] for row in X.values],
        "eigenvalues": rnd(w, 5),
        "eigenvectors": rnd(eigvecs, 5),
        "pcaScores": rnd(scores[:, :n_pc], 4),
        "kmeansLabels": labels_all,
        "kmeansMSE": rnd(np.array(mse), 5),
        "elbowK": k_elbow,
        "dataMDS": rnd(dm, 4),
        "variablesMDS": rnd(vm, 5),
        "correlation": rnd(C, 4),
    }

    # ---------------- optional second source: state-level context ----------------
    if a.state_context:
        sc = pd.read_csv(a.state_context)
        if "state" not in sc.columns:
            sys.exit("state context file needs a 'state' column holding 2-letter abbreviations")
        sc["state"] = sc["state"].astype(str).str.strip().str.upper()
        ccols = [c for c in sc.columns if c != "state" and pd.to_numeric(sc[c], errors="coerce").notna().any()]
        sc[ccols] = sc[ccols].apply(pd.to_numeric, errors="coerce")
        out["stateContext"] = {
            "columns": ccols,
            "labels": [c.replace("_", " ") for c in ccols],
            "values": {r["state"]: {c: (None if pd.isna(r[c]) else float(r[c])) for c in ccols} for _, r in sc.iterrows()},
        }
        have = set(sc.dropna(subset=ccols, how="all")["state"])
        print("state context: %d states with data, columns %s" % (len(have), ccols))

    with open(a.out, "w") as f:
        f.write("// generated by prepare.py from %s - do not edit by hand\nvar DATA = " % os.path.basename(a.csv))
        json.dump(out, f, separators=(",", ":"))
        f.write(";\n")
    print("\nwrote %s (%.0f KB)" % (a.out, os.path.getsize(a.out) / 1024))


if __name__ == "__main__":
    main()

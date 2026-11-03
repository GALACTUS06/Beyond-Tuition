"""
tools/make_sample_data.py - writes SYNTHETIC test data in the College Scorecard column format.

!! These are NOT real colleges or real numbers. Every school is named "Synthetic College N".
!! It exists only so the pipeline + dashboard can be tested without the real download.
!! Replace with the real Most-Recent-Cohorts-Institution.csv for the project.

Usage: python tools/make_sample_data.py sample_scorecard.csv
"""
import json, re, sys
import numpy as np
import pandas as pd

rng = np.random.default_rng(7)
N = 2600

ST = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split()
# rough weights so big states get more colleges
W = {s: 1.0 for s in ST}
for s, w in {'CA': 9, 'NY': 8, 'TX': 7, 'PA': 6, 'FL': 5, 'OH': 5, 'IL': 5, 'MA': 5, 'NC': 4, 'MI': 4, 'VA': 4, 'GA': 3, 'NJ': 3, 'IN': 3, 'MO': 3, 'TN': 3, 'WI': 3, 'MN': 3}.items():
    W[s] = w
p = np.array([W[s] for s in ST]); p = p / p.sum()

# state centroids from states.js (largest ring, mean of points) so dots land inside the map
raw = open('states.js').read()
fc = json.loads(re.sub(r'^var STATES = |;\s*$', '', raw))
cent = {}
for f in fc['features']:
    g = f['geometry']
    polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    ring = max((pl[0] for pl in polys), key=len)
    a = np.array(ring)
    cent[f['id']] = (a[:, 0].mean(), a[:, 1].mean())

state = rng.choice(ST, size=N, p=p)
control = rng.choice([1, 2, 3], size=N, p=[0.42, 0.40, 0.18])
preddeg = rng.choice([1, 2, 3, 4], size=N, p=[0.10, 0.25, 0.60, 0.05])
sel = np.clip(rng.beta(2, 2.6, N) + 0.12 * (control == 2) - 0.10 * (control == 3), 0, 1)
sel_s = {s: rng.normal(0, 0.04) for s in ST}
sel = np.clip(sel + np.array([sel_s[s] for s in state]), 0, 1)

def clip(a, lo, hi): return np.clip(a, lo, hi)
n = lambda s=1: rng.normal(0, s, N)

adm = clip(0.97 - 0.75 * sel + n(0.08), 0.04, 1.0)
sat = clip(930 + 480 * sel + n(40), 800, 1580)
ugds = np.round(np.exp(7.0 + 1.2 * (control == 1) + 0.6 * sel + n(0.8)))
tuit_in = clip(5000 + 9000 * (control == 1) * (0.5 + sel) + 28000 * (control == 2) * (0.35 + sel) + 12000 * (control == 3) + n(1800), 2500, 65000)
costt4 = tuit_in + 14000 + 3000 * sel + n(1500)
netprice = clip(costt4 * (0.45 + 0.25 * (control == 1) - 0.1 * sel) + n(1800), 3000, 45000)
pell = clip(0.62 - 0.45 * sel + n(0.07), 0.04, 0.95)
floan = clip(0.55 - 0.15 * sel + 0.1 * (control == 3) + n(0.1), 0.02, 0.95)
c150 = clip(0.22 + 0.68 * sel - 0.08 * (control == 3) + n(0.07), 0.05, 0.99)
ret = clip(0.50 + 0.45 * sel + n(0.05), 0.2, 0.99)
earn = clip(27000 + 38000 * sel + 3000 * (control == 2) - 4000 * (control == 3) + n(3800), 18000, 110000)
debt = clip(13000 + 9000 * (control != 1) + 4000 * (control == 3) - 3000 * sel + n(2200), 5000, 40000)
rpy = clip(0.35 + 0.45 * sel + n(0.06), 0.1, 0.95)
facsal = clip(5200 + 5200 * sel + 800 * (control == 1) + n(500), 3000, 16000)
inexp = clip(5000 + 22000 * sel * (control != 1) + 6000 * sel + n(1800), 1500, 60000)
faminc = clip(32000 + 62000 * sel - 6000 * (control == 3) + n(7000), 18000, 140000)
firstgen = clip(0.55 - 0.35 * sel + n(0.06), 0.05, 0.9)
ug25 = clip(0.2 - 0.12 * sel + 0.25 * (control == 3) + n(0.07), 0.01, 0.9)
pptug = clip(0.2 - 0.14 * sel + n(0.07), 0.0, 0.9)
cdr3 = clip(0.12 - 0.08 * sel + 0.04 * (control == 3) + n(0.025), 0.0, 0.3)

lon = np.array([cent[s][0] for s in state]) + n(1.1)
lat = np.array([cent[s][1] for s in state]) + n(0.8)
locale = rng.choice([11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 42, 43], size=N, p=[.18, .1, .04, .2, .08, .02, .06, .06, .04, .08, .1, .04])

df = pd.DataFrame({
    'UNITID': 100000 + np.arange(N), 'INSTNM': ['Synthetic College %04d' % i for i in range(N)],
    'CITY': 'Sampletown', 'STABBR': state, 'CONTROL': control, 'LOCALE': locale, 'PREDDEG': preddeg, 'CURROPER': 1,
    'LATITUDE': lat.round(4), 'LONGITUDE': lon.round(4),
    'ADM_RATE': adm.round(4), 'SAT_AVG': sat.round(), 'UGDS': ugds, 'COSTT4_A': costt4.round(), 'TUITIONFEE_IN': tuit_in.round(),
    'NPT4_PUB': np.where(control == 1, netprice.round(), np.nan), 'NPT4_PRIV': np.where(control != 1, netprice.round(), np.nan),
    'PCTPELL': pell.round(4), 'PCTFLOAN': floan.round(4), 'C150_4': c150.round(4), 'RET_FT4': ret.round(4),
    'MD_EARN_WNE_P10': earn.round(), 'GRAD_DEBT_MDN': debt.round(), 'RPY_3YR_RT': rpy.round(4), 'AVGFACSAL': facsal.round(),
    'INEXPFTE': inexp.round(), 'MD_FAMINC': faminc.round(), 'FIRST_GEN': firstgen.round(4), 'UG25ABV': ug25.round(4),
    'PPTUG_EF': pptug.round(4), 'CDR3': cdr3.round(4),
})
# real Scorecard quirks: SAT only for selective schools, privacy suppression, NULL strings, some rows missing coordinates
for c, frac in [('SAT_AVG', 0.30), ('ADM_RATE', 0.12), ('C150_4', 0.06), ('RET_FT4', 0.06), ('MD_EARN_WNE_P10', 0.12), ('GRAD_DEBT_MDN', 0.10),
                ('RPY_3YR_RT', 0.14), ('AVGFACSAL', 0.08), ('INEXPFTE', 0.05), ('MD_FAMINC', 0.09), ('FIRST_GEN', 0.35), ('CDR3', 0.07)]:
    df[c] = df[c].astype(object)
    m = rng.random(N) < frac
    df.loc[m, c] = rng.choice(['PrivacySuppressed', 'NULL'], size=m.sum())
df.loc[rng.random(N) < 0.01, 'LATITUDE'] = np.nan
out = sys.argv[1] if len(sys.argv) > 1 else 'sample_scorecard.csv'
df.to_csv(out, index=False)
print('wrote', out, df.shape)

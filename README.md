# College ROI Explorer — CSE 332 capstone

Single-screen, linked D3 (v3) dashboard of US four-year colleges: cost, debt, completion and earnings.

## Run it
    python3 -m http.server 8000      # in this folder, then open http://localhost:8000
(Double-clicking index.html also works in most browsers, since everything is local scripts.)

**What you see right now is SYNTHETIC test data** (red tag at the top, colleges named "Synthetic College N").
It exists only so the pipeline and dashboard could be tested. Swap in the real data before submitting.

## Use the real data
1. Download "Most Recent Institution-Level Data" (zip, ~23 MB) from https://collegescorecard.ed.gov/data/ and unzip it.
   Also grab the data dictionary (XLSX) from https://catalog.data.gov/dataset/college-scorecard
2. (Second source) Fill in `state_context_template.csv` — one row per state abbreviation. Unemployment rate from
   https://www.bls.gov/lau/ and e.g. median gross rent from https://data.census.gov . Rename columns if you like;
   any numeric column becomes a map-shading option.
3. Run:
       pip install numpy pandas scikit-learn
       python3 prepare.py Most-Recent-Cohorts-Institution.csv --state-context state_context.csv
   It prints each attribute's coverage, how many values were filled, explained variance, k-means MSE, and the elbow k.
   If it says a REQUIRED attribute is missing/sparse, check the column name in the data dictionary and edit the POOL list
   at the top of prepare.py (or lower --min-coverage).
4. Reload the page. The red synthetic tag disappears automatically.

## Files
- prepare.py ........ cleaning + PCA + k-means (k=1..10) + data MDS (SMACOF) + variables' MDS -> data.js  (run once)
- data.js ........... all analysis results (generated)      - states.js .... US state outlines (generated, tools/build_geo.js)
- index.html / style.css / main.js ... the dashboard (reads data.js, recomputes nothing)
- d3/d3.v3.js ....... D3 3.5.17 from npm; overwrite with the course copy if you prefer
- tools/ ............ make_sample_data.py (synthetic test data), test_tabs.py (headless test: tabs, drill-down, focus, stories), build_geo.js

## Tabs (keys 1-5) - each is a different arrangement of the same panels
1 Overview (all six views) · 2 Hierarchy (big sunburst + slice details) · 3 Geography (map + states ranked) ·
4 Similarity (similarity map + clusters) · 5 Attributes (parallel coordinates + attribute map).
The ⤢ button on any panel shows that view alone; Esc (or "back") returns. Selection, k, color-by, sunburst position and
axis order are kept when you switch.

## Sunburst
Click a slice and it becomes the center of a new sunburst: its children grow out as the first ring, with deeper levels
(down to individual colleges) behind them. Click the center or a breadcrumb to go up. Click a college to pin it.
The levels dropdown reorders the hierarchy (Region>State>Sector, Sector>Region>State, Region>Locale>Sector);
"angle" switches between enrollment and college count; "Color by" recolors slices.

## Other views (all linked through one shared selection)
map (state shading + college dots) · similarity map (data MDS / PCA biplot / any-vs-any scatterplot, brushable) ·
parallel coordinates (brush any axis, axis order from the attribute map) · attribute map (click to reorder axes,
"best correlation order") · elbow bars (click k) + cluster chips + selection summary.
Stories: Price trap, Beating the odds, Where you study - each opens the tab(s) that show it.

## Test
    python3 tools/test_tabs.py 1600 900      # also try 1366 768 and 1920 1080


## Two pages, one code base
- **index.html** (the dashboard to hand in): ONE screen, all six views always visible, no scrolling.
  *Pseudo zoom:* click a view's title bar (or its enlarge button); that view grows and the others shrink but stay visible.
  Click again or press Esc to restore. Linked brushing, stories and drill-down all work in either state.
- **index_tabs.html**: same dashboard plus optional focus tabs (Hierarchy / Geography / Similarity / Attributes) for exploring one or two views.
- Tests: `python3 tools/test_single.py 1600 900` and `python3 tools/test_tabs.py 1600 900` (also 1366 768, 1920 1080).

- `python3 tools/audit_single.py` checks every state (default + each view enlarged) at 1280x720 to 1920x1080 for hidden, clipped or truncated parts. The side panel is scaled to fit rather than cut; the shrunk row never gets smaller than ~230 px; panels are never narrower than 250 px.

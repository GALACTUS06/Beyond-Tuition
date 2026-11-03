// main.js - College ROI Explorer (CSE 332 capstone), D3 v3.
//
// AI-USE DISCLOSURE: (write your own statement here, as in the labs - say which parts were AI-assisted.)
//
// All heavy analysis (PCA, k-means for k=1..10, data MDS, variables' MDS, correlations) was computed ONCE
// in Python (prepare.py) and saved in data.js. Nothing here recomputes it; this file draws it and links the
// views together through ONE shared selection:
//
//     filters (F)  ->  recompute()  ->  inSel[i] = 1 if college i passes every active filter
//                                  ->  selectionChanged() restyles every view from inSel
//
// Sources of a filter: a sunburst wedge (zoom), a map state, a brush on the similarity map, brushes on parallel
// axes, a cluster chip. They are ANDed. Hover is linked too (one college highlighted in every view).

/* =====================================================================
   1. DATA SHORTCUTS + STATISTICS
   ===================================================================== */
// The page decides the mode: index.html = ONE screen, every view always visible (the default dashboard);
// index_tabs.html sets window.DASH_TABS = true before loading this file and adds tabs + a focus button on every view.
var TABS_ON = window.DASH_TABS === true;
var N = DATA.colleges.length, P = DATA.attributes.length;
var COL = DATA.colleges, VAL = DATA.values, ATTR = DATA.attributes, FMT = DATA.formats;
var IDX = {}; ATTR.forEach(function(a, j) { IDX[a] = j; });
var EARN = IDX.MD_EARN_WNE_P10, DEBT = IDX.GRAD_DEBT_MDN, NETP = IDX.NET_PRICE, COMP = IDX.C150_4,
    PELL = IDX.PCTPELL, ENR = IDX.UGDS, ADM = IDX.ADM_RATE, FAM = IDX.MD_FAMINC;

var MEAN = [], SD = [], MIN = [], MAX = [], SORTED = [];
ATTR.forEach(function(a, j) {
  var v = VAL.map(function(r) { return r[j]; });
  MEAN[j] = d3.mean(v);
  SD[j] = Math.sqrt(d3.mean(v, function(x) { return (x - MEAN[j]) * (x - MEAN[j]); })) || 1;
  MIN[j] = d3.min(v); MAX[j] = d3.max(v);
  SORTED[j] = v.slice().sort(d3.ascending);
});
function qnt(j, p) { return d3.quantile(SORTED[j], p); }

var SECTORS = ["Public", "Private nonprofit", "For-profit"];
var REGION_ORDER = ["New England", "Mid East", "Great Lakes", "Plains", "Southeast", "Southwest", "Rocky Mountains", "Far West", "Outlying Areas"]
    .filter(function(r) { return COL.some(function(c) { return c.region === r; }); });
var REG_SHORT = { "New England": "N. England", "Mid East": "Mid East", "Great Lakes": "Gr. Lakes", "Rocky Mountains": "Rocky Mtn", "Outlying Areas": "Outlying" };
var SEC_SHORT = { "Public": "Public", "Private nonprofit": "Priv. nonprofit", "For-profit": "For-profit" };
function isCat(dim) { return dim === "sector" || dim === "region"; }

function fmtV(f, v) {   // full-length value, for tooltips and the summary
  if (v == null || isNaN(v)) return "n/a";
  if (f === "pct") return d3.format(".0%")(v);
  if (f === "usd") return "$" + d3.format(",.0f")(v);
  if (f === "ratio") return d3.format(".1f")(v) + "x";
  if (f === "int") return d3.format(",.0f")(v);
  return d3.format(".2f")(v);
}
function fmtS(f, v) {   // short value, for axis ticks
  if (f === "pct") return d3.format(".0%")(v);
  if (f === "usd") return "$" + d3.format(".2s")(v);
  if (f === "ratio") return d3.format(".1f")(v);
  if (f === "int") return d3.format(".2s")(v);
  return d3.format(".2f")(v);
}
function hexRgba(hex, a) {
  var h = hex.replace("#", "");
  return "rgba(" + parseInt(h.substr(0, 2), 16) + "," + parseInt(h.substr(2, 2), 16) + "," + parseInt(h.substr(4, 2), 16) + "," + a + ")";
}
function sizeOf(id) { var e = document.getElementById(id); return { w: e.clientWidth, h: e.clientHeight }; }
function emptyEl(sel) { d3.select(sel).selectAll("*").remove(); }

/* the "color by" menu: every attribute, plus one derived ratio */
var METRICS = ATTR.map(function(a, j) { return { id: a, j: j, label: DATA.labels[j], fmt: FMT[j] }; });
if (EARN != null && DEBT != null) METRICS.unshift({ id: "EARN_PER_DEBT", j: -1, label: "Earnings per $1 of graduate debt", fmt: "ratio" });
METRICS.forEach(function(m) {
  m.vals = new Array(N);
  for (var i = 0; i < N; i++) m.vals[i] = m.j >= 0 ? VAL[i][m.j] : VAL[i][EARN] / Math.max(VAL[i][DEBT], 1);
});
function metricById(id) { return METRICS.filter(function(m) { return m.id === id; })[0]; }

function weightOf(i) { return ENR != null ? VAL[i][ENR] : 1; }
function wmean(members, vals) {    // enrollment-weighted mean over a list of college indices
  var s = 0, w = 0;
  for (var q = 0; q < members.length; q++) { var i = members[q], wi = weightOf(i); s += wi * vals[i]; w += wi; }
  return w ? s / w : null;
}

/* =====================================================================
   2. SHARED STATE
   ===================================================================== */
var S = {
  k: DATA.elbowK,
  metric: metricById("MD_EARN_WNE_P10") || METRICS[0],
  order: DATA.categorical.concat(ATTR),      // parallel-coordinates axis order
  mdsClick: [],                               // attributes clicked in the variables' MDS (their order drives the axes)
  hover: -1
};
var F = freshFilters();
function freshFilters() { return { node: null, states: {}, brush: null, pcp: {}, clusters: {} }; }
var inSel = new Uint8Array(N), nSel = N, anyF = false;
var cc = d3.scale.category10();
function labelsK() { return DATA.kmeansLabels[S.k - 1]; }

function hasKeys(o) { for (var k in o) return true; return false; }
function recompute() {
  var hasStates = hasKeys(F.states), hasCl = hasKeys(F.clusters), pk = Object.keys(F.pcp), lab = labelsK();
  anyF = !!(F.node || F.brush || hasStates || hasCl || pk.length);
  nSel = 0;
  for (var i = 0; i < N; i++) {
    var ok = 1;
    if (F.node && !F.node[i]) ok = 0;
    if (ok && hasStates && !F.states[COL[i].state]) ok = 0;
    if (ok && F.brush && !F.brush[i]) ok = 0;
    if (ok && hasCl && !F.clusters[lab[i]]) ok = 0;
    for (var q = 0; ok && q < pk.length; q++) {
      var s = F.pcp[pk[q]];
      if (s.cat) { if (!s.set[COL[i][s.key]]) ok = 0; }
      else { var v = VAL[i][s.j]; if (v < s.lo || v > s.hi) ok = 0; }
    }
    inSel[i] = ok; nSel += ok;
  }
}
function maskOf(list) { var m = new Uint8Array(N); for (var q = 0; q < list.length; q++) m[list[q]] = 1; return m; }

function selectionChanged() {
  recompute();
  sun.updateSel(); detail.updateSel(); srank.updateSel(); map.updateSel(); emb.updateSel(); pcp.drawLines(); side.update();
  var b = document.getElementById("badge");
  b.innerHTML = anyF ? "<b>" + d3.format(",")(nSel) + "</b> of " + d3.format(",")(N) + " colleges selected" : "all <b>" + d3.format(",")(N) + "</b> colleges";
}

/* =====================================================================
   3. CLUSTERS: names, colors
   ===================================================================== */
var nameCache = {};
function clusterInfo() {
  if (nameCache[S.k]) return nameCache[S.k];
  var lab = labelsK(), names = [], counts = [];
  for (var c = 0; c < S.k; c++) {
    var sums = [], cnt = 0;
    for (var j = 0; j < P; j++) sums[j] = 0;
    for (var i = 0; i < N; i++) if (lab[i] === c) { cnt++; for (var j2 = 0; j2 < P; j2++) sums[j2] += VAL[i][j2]; }
    counts.push(cnt);
    if (!cnt) { names.push("(empty)"); continue; }
    var z = d3.range(P).map(function(j) { return { j: j, z: (sums[j] / cnt - MEAN[j]) / SD[j] }; });
    z.sort(function(a, b) { return Math.abs(b.z) - Math.abs(a.z); });
    var pick = [z[0]];
    for (var q = 1; pick.length < 2 && q < z.length; q++) {          // skip an attribute that is nearly a copy of the first
      if (Math.abs(DATA.correlation[z[0].j][z[q].j]) > 0.85) continue;
      pick.push(z[q]);
    }
    names.push(pick.map(function(d) { return (d.z > 0 ? "high " : "low ") + DATA.short[d.j].toLowerCase(); }).join(", "));
  }
  return (nameCache[S.k] = { names: names, counts: counts });
}

/* =====================================================================
   4. COLOR SCALE FOR THE "COLOR BY" METRIC  (shared by sunburst + map)
   ===================================================================== */
var RAMP = ["#ffffd9", "#c7e9b4", "#41b6c4", "#225ea8", "#081d58"];
var colorScale = null;
function rebuildColorScale() {
  var v = S.metric.vals.slice().sort(d3.ascending);
  var lo = d3.quantile(v, 0.05), hi = d3.quantile(v, 0.95);
  if (!(hi > lo)) hi = lo + 1;
  colorScale = d3.scale.linear().domain(d3.range(5).map(function(i) { return lo + (hi - lo) * i / 4; })).range(RAMP).clamp(true);
  document.getElementById("rampBar").style.background = "linear-gradient(to right," + RAMP.join(",") + ")";
  document.getElementById("rampMin").textContent = fmtS(S.metric.fmt, lo);
  document.getElementById("rampMax").textContent = fmtS(S.metric.fmt, hi);
}

/* =====================================================================
   5. TOOLTIP + HOVER (one college highlighted everywhere)
   ===================================================================== */
var tipEl = document.getElementById("tip");
function tipHtmlCollege(i) {
  var c = COL[i], info = clusterInfo(), lab = labelsK()[i];
  var rows = [EARN, DEBT, NETP, COMP, PELL].filter(function(j) { return j != null; }).map(function(j) {
    return '<span class="k">' + DATA.short[j] + ":</span> " + fmtV(FMT[j], VAL[i][j]);
  });
  return "<b>" + c.name + '</b><br><span class="k">' + c.city + ", " + c.state + " · " + c.sector + " · " + c.locale + "</span><br>" +
      rows.join("<br>") + '<br><span class="k">cluster ' + lab + ":</span> " + info.names[lab];
}
function showTip(html, ev) {
  tipEl.innerHTML = html; tipEl.style.display = "block";
  var x = ev.clientX + 14, y = ev.clientY + 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  if (x + w > window.innerWidth - 4) x = ev.clientX - w - 14;
  if (y + h > window.innerHeight - 4) y = ev.clientY - h - 14;
  tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
}
function hideTip() { tipEl.style.display = "none"; }
function setHover(i, ev) {
  S.hover = i;
  map.hover(i); emb.hover(i); pcp.hover(i); sun.hover(i);
  if (i >= 0 && ev) showTip(tipHtmlCollege(i), ev); else hideTip();
}

/* =====================================================================
   6. SUNBURST - drill-down. Click a slice and IT BECOMES THE CENTER of a new sunburst: its children grow out as the
      first ring, deeper levels (down to individual colleges) fade in behind them. Click the center or a breadcrumb to
      go back up. Every slice keeps its identity (a key), so the old and new sunburst MORPH into each other instead
      of cutting. Slice angle = enrollment (or college count); color = the "color by" metric (enrollment-weighted).
   ===================================================================== */
var HIER = {
  rss: { label: "Region › State › Sector", levels: ["region", "state", "sector"] },
  srs: { label: "Sector › Region › State", levels: ["sector", "region", "state"] },
  rls: { label: "Region › Locale › Sector", levels: ["region", "locale", "sector"] }
};
var LOCALE_ORDER = ["City", "Suburb", "Town", "Rural", "Unknown"];
var KIND_PLURAL = { region: "regions", state: "states", sector: "sectors", locale: "locale types", college: "colleges" };
var SUNS = { hier: "rss", size: "enroll", rootKey: "All", pin: -1 };   // survives rebuilds (tab changes, resize)

function nodeVal(n) { return n.kind === "college" ? S.metric.vals[n.leaf] : wmean(n.members, S.metric.vals); }
function nodeLabel(n) {
  if (n.kind === "root") return "All colleges";
  if (n.kind === "region") return REG_SHORT[n.name] || n.name;
  return n.name;
}
function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

var sun = (function() {
  var TAU = 2 * Math.PI, DUR = 850;
  var tree = null, byKey = {}, viewRoot = null, svg, g, arcG, labG, ctrG, W = 0, H = 0, R = 0, R0 = 0;
  var cur = {};             // key -> geometry the slice is drawn with RIGHT NOW (updated every animation frame)
  var curLay = [];          // layout of the sunburst now shown
  var token = 0, built = false, nRings = 3;
  var arcGen = d3.svg.arc().startAngle(function(q) { return q.a0; }).endAngle(function(q) { return q.a1; })
      .innerRadius(function(q) { return q.r0; }).outerRadius(function(q) { return q.r1; });

  /* ---------- the hierarchy ---------- */
  function ordKey(kind, name) {
    if (kind === "region") return REGION_ORDER.indexOf(name);
    if (kind === "sector") return SECTORS.indexOf(name);
    if (kind === "locale") return LOCALE_ORDER.indexOf(name);
    return 0;
  }
  function buildTree() {
    var levels = HIER[SUNS.hier].levels;
    byKey = {};
    tree = { key: "All", name: "All colleges", kind: "root", depth: 0, parent: null, children: [], members: [] };
    byKey.All = tree;
    for (var i = 0; i < N; i++) {
      var n = tree, path = "All";
      for (var d = 0; d < levels.length; d++) {
        var kind = levels[d], nm = COL[i][kind] || "Unknown";
        path += "|" + nm;
        var ch = byKey[path];
        if (!ch) { ch = { key: path, name: nm, kind: kind, depth: d + 1, parent: n, children: [], members: [] }; byKey[path] = ch; n.children.push(ch); }
        ch.members.push(i); n = ch;
      }
      var leaf = { key: path + "|#" + i, name: COL[i].name, kind: "college", depth: levels.length + 1, parent: n, children: [], members: [i], leaf: i };
      byKey[leaf.key] = leaf; n.children.push(leaf);
      tree.members.push(i);
    }
    computeValues();
  }
  function computeValues() {          // slice size, then sort children (colleges: biggest first)
    (function rec(n) {
      if (n.kind === "college") { n.value = SUNS.size === "enroll" ? Math.max(weightOf(n.leaf), 1) : 1; return n.value; }
      n.value = 0;
      n.children.forEach(function(c) { n.value += rec(c); });
      n.children.sort(function(a, b) {
        if (a.kind === "college") return b.value - a.value;
        var d = ordKey(a.kind, a.name) - ordKey(b.kind, b.name);
        return d || (a.name < b.name ? -1 : 1);
      });
      return n.value;
    })(tree);
  }

  /* ---------- geometry ---------- */
  function ringsFor(root) {           // as many rings as the hierarchy has left below this node (3, or 4 in a big panel)
    var remain = HIER[SUNS.hier].levels.length + 1 - root.depth;
    return Math.max(1, Math.min(remain, R > 240 ? 4 : 3));
  }
  function layout(root) {
    nRings = ringsFor(root);
    var ringW = (R - R0) / nRings, out = [];
    out.push({ node: root, key: root.key, a0: 0, a1: TAU, r0: 0, r1: R0, rel: 0 });
    (function rec(n, a0, a1, rel) {
      if (rel >= nRings || !n.children.length) return;
      var a = a0;
      n.children.forEach(function(c) {
        var da = (a1 - a0) * c.value / n.value;
        if (da >= 0.0015) {           // slivers thinner than a pixel are left out of the picture (still in the selection)
          out.push({ node: c, key: c.key, a0: a, a1: a + da, r0: R0 + rel * ringW, r1: R0 + (rel + 1) * ringW, rel: rel + 1 });
          rec(c, a, a + da, rel + 1);
        }
        a += da;
      });
    })(root, 0, TAU, 0);
    return out;
  }
  function geomOf(q) { return { a0: q.a0, a1: q.a1, r0: q.r0, r1: q.r1 }; }
  function lerpG(f, t) {
    return function(u) { return { a0: f.a0 + (t.a0 - f.a0) * u, a1: f.a1 + (t.a1 - f.a1) * u, r0: f.r0 + (t.r0 - f.r0) * u, r1: f.r1 + (t.r1 - f.r1) * u }; };
  }
  function isAncestor(a, n) { for (var p = n; p; p = p.parent) if (p === a) return true; return false; }

  function fillFor(q) {
    if (q.rel === 0 && !q.leave) return "#f3f6fa";
    var v = nodeVal(q.node);
    return v == null ? "#dcdfe4" : colorScale(v);
  }

  /* ---------- draw / morph to a new view root ---------- */
  function show(root, animate) {
    var my = ++token;
    viewRoot = root;
    var lay = layout(root), to = {};
    lay.forEach(function(L) { to[L.key] = L; });
    var all = [];
    lay.forEach(function(L) {                       // staying or entering slices
      var from = cur[L.key];
      L.enter = !from;
      if (!from) {                                  // entering: grow out of the nearest ancestor that was already on screen
        var a = L.node.parent;
        while (a && !cur[a.key]) a = a.parent;
        from = a ? geomOf(cur[a.key]) : { a0: L.a0, a1: L.a1, r0: L.r0, r1: L.r0 };
      }
      L.from = from; L.leave = false; all.push(L);
    });
    Object.keys(cur).forEach(function(k) {          // leaving slices: collapse into the nearest surviving ancestor, fading out
      if (to[k]) return;
      var node = byKey[k];
      if (!node) { delete cur[k]; return; }
      var a = node.parent;
      while (a && !to[a.key]) a = a.parent;
      var c = cur[k], tgt = a ? geomOf(to[a.key]) : (isAncestor(node, root) ? geomOf(c) : { a0: c.a0, a1: c.a1, r0: c.r1, r1: c.r1 });
      all.push({ node: node, key: k, leave: true, rel: c.rel, from: geomOf(c), to: tgt });
    });
    curLay = lay;

    var sel = arcG.selectAll("path.arc").data(all, function(q) { return q.key; });
    sel.exit().remove();
    sel.enter().append("path")
        .on("click", onClick)
        .on("mouseover", function(q) { if (!q.leave) hoverArc(q, d3.event); })
        .on("mousemove", function(q) { if (q.node && q.node.kind !== "college") moveTip(d3.event); })
        .on("mouseout", function(q) { hoverOut(q); })
        .attr("d", function(q) { return arcGen(q.from); })
        .style("opacity", function(q) { return q.enter ? 0 : 1; })
        .style("fill", fillFor);
    sel.attr("class", function(q) { return "arc" + (q.rel === 0 && !q.leave ? " center" : "") + (q.node.kind === "college" ? " leafarc" : "") + (q.node.leaf === SUNS.pin ? " pinned" : ""); });
    sel.style("pointer-events", function(q) { return q.leave ? "none" : null; });
    labG.selectAll("*").remove();
    ctrG.selectAll("*").remove();
    updateSel();

    sel.each(function(q) {
      var dest = q.leave ? q.to : geomOf(q), rel = q.rel, el = d3.select(this);
      var step = lerpG(q.from, dest);
      var tr = el.transition().duration(animate ? DUR : 0).ease("cubic-in-out");
      tr.attrTween("d", function() {
        return function(u) { var gg = step(u); cur[q.key] = { a0: gg.a0, a1: gg.a1, r0: gg.r0, r1: gg.r1, rel: rel }; return arcGen(gg); };
      });
      tr.style("opacity", q.leave ? 0 : 1);
      if (!q.leave) tr.style("fill", fillFor(q));
      if (q.leave) tr.each("end", function() { d3.select(this).remove(); delete cur[q.key]; });
    });
    setTimeout(function() { if (my === token) placeLabels(); }, animate ? DUR + 40 : 0);
    breadcrumb();
  }

  /* ---------- labels, center ---------- */
  function placeLabels() {
    labG.selectAll("*").remove();
    curLay.forEach(function(L) {
      if (L.rel === 0) return;
      var thick = L.r1 - L.r0, arcLen = (L.a1 - L.a0) * (L.r0 + L.r1) / 2;
      if (arcLen < 11) return;
      var name = nodeLabel(L.node), maxCh = Math.floor((thick - 6) / 5.3);
      if (maxCh < 3) return;
      if (name.length > maxCh) name = name.slice(0, maxCh - 1) + "…";
      var deg = (L.a0 + L.a1) / 2 * 180 / Math.PI - 90, rad = (L.r0 + L.r1) / 2;
      labG.append("text").attr("class", "arclabel").attr("text-anchor", "middle").attr("dy", ".35em")
          .attr("transform", "rotate(" + deg + ")translate(" + rad + ")" + (deg > 90 ? "rotate(180)" : ""))
          .text(name).style("opacity", 0).transition().duration(250).style("opacity", 1);
    });
    centerText();
  }
  function centerText() {
    ctrG.selectAll("*").remove();
    if (!viewRoot) return;
    var n = viewRoot, maxCh = Math.max(6, Math.floor(R0 * 1.75 / 6.2)), nm = nodeLabel(n);
    if (nm.length > maxCh) nm = nm.slice(0, maxCh - 1) + "…";
    function t(txt, y, cls) { ctrG.append("text").attr("class", "center-t " + cls).attr("y", y).text(txt); }
    var v = nodeVal(n);
    t(nm, -R0 * 0.3, "c1");
    t(d3.format(",")(n.members.length) + (n.members.length === 1 ? " college" : " colleges"), -R0 * 0.3 + 14, "c2");
    t(v == null ? "" : fmtV(S.metric.fmt, v), -R0 * 0.3 + 28, "c2");
    t(n.parent ? "▲ click: go up" : "click a slice", R0 * 0.62, "c3");
  }
  function breadcrumb() {
    var path = [];
    for (var n = viewRoot; n; n = n.parent) path.unshift(n);
    var box = d3.select("#sunCrumb");
    box.selectAll("*").remove();
    path.forEach(function(n, i) {
      if (i) box.append("span").attr("class", "sep").text("›");
      var last = i === path.length - 1 && SUNS.pin < 0;
      box.append("span").attr("class", "cr" + (last ? " cur" : "")).text(nodeLabel(n)).on("click", function() { if (!last) drill(n); });
    });
    if (SUNS.pin >= 0) { box.append("span").attr("class", "sep").text("›"); box.append("span").attr("class", "cr cur").text(COL[SUNS.pin].name); }
    box.append("span").attr("class", "rings").text(nRings + (nRings === 1 ? " ring" : " rings") + " shown");
  }

  /* ---------- interaction ---------- */
  function moveTip(ev) { tipEl.style.left = (ev.clientX + 14) + "px"; tipEl.style.top = (ev.clientY + 14) + "px"; }
  function pathName(n) { var a = []; for (var p = n; p && p.kind !== "root"; p = p.parent) a.unshift(nodeLabel(p)); return a.length ? a.join(" › ") : "All colleges"; }
  function hoverArc(q, ev) {
    var n = q.node;
    detail.highlight(q.key);
    if (n.kind === "college") { setHover(n.leaf, ev); return; }
    map.peek(n.members);
    var v = nodeVal(n), what = q.rel === 0 ? "center: click to go up" : "click to expand";
    showTip("<b>" + escHtml(pathName(n)) + '</b><br><span class="k">' + d3.format(",")(n.members.length) + " colleges" +
        (ENR != null ? " · " + d3.format(",")(Math.round(d3.sum(n.members, weightOf))) + " undergrads" : "") + "</span><br>" +
        '<span class="k">' + S.metric.label + ":</span> " + fmtV(S.metric.fmt, v) + '<br><span class="k">' + what + "</span>", ev);
  }
  function hoverOut(q) {
    detail.highlight(null); map.peek(null);
    if (q.node && q.node.kind === "college") setHover(-1); else hideTip();
  }
  function onClick(q) {
    if (q.leave) return;
    var n = q.node;
    if (q.rel === 0) { if (n.parent) drill(n.parent); return; }      // the center disk = go up one level
    if (n.kind === "college") { pinCollege(n); return; }
    drill(n);
  }
  function drill(n) {
    if (!n) return;
    SUNS.pin = -1; SUNS.rootKey = n.key;
    show(n, true);
    F.node = n === tree ? null : maskOf(n.members);
    detail.show(n);
    selectionChanged();
    story.afterZoom(n);
  }
  function drillKey(key) {
    var n = byKey[key];
    if (!n) return;
    if (n.kind === "college") pinCollege(n); else drill(n);
  }
  function pinCollege(n) {
    SUNS.pin = SUNS.pin === n.leaf ? -1 : n.leaf;
    F.node = SUNS.pin >= 0 ? maskOf([n.leaf]) : (viewRoot === tree ? null : maskOf(viewRoot.members));
    arcG.selectAll("path.arc").classed("pinned", function(q) { return q.node.leaf === SUNS.pin; });
    breadcrumb(); detail.show(viewRoot);
    selectionChanged();
  }

  /* ---------- panel life-cycle ---------- */
  function build() {
    var sz = sizeOf("b-sun"); W = sz.w; H = sz.h;
    if (!W || !H) return;
    R = Math.min(W, H) / 2 - 6; R0 = Math.max(40, R * 0.2);
    if (!tree) buildTree();
    emptyEl("#b-sun");
    svg = d3.select("#b-sun").append("svg").attr("width", W).attr("height", H);
    g = svg.append("g").attr("transform", "translate(" + W / 2 + "," + H / 2 + ")");
    arcG = g.append("g"); labG = g.append("g").style("pointer-events", "none"); ctrG = g.append("g").style("pointer-events", "none");
    cur = {}; curLay = [];
    var root = byKey[SUNS.rootKey] || tree;
    SUNS.rootKey = root.key;
    built = true;
    show(root, false);
    detail.show(root);
  }
  function recolor() {
    if (!built) return;
    arcG.selectAll("path.arc").transition().duration(600).style("fill", fillFor);
    centerText();
  }
  function updateSel() {
    if (!built) return;
    arcG.selectAll("path.arc").style("fill-opacity", function(q) {
      if (!anyF || q.leave || q.rel === 0) return 1;
      var m = q.node.members;
      for (var i = 0; i < m.length; i++) if (inSel[m[i]]) return 1;
      return 0.16;
    });
  }
  function hover(i) {         // a college was hovered in another view: ring its slice if it is on screen
    if (!built) return;
    arcG.selectAll("path.arc").classed("hv", function(q) { return i >= 0 && q.node.kind === "college" && q.node.leaf === i; });
  }
  function highlight(key) { if (built) arcG.selectAll("path.arc").classed("focus", function(q) { return key != null && q.key === key; }); }
  function reset() {
    SUNS.pin = -1; SUNS.rootKey = "All";
    if (built && tree && viewRoot !== tree) { show(tree, true); detail.show(tree); }
    else if (built) { breadcrumb(); detail.show(viewRoot); }
  }
  function setSize(m) { SUNS.size = m; if (!tree) return; computeValues(); if (built) show(viewRoot, true); detail.show(viewRoot); }
  function setHier(h) {
    SUNS.hier = h; SUNS.rootKey = "All"; SUNS.pin = -1; F.node = null;
    buildTree();
    if (built) { cur = {}; arcG.selectAll("*").remove(); show(tree, true); detail.show(tree); }
    selectionChanged();
  }
  function biggestRegion() {
    if (!tree) buildTree();
    var best = null, bv = -1;
    tree.children.forEach(function(r) {
      var v = d3.sum(r.members, weightOf);
      if (v > bv && r.name !== "Outlying Areas") { bv = v; best = r; }
    });
    return best;
  }
  return { build: build, recolor: recolor, updateSel: updateSel, hover: hover, highlight: highlight, reset: reset, setSize: setSize, setHier: setHier,
           drill: drill, drillKey: drillKey, biggestRegion: biggestRegion,
           getRoot: function() { if (!tree) buildTree(); return viewRoot || byKey[SUNS.rootKey] || tree; },
           getTree: function() { if (!tree) buildTree(); return tree; } };
})();

/* ---------------------------------------------------------------------
   SLICE DETAILS (companion to the sunburst): what the sunburst is centered on - totals, the pinned college if any,
   and its children ranked by the "color by" metric. Click a row = expand that slice. Hover = locate it (sunburst + map).
   --------------------------------------------------------------------- */
var detail = (function() {
  var root = null, asc = false, LIMIT = 40, ready = false;
  function skeleton() {
    var el = d3.select("#b-detail");
    el.selectAll("*").remove();
    el.append("div").attr("id", "dHead");
    el.append("div").attr("id", "dCard");
    el.append("div").attr("class", "dsub").attr("id", "dSub").style("cursor", "pointer").attr("title", "click to reverse the order")
        .on("click", function() { asc = !asc; if (root) show(root); });
    el.append("div").attr("id", "dRows");
    el.append("div").attr("class", "more").attr("id", "dMore");
    ready = true;
  }
  function show(n) {
    if (!n) return;
    root = n;
    var host = document.getElementById("b-detail");
    if (!host || !host.clientHeight) return;                     // panel not on screen right now
    if (!ready || !host.querySelector("#dHead")) skeleton();
    var all = sun.getTree(), v = nodeVal(n), vAll = nodeVal(all);
    var diff = "";
    if (n !== all && v != null && vAll != null) {
      diff = " <span style='color:#627084'>(" + (v >= vAll ? "+" : "−") + fmtV(S.metric.fmt === "pct" ? "pct" : S.metric.fmt, Math.abs(v - vAll)) + " vs. all colleges)</span>";
      if (S.metric.fmt === "ratio") diff = " <span style='color:#627084'>(all colleges: " + fmtV("ratio", vAll) + ")</span>";
    }
    var path = [];
    for (var p = n; p; p = p.parent) path.unshift(nodeLabel(p));
    d3.select("#dHead").html("<div class='dtitle'>" + escHtml(path.join(" › ")) + "</div><div class='dkpi'><b>" + d3.format(",")(n.members.length) + "</b> colleges" +
        (ENR != null ? " · <b>" + d3.format(".3s")(d3.sum(n.members, weightOf)).replace("G", "B") + "</b> undergrads" : "") + "<br>" + escHtml(S.metric.label) + ": <b>" + fmtV(S.metric.fmt, v) + "</b>" + diff + "</div>");
    card();

    var kids = n.children.map(function(c) { return { n: c, key: c.key, v: nodeVal(c) }; }).filter(function(d) { return d.v != null; });
    kids.sort(function(a, b) { return asc ? a.v - b.v : b.v - a.v; });
    var shown = kids.slice(0, LIMIT), vmax = d3.max(shown, function(d) { return d.v; }) || 1;
    var kind = n.children.length ? n.children[0].kind : "college";
    d3.select("#dSub").text((KIND_PLURAL[kind] || kind) + " by " + S.metric.label + (asc ? "  ▲" : "  ▼"));
    var rows = d3.select("#dRows").selectAll("div.crow").data(shown, function(d) { return d.key; });
    rows.exit().remove();
    var ent = rows.enter().append("div").attr("class", "crow")
        .on("click", function(d) { sun.drillKey(d.key); })
        .on("mouseover", function(d) { sun.highlight(d.key); if (d.n.kind === "college") setHover(d.n.leaf, d3.event); else map.peek(d.n.members); })
        .on("mouseout", function(d) { sun.highlight(null); if (d.n.kind === "college") setHover(-1); else map.peek(null); });
    ent.append("span").attr("class", "rk");
    ent.append("span").attr("class", "cn");
    ent.append("span").attr("class", "cb").append("i").style("width", "0%");
    ent.append("span").attr("class", "cv");
    ent.append("span").attr("class", "cc");
    rows.order();
    rows.select(".rk").text(function(d, i) { return i + 1; });
    rows.select(".cn").text(function(d) { return nodeLabel(d.n); }).attr("title", function(d) { return d.n.name; });
    rows.select(".cb i").transition().duration(600).style("width", function(d) { return Math.max(1.5, 100 * d.v / vmax) + "%"; }).style("background", function(d) { return colorScale(d.v); });
    rows.select(".cv").text(function(d) { return fmtS(S.metric.fmt, d.v); });
    rows.select(".cc").text(function(d) { return d.n.kind === "college" ? "" : d.n.members.length; });
    rows.classed("on", function(d) { return d.n.leaf === SUNS.pin; });
    d3.select("#dMore").text(kids.length > shown.length ? "+ " + (kids.length - shown.length) + " more (" + (asc ? "highest" : "lowest") + " values)" : "");
    updateSel();
  }
  function card() {
    var el = d3.select("#dCard");
    if (SUNS.pin < 0) { el.html(""); return; }
    var i = SUNS.pin, c = COL[i];
    el.html("<div class='card'><b>" + escHtml(c.name) + "</b><br><span class='k'>" + escHtml(c.city) + ", " + c.state + " · " + c.sector + " · " + c.locale + "</span><br>" +
        [EARN, DEBT, NETP, COMP, PELL, ADM].filter(function(j) { return j != null; }).map(function(j) {
          return "<span class='k'>" + DATA.short[j] + ":</span> " + fmtV(FMT[j], VAL[i][j]);
        }).join(" &nbsp;·&nbsp; ") + "<br><span class='k'>click the slice again to unpin</span></div>");
  }
  function updateSel() {
    d3.selectAll("#dRows .crow").classed("off", function(d) {
      if (!anyF) return false;
      var m = d.n.members;
      for (var i = 0; i < m.length; i++) if (inSel[m[i]]) return false;
      return true;
    });
  }
  function highlight(key) { d3.selectAll("#dRows .crow").classed("hl", function(d) { return key != null && d.key === key; }); }
  function build() { show(sun.getRoot()); }
  function recolor() { if (root) show(root); }
  return { build: build, show: show, updateSel: updateSel, highlight: highlight, recolor: recolor };
})();

/* ---------------------------------------------------------------------
   STATE RANKING (companion to the map): every state ranked by what the map is shading. Click = select/unselect that state
   (same as clicking it on the map). Hover = outline it on the map.
   --------------------------------------------------------------------- */
var srank = (function() {
  var asc = false, ready = false, feats = STATES.features.filter(function(f) { return f.id !== "PR"; });
  function skeleton() {
    var el = d3.select("#b-rank");
    el.selectAll("*").remove();
    el.append("div").attr("class", "dsub").attr("id", "rSub");
    el.append("div").attr("id", "rRows");
    ready = true;
  }
  function show() {
    var host = document.getElementById("b-rank");
    if (!host || !host.clientHeight) return;
    if (!ready || !host.querySelector("#rRows")) skeleton();
    var color = map.colorFn();
    var rows = feats.map(function(f) { return { abbr: f.id, name: f.properties.name, v: map.stateValue(f.id), n: (map.stateIdx[f.id] || []).length }; })
        .filter(function(d) { return d.v != null && d.n > 0; });
    rows.sort(function(a, b) { return asc ? a.v - b.v : b.v - a.v; });
    var vmax = d3.max(rows, function(d) { return d.v; }) || 1, fm = map.shadeFmt();
    d3.select("#rSub").text("states by " + map.shadeLabel() + (asc ? "  ▲" : "  ▼")).style("cursor", "pointer").attr("title", "click to reverse the order")
        .on("click", function() { asc = !asc; show(); });
    var sel = d3.select("#rRows").selectAll("div.crow").data(rows, function(d) { return d.abbr; });
    sel.exit().remove();
    var ent = sel.enter().append("div").attr("class", "crow")
        .on("click", function(d) { if (F.states[d.abbr]) delete F.states[d.abbr]; else F.states[d.abbr] = true; selectionChanged(); })
        .on("mouseover", function(d) { map.hlState(d.abbr); })
        .on("mouseout", function() { map.hlState(null); });
    ent.append("span").attr("class", "rk");
    ent.append("span").attr("class", "cn");
    ent.append("span").attr("class", "cb").append("i").style("width", "0%");
    ent.append("span").attr("class", "cv");
    ent.append("span").attr("class", "cc");
    sel.order();
    sel.select(".rk").text(function(d, i) { return i + 1; });
    sel.select(".cn").text(function(d) { return d.name; });
    sel.select(".cb i").transition().duration(600).style("width", function(d) { return Math.max(1.5, 100 * d.v / vmax) + "%"; }).style("background", function(d) { return color(d.abbr); });
    sel.select(".cv").text(function(d) { return fmtS(fm, d.v); });
    updateSel();
  }
  function updateSel() {
    var hit = {};
    if (anyF) for (var i = 0; i < N; i++) if (inSel[i]) hit[COL[i].state] = (hit[COL[i].state] || 0) + 1;
    d3.selectAll("#rRows .crow").classed("on", function(d) { return !!F.states[d.abbr]; }).classed("off", function(d) { return anyF && !hit[d.abbr]; })
        .select(".cc").text(function(d) { return anyF ? (hit[d.abbr] || 0) + "/" + d.n : d.n; });
  }
  function build() { show(); }
  return { build: build, show: show, updateSel: updateSel };
})();

/* =====================================================================
   7. MAP: state shading (metric or state-level context) + one dot per college
   ===================================================================== */
var map = (function() {
  var svg, W, H, proj, geo, statePaths, dots, ring, shade = "metric", built = false, stateIdx = {}, feats, dotPos = [];
  COL.forEach(function(c, i) { (stateIdx[c.state] || (stateIdx[c.state] = [])).push(i); });

  function stateValue(abbr) {
    if (shade === "metric") { var m = stateIdx[abbr]; return m ? wmean(m, S.metric.vals) : null; }
    var v = DATA.stateContext && DATA.stateContext.values[abbr];
    return v && v[shade] != null ? v[shade] : null;
  }
  function stateScale() {
    if (shade === "metric") return colorScale;
    var vals = Object.keys(DATA.stateContext.values).map(function(s) { return DATA.stateContext.values[s][shade]; }).filter(function(v) { return v != null; });
    var lo = d3.min(vals), hi = d3.max(vals);
    return d3.scale.linear().domain(d3.range(5).map(function(i) { return lo + (hi - lo) * i / 4; })).range(RAMP).clamp(true);
  }
  function stateFill(sc) { return function(f) { var v = stateValue(f.id); return v == null ? "#e6e9ee" : sc(v); }; }

  function build() {
    var sz = sizeOf("b-map"); W = sz.w; H = sz.h;
    emptyEl("#b-map");
    svg = d3.select("#b-map").append("svg").attr("width", W).attr("height", H);
    var s = Math.min(W / 960, H / 520);
    proj = d3.geo.albersUsa().scale(1070 * s).translate([W / 2, H / 2 - 4]);
    geo = d3.geo.path().projection(proj);
    feats = STATES.features.filter(function(f) { return f.id !== "PR"; });
    var sc = stateScale();
    statePaths = svg.append("g").selectAll("path").data(feats).enter().append("path").attr("class", "state")
        .attr("d", geo).style("fill", stateFill(sc)).style("fill-opacity", 0.8)
        .on("click", function(f) { if (F.states[f.id]) delete F.states[f.id]; else F.states[f.id] = true; selectionChanged(); story.afterState(); })
        .on("mouseover", function(f) {
          var v = stateValue(f.id), m = stateIdx[f.id] || [];
          var lbl = shade === "metric" ? S.metric.label : DATA.stateContext.labels[DATA.stateContext.columns.indexOf(shade)];
          var fm = shade === "metric" ? S.metric.fmt : "num";
          showTip("<b>" + f.properties.name + '</b><br><span class="k">' + m.length + " colleges</span><br><span class=\"k\">" + lbl + ":</span> " + (v == null ? "n/a" : fmtV(fm, v)), d3.event);
        })
        .on("mousemove", function() { var e = d3.event; tipEl.style.left = (e.clientX + 14) + "px"; tipEl.style.top = (e.clientY + 14) + "px"; })
        .on("mouseout", hideTip);

    var rmax = d3.max(d3.range(N), weightOf) || 1;
    var rs = d3.scale.sqrt().domain([0, rmax]).range([1.8, Math.max(4.5, 6 * s)]);
    var pts = [];
    for (var i = 0; i < N; i++) { var p = proj([COL[i].lon, COL[i].lat]); dotPos[i] = p; if (p) pts.push(i); }
    var lab = labelsK();
    dots = svg.append("g").selectAll("circle").data(pts).enter().append("circle").attr("class", "dot")
        .attr("cx", function(i) { return dotPos[i][0]; }).attr("cy", function(i) { return dotPos[i][1]; })
        .attr("r", function(i) { return rs(weightOf(i)); })
        .style("fill", function(i) { return cc(lab[i]); }).style("fill-opacity", 0.82)
        .on("mouseover", function(i) { setHover(i, d3.event); })
        .on("mousemove", function() { var e = d3.event; tipEl.style.left = (e.clientX + 14) + "px"; tipEl.style.top = (e.clientY + 14) + "px"; })
        .on("mouseout", function() { setHover(-1); });
    ring = svg.append("circle").attr("class", "hover-ring").attr("r", 8).style("display", "none");
    built = true;
    updateSel();
  }
  function recolor() {     // cluster colors changed (k) or metric changed
    if (!built) return;
    var lab = labelsK();
    dots.transition().duration(600).style("fill", function(i) { return cc(lab[i]); });
    recolorStates();
  }
  function recolorStates() { if (built) statePaths.transition().duration(600).style("fill", stateFill(stateScale())); }
  function updateSel() {
    if (!built) return;
    dots.classed("dim", function(i) { return anyF && !inSel[i]; });
    statePaths.classed("picked", function(f) { return !!F.states[f.id]; });
    if (anyF) {
      var hit = {};
      for (var i = 0; i < N; i++) if (inSel[i]) hit[COL[i].state] = true;
      statePaths.classed("nohit", function(f) { return !hit[f.id]; });
    } else statePaths.classed("nohit", false);
  }
  function hover(i) {
    if (!built) return;
    if (i >= 0 && dotPos[i]) ring.style("display", null).attr("cx", dotPos[i][0]).attr("cy", dotPos[i][1]); else ring.style("display", "none");
  }
  function setShade(v) { shade = v; recolorStates(); srank.show(); }
  var peekMask = null;
  function peek(list) {                 // outline the dots of these colleges (hovering a slice / a row elsewhere)
    if (!list) peekMask = null; else { peekMask = new Uint8Array(N); for (var q = 0; q < list.length; q++) peekMask[list[q]] = 1; }
    if (built) dots.classed("peek", function(i) { return !!peekMask && !!peekMask[i]; });
  }
  function hlState(abbr) { if (built) statePaths.classed("hl", function(f) { return abbr != null && f.id === abbr; }); }
  function colorFn() { var sc = stateScale(); return function(a) { var v = stateValue(a); return v == null ? "#e6e9ee" : sc(v); }; }
  function shadeLabel() { return shade === "metric" ? S.metric.label : DATA.stateContext.labels[DATA.stateContext.columns.indexOf(shade)]; }
  function shadeFmt() { return shade === "metric" ? S.metric.fmt : "num"; }
  function getShade() { return shade; }
  return { build: build, recolor: recolor, recolorStates: recolorStates, updateSel: updateSel, hover: hover, setShade: setShade, getShade: getShade, stateValue: stateValue,
           stateIdx: stateIdx, peek: peek, hlState: hlState, colorFn: colorFn, shadeLabel: shadeLabel, shadeFmt: shadeFmt };
})();

/* =====================================================================
   8. SIMILARITY MAP: data MDS / PCA biplot / any-vs-any scatterplot, with a brush
   ===================================================================== */
var emb = (function() {
  var M = { t: 8, r: 12, b: 36, l: 46 }, svg, g, W, H, w, h, xs, ys, cx = [], cy = [], dots, brush, brushG, ring, arrows, view = "mds", px = 0, py = 1, ax, ay, built = false, xLab, yLab;
  var nPC = DATA.pcaScores[0].length;
  ax = NETP != null ? NETP : 0; ay = EARN != null ? EARN : 1;

  function coords() {
    for (var i = 0; i < N; i++) {
      if (view === "mds") { cx[i] = DATA.dataMDS[i][0]; cy[i] = DATA.dataMDS[i][1]; }
      else if (view === "pca") { cx[i] = DATA.pcaScores[i][px]; cy[i] = DATA.pcaScores[i][py]; }
      else { cx[i] = VAL[i][ax]; cy[i] = VAL[i][ay]; }
    }
  }
  function build() {
    var sz = sizeOf("b-emb"); W = sz.w; H = sz.h; w = W - M.l - M.r; h = H - M.t - M.b;
    emptyEl("#b-emb");
    svg = d3.select("#b-emb").append("svg").attr("width", W).attr("height", H);
    g = svg.append("g").attr("transform", "translate(" + M.l + "," + M.t + ")");
    g.append("g").attr("class", "x-axis").attr("transform", "translate(0," + h + ")");
    g.append("g").attr("class", "y-axis");
    xLab = g.append("text").attr("class", "axis-label").attr("text-anchor", "middle").attr("x", w / 2).attr("y", h + 30);
    yLab = g.append("text").attr("class", "axis-label").attr("text-anchor", "middle").attr("transform", "translate(" + (-M.l + 11) + "," + h / 2 + ")rotate(-90)");
    xs = d3.scale.linear().range([0, w]); ys = d3.scale.linear().range([h, 0]);
    var lab = labelsK();
    var marks = g.append("g").attr("class", "marks");
    dots = marks.selectAll("circle").data(d3.range(N)).enter().append("circle").attr("class", "dot").attr("r", 2.8)
        .style("fill", function(i) { return cc(lab[i]); }).style("fill-opacity", 0.75);
    arrows = g.append("g").attr("class", "arrows").style("pointer-events", "none").style("opacity", 0);
    DATA.attributes.forEach(function(a, j) {
      var a_ = arrows.append("g").attr("class", "arr-" + j);
      a_.append("line").attr("class", "arrow");
      a_.append("text").attr("class", "arrow-label").text(DATA.short[j]);
    });
    brush = d3.svg.brush().x(xs).y(ys).on("brush", onBrush).on("brushend", onBrush);
    brushG = g.append("g").attr("class", "brush").call(brush);
    ring = g.append("circle").attr("class", "hover-ring").attr("r", 7).style("display", "none");
    svg.on("mousemove", onMove).on("mouseleave", function() { setHover(-1); });
    built = true;
    render(false);
    if (F.brush && F.brushExt) { brush.extent(F.brushExt); brushG.call(brush); }      // put the brush rectangle back after a rebuild
    updateSel();
  }
  function render(animate) {
    coords();
    var ex = d3.extent(cx), ey = d3.extent(cy), px_ = (ex[1] - ex[0]) * 0.05 || 1, py_ = (ey[1] - ey[0]) * 0.05 || 1;
    xs.domain([ex[0] - px_, ex[1] + px_]); ys.domain([ey[0] - py_, ey[1] + py_]);
    var t = animate ? 700 : 0;
    var xa = d3.svg.axis().scale(xs).orient("bottom").ticks(5), ya = d3.svg.axis().scale(ys).orient("left").ticks(5);
    if (view === "scatter") { xa.tickFormat(function(v) { return fmtS(FMT[ax], v); }); ya.tickFormat(function(v) { return fmtS(FMT[ay], v); }); }
    g.select(".x-axis").transition().duration(t).call(xa);
    g.select(".y-axis").transition().duration(t).call(ya);
    var vs = d3.sum(DATA.eigenvalues);
    xLab.text(view === "mds" ? "MDS dimension 1" : view === "pca" ? "PC" + (px + 1) + " (" + d3.format(".0%")(DATA.eigenvalues[px] / vs) + " of variance)" : DATA.labels[ax]);
    yLab.text(view === "mds" ? "MDS dimension 2" : view === "pca" ? "PC" + (py + 1) + " (" + d3.format(".0%")(DATA.eigenvalues[py] / vs) + " of variance)" : DATA.labels[ay]);
    dots.transition().duration(t).attr("cx", function(i) { return xs(cx[i]); }).attr("cy", function(i) { return ys(cy[i]); });

    // loading arrows (PCA view only), scaled so the longest reaches about half the cloud
    var maxLoad = 0, maxExt = Math.max(Math.abs(ex[0]), Math.abs(ex[1]), Math.abs(ey[0]), Math.abs(ey[1]));
    if (view === "pca") {
      for (var j = 0; j < P; j++) maxLoad = Math.max(maxLoad, Math.hypot(DATA.eigenvectors[px][j], DATA.eigenvectors[py][j]));
      var sc = 0.55 * maxExt / (maxLoad || 1);
      for (var j2 = 0; j2 < P; j2++) {
        var a_ = arrows.select(".arr-" + j2), X = xs(DATA.eigenvectors[px][j2] * sc), Y = ys(DATA.eigenvectors[py][j2] * sc);
        a_.select("line").transition().duration(t).attr("x1", xs(0)).attr("y1", ys(0)).attr("x2", X).attr("y2", Y);
        a_.select("text").transition().duration(t).attr("x", xs(0) + (X - xs(0)) * 1.08).attr("y", ys(0) + (Y - ys(0)) * 1.08);
      }
    }
    arrows.transition().duration(t).style("opacity", view === "pca" ? 1 : 0);
  }
  function onBrush() {
    if (brush.empty()) { F.brush = null; F.brushExt = null; }
    else {
      var e = brush.extent(), m = new Uint8Array(N);
      F.brushExt = e;
      for (var i = 0; i < N; i++) if (cx[i] >= e[0][0] && cx[i] <= e[1][0] && cy[i] >= e[0][1] && cy[i] <= e[1][1]) m[i] = 1;
      F.brush = m;
    }
    selectionChanged();
  }
  function onMove() {
    if (!built) return;
    var m = d3.mouse(g.node()), best = -1, bd = 12 * 12;
    for (var i = 0; i < N; i++) {
      if (anyF && !inSel[i]) continue;
      var dx = xs(cx[i]) - m[0], dy = ys(cy[i]) - m[1], d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    setHover(best, d3.event);
  }
  function recolor() { if (!built) return; var lab = labelsK(); dots.transition().duration(600).style("fill", function(i) { return cc(lab[i]); }); }
  function updateSel() { if (built) dots.classed("dim", function(i) { return anyF && !inSel[i]; }); }
  function hover(i) {
    if (!built) return;
    if (i >= 0) ring.style("display", null).attr("cx", xs(cx[i])).attr("cy", ys(cy[i])); else ring.style("display", "none");
  }
  function clearBrush() { if (built) { brush.clear(); brushG.call(brush); } F.brush = null; F.brushExt = null; }
  function setView(v, a, b) {          // v: mds | pca | scatter, a/b: PC index or attribute index
    view = v;
    if (v === "pca") { px = a != null ? a : px; py = b != null ? b : py; }
    if (v === "scatter") { ax = a != null ? a : ax; ay = b != null ? b : ay; }
    clearBrush();
    syncControls();
    render(true);
    selectionChanged();
  }
  function setBrush(x0, y0, x1, y1) {
    brush.extent([[x0, y0], [x1, y1]]); brushG.call(brush); brush.event(brushG);
  }
  function syncControls() {
    var vsel = document.getElementById("embView"), xsel = document.getElementById("embX"), ysel = document.getElementById("embY");
    vsel.value = view;
    xsel.style.display = ysel.style.display = view === "mds" ? "none" : "";
    var opts = view === "pca" ? d3.range(nPC).map(function(i) { return { v: i, t: "PC" + (i + 1) }; })
                              : DATA.attributes.map(function(a, j) { return { v: j, t: DATA.short[j] }; });
    [xsel, ysel].forEach(function(s, k) {
      var cur = view === "pca" ? (k ? py : px) : (k ? ay : ax);
      d3.select(s).selectAll("option").remove();
      d3.select(s).selectAll("option").data(opts).enter().append("option").attr("value", function(o) { return o.v; }).text(function(o) { return o.t; });
      s.value = cur;
    });
  }
  function current() { return { view: view, ax: ax, ay: ay, scaleX: xs, scaleY: ys }; }
  return { build: build, recolor: recolor, updateSel: updateSel, hover: hover, clearBrush: clearBrush, setView: setView, setBrush: setBrush, syncControls: syncControls,
           getPC: function() { return [px, py]; }, getAttr: function() { return [ax, ay]; }, current: current, getView: function() { return view; } };
})();

/* =====================================================================
   9. PARALLEL COORDINATES (lines on canvas for speed, axes + brushes on SVG)
   ===================================================================== */
var pcp = (function() {
  var M = { t: 62, r: 30, b: 12, l: 72 }, W, H, w, h, dims, xs, ys = {}, Y = {}, xpos = [], cv, ctx, cvH, ctxH, svg, g, brushes = {}, brushGs = {}, built = false, dpr = window.devicePixelRatio || 1;

  function ordinalDomain(dim) { return dim === "sector" ? SECTORS : REGION_ORDER; }
  function build() {
    var sz = sizeOf("b-pcp"); W = sz.w; H = sz.h; w = W - M.l - M.r; h = H - M.t - M.b;
    emptyEl("#b-pcp");
    var host = d3.select("#b-pcp");
    function mkCanvas() {
      var c = host.append("canvas").attr("width", w * dpr).attr("height", h * dpr).style("left", M.l + "px").style("top", M.t + "px")
          .style("width", w + "px").style("height", h + "px").style("pointer-events", "none");
      var x = c.node().getContext("2d"); x.scale(dpr, dpr); return { c: c, x: x };
    }
    var a = mkCanvas(); cv = a.c; ctx = a.x;
    var b = mkCanvas(); cvH = b.c; ctxH = b.x;
    svg = host.append("svg").attr("width", W).attr("height", H);
    g = svg.append("g").attr("transform", "translate(" + M.l + "," + M.t + ")");
    dims = S.order.slice();
    xs = d3.scale.ordinal().domain(dims).rangePoints([0, w], 0.45);
    dims.forEach(function(d) {
      if (isCat(d)) ys[d] = d3.scale.ordinal().domain(ordinalDomain(d)).rangePoints([h, 0], 0.6);
      else ys[d] = d3.scale.linear().domain([MIN[IDX[d]], MAX[IDX[d]]]).range([h, 0]);
      Y[d] = new Array(N);
      for (var i = 0; i < N; i++) Y[d][i] = isCat(d) ? ys[d](COL[i][d]) : ys[d](VAL[i][IDX[d]]);
    });
    xpos = dims.map(xs);

    var axG = g.selectAll("g.pcp-axis").data(dims).enter().append("g").attr("class", "pcp-axis")
        .attr("transform", function(d) { return "translate(" + xs(d) + ",0)"; });
    axG.each(function(d) {
      var ax_ = d3.svg.axis().scale(ys[d]).orient("left");
      if (isCat(d)) ax_.tickFormat(function(v) { return d === "sector" ? SEC_SHORT[v] : (REG_SHORT[v] || v); });
      else ax_.ticks(4).tickFormat(function(v) { return fmtS(FMT[IDX[d]], v); });
      d3.select(this).call(ax_);
      if (isCat(d)) d3.select(this).selectAll(".tick text").attr("class", "cat");
    });
    axG.append("text").attr("class", function(d) { return "pcp-label" + (isCat(d) ? " cat" : ""); }).attr("data-dim", function(d) { return d; })
        .attr("transform", "translate(-3,-9)rotate(-38)").attr("text-anchor", "start")
        .text(function(d) { return isCat(d) ? (d === "sector" ? "Sector" : "Region") : DATA.short[IDX[d]]; })
        .append("title").text(function(d) { return isCat(d) ? d : DATA.labels[IDX[d]]; });

    brushes = {}; brushGs = {};
    axG.each(function(d) {
      var sc = isCat(d) ? d3.scale.linear().domain([0, h]).range([0, h]) : ys[d];
      var br = d3.svg.brush().y(sc).on("brush", function() { onBrush(d); }).on("brushend", function() { onBrush(d); });
      brushes[d] = br;
      var bg = d3.select(this).append("g").attr("class", "brush").call(br);
      bg.selectAll("rect").attr("x", -8).attr("width", 16);
      brushGs[d] = bg;
      var s = F.pcp[d];                           // restore a filter after the axes were rebuilt
      if (s) {
        var ext = [s.lo, s.hi];
        if (s.cat) {      // categorical filters are stored as a set of categories; the pixel extent is rebuilt from the new axis
          var ps = Object.keys(s.set).map(function(c) { return ys[d](c); }).filter(function(v) { return v != null && !isNaN(v); });
          ext = ps.length ? [Math.max(0, d3.min(ps) - 8), Math.min(h, d3.max(ps) + 8)] : [0, 0];
        }
        br.extent(ext); bg.call(br); bg.selectAll("rect").attr("x", -8).attr("width", 16); }
    });
    svg.on("mousemove", onMove).on("mouseleave", function() { setHover(-1); });
    built = true;
    drawLines();
  }
  function onBrush(d) {
    var br = brushes[d];
    if (br.empty()) delete F.pcp[d];
    else {
      var e = br.extent();
      if (isCat(d)) {
        var set = {};
        ys[d].domain().forEach(function(c) { var yy = ys[d](c); if (yy >= e[0] && yy <= e[1]) set[c] = true; });
        F.pcp[d] = { cat: true, key: d, set: set, ext: e };
      } else F.pcp[d] = { j: IDX[d], lo: e[0], hi: e[1] };
    }
    selectionChanged();
  }
  function tracePath(i) {
    ctx.moveTo(xpos[0], Y[dims[0]][i]);
    for (var s = 1; s < dims.length; s++) ctx.lineTo(xpos[s], Y[dims[s]][i]);
  }
  function drawLines() {
    if (!built) return;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1; ctx.lineJoin = "round";
    var lab = labelsK(), i, c;
    if (anyF) {
      ctx.strokeStyle = "rgba(150,160,175,0.10)"; ctx.beginPath();
      for (i = 0; i < N; i++) if (!inSel[i]) tracePath(i);
      ctx.stroke();
    }
    var alpha = nSel > 900 ? 0.2 : nSel > 300 ? 0.3 : nSel > 80 ? 0.45 : 0.65;
    for (c = 0; c < S.k; c++) {
      ctx.strokeStyle = hexRgba(cc(c), alpha); ctx.beginPath();
      for (i = 0; i < N; i++) if (lab[i] === c && inSel[i]) tracePath(i);
      ctx.stroke();
    }
  }
  function onMove() {
    if (!built) return;
    var m = d3.mouse(g.node());
    var s = 0;
    while (s < xpos.length - 2 && m[0] > xpos[s + 1]) s++;
    if (m[0] < xpos[0] - 12 || m[0] > xpos[xpos.length - 1] + 12) { setHover(-1); return; }
    var t = Math.max(0, Math.min(1, (m[0] - xpos[s]) / (xpos[s + 1] - xpos[s])));
    var best = -1, bd = 8;
    for (var i = 0; i < N; i++) {
      if (anyF && !inSel[i]) continue;
      var yy = Y[dims[s]][i] * (1 - t) + Y[dims[s + 1]][i] * t, d = Math.abs(yy - m[1]);
      if (d < bd) { bd = d; best = i; }
    }
    setHover(best, d3.event);
  }
  function hover(i) {
    if (!built) return;
    ctxH.clearRect(0, 0, w, h);
    if (i < 0) return;
    ctxH.lineJoin = "round";
    [["#fff", 4.5], ["#111", 2]].forEach(function(st) {
      ctxH.strokeStyle = st[0]; ctxH.lineWidth = st[1]; ctxH.beginPath();
      ctxH.moveTo(xpos[0], Y[dims[0]][i]);
      for (var s = 1; s < dims.length; s++) ctxH.lineTo(xpos[s], Y[dims[s]][i]);
      ctxH.stroke();
    });
  }
  function highlightAxis(dim) { if (built) svg.selectAll(".pcp-label").classed("hl", function(d) { return d === dim; }); }
  function clearBrushes() { if (!built) { F.pcp = {}; return; } dims.forEach(function(d) { brushes[d].clear(); brushGs[d].call(brushes[d]); }); F.pcp = {}; }
  function setBrush(dim, lo, hi) { var br = brushes[dim]; br.extent([lo, hi]); brushGs[dim].call(br); brushGs[dim].selectAll("rect").attr("x", -8).attr("width", 16); br.event(brushGs[dim]); }
  return { build: build, drawLines: drawLines, hover: hover, highlightAxis: highlightAxis, clearBrushes: clearBrushes, setBrush: setBrush };
})();

/* =====================================================================
   10. VARIABLES' MDS: attributes placed by 1 - |correlation|. Click in order -> reorders the parallel axes.
   ===================================================================== */
var vmds = (function() {
  var M = { t: 10, r: 74, b: 10, l: 22 }, W, H, svg, g, built = false, xs, ys;

  function build() {
    var sz = sizeOf("b-vmds"); W = sz.w; H = sz.h;
    emptyEl("#b-vmds");
    svg = d3.select("#b-vmds").append("svg").attr("width", W).attr("height", H);
    g = svg.append("g").attr("transform", "translate(" + M.l + "," + M.t + ")");
    var w = W - M.l - M.r, h = H - M.t - M.b;
    var ex = d3.extent(DATA.variablesMDS, function(p) { return p[0]; }), ey = d3.extent(DATA.variablesMDS, function(p) { return p[1]; });
    // keep the aspect ratio so distances are not stretched
    var sx = w / ((ex[1] - ex[0]) || 1), sy = h / ((ey[1] - ey[0]) || 1), s = Math.min(sx, sy);
    xs = function(v) { return (v - ex[0]) * s + (w - (ex[1] - ex[0]) * s) / 2; };
    ys = function(v) { return h - ((v - ey[0]) * s + (h - (ey[1] - ey[0]) * s) / 2); };
    built = true;
    render();
  }
  function render() {
    if (!built) return;
    g.selectAll("*").remove();
    var pts = ATTR.map(function(a, j) { return { a: a, j: j, x: xs(DATA.variablesMDS[j][0]), y: ys(DATA.variablesMDS[j][1]) }; });
    // label de-overlap: labels start beside their point, then push apart vertically (and right) while they collide
    pts.forEach(function(p) { p.lx = p.x + 9; p.ly = p.y + 3; });
    for (var it = 0; it < 60; it++) {
      var moved = false;
      for (var a1 = 0; a1 < pts.length; a1++) for (var b1 = a1 + 1; b1 < pts.length; b1++) {
        var A = pts[a1], B = pts[b1], wA = DATA.short[A.j].length * 5.2, wB = DATA.short[B.j].length * 5.2;
        var ox = Math.min(A.lx + wA, B.lx + wB) - Math.max(A.lx, B.lx), oy = 11 - Math.abs(A.ly - B.ly);
        if (ox > 0 && oy > 0) { var dir = A.ly <= B.ly ? -1 : 1; A.ly += dir * oy / 2; B.ly -= dir * oy / 2; moved = true; }
      }
      if (!moved) break;
    }
    var grp = g.selectAll("g.v").data(pts).enter().append("g").attr("class", "v")
        .on("click", function(p) { onClick(p.a); })
        .on("mouseover", function(p) { pcp.highlightAxis(p.a); })
        .on("mouseout", function() { pcp.highlightAxis(null); });
    grp.append("circle").attr("class", "mds-point").attr("cx", function(p) { return p.x; }).attr("cy", function(p) { return p.y; })
        .attr("r", function(p) { return S.mdsClick.indexOf(p.a) >= 0 ? 9 : 6; })
        .style("fill", function(p) { return S.mdsClick.indexOf(p.a) >= 0 ? "#e6842e" : "#4f81bd"; })
        .style("stroke", function(p) { return S.metric.j === p.j ? "#111" : "#fff"; })
        .style("stroke-width", function(p) { return S.metric.j === p.j ? 2.2 : 1; })
      .append("title").text(function(p) { return DATA.labels[p.j] + " (click to add to the axis order)"; });
    grp.append("line").attr("class", "mds-leader").attr("x1", function(p) { return p.x; }).attr("y1", function(p) { return p.y; }).attr("x2", function(p) { return p.lx - 1; }).attr("y2", function(p) { return p.ly - 3.5; })
        .style("stroke", function(p) { return Math.abs(p.ly - 3 - p.y) > 5 ? "#9aa5b4" : "none"; });
    grp.append("text").attr("class", "mds-label").attr("x", function(p) { return p.lx; }).attr("y", function(p) { return p.ly; }).text(function(p) { return DATA.short[p.j]; });
    grp.filter(function(p) { return S.mdsClick.indexOf(p.a) >= 0; }).append("text").attr("class", "mds-badge")
        .attr("x", function(p) { return p.x; }).attr("y", function(p) { return p.y + 3; }).text(function(p) { return S.mdsClick.indexOf(p.a) + 1; });
  }
  function applyOrder() {
    var rest = ATTR.filter(function(a) { return S.mdsClick.indexOf(a) < 0; });
    S.order = DATA.categorical.concat(S.mdsClick, rest);
    pcp.build();
    render();
  }
  function onClick(a) {
    var k = S.mdsClick.indexOf(a);
    if (k < 0) S.mdsClick.push(a); else S.mdsClick.splice(k, 1);
    applyOrder();
  }
  // greedy chain: start with the most correlated pair (+ or -), keep adding the attribute closest to either end
  function bestOrder() {
    var C = DATA.correlation;
    function dist(i, j) { return 1 - Math.abs(C[i][j]); }
    var bi = 0, bj = 1;
    for (var i = 0; i < P; i++) for (var j = i + 1; j < P; j++) if (dist(i, j) < dist(bi, bj)) { bi = i; bj = j; }
    var chain = [bi, bj], unused = d3.range(P).filter(function(k) { return k !== bi && k !== bj; });
    while (unused.length) {
      var best = null;
      unused.forEach(function(k) {
        var df = dist(k, chain[0]), db = dist(k, chain[chain.length - 1]), d = Math.min(df, db);
        if (!best || d < best.d) best = { k: k, d: d, front: df < db };
      });
      if (best.front) chain.unshift(best.k); else chain.push(best.k);
      unused.splice(unused.indexOf(best.k), 1);
    }
    S.mdsClick = chain.map(function(k) { return ATTR[k]; });
    applyOrder();
  }
  function reset() { S.mdsClick = []; applyOrder(); }
  return { build: build, render: render, bestOrder: bestOrder, reset: reset };
})();

/* =====================================================================
   11. SIDE PANEL: k-means elbow bars, cluster chips (click = filter), selection summary
   ===================================================================== */
var side = (function() {
  var M = { t: 6, r: 8, b: 30, l: 34 }, svg, g, W, H, w, h, x, y, bars, built = false;
  var SUM = [EARN, DEBT, NETP, COMP, PELL, ADM, ENR, FAM].filter(function(j) { return j != null; });

  function buildElbow() {
    var sz = sizeOf("b-elbow"); W = sz.w; H = sz.h; w = W - M.l - M.r; h = H - M.t - M.b;
    emptyEl("#b-elbow");
    svg = d3.select("#b-elbow").append("svg").attr("width", W).attr("height", H);
    g = svg.append("g").attr("transform", "translate(" + M.l + "," + M.t + ")");
    var data = DATA.kmeansMSE.map(function(v, i) { return { k: i + 1, v: v }; });
    x = d3.scale.ordinal().domain(data.map(function(d) { return d.k; })).rangeRoundBands([0, w], 0.18);
    y = d3.scale.linear().domain([0, d3.max(data, function(d) { return d.v; })]).nice().range([h, 0]);
    g.append("g").attr("class", "x-axis").attr("transform", "translate(0," + h + ")").call(d3.svg.axis().scale(x).orient("bottom"));
    g.append("g").attr("class", "y-axis").call(d3.svg.axis().scale(y).orient("left").ticks(4).tickFormat(d3.format(".0f")));
    g.append("text").attr("class", "axis-label").attr("x", w / 2).attr("y", h + 26).attr("text-anchor", "middle").text("k (number of clusters)");
    g.append("text").attr("class", "axis-label").attr("transform", "translate(" + (-M.l + 9) + "," + h / 2 + ")rotate(-90)").attr("text-anchor", "middle").text("MSE");
    bars = g.selectAll("rect.bar-rect").data(data).enter().append("rect").attr("class", "bar-rect")
        .attr("x", function(d) { return x(d.k); }).attr("width", x.rangeBand()).attr("y", h).attr("height", 0)
        .on("click", function(d) { setK(d.k); })
        .on("mouseover", function(d) { showTip("<b>k = " + d.k + '</b><br><span class="k">MSE</span> ' + d.v.toFixed(2) + (d.k === DATA.elbowK ? '<br><span class="k">elbow suggestion</span>' : ""), d3.event); })
        .on("mousemove", function() { var e = d3.event; tipEl.style.left = (e.clientX + 14) + "px"; tipEl.style.top = (e.clientY + 14) + "px"; })
        .on("mouseout", hideTip);
    bars.transition().duration(600).attr("y", function(d) { return y(d.v); }).attr("height", function(d) { return h - y(d.v); });
    g.append("text").attr("class", "axis-label").attr("x", w - 2).attr("y", 10).attr("text-anchor", "end").attr("id", "elbowTitle");
    built = true;
    styleBars();
  }
  function styleBars() {
    if (!built) return;
    bars.attr("class", function(d) { return "bar-rect" + (d.k === S.k ? " selected" : ""); });
    d3.select("#elbowTitle").text("k-means: k = " + S.k);
  }
  function buildLegend() {
    var info = clusterInfo(), box = d3.select("#b-legend");
    box.selectAll("*").remove();
    var chips = box.selectAll("div.chip").data(d3.range(S.k)).enter().append("div").attr("class", "chip")
        .attr("title", function(c) { return "Cluster " + c + ": " + info.names[c] + " (" + info.counts[c] + " colleges) - click to filter"; })
        .on("click", function(c) { if (F.clusters[c]) delete F.clusters[c]; else F.clusters[c] = true; selectionChanged(); });
    chips.append("i").style("background", function(c) { return cc(c); });
    chips.append("span").text(function(c) { return c + ": " + info.names[c] + " (" + info.counts[c] + ")"; });
    styleChips();
  }
  function styleChips() {
    var any = hasKeys(F.clusters);
    d3.selectAll("#b-legend .chip").classed("on", function(c) { return !!F.clusters[c]; }).classed("off", function(c) { return any && !F.clusters[c]; });
  }
  var rowsBuilt = false;
  function buildSummary() {
    var box = d3.select("#b-summary");
    box.append("div").attr("class", "sumhead").attr("id", "sumHead");
    SUM.forEach(function(j) {
      var r = box.append("div").attr("class", "srow");
      r.append("span").attr("class", "nm").text(DATA.short[j]).attr("title", DATA.labels[j]);
      r.append("span").attr("class", "tr").append("span").attr("class", "bar").attr("id", "sb" + j).style("left", "50%").style("width", "0%");
      r.append("span").attr("class", "vl").attr("id", "sv" + j);
    });
    rowsBuilt = true;
  }
  function updateSummary() {
    if (!rowsBuilt) return;
    var idx = [];
    for (var i = 0; i < N; i++) if (inSel[i]) idx.push(i);
    d3.select("#sumHead").html(anyF ? "<b>" + d3.format(",")(idx.length) + "</b> selected vs. all colleges (bars = std. devs from overall mean)"
                                    : "all colleges (select something to compare)");
    SUM.forEach(function(j) {
      var m = idx.length ? d3.mean(idx, function(i) { return VAL[i][j]; }) : MEAN[j];
      var z = anyF && idx.length ? (m - MEAN[j]) / SD[j] : 0, half = Math.min(Math.abs(z) / 1.5, 1) * 50;
      d3.select("#sb" + j).style("left", (z >= 0 ? 50 : 50 - half) + "%").style("width", half + "%").style("background", z >= 0 ? "#3e7cc4" : "#d2793c");
      d3.select("#sv" + j).text(fmtS(FMT[j], m));
    });
  }
  function setK(k) {
    S.k = k; F.clusters = {};
    styleBars(); buildLegend(); fitLater();
    map.recolor(); emb.recolor();
    selectionChanged();
  }
  // Everything in this panel must always be visible: the content is laid out at its natural size and then scaled
  // down (never cut off) when the panel is small; when the panel is big, the elbow chart gets the spare height.
  var ELBOW_H = 96, fitRaf = null;
  function fitSide(rebuilding) {
    var box = document.getElementById("sideBox"), fit = document.getElementById("sideFit"), el = document.getElementById("b-elbow");
    if (!box || !fit) return;
    var bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    if (rebuilding) ELBOW_H = 96;
    el.style.height = ELBOW_H + "px";
    fit.style.transform = "none";
    var s = 1, H = 0;
    for (var i = 0; i < 5; i++) {
      fit.style.width = (bw / s) + "px";
      H = fit.offsetHeight;
      var ns = Math.min(1, bh / H);
      if (Math.abs(ns - s) < 0.005) break;
      s = Math.max(0.3, ns);
    }
    if (rebuilding && s >= 0.999 && H < bh - 4) {          // spare room: give it to the elbow chart
      ELBOW_H = 96 + Math.min(bh - H - 4, 170); el.style.height = ELBOW_H + "px";
    }
    fit.style.transform = s < 0.999 ? "scale(" + s + ")" : "none";
  }
  function fitLater() { if (fitRaf) cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(function() { fitSide(false); }); }
  function build() { fitSide(true); buildElbow(); }
  function update() { styleChips(); updateSummary(); fitLater(); }
  function init() { buildSummary(); buildLegend(); updateSummary(); }
  return { build: build, update: update, init: init, setK: setK, styleBars: styleBars, buildLegend: buildLegend };
})();

/* =====================================================================
   12. STORIES: preset selections that walk through the dashboard's guiding questions
   ===================================================================== */
var story = (function() {
  var tok = 0, el = document.getElementById("story"), mode = null;
  var DEFAULT = TABS_ON ? "Click, brush or zoom in any view - every other view follows. Use the tabs to focus on one or two views, or press \u2922 on any panel to view it alone."
                        : "Click, brush or expand in any view - every other view follows. Pick a story above for a guided example.";
  function say(html) { el.innerHTML = html; }
  function topSector(idx) {
    var cnt = {};
    idx.forEach(function(i) { cnt[COL[i].sector] = (cnt[COL[i].sector] || 0) + 1; });
    var best = Object.keys(cnt).sort(function(a, b) { return cnt[b] - cnt[a]; })[0];
    return best ? { name: best, share: cnt[best] / idx.length } : null;
  }
  function selIdx() { var a = []; for (var i = 0; i < N; i++) if (inSel[i]) a.push(i); return a; }

  function priceTrap() {
    if (NETP == null || EARN == null) return say("This story needs net price and earnings columns.");
    var my = ++tok; clearAll(true); mode = "price";
    var x0 = qnt(NETP, 0.65), y1 = qnt(EARN, 0.4);
    say("<b>The price trap</b> - switching to net price vs. earnings...");
    layout.ensure(["emb"], "sim", function() {
      if (my !== tok) return;
      emb.setView("scatter", NETP, EARN);
      setTimeout(function() {
        if (my !== tok) return;
        var sc = emb.current();
        emb.setBrush(x0, sc.scaleY.domain()[0], sc.scaleX.domain()[1], y1);
        var idx = selIdx(), ts = topSector(idx);
        say("<b>The price trap:</b> " + idx.length + " colleges charge a net price above " + fmtV("usd", x0) + " yet their graduates earn under " + fmtV("usd", y1) +
            (ts ? " - " + d3.format(".0%")(ts.share) + " are " + ts.name.toLowerCase() + ". Check the map and sunburst tabs for where they cluster." : "."));
      }, 800);
    });
  }
  function odds() {
    if (PELL == null || COMP == null) return say("This story needs Pell share and completion columns.");
    var my = ++tok; clearAll(true); mode = "odds";
    var lo = qnt(PELL, 0.75), cmin = qnt(COMP, 0.6);
    say("<b>Beating the odds</b> - switching to Pell share vs. completion...");
    layout.ensure(["emb", "pcp"], "overview", function() {
      if (my !== tok) return;
      emb.setView("scatter", PELL, COMP);
      setTimeout(function() {
        if (my !== tok) return;
        pcp.setBrush(DATA.attributes[PELL], lo, MAX[PELL]);
        pcp.setBrush(DATA.attributes[COMP], cmin, MAX[COMP]);
        var idx = selIdx(), ts = topSector(idx);
        say("<b>Beating the odds:</b> among colleges where at least " + d3.format(".0%")(lo) + " of students get Pell grants, " + idx.length + " still graduate " + d3.format(".0%")(cmin) + "+ within 150% of normal time" +
            (idx.length && EARN != null ? "; their average earnings are " + fmtV("usd", d3.mean(idx, function(i) { return VAL[i][EARN]; })) + " vs. " + fmtV("usd", MEAN[EARN]) + " overall" : "") +
            (ts ? " (mostly " + ts.name.toLowerCase() + ")." : "."));
      }, 800);
    });
  }
  function whereYouStudy() {
    var r = sun.biggestRegion();
    if (!r) return;
    var my = ++tok; clearAll(true); mode = "where";
    if (DATA.stateContext) { var s0 = DATA.stateContext.columns[0]; map.setShade(s0); document.getElementById("mapShade").value = s0; }
    layout.ensure(["sun"], "hier", function() { if (my === tok) sun.drill(r); });
  }
  function afterZoom(d) {      // called whenever the sunburst drills to a new node
    if (mode !== "where") return;
    if (d.kind === "root") { mode = null; say(DEFAULT); return; }
    if (d.kind === "college") return;
    var states = {};
    d.members.forEach(function(i) { (states[COL[i].state] = states[COL[i].state] || []).push(i); });
    var rows = Object.keys(states).map(function(s) { return { s: s, e: EARN != null ? wmean(states[s], S.metric.vals) : null, n: states[s].length }; })
        .filter(function(r) { return r.e != null; }).sort(function(a, b) { return b.e - a.e; });
    var txt = "<b>Where you study:</b> " + d.name + " has " + d.members.length + " colleges in " + rows.length + (rows.length === 1 ? " state" : " states");
    if (rows.length > 1) txt += "; the highest-" + S.metric.label.toLowerCase() + " state is " + rows[0].s + " (" + fmtV(S.metric.fmt, rows[0].e) + ") and the lowest is " + rows[rows.length - 1].s + " (" + fmtV(S.metric.fmt, rows[rows.length - 1].e) + ")";
    if (DATA.stateContext && rows.length >= 5) {
      var col = DATA.stateContext.columns[0], pairs = rows.map(function(r) { var v = DATA.stateContext.values[r.s]; return v && v[col] != null ? [v[col], r.e] : null; }).filter(Boolean);
      if (pairs.length >= 5) {
        var mx = d3.mean(pairs, function(p) { return p[0]; }), my = d3.mean(pairs, function(p) { return p[1]; });
        var sxy = d3.sum(pairs, function(p) { return (p[0] - mx) * (p[1] - my); }), sxx = d3.sum(pairs, function(p) { return (p[0] - mx) * (p[0] - mx); }), syy = d3.sum(pairs, function(p) { return (p[1] - my) * (p[1] - my); });
        if (sxx > 0 && syy > 0) txt += ". Across these " + pairs.length + " states, the correlation between " + DATA.stateContext.labels[0] + " and the metric is r = " + (sxy / Math.sqrt(sxx * syy)).toFixed(2);
      }
    }
    say(txt + ". Click a slice to expand further.");
  }
  function afterState() { /* map click: nothing extra */ }
  function reset() { ++tok; mode = null; say(DEFAULT); }
  return { priceTrap: priceTrap, odds: odds, whereYouStudy: whereYouStudy, afterZoom: afterZoom, afterState: afterState, reset: reset };
})();

/* =====================================================================
   13. WIRING: controls, clear, resize, start-up
   ===================================================================== */
function clearAll(keepStory) {
  F = freshFilters();
  sun.reset(); emb.clearBrush(); pcp.clearBrushes();
  if (!keepStory) story.reset();
  selectionChanged();
}

function initControls() {
  // color by
  d3.select("#colorBy").selectAll("option").data(METRICS).enter().append("option").attr("value", function(m) { return m.id; }).text(function(m) { return m.label; });
  document.getElementById("colorBy").value = S.metric.id;
  d3.select("#colorBy").on("change", function() {
    S.metric = metricById(this.value);
    rebuildColorScale(); sun.recolor(); detail.recolor(); map.recolorStates(); srank.show(); vmds.render();
    if (story) selectionChanged();
  });
  // map shading
  var sh = d3.select("#mapShade");
  var opts = [{ v: "metric", t: "color-by metric" }];
  if (DATA.stateContext) DATA.stateContext.columns.forEach(function(c, i) { opts.push({ v: c, t: DATA.stateContext.labels[i] }); });
  sh.selectAll("option").data(opts).enter().append("option").attr("value", function(o) { return o.v; }).text(function(o) { return o.t; });
  sh.on("change", function() { map.setShade(this.value); });
  if (opts.length === 1) sh.style("display", "none");
  // sunburst: which levels in which order, and what the slice angle means
  d3.select("#sunHier").selectAll("option").data(Object.keys(HIER)).enter().append("option").attr("value", function(k) { return k; }).text(function(k) { return HIER[k].label; });
  d3.select("#sunHier").on("change", function() { story.reset(); sun.setHier(this.value); });
  d3.select("#sunSize").on("change", function() { sun.setSize(this.value); });
  // similarity map view / axes
  d3.select("#embView").on("change", function() {
    var v = this.value;
    emb.setView(v, v === "pca" ? emb.getPC()[0] : emb.getAttr()[0], v === "pca" ? emb.getPC()[1] : emb.getAttr()[1]);
  });
  d3.select("#embX").on("change", function() { var v = emb.getView(); emb.setView(v, +this.value, v === "pca" ? emb.getPC()[1] : emb.getAttr()[1]); });
  d3.select("#embY").on("change", function() { var v = emb.getView(); emb.setView(v, v === "pca" ? emb.getPC()[0] : emb.getAttr()[0], +this.value); });
  emb.syncControls();
  // buttons
  d3.select("#bestOrder").on("click", function() { vmds.bestOrder(); });
  d3.select("#resetOrder").on("click", function() { vmds.reset(); });
  d3.select("#clearAll").on("click", function() { clearAll(); });
  d3.select("#st1").on("click", function() { story.priceTrap(); });
  d3.select("#st2").on("click", function() { story.odds(); });
  d3.select("#st3").on("click", function() { story.whereYouStudy(); });
  if (DATA.meta.synthetic) document.getElementById("synthTag").hidden = false;
}

/* =====================================================================
   LAYOUTS / TABS. Each tab is a different arrangement of the SAME panels on a 12-column x 2-row grid
   ([column from, column to, row from, row to]). The "focus" button on every panel header shows that panel alone.
   All shared state (filters, k, color-by, sunburst position, axis order, ...) lives outside the panels, so switching tab
   rebuilds only the panels that are visible and keeps everything else.
   ===================================================================== */
var LAYOUTS = {
  overview: { sun: [1, 5, 1, 2], map: [5, 9, 1, 2], emb: [9, 13, 1, 2], pcp: [1, 7, 2, 3], vmds: [7, 10, 2, 3], side: [10, 13, 2, 3] }
};
if (TABS_ON) {          // the other tabs only exist in the tabbed page
  LAYOUTS.hier = { sun: [1, 9, 1, 3], detail: [9, 13, 1, 3] };
  LAYOUTS.geo  = { map: [1, 9, 1, 3], rank: [9, 13, 1, 3] };
  LAYOUTS.sim  = { emb: [1, 9, 1, 3], side: [9, 13, 1, 3] };
  LAYOUTS.attr = { pcp: [1, 9, 1, 3], vmds: [9, 13, 1, 3] };
}
var TAB_ORDER = TABS_ON ? ["overview", "hier", "geo", "sim", "attr"] : ["overview"];
var PANEL_IDS = ["sun", "detail", "map", "rank", "emb", "pcp", "vmds", "side"];

var layout = (function() {
  var tab = "overview", single = null, raf = null;
  var BUILD = {
    sun: function() { sun.build(); }, detail: function() { detail.build(); }, map: function() { map.build(); }, rank: function() { srank.build(); },
    emb: function() { emb.build(); }, pcp: function() { pcp.build(); }, vmds: function() { vmds.build(); }, side: function() { side.build(); }
  };
  function spec() { if (single) { var o = {}; o[single] = [1, 13, 1, 3]; return o; } return LAYOUTS[tab]; }
  function isShown(id) { return !!spec()[id]; }
  function rebuild() {
    PANEL_IDS.forEach(function(id) { if (isShown(id)) BUILD[id](); });
    selectionChanged();
  }
  function apply() {
    var sp = spec();
    PANEL_IDS.forEach(function(id) {
      var el = document.getElementById("p-" + id), p = sp[id];
      if (!el) return;                                   // (the single-screen page has no detail / rank panel)
      if (!p) { el.style.display = "none"; return; }
      el.style.display = "";
      el.style.gridColumn = p[0] + " / " + p[1];
      el.style.gridRow = p[2] + " / " + p[3];
      el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
      var b = el.querySelector(".maxbtn");
      if (b) { b.textContent = single === id ? "⤡" : "⤢"; b.title = single === id ? "Back to the tab layout (Esc)" : "Focus this view alone"; }
    });
    d3.selectAll("#tabs .tab").classed("on", function() { return !single && this.getAttribute("data-l") === tab; });
    d3.select("#focusBack").style("display", single ? "" : "none");
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function() { raf = requestAnimationFrame(rebuild); });     // wait until the grid has its new size
  }
  function set(t) { if (!LAYOUTS[t]) return; tab = t; single = null; apply(); }
  function focus(id) { single = single === id ? null : id; apply(); }
  function unfocus() { if (single) { single = null; apply(); } }
  function ensure(ids, prefTab, cb) {          // make sure these panels are on screen (switching tab if not), then run cb
    if (ids.every(isShown)) return cb();
    single = null;
    tab = ids.every(function(id) { return LAYOUTS[prefTab][id]; }) ? prefTab : "overview";
    apply();
    setTimeout(cb, 450);
  }
  // ---- single-screen "pseudo zoom": click a view's title bar -> it grows, the others shrink but stay visible ----
  var ROWS = [["sun", "map", "emb"], ["pcp", "vmds", "side"]], DW = { sun: 4, map: 4, emb: 4, pcp: 6, vmds: 3, side: 3 };
  var zoomed = null, zTimer = null;
  function zoomApply() {
    ROWS.forEach(function(ids, r) {
      var rowEl = document.getElementById("row" + r), has = ids.indexOf(zoomed) >= 0;
      var g = document.getElementById("grid"), cs = getComputedStyle(g);
      var gh = g.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8;   // height available to the 2 rows
      var other = Math.max(gh * 0.4, 230), big = Math.max(gh - other, gh / 2);                   // the shrunk row never gets too small to read
      rowEl.style.flexGrow = zoomed ? (has ? big : gh - big) : 1;
      ids.forEach(function(id) {
        var el = document.getElementById("p-" + id);
        el.style.flexGrow = id === zoomed ? DW[id] * 2.6 : DW[id];
        el.classList.toggle("zoomed", id === zoomed);
        var b = el.querySelector(".maxbtn");
        if (b) { b.textContent = id === zoomed ? "\u2921" : "\u2922"; b.title = id === zoomed ? "Back to the equal layout (Esc)" : "Enlarge this view (the others shrink)"; }
      });
    });
    clearTimeout(zTimer);
    zTimer = setTimeout(rebuild, 420);                   // redraw at the new size once the animation has finished
  }
  function zoom(id) { zoomed = zoomed === id ? null : id; zoomApply(); }
  function initZoom() {
    var grid = document.getElementById("grid");
    grid.classList.add("rows");
    ROWS.forEach(function(ids, r) {
      var row = document.createElement("div"); row.className = "grow"; row.id = "row" + r;
      grid.appendChild(row);
      ids.forEach(function(id) { row.appendChild(document.getElementById("p-" + id)); });
    });
    ROWS.forEach(function(ids) { ids.forEach(function(id) {
      var el = document.getElementById("p-" + id), ph = el.querySelector(".ph");
      el.style.flexGrow = DW[id];
      var b = document.createElement("button");
      b.className = "maxbtn"; b.textContent = "\u2922"; b.title = "Enlarge this view (the others shrink)";
      ph.appendChild(b);
      ph.title = "Click the title bar to enlarge this view - the others shrink but stay visible";
      ph.addEventListener("click", function(e) {
        if (/^(SELECT|OPTION|INPUT|LABEL)$/.test(e.target.tagName)) return;
        zoom(id);
      });
    }); });
    document.addEventListener("keydown", function(e) {
      var t = e.target && e.target.tagName;
      if (t === "SELECT" || t === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && zoomed) zoom(zoomed);
    });
  }
  function init() {
    if (!TABS_ON) { initZoom(); return; }                // one screen: no tabs; views enlarge in place instead
    d3.selectAll("#tabs .tab").on("click", function() { set(this.getAttribute("data-l")); });
    var back = document.createElement("button");
    back.id = "focusBack"; back.className = "tab"; back.textContent = "◂ back (Esc)"; back.style.display = "none"; back.style.color = "#b3470c";
    back.addEventListener("click", unfocus);
    document.getElementById("tabs").appendChild(back);
    PANEL_IDS.forEach(function(id) {
      var ph = document.querySelector("#p-" + id + " .ph");
      if (!ph) return;
      var b = document.createElement("button");
      b.className = "maxbtn"; b.textContent = "⤢"; b.title = "Focus this view alone";
      b.addEventListener("click", function() { focus(id); });
      ph.appendChild(b);
    });
    document.addEventListener("keydown", function(e) {
      var t = e.target && e.target.tagName;
      if (t === "SELECT" || t === "INPUT" || t === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") unfocus();
      var k = parseInt(e.key, 10);
      if (k >= 1 && k <= TAB_ORDER.length) set(TAB_ORDER[k - 1]);
    });
  }
  return { init: init, apply: apply, set: set, focus: focus, unfocus: unfocus, ensure: ensure, rebuild: rebuild, zoom: zoom, current: function() { return single || tab; }, isShown: isShown };
})();

var resizeTimer = null;
window.addEventListener("resize", function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function() { layout.rebuild(); }, 250);    // filters, sunburst position and axis order are kept
});

// ---- start-up ----
rebuildColorScale();
initControls();
side.init();
layout.init();
layout.apply();
selectionChanged();

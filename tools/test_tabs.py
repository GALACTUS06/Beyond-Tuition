"""Headless test of tabs, focus mode and the drill-down sunburst. python tools/test_tabs.py [w h]"""
import sys, os, json, math
from playwright.sync_api import sync_playwright
W = int(sys.argv[1]) if len(sys.argv) > 1 else 1600
H = int(sys.argv[2]) if len(sys.argv) > 2 else 900
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs("/tmp/shots", exist_ok=True)
errs = []; fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--allow-file-access-from-files"])
    pg = b.new_page(viewport={"width": W, "height": H})
    pg.on("pageerror", lambda e: errs.append("pageerror: %s" % e))
    pg.on("console", lambda m: errs.append("console.%s: %s" % (m.type, m.text)) if m.type in ("error", "warning") else None)
    pg.goto("file://%s/index_tabs.html" % root); pg.wait_for_timeout(1800)
    shot = lambda n: pg.screenshot(path="/tmp/shots/t_%s_%dx%d.png" % (n, W, H))
    shown = lambda: pg.evaluate("() => Array.from(document.querySelectorAll('.panel')).filter(e => e.style.display !== 'none').map(e => e.id)")
    scroll_ok = lambda: pg.evaluate("() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1")
    crumb = lambda: pg.evaluate("() => document.getElementById('sunCrumb').innerText.replace(/\\s+/g,' ')")
    narcs = lambda: pg.evaluate("() => document.querySelectorAll('#b-sun path.arc').length")
    badge = lambda: pg.inner_text("#badge")

    def arc_xy(pick):          # screen position of a slice, chosen in page by JS expression `pick` over arc data list
        return pg.evaluate("""(pick) => {
            const svg = document.querySelector('#b-sun svg'), r = svg.getBoundingClientRect();
            const ds = d3.selectAll('#b-sun path.arc').data().filter(q => !q.leave);
            const q = (new Function('ds', 'return ' + pick))(ds);
            if (!q) return null;
            const th = (q.a0 + q.a1) / 2, rad = (q.r0 + q.r1) / 2;
            return {x: r.left + r.width / 2 + rad * Math.sin(th), y: r.top + r.height / 2 - rad * Math.cos(th), key: q.key, rel: q.rel, kind: q.node.kind};
        }""", pick)

    check(shown() == ["p-sun", "p-map", "p-emb", "p-pcp", "p-vmds", "p-side"], "overview shows 6 panels: %s" % shown())
    check(scroll_ok(), "overview does not scroll"); shot("00_overview")

    # ---------- tabs ----------
    expect = {"hier": ["p-sun", "p-detail"], "geo": ["p-map", "p-rank"], "sim": ["p-emb", "p-side"], "attr": ["p-pcp", "p-vmds"]}
    for l, ids in expect.items():
        pg.click('#tabs .tab[data-l="%s"]' % l); pg.wait_for_timeout(900)
        check(shown() == ids, "tab %s shows %s (got %s)" % (l, ids, shown())); check(scroll_ok(), "tab %s does not scroll" % l); shot("tab_" + l)

    # ---------- hierarchy tab: drill down ----------
    pg.click('#tabs .tab[data-l="hier"]'); pg.wait_for_timeout(900)
    n0 = narcs(); print("arcs at root:", n0, "| crumb:", crumb())
    pt = arc_xy("ds.filter(q => q.rel === 1).sort((a, b) => (b.a1 - b.a0) - (a.a1 - a.a0))[0]")
    pg.mouse.move(pt["x"], pt["y"]); pg.wait_for_timeout(250); shot("hier_hover")
    pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(330); shot("hier_drill_mid")      # mid-morph frame
    pg.wait_for_timeout(1200); shot("hier_drill1")
    c1 = crumb(); print("after drill 1:", c1, "| arcs:", narcs(), "|", badge())
    check(c1.startswith("All colleges") and c1.count("›") == 1, "breadcrumb has 2 levels after one drill")
    check("selected" in badge(), "drilling selects the slice's colleges")
    check(pg.evaluate("() => document.querySelectorAll('#dRows .crow').length") > 3, "detail panel lists the children")
    # drill again (a state), then again (a sector) -> colleges
    for step in (2, 3):
        pt = arc_xy("ds.filter(q => q.rel === 1).sort((a, b) => (b.a1 - b.a0) - (a.a1 - a.a0))[0]")
        pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(1300)
        print("after drill %d:" % step, crumb(), "| arcs:", narcs())
    shot("hier_drill3")
    kinds = pg.evaluate("() => Array.from(new Set(d3.selectAll('#b-sun path.arc').data().map(q => q.node.kind)))")
    check("college" in kinds, "individual colleges appear after drilling to a sector: %s" % kinds)
    # pin a college
    pt = arc_xy("ds.filter(q => q.node.kind === 'college').sort((a, b) => (b.a1 - b.a0) - (a.a1 - a.a0))[0]")
    pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(500); shot("hier_pinned")
    check(pg.evaluate("() => !!document.querySelector('#dCard .card')"), "pinned college shows a card"); print("pinned crumb:", crumb(), "|", badge())
    check(badge().startswith("1 of"), "pinned college => selection of exactly 1")
    pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(400)
    check(not pg.evaluate("() => !!document.querySelector('#dCard .card')"), "clicking again unpins")
    # filters survive a tab change
    sel_before = badge()
    pg.click('#tabs .tab[data-l="geo"]'); pg.wait_for_timeout(1000); shot("geo_with_selection")
    check(badge() == sel_before, "selection kept across tab change (%s)" % badge())
    check(pg.evaluate("() => document.querySelectorAll('#b-map circle.dim').length") > 100, "map dims unselected colleges")
    check(pg.evaluate("() => document.querySelectorAll('#rRows .crow.on, #rRows .crow.off').length") > 0, "state ranking reflects the selection")
    # click a state row => selects the state
    pg.evaluate("() => { document.getElementById('clearAll').click(); }"); pg.wait_for_timeout(500)
    pg.click("#rRows .crow:nth-child(2)"); pg.wait_for_timeout(400)
    check("selected" in badge(), "clicking a state-ranking row selects that state (%s)" % badge()); shot("geo_state_row")
    pg.click('#tabs .tab[data-l="hier"]'); pg.wait_for_timeout(1000); shot("hier_back")
    c = crumb(); print("back on hier tab, crumb:", c)
    check(c.count("›") == 0, "Clear selection also returns the sunburst to the root (position persistence is checked separately below)")
    # go up: center click, then breadcrumb root
    ctr = arc_xy("ds.filter(q => q.rel === 0)[0]")
    pg.mouse.click(ctr["x"], ctr["y"]); pg.wait_for_timeout(1200); print("after center click:", crumb())
    pg.click("#sunCrumb .cr:first-child"); pg.wait_for_timeout(1200); print("after crumb click:", crumb(), "| arcs:", narcs(), "|", badge())
    check("selected" in badge(), "the state filter from the ranking still applies after going back to the root (filters are ANDed)")
    pg.click("#clearAll"); pg.wait_for_timeout(700)
    check(badge().startswith("all"), "Clear selection removes every filter")

    # ---------- hierarchy / size options ----------
    pg.select_option("#sunHier", "srs"); pg.wait_for_timeout(1300); shot("hier_sector_first"); print("hier srs crumb:", crumb(), "arcs", narcs())
    pg.select_option("#sunSize", "count"); pg.wait_for_timeout(1100); shot("hier_count")
    pg.select_option("#sunHier", "rls"); pg.wait_for_timeout(1300)
    pg.select_option("#sunHier", "rss"); pg.select_option("#sunSize", "enroll"); pg.wait_for_timeout(1300)
    pg.select_option("#colorBy", "EARN_PER_DEBT"); pg.wait_for_timeout(900); shot("hier_color_ratio")

    # ---------- focus mode ----------
    pg.click("#p-sun .maxbtn"); pg.wait_for_timeout(1000)
    check(shown() == ["p-sun"], "focus button shows the sunburst alone: %s" % shown()); check(scroll_ok(), "focus mode does not scroll"); shot("focus_sun")
    pt = arc_xy("ds.filter(q => q.rel === 1).sort((a, b) => (b.a1 - b.a0) - (a.a1 - a.a0))[0]")
    pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(1300); shot("focus_sun_drilled")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(900)
    check(shown() == ["p-sun", "p-detail"], "Esc returns to the tab layout: %s" % shown())
    for key, ids in (("1", 6), ("3", 2), ("5", 2)):
        pg.keyboard.press(key); pg.wait_for_timeout(600)
        check(len(shown()) == ids, "key %s switches tab (%d panels)" % (key, len(shown())))
    for l in ("overview",):
        pg.click('#tabs .tab[data-l="%s"]' % l); pg.wait_for_timeout(800)
    # ---------- stories from a tab that lacks the views ----------
    pg.click('#tabs .tab[data-l="attr"]'); pg.wait_for_timeout(700)
    pg.click("#st3"); pg.wait_for_timeout(2600); shot("story_where")
    check("p-sun" in shown(), "'Where you study' switches to a tab with the sunburst: %s" % shown()); print("story crumb:", crumb(), "|", pg.inner_text("#story")[:120])
    pg.click('#tabs .tab[data-l="geo"]'); pg.wait_for_timeout(600)
    pg.click("#st1"); pg.wait_for_timeout(2800); shot("story_price")
    check("p-emb" in shown(), "'Price trap' switches to a tab with the similarity map: %s" % shown()); print(badge())
    pg.click("#st2"); pg.wait_for_timeout(2800); check("p-pcp" in shown() and "p-emb" in shown(), "'Beating the odds' needs emb+pcp: %s" % shown()); print(badge())
    # brush survives tab change
    pg.click('#tabs .tab[data-l="sim"]'); pg.wait_for_timeout(900)
    pg.click("#clearAll"); pg.wait_for_timeout(500)
    pg.evaluate("() => { var c = emb.current(), xs = c.scaleX.domain(), ys = c.scaleY.domain(); emb.setBrush(xs[0] + (xs[1]-xs[0])*.2, ys[0] + (ys[1]-ys[0])*.2, xs[0] + (xs[1]-xs[0])*.5, ys[0] + (ys[1]-ys[0])*.6); }"); pg.wait_for_timeout(300)
    bw = lambda: pg.evaluate("() => { var e = document.querySelector('#b-emb .brush .extent'); return e ? +e.getAttribute('width') : -1; }")
    w0, n0 = bw(), badge()
    pg.click('#tabs .tab[data-l="attr"]'); pg.wait_for_timeout(800); pg.click('#tabs .tab[data-l="sim"]'); pg.wait_for_timeout(900)
    check(w0 > 0 and abs(bw() - w0) < 1 and badge() == n0, "similarity brush rectangle and selection restored after a tab round-trip (%s -> %s)" % (w0, bw()))
    # the sunburst keeps its place when you leave and come back (nothing cleared in between)
    pg.click("#clearAll"); pg.click('#tabs .tab[data-l="hier"]'); pg.wait_for_timeout(900)
    pg.evaluate("() => { var q = d3.selectAll('#b-sun path.arc').data().filter(q => q.rel === 1 && !q.leave)[0]; sun.drillKey(q.key); }"); pg.wait_for_timeout(1300)
    cb = crumb(); pg.click('#tabs .tab[data-l="geo"]'); pg.wait_for_timeout(800); pg.click('#tabs .tab[data-l="hier"]'); pg.wait_for_timeout(1000)
    check(cb.count("›") == 1 and crumb() == cb, "sunburst position kept across a tab round-trip (%s)" % crumb())
    b.close()
print("\nERRORS:", errs if errs else "none")
print("FAILS:", fails if fails else "none")

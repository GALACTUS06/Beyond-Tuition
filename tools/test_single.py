"""Single-screen page: all 6 views always visible, click-to-enlarge pseudo zoom, linked brushing. python tools/test_single.py [w h]"""
import sys, os
from playwright.sync_api import sync_playwright
W = int(sys.argv[1]) if len(sys.argv) > 1 else 1600
H = int(sys.argv[2]) if len(sys.argv) > 2 else 900
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errs = []; fails = []
def check(c, m):
    print(("PASS " if c else "FAIL ") + m)
    if not c: fails.append(m)
IDS = ["sun", "map", "emb", "pcp", "vmds", "side"]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--allow-file-access-from-files"])
    pg = b.new_page(viewport={"width": W, "height": H})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type in ("error", "warning") else None)
    pg.goto("file://%s/index.html" % root); pg.wait_for_timeout(1800)
    shot = lambda n: pg.screenshot(path="/tmp/shots/s_%s_%dx%d.png" % (n, W, H))
    rect = lambda i: pg.evaluate("i => { const r = document.getElementById('p-' + i).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }", i)
    def allvis():
        ok = True
        for i in IDS:
            l, t, w, h = rect(i)
            ok &= w > 150 and h > 120 and l >= -1 and t >= -1 and l + w <= W + 1 and t + h <= H + 1
        return ok
    noscroll = lambda: pg.evaluate("() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1")
    check(pg.evaluate("() => !document.getElementById('tabs')"), "no tab bar")
    check(allvis() and noscroll(), "default: 6 views visible, no scroll"); shot("00_default")
    base = {i: rect(i) for i in IDS}
    for i in IDS:
        pg.click("#p-%s .ph h2" % i); pg.wait_for_timeout(900)
        r = rect(i)
        check(r[2] * r[3] > 1.3 * base[i][2] * base[i][3], "%s grows (%.0f -> %.0f px area)" % (i, base[i][2] * base[i][3], r[2] * r[3]))
        check(allvis() and noscroll(), "%s zoomed: all 6 views still visible, no scroll" % i)
        shot("zoom_" + i)
        pg.click("#p-%s .ph h2" % i); pg.wait_for_timeout(900)
        r2 = rect(i); check(abs(r2[2] - base[i][2]) < 3 and abs(r2[3] - base[i][3]) < 3, "%s returns to normal size" % i)
    pg.click("#p-emb .ph h2"); pg.wait_for_timeout(900)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(900)
    check(abs(rect("emb")[2] - base["emb"][2]) < 3, "Esc restores the layout")
    # linked brushing still works while enlarged
    pg.click("#p-emb .ph h2"); pg.wait_for_timeout(900)
    bb = pg.evaluate("() => { const r = document.querySelector('#b-emb svg').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
    pg.mouse.move(bb[0] + bb[2] * .3, bb[1] + bb[3] * .3); pg.mouse.down()
    pg.mouse.move(bb[0] + bb[2] * .6, bb[1] + bb[3] * .6, steps=6); pg.mouse.up(); pg.wait_for_timeout(500)
    badge = pg.inner_text("#badge"); check("selected" in badge, "brush in enlarged similarity map selects colleges: " + badge)
    shot("brush_zoomed")
    pg.click("#st1"); pg.wait_for_timeout(1200)
    check(allvis(), "story button works in place, views visible"); shot("story")
    pg.click("#clearAll"); pg.wait_for_timeout(600)
    check(not errs, "no console errors %s" % errs[:3])
    print("FAILS:", fails)
    b.close()
sys.exit(1 if fails else 0)

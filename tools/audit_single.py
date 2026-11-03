"""Audit: in every state (default + each view enlarged) and size, is anything clipped/hidden? python tools/audit_single.py"""
import sys, os
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDS = ["sun","map","emb","pcp","vmds","side"]
JS = """() => {
 const out = [];
 const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
 document.querySelectorAll('.panel').forEach(p => {
   const pr = p.getBoundingClientRect();
   // every control / header item must lie fully inside its panel
   p.querySelectorAll('.ph > *, .ph select, .ctlr > *, .pbtn button, .crumb, .maxbtn').forEach(e => {
     if (!vis(e)) { out.push(p.id + ': hidden ' + e.tagName + '.' + e.className + '#' + e.id); return; }
     const r = e.getBoundingClientRect(), ph = p.querySelector('.ph').getBoundingClientRect();
     if (r.right > ph.right + 1 || r.left < ph.left - 1) out.push(p.id + ': header item clipped ' + e.tagName + '#' + e.id + '.' + e.className.toString().slice(0,20) + ' right ' + Math.round(r.right - ph.right));
   });
   // text/content that is cut by overflow:hidden
   p.querySelectorAll('#b-summary, #b-legend, #b-elbow, .pb, .listbox').forEach(e => {
     if (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2) out.push(p.id + ': ' + (e.id||e.className) + ' content cut (scroll ' + e.scrollWidth + 'x' + e.scrollHeight + ' vs ' + e.clientWidth + 'x' + e.clientHeight + ')');
   });
   if (p.scrollHeight > p.clientHeight + 2) out.push(p.id + ': panel content taller than panel by ' + (p.scrollHeight - p.clientHeight));
   // svg / canvas inside the box
   p.querySelectorAll('svg, canvas').forEach(s => { const r = s.getBoundingClientRect(); if (r.right > pr.right + 1 || r.bottom > pr.bottom + 1) out.push(p.id + ': ' + s.tagName + ' overflows panel'); });
 });
 document.querySelectorAll('.panel .chip span, .panel .sumhead, .panel .srow .nm, .panel .srow .vl, .panel .hint, .panel h2, .panel .crumb, .panel button').forEach(e => {
   if (e.scrollWidth > e.clientWidth + 1 && vis(e)) out.push(e.closest('.panel').id + ': TEXT truncated "' + e.textContent.trim().slice(0, 40) + '"');
 });
 return out;
}"""
res = {}
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--allow-file-access-from-files"])
    for W, H in [(1280,720),(1366,768),(1600,900),(1920,1080)]:
        pg = b.new_page(viewport={"width": W, "height": H}); pg.goto("file://%s/index.html" % root); pg.wait_for_timeout(1500)
        for st in [None] + IDS:
            if st: pg.click("#p-%s .ph h2" % st); pg.wait_for_timeout(900)
            for i in pg.evaluate(JS): print("%dx%d %-8s %s" % (W, H, st or "default", i))
            if st: pg.click("#p-%s .ph h2" % st); pg.wait_for_timeout(700)
        pg.close()
    b.close()

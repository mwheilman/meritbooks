"""Headless screenshot via QtWebEngine (sandbox has no Chrome). Usage:
shot.py page.html out_prefix [width] — writes out_prefix.png (full page) and prints the overflow report."""
import sys, os, json
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--no-sandbox --disable-gpu --force-device-scale-factor=1")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
from PySide6.QtCore import QUrl, QTimer, QSize
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView

page, out = sys.argv[1], sys.argv[2]
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
app = QApplication(sys.argv)
v = QWebEngineView()
v.resize(W, 900)
CHECK = r"""
(function(){var bad=[];
 document.querySelectorAll('.app *').forEach(function(el){var cs=getComputedStyle(el); if(el.classList.contains('sr')||el.closest('[hidden]')||cs.display==='none')return;
   if(el.clientWidth>0 && el.scrollWidth>el.clientWidth+1 && (cs.overflowX!=='visible'||cs.textOverflow==='ellipsis')) bad.push('W '+(el.className||el.tagName)+' "'+(el.textContent||'').trim().slice(0,40)+'" '+el.scrollWidth+'/'+el.clientWidth);
   if(el.classList.contains('wg-body') && el.scrollHeight>el.clientHeight+1) bad.push('H wg-body in '+el.parentNode.getAttribute('data-widget')+' '+el.scrollHeight+'/'+el.clientHeight);});
 document.querySelectorAll('.wg').forEach(function(w){var r=w.getBoundingClientRect();
   w.querySelectorAll('*').forEach(function(c){var q=c.getBoundingClientRect(); if(q.width&&getComputedStyle(c).position!=='absolute'&&(q.right>r.right+1||q.left<r.left-1)) bad.push('X '+w.getAttribute('data-widget')+' '+(c.className||c.tagName)+' "'+(c.textContent||'').trim().slice(0,30)+'"');});});
 return JSON.stringify({h:document.documentElement.scrollHeight,bad:bad.slice(0,60),n:bad.length});})()
"""

def done(ok):
    def after(res):
        r = json.loads(res)
        print("height", r["h"], "issues", r["n"])
        for b in r["bad"]:
            print("  ", b)
        h = min(r["h"], 16000)
        v.resize(W, h)
        QTimer.singleShot(1200, lambda: grab())
    pre = os.environ.get("PRE_JS")
    if pre:
        QTimer.singleShot(1200, lambda: v.page().runJavaScript(pre, 0, lambda r: print("PRE:", r)))
    QTimer.singleShot(2000, lambda: v.page().runJavaScript(CHECK, 0, after))

def grab():
    img = v.grab()
    img.save(out + ".png")
    print("saved", out + ".png", img.width(), img.height())
    app.quit()

v.loadFinished.connect(done)
v.load(QUrl(page) if page.startswith("http") else QUrl.fromLocalFile(os.path.abspath(page)))
v.show()
app.exec()

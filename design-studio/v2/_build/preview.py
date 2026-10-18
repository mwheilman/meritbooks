"""Self-contained preview copies (fonts, css, images inlined) + an overflow
checker, for screenshotting in a sandbox with no web access. Not deployed."""
import base64, re, sys, os, glob

V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)


def b64(p):
    return base64.b64encode(open(p, "rb").read()).decode()


syne = glob.glob('/tmp/fs/*syne*/package/files/syne-latin-700-normal.woff2')[0]
dm = glob.glob('/tmp/fs/*dm-sans*/package/files/dm-sans-latin-wght-normal.woff2')[0]
FONTCSS = (f"@font-face{{font-family:'Syne';font-weight:700;src:url(data:font/woff2;base64,{b64(syne)}) format('woff2')}}"
           f"@font-face{{font-family:'DM Sans';font-weight:100 1000;src:url(data:font/woff2;base64,{b64(dm)}) format('woff2')}}")
SYS = open(os.path.join(V2, "system.css")).read()
IMGS = {f"assets/{n}": "data:image/png;base64," + b64(os.path.join(V2, "assets", n)) for n in os.listdir(os.path.join(V2, "assets"))}

CHECK = """<script>
window.addEventListener('load',function(){setTimeout(function(){
 var bad=[];
 document.querySelectorAll('.app *').forEach(function(el){
   var cs=getComputedStyle(el); if(cs.display==='none'||el.closest('[hidden]'))return;
   if(el.scrollWidth>el.clientWidth+1 && (cs.overflowX!=='visible'||cs.textOverflow==='ellipsis') && el.clientWidth>0){bad.push(['W',el]);}
   if(el.classList.contains('wg-body') && el.scrollHeight>el.clientHeight+1){bad.push(['H',el]);}
 });
 document.querySelectorAll('.wg').forEach(function(w){var r=w.getBoundingClientRect();
   w.querySelectorAll('*').forEach(function(c){var q=c.getBoundingClientRect(); if(q.width&&(q.right>r.right+1||q.left<r.left-1)&&getComputedStyle(c).position!=='absolute'){bad.push(['X',c]);}});});
 bad.forEach(function(b){b[1].style.outline='3px solid red';});
 var d=document.createElement('div');d.style.cssText='position:fixed;left:0;top:0;z-index:9999;background:#B42318;color:#fff;font:600 22px/30px sans-serif;padding:6px 12px;max-width:1400px';
 d.textContent='OVERFLOW '+bad.length+': '+bad.slice(0,12).map(function(b){var e=b[1];return b[0]+':'+(e.className||e.tagName)+' "'+(e.textContent||'').trim().slice(0,28)+'" '+e.scrollWidth+'/'+e.clientWidth+(b[0]==='H'?(' h'+e.scrollHeight+'/'+e.clientHeight):'');}).join(' | ');
 document.body.appendChild(d);
 var y=parseInt((document.body.getAttribute('data-y')||'0'),10); window.scrollTo(0,y);
},300);});
</script>"""

for page, shots in [(a.split(":")[0], a.split(":")[1:]) for a in sys.argv[2:]]:
    src = open(os.path.join(V2, page)).read()
    src = re.sub(r'<link rel="preconnect"[^>]*>', '', src)
    src = re.sub(r'<link href="https://fonts.googleapis.com[^>]*>', '', src)
    src = src.replace('<link rel="stylesheet" href="system.css">', f"<style>{FONTCSS}{SYS}</style>")
    for k, v in IMGS.items():
        src = src.replace(k, v)
    open(os.path.join(OUT, page.replace(".html", "-full.html")), "w").write(src)
    if os.environ.get("FULLONLY"): continue
    zoom = 0.5
    for i, y in enumerate(shots or ["0"]):
        s = src.replace("<body>", f'<body data-y="{y}"><style>html{{zoom:{zoom}}}</style>', 1).replace("</body>", CHECK + "</body>")
        name = page.replace(".html", f"-p{i}.html")
        open(os.path.join(OUT, name), "w").write(s)
        print(os.path.join(OUT, name))

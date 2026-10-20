"""Preview copies for the file-preview screenshot tool: local fonts, audit on,
optionally isolate one frame (n = 1-based index) and zoom to fit the panel.
usage: acc_preview.py PAGE.html [frame_index] [zoom] [scrollY]"""
import os, re, sys, shutil
V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = "/sessions/practical-loving-lovelace/mnt/outputs/pv"
page = sys.argv[1]; fi = int(sys.argv[2]) if len(sys.argv) > 2 else 0
zoom = sys.argv[3] if len(sys.argv) > 3 else "0.5"; sy = sys.argv[4] if len(sys.argv) > 4 else "0"
os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)
shutil.copy(os.path.join(V2, "system.css"), OUT)
for f in os.listdir(os.path.join(V2, "assets")):
    shutil.copy(os.path.join(V2, "assets", f), os.path.join(OUT, "assets"))
s = open(os.path.join(V2, page)).read()
ff = "".join(f"@font-face{{font-family:'DM Sans';font-weight:{w};src:url(fonts/dm-sans-latin-{w}-normal.woff2) format('woff2')}}" for w in (400, 500, 600, 700))
ff += "@font-face{font-family:'Syne';font-weight:700;src:url(fonts/syne-latin-700-normal.woff2) format('woff2')}"
iso = ""
if fi:
    iso = (f".frame,.frame-cap,.board-h,.anno,.pair-h,.legend,.sheet-top{{display:none!important}}"
           f".frame:nth-of-type({fi}){{display:block!important}}")
css = f"<style>{ff}html{{zoom:{zoom}}}{iso}</style><script>window.__AUDIT=1</script>"
s = re.sub(r'<link[^>]+fonts\.(googleapis|gstatic)[^>]*>', '', s)
s = s.replace("</head>", css + "</head>")
if fi:
    # nth-of-type counts divs; mark the chosen frame instead
    s = s.replace(iso, ".frame,.frame-cap,.board-h,.anno,.pair-h,.legend,.sheet-top{display:none!important}.frame.pick{display:block!important}")
    s = s.replace("</body>", f"<script>(function(){{var f=document.querySelectorAll('.frame')[{fi-1}];f.classList.add('pick');f.style.margin='0';window.scrollTo(0,{sy})}})()</script></body>")
name = page.replace(".html", f"-f{fi}.html")
open(os.path.join(OUT, name), "w").write(s)
print(os.path.join(OUT, name))

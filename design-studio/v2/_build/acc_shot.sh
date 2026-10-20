#!/bin/bash
# Static render for review in a sandbox with no browser:
#   jsdom runs the page scripts -> serialized DOM -> WeasyPrint (real CSS layout, real fonts) -> PNG.
# usage: acc_shot.sh PAGE.html OUTPREFIX [extra-js-to-run-before-serialize]
set -e
B=$(cd "$(dirname "$0")" && pwd); V2=$(dirname "$B"); OUT=/sessions/practical-loving-lovelace/mnt/outputs/shots; mkdir -p $OUT
node /tmp/ch/dom.js "$V2/$1" "$OUT/$2.html" "$3"
cd $OUT && python3 - "$2" <<'EOF'
import sys, weasyprint
n = sys.argv[1]
css = weasyprint.CSS(string="""@page{size:1440px 14000px;margin:0}
@font-face{font-family:'DM Sans';font-weight:400;src:url(/sessions/practical-loving-lovelace/mnt/outputs/pv/fonts/dm-sans-latin-400-normal.woff2)}
@font-face{font-family:'DM Sans';font-weight:500;src:url(/sessions/practical-loving-lovelace/mnt/outputs/pv/fonts/dm-sans-latin-500-normal.woff2)}
@font-face{font-family:'DM Sans';font-weight:600;src:url(/sessions/practical-loving-lovelace/mnt/outputs/pv/fonts/dm-sans-latin-600-normal.woff2)}
@font-face{font-family:'DM Sans';font-weight:700;src:url(/sessions/practical-loving-lovelace/mnt/outputs/pv/fonts/dm-sans-latin-700-normal.woff2)}
@font-face{font-family:'Syne';font-weight:700;src:url(/sessions/practical-loving-lovelace/mnt/outputs/pv/fonts/syne-latin-700-normal.woff2)}
""")
doc = weasyprint.HTML(filename=f"{n}.html", base_url="/sessions/practical-loving-lovelace/mnt/meritbooks/design-studio/v2/").render(stylesheets=[css])
doc.write_pdf(f"{n}.pdf")
EOF
pdftoppm -r 96 -png -singlefile "$OUT/$2.pdf" "$OUT/$2"
convert "$OUT/$2.png" -trim +repage "$OUT/$2.png"
echo "$OUT/$2.png $(identify -format '%wx%h' $OUT/$2.png)"

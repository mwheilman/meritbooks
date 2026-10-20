#!/bin/bash
# fo_shot.sh <builder.py> <Page.html> [width] -> builds, inlines fonts, screenshots into outputs/rf/<page>-N.png slices
B=/sessions/practical-loving-lovelace/mnt/meritbooks/design-studio/v2/_build
O=/sessions/practical-loving-lovelace/mnt/outputs/rf
mkdir -p $O
cd $B && python3 $1 || exit 1
FULLONLY=1 python3 preview.py /tmp/pv $2 >/dev/null
P=${2%.html}
cd /tmp/pw && node shot.js /tmp/pv/$P-full.html /tmp/pv/$P.png ${3:-1440} 30000
python3 - "$P" "$O" <<'PY'
import sys, os
from PIL import Image
p, o = sys.argv[1], sys.argv[2]
im = Image.open(f'/tmp/pv/{p}.png'); H = 1300
for f in os.listdir(o):
    if f.startswith(p + '-'): os.remove(os.path.join(o, f))
y = i = 0
while y < im.height:
    im.crop((0, y, im.width, min(y + H, im.height))).save(f'{o}/{p}-{i}.png'); y += H; i += 1
print('slices', i, 'height', im.height)
PY

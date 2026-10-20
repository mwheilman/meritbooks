#!/bin/bash
# oshot.sh <builder.py> <Page.html> [crop_h]   -> builds, inlines fonts, screenshots to outputs/shots/<page>-N.png slices
B=/sessions/practical-loving-lovelace/mnt/meritbooks/design-studio/v2/_build
cd $B && python3 $1 >/dev/null || exit 1
FULLONLY=1 python3 preview.py /tmp/pv $2 >/dev/null
P=${2%.html}
cd /tmp/pw && node shot.js /tmp/pv/$P-full.html /tmp/pv/$P.png 1440 ${3:-30000}
python3 - "$P" <<'PY'
import sys
from PIL import Image
p=sys.argv[1]; im=Image.open(f'/tmp/pv/{p}.png'); H=1250; i=0
import os
for f in os.listdir('/sessions/practical-loving-lovelace/mnt/outputs/shots'):
    if f.startswith(p+'-'): os.remove('/sessions/practical-loving-lovelace/mnt/outputs/shots/'+f)
y=0
while y < im.height:
    im.crop((0,y,1440,min(y+H,im.height))).save(f'/sessions/practical-loving-lovelace/mnt/outputs/shots/{p}-{i}.png'); y+=H; i+=1
print('slices',i,'height',im.height)
PY

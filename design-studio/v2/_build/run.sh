#!/bin/bash
# build + shoot: run.sh S6-owner-home.html tag
B=/sessions/practical-loving-lovelace/mnt/meritbooks/design-studio/v2/_build
cd $B && python3 s6.py >/dev/null && ( [ -f s6b.py ] && python3 s6b.py >/dev/null; [ -f s6c.py ] && python3 s6c.py >/dev/null; [ -f s9.py ] && python3 s9.py >/dev/null; true )
FULLONLY=1 python3 preview.py /tmp/pv $1 >/dev/null
cd /tmp/pv && LD_LIBRARY_PATH=/tmp/qtlibs/lib timeout 150 python3 $B/shot.py ${1%.html}-full.html /tmp/pv/$2 2>&1 | grep -E "height|^   |saved"

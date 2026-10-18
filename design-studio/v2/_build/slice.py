import sys
from PIL import Image
im=Image.open(sys.argv[1]); out=sys.argv[2]; y0=int(sys.argv[3]); y1=int(sys.argv[4]); sc=float(sys.argv[5]) if len(sys.argv)>5 else 1
c=im.crop((0,y0,im.width,min(y1,im.height)))
if sc!=1: c=c.resize((int(c.width*sc),int(c.height*sc)),Image.LANCZOS)
c.save(out)

import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
src,out_b=sys.argv[1],sys.argv[2]
f=instantiateVariableFont(TTFont(src),{"opsz":72,"wght":500})
cmap=f.getBestCmap();gs=f.getGlyphSet();hmtx=f['hmtx'];upm=f['head'].unitsPerEm
text="Polycarp";size=44;k=size/upm;x=0;d=[]
for ch in text:
    g=cmap[ord(ch)];pen=SVGPathPen(gs,ntos=lambda v:f"{v:.1f}".rstrip('0').rstrip('.'))
    gs[g].draw(TransformPen(pen,(k,0,0,-k,x,50)));d.append(pen.getCommands());x+=hmtx[g][0]*k
w=round(x+2);mark=open(f"{out_b}/mark.svg").read().split('</title>')[1].split('</svg>')[0]
for name,col in (("wordmark",'#59693F'),("wordmark-on-dark",'#F6F3E8')):
    open(f"{out_b}/{name}.svg","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w+74}" height="66" viewBox="0 0 {w+74} 66" color="{col}"><title>Polycarp</title><g transform="translate(0 1)">{mark}</g><path transform="translate(72 0)" fill="currentColor" d="{" ".join(d)}"/></svg>\n')
print("wordmark width",w+74)

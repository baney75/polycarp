import math,sys,os
B=sys.argv[1]
def leaf(x,y,ang,L,W):
    a=math.radians(ang); ux,uy=math.cos(a),-math.sin(a); nx,ny=-uy,ux
    tx,ty=x+ux*L,y+uy*L
    c=lambda t,s:(x+ux*L*t+nx*W*s, y+uy*L*t+ny*W*s)
    p1,p2=c(.28,1.0),c(.72,.72); p3,p4=c(.72,-.72),c(.28,-1.0)
    return f"M{x:.1f} {y:.1f}C{p1[0]:.1f} {p1[1]:.1f} {p2[0]:.1f} {p2[1]:.1f} {tx:.1f} {ty:.1f}C{p3[0]:.1f} {p3[1]:.1f} {p4[0]:.1f} {p4[1]:.1f} {x:.1f} {y:.1f}Z"
def olive(cx,cy,rx,ry,rot): return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" transform="rotate({rot} {cx} {cy})"/>'
# full mark: gentle arc, alternating leaves, two olives
stem='M10 56C20 48 33 35 45 19'
leaves=[leaf(45,19,62,15,5.0),leaf(40,25.5,112,15,4.8),leaf(38,27.5,14,17,4.8),leaf(28,38,118,15,4.6)]
full=f'<path d="{stem}" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><g fill="currentColor"><path d="{" ".join(leaves)}"/>{olive(40,44,6.6,8.4,-14)}{olive(22,54,5.8,7.4,-14)}</g><path d="M32.5 33C35 34.5 37 35.5 38.5 36.5M16.5 51C18 50.5 19.5 49 20.5 47.5" fill="none" stroke="currentColor" stroke-width="2"/>'
# small cut: thick stem, two leaves, one olive
sstem='M8 58C20 49 33 36 42 23'
sl=[leaf(42,23,58,23,8.2),leaf(35,31.5,104,23,7.4),leaf(39,27,8,21,7.0)]
small=f'<path d="{sstem}" fill="none" stroke="currentColor" stroke-width="5.4" stroke-linecap="round"/><g fill="currentColor"><path d="{" ".join(sl)}"/>{olive(29,52,9.2,10.6,-12)}</g>'
def svg(body,c='#000',size=64): return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 64 64" color="{c}"><title>Polycarp</title>{body}</svg>\n'
open(f'{B}/mark.svg','w').write(svg(full))
open(f'{B}/mark-small.svg','w').write(svg(small))
G='#59693F';C='#F6F3E8'
def tile(body,rx,pad,s=1024,fill=G,fg=C,tx=100,ts=824):
    k=(ts-2*pad)/64
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{s}" height="{s}" viewBox="0 0 {s} {s}"><title>Polycarp</title><rect x="{tx}" y="{tx}" width="{ts}" height="{ts}" rx="{rx}" fill="{fill}"/><g color="{fg}" transform="translate({tx+pad} {tx+pad}) scale({k:.4f})">{body}</g></svg>\n'
open(f'{B}/icon-macos.svg','w').write(tile(full,186,62))
open(f'{B}/icon-full-bleed.svg','w').write(tile(full,0,150,tx=0,ts=1024))
open(f'{B}/icon-android-foreground.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 432 432"><title>Polycarp</title><g color="{C}" transform="translate(116 116) scale(3.125)">{full}</g></svg>\n')

"""Renders brand/export and brand-sheet.png from the SVGs that gen.py and wordmark.py write.

    python3 brand/tools/export.py BRAND [OUT]

BRAND is the brand folder; OUT (default BRAND) gets export/ and brand-sheet.png. Needs ImageMagick 7 (`magick`) with an
SVG renderer (Inkscape or librsvg). Each set below names the SVG it comes from; a different renderer's antialiasing
differs by a few percent RMSE, nothing visible.
"""
import os
import shutil
import subprocess
import sys
import tempfile

B = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else B

# (folder, file name pattern, source SVG, sizes)
SETS = [
    ("macos", "icon-{}.png", "icon-macos.svg", [16, 32, 64, 128, 256, 512, 1024]),
    ("ios", "icon-{}.png", "icon-full-bleed.svg", [1024]),
    ("windows", "icon-{}.png", "icon-full-bleed.svg", [16, 24, 32, 48, 64, 256]),
    ("linux", "icon-{}.png", "icon-full-bleed.svg", [48, 128, 256, 512]),
    ("web", "icon-{}.png", "icon-full-bleed.svg", [16, 32, 180, 192, 512]),
    ("android", "legacy-{}.png", "icon-full-bleed.svg", [48, 72, 96, 144, 192, 512]),
    ("android", "adaptive-foreground-{}.png", "icon-android-foreground.svg", [432]),
    # Black on transparent: macOS and Linux trays tint a template image themselves.
    ("tray", "tray-{}.png", "mark-small.svg", [16, 22, 32, 44]),
]
ICO = ("windows", "polycarp.ico", [16, 24, 32, 48, 64, 256])


def magick(*args):
    subprocess.run(["magick", *args], check=True, capture_output=True)


def render(svg, size, out):
    """The SVG at size x size px, rasterized at 4x its own width and scaled down, so small sizes keep their detail."""
    with open(svg) as f:
        head = f.read(300)
    width = int(head.split('width="')[1].split('"')[0])
    magick("-background", "none", "-density", str(72 * size * 4 / width), svg, "-resize", f"{size}x{size}!", out)


def export():
    for folder, name, svg, sizes in SETS:
        os.makedirs(f"{OUT}/export/{folder}", exist_ok=True)
        for size in sizes:
            render(f"{B}/{svg}", size, f"{OUT}/export/{folder}/{name.format(size)}")
    shutil.copyfile(f"{B}/mark-small.svg", f"{OUT}/export/tray/tray.svg")
    folder, name, sizes = ICO
    magick(*[f"{OUT}/export/{folder}/icon-{s}.png" for s in sizes], f"{OUT}/export/{folder}/{name}")


def sheet():
    """Light half and dark half: the wordmark, then the icons and marks at the sizes they are used."""
    with tempfile.TemporaryDirectory() as tmp:
        def piece(svg, size, name):
            path = f"{tmp}/{name}.png"
            render(f"{B}/{svg}", size, path)
            return path
        circle = f"{tmp}/circle.png"
        magick(piece("icon-full-bleed.svg", 144, "round"), "(", "-size", "144x144", "xc:none", "-fill", "white",
               "-draw", "circle 72,72 72,0", ")", "-compose", "DstIn", "-composite", circle)
        cream_small = f"{tmp}/cream.svg"
        with open(f"{B}/mark-small.svg") as f:
            open(cream_small, "w").write(f.read().replace('color="#000"', 'color="#F6F3E8"'))
        wide = 560  # the wordmark's width on each half, centred
        wm = f"{tmp}/wm.png"
        wmd = f"{tmp}/wmd.png"
        magick("-background", "none", "-density", str(72 * wide * 4 / 258), f"{B}/wordmark.svg", "-resize", f"{wide}x", wm)
        magick("-background", "none", "-density", str(72 * wide * 4 / 258), f"{B}/wordmark-on-dark.svg", "-resize", f"{wide}x", wmd)
        places = [
            (wm, 70, 60), (piece("icon-macos.svg", 256, "mac"), 50, 230), (circle, 350, 280),
            (piece("icon-full-bleed.svg", 64, "sq"), 530, 320),
            (wmd, 770, 60), (piece("icon-macos.svg", 128, "mac128"), 800, 290),
        ]
        for size, x, y in [(44, 1000, 330), (22, 1080, 342)]:
            path = f"{tmp}/cream-{size}.png"
            render(cream_small, size, path)
            places.append((path, x, y))
        args = ["-size", "1400x620", "xc:#F6F3E8", "-fill", "#2B2E26", "-draw", "rectangle 700,0 1400,620"]
        for path, x, y in places:
            args += [path, "-geometry", f"+{x}+{y}", "-composite"]
        magick(*args, f"{OUT}/brand-sheet.png")


export()
sheet()
print(f"export: wrote {OUT}/export and {OUT}/brand-sheet.png")

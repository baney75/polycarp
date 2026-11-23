#!/usr/bin/env python3
"""Build the non-Chromium test fixtures for the Polycarp importers.

Run from anywhere: python3 tests/fixtures/make_fixtures.py
Writes into the directory that holds this script. The PDFs that need a real
layout engine come from make_pdf_fixtures.mjs (headless Chromium).
"""
import base64
import hashlib
import io
import os
import struct
import zipfile

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def out(name):
    return os.path.join(HERE, name)


def png_bytes(w=120, h=80, color=(40, 90, 160), label="FIG"):
    im = Image.new("RGB", (w, h), color)
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, w - 5, h - 5], outline=(255, 255, 255), width=2)
    d.text((10, h // 2 - 6), label, fill=(255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# EPUB 3
# ---------------------------------------------------------------------------

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:polycarp-test-book</dc:identifier>
    <dc:title>The Test Book</dc:title>
    <dc:creator>Ada Tester</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-11-20T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="fig" href="images/fig%20one.png" media-type="image/png"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="font" href="fonts/dummy.otf" media-type="font/otf"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="text/ch1.xhtml">One: The Start</a></li>
      <li><a href="text/ch2.xhtml#top">Two: The Picture</a></li>
      <li><a href="text/ch3.xhtml">Three: The End</a></li>
    </ol>
  </nav>
</body>
</html>
"""


def xhtml(title, body):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title}</title><link rel="stylesheet" href="../style.css"/></head>
<body>
{body}
</body>
</html>
"""


FILLER = ("The lamp burned low while the house slept, and the pages turned one after another "
          "as the story found its pace. Nothing in the room moved except the reader and the light. ")

COVER = xhtml("Cover", '<div class="cover"><p>COVERTEXT The Test Book, by Ada Tester</p></div>')

CH1 = xhtml("Chapter 1", f"""
<h1 class="chapter">Chapter 1</h1>
<p style="color:red" onclick="alert(1)">First chapter paragraph. {FILLER}</p>
<script>window.evil = 1;</script>
<p>Second paragraph with a <a href="javascript:alert(1)">bad link</a> and a <a href="https://example.com/ok">good link</a>. {FILLER}</p>
""")

CH2 = xhtml("Chapter 2", f"""
<h1 id="top">Chapter 2</h1>
<p>The picture chapter. {FILLER}</p>
<div class="figure"><img src="../images/fig%20one.png" alt="A test figure"/></div>
<p>After the picture. {FILLER}</p>
""")

# ch3 uses an HTML entity that plain XML does not know, which forces the
# text/html fallback parse.
CH3 = xhtml("Chapter 3", f"""
<h2>Chapter 3</h2>
<p>The last chapter&nbsp;ends here. {FILLER}</p>
<p>ENDMARK {FILLER}</p>
""")

ENC_FONT_ONLY = """<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/dummy.otf"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>
"""

ENC_DRM = """<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>
"""


def write_epub(path, encryption):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("META-INF/encryption.xml", encryption, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", OPF, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", NAV, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/cover.xhtml", COVER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/ch1.xhtml", CH1, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/ch2.xhtml", CH2, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/ch3.xhtml", CH3, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/images/fig one.png", png_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", "body{font-family:serif}", compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/fonts/dummy.otf", b"\x00" * 64, compress_type=zipfile.ZIP_DEFLATED)


# ---------------------------------------------------------------------------
# DOCX (hand-built minimal package)
# ---------------------------------------------------------------------------

DOCX_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
"""

DOCX_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
"""

DOCX_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
"""

DOCX_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>
"""

DOCX_CORE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Docx Fixture Title</dc:title>
  <dc:creator>Wendy Word</dc:creator>
</cp:coreProperties>
"""


def w_para(text, style=None, bold=False, italic=False):
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    rpr = ""
    if bold or italic:
        rpr = "<w:rPr>" + ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "") + "</w:rPr>"
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def w_mixed(parts):
    runs = ""
    for text, bold, italic in parts:
        rpr = ""
        if bold or italic:
            rpr = "<w:rPr>" + ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "") + "</w:rPr>"
        runs += f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'
    return f"<w:p>{runs}</w:p>"


def write_docx(path):
    body = "".join([
        w_para("First Part", "Heading1"),
        w_mixed([("The first part has ", False, False), ("bold words", True, False), (" and ", False, False),
                 ("italic words", False, True), (" inside one paragraph of ordinary text.", False, False)]),
        w_para("A subsection", "Heading2"),
        w_para("More text in the first part, long enough to read as a real paragraph in the reader."),
        w_para("Second Part", "Heading1"),
        w_para("The second part starts here and holds DOCXEND as its marker."),
    ])
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>{body}<w:sectPr/></w:body>
</w:document>
"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", DOCX_TYPES)
        z.writestr("_rels/.rels", DOCX_RELS)
        z.writestr("word/_rels/document.xml.rels", DOCX_DOC_RELS)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", DOCX_STYLES)
        z.writestr("docProps/core.xml", DOCX_CORE)


# ---------------------------------------------------------------------------
# FB2
# ---------------------------------------------------------------------------

def write_fb2(path):
    img = base64.b64encode(png_bytes(label="FB2")).decode()
    fb2 = f"""<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <author><first-name>Fyodor</first-name><last-name>Fixture</last-name></author>
      <book-title>The FB2 Fixture</book-title>
    </title-info>
  </description>
  <body>
    <section>
      <title><p>Part One</p></title>
      <p>The first FB2 section has <emphasis>emphasis</emphasis> and <strong>strong</strong> text. {FILLER}</p>
      <image l:href="#pic.png"/>
    </section>
    <section>
      <title><p>Part Two</p></title>
      <p>The second FB2 section. {FILLER}</p>
    </section>
  </body>
  <binary id="pic.png" content-type="image/png">{img}</binary>
</FictionBook>
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(fb2)


# ---------------------------------------------------------------------------
# Text and Markdown
# ---------------------------------------------------------------------------

TXT = """Title: The Plain Book
Author: Tess Writer

CHAPTER I

The Arrival

It was a quiet morning when the train came into the station, and the
platform was almost empty. A porter leaned on his cart and watched the
steam rise into the cold air while TXTJOIN the last passengers stepped down.

The second paragraph of the first chapter is short but complete.

CHAPTER II

The road out of town ran between two low stone walls, and the walls ran
on for miles without a gap, so that the traveller saw nothing but stone
and sky until the sun went down behind the hills.

CHAPTER III

At last the house came into view, and the long journey was over.
"""

MD = """# Markdown Fixture

A paragraph with **strong words**, *emphasis*, `inline code` and a [link](https://example.com/page).
It continues on a second source line.

## A Subheading

- first item
- second item with **bold**
- third item

1. one
2. two

> A quoted line
> that continues.

```
<script>alert("not run")</script>
const x = 1;
```

---

Final paragraph after the rule.
"""

ARTICLE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Site Name | The Article Title</title>
<meta name="author" content="Rita Reporter">
<script>window.tracker = 1;</script></head>
<body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main>
<article>
<h1>The Article Title</h1>
<p class="byline">By Rita Reporter</p>
<p>The first paragraph of the article explains why calm reading matters for people who are easily distracted by busy pages full of links and adverts.</p>
<p>The second paragraph has a <a href="/relative/path">relative link</a> that must resolve against the page address, and an image follows below.</p>
<p><img src="images/photo.png" alt="A photo"></p>
<p>The third paragraph closes the article with ARTICLEEND so the test can find it, after enough words to look like a real article body to Readability.</p>
<p>A fourth paragraph adds more length because Readability prefers articles with a reasonable amount of text in them before it trusts the result.</p>
</article>
</main>
<aside>Sidebar junk that should not appear.</aside>
<footer>Footer junk copyright line.</footer>
</body></html>
"""


# ---------------------------------------------------------------------------
# PDFs: an image-only scan and an RC4 password-protected PDF
# ---------------------------------------------------------------------------

def write_scan_pdf(path):
    pages = []
    for i in range(2):
        im = Image.new("RGB", (850, 1100), (250, 248, 240))
        d = ImageDraw.Draw(im)
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 28)
        except OSError:
            font = ImageFont.load_default()
        for line in range(20):
            d.text((80, 100 + line * 44), f"This is scanned text on page {i + 1}, line {line + 1}.", fill=(20, 20, 20), font=font)
        pages.append(im)
    pages[0].save(path, "PDF", resolution=100.0, save_all=True, append_images=pages[1:])


PAD = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")


def rc4(key, data):
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    i = j = 0
    out = bytearray()
    for b in data:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        out.append(b ^ s[(s[i] + s[j]) % 256])
    return bytes(out)


def write_password_pdf(path):
    user, owner = b"secret", b"owner"
    pad = lambda pw: (pw + PAD)[:32]
    o_val = rc4(hashlib.md5(pad(owner)).digest()[:5], pad(user))
    perms = struct.pack("<i", -4)
    id0 = hashlib.md5(b"polycarp-password-fixture").digest()
    key = hashlib.md5(pad(user) + o_val + perms + id0).digest()[:5]
    u_val = rc4(key, PAD)

    def obj_key(num, gen=0):
        return hashlib.md5(key + struct.pack("<I", num)[:3] + struct.pack("<I", gen)[:2]).digest()[:10]

    content = rc4(obj_key(4), b"BT /F1 18 Tf 72 700 Td (This text is behind a password) Tj ET")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Filter /Standard /V 1 /R 2 /O <" + o_val.hex().encode() + b"> /U <" + u_val.hex().encode() + b"> /P -4 >>",
    ]
    buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(buf))
        buf += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(buf)
    buf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        buf += f"{off:010d} 00000 n \n".encode()
    idhex = id0.hex().encode()
    buf += (b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R /Encrypt 6 0 R /ID [<" + idhex + b"> <" + idhex + b">] >>\n")
    buf += f"startxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(bytes(buf))


def main():
    write_epub(out("fx-book.epub"), ENC_FONT_ONLY)
    write_epub(out("fx-drm.epub"), ENC_DRM)
    write_docx(out("fx-doc.docx"))
    write_fb2(out("fx-book.fb2"))
    with open(out("fx-chapters.txt"), "w", encoding="utf-8") as f:
        f.write(TXT)
    with open(out("fx-notes.md"), "w", encoding="utf-8") as f:
        f.write(MD)
    with open(out("fx-article.html"), "w", encoding="utf-8") as f:
        f.write(ARTICLE)
    write_scan_pdf(out("fx-scan.pdf"))
    write_password_pdf(out("fx-password.pdf"))
    with open(out("fx-kindle.mobi"), "wb") as f:
        f.write(b"\x00" * 60 + b"BOOKMOBI" + b"\x00" * 200)
    print("python fixtures written to", HERE)


if __name__ == "__main__":
    main()

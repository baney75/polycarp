// Artifact previews (src/artifacts/): which viewer a file gets, and the
// readers behind the new viewers. The readers parse untrusted files, so the limits and the
// no-network rules are tested here too. Drawing is checked live (see the PR's screenshots).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import XLSX_ZAHL from "xlsx/dist/xlsx.zahl.mjs";

import { conversionHint, getArtifactFileType, mimeTypeFor } from "../src/artifacts/preview/file-types.ts";
import { detectDelimiter, parseDelimited } from "../src/artifacts/preview/delimited.ts";
import { parseXml, XmlError, textOf } from "../src/artifacts/preview/xml.ts";
import { autoNumberLabel, presetPath, colorOf, emptyTheme } from "../src/artifacts/preview/drawingml.ts";
import { fitRow, readPptx } from "../src/artifacts/preview/pptx.ts";
import { readOdt, readOdp } from "../src/artifacts/preview/odf.ts";
import { parseRtf } from "../src/artifacts/preview/rtf.ts";
import { cappedWorkbookZip, clampSheet, iwaUncompressedSize } from "../src/artifacts/preview/spreadsheet.ts";
import { attachmentData, parseNotebook, neutralizeRemoteImages, stripAnsi } from "../src/artifacts/preview/notebook.ts";
import { countZipEntries, decodeBase64Content, readTextContent, PreviewLimitError, PREVIEW_LIMITS } from "../src/artifacts/preview/content.ts";

test("each file type gets its viewer", () => {
	const cases = {
		"deck.pptx": "pptx",
		"COOKIE-RECIPES.PPTX": "pptx",
		"show.ppsx": "pptx",
		"book.xlsx": "excel",
		"old.xls": "excel",
		"macro.xlsm": "excel",
		"binary.xlsb": "excel",
		"calc.ods": "excel",
		"apple.numbers": "excel",
		"data.csv": "delimited",
		"data.tsv": "delimited",
		"song.mp3": "audio",
		"a.wav": "audio",
		"a.ogg": "audio",
		"a.m4a": "audio",
		"a.flac": "audio",
		"clip.mp4": "video",
		"clip.webm": "video",
		"clip.mov": "video",
		"photo.avif": "image",
		"photo.jpeg": "image",
		"nb.ipynb": "notebook",
		"letter.odt": "odt",
		"slides.odp": "odp",
		"memo.rtf": "rtf",
		"report.docx": "docx",
		"page.html": "html",
		"main.rs": "text",
		"Dockerfile": "text",
		"legacy.doc": "generic",
		"legacy.ppt": "generic",
		"talk.key": "generic",
		"essay.pages": "generic",
		"archive.zip": "generic",
	};
	for (const [name, type] of Object.entries(cases)) assert.equal(getArtifactFileType(name), type, name);
});

test("formats without a preview say how to convert them", () => {
	assert.match(conversionHint("a.ppt").saveAs, /PPTX/);
	assert.match(conversionHint("a.doc").saveAs, /DOCX/);
	assert.match(conversionHint("a.key").name, /Keynote/);
	assert.match(conversionHint("a.pages").saveAs, /DOCX/);
	assert.equal(conversionHint("a.zip"), undefined);
	assert.equal(mimeTypeFor("x.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
	assert.equal(mimeTypeFor("x.unknown"), "application/octet-stream");
});

test("CSV parsing handles quotes, embedded newlines, CRLF and a BOM", () => {
	const text = '﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nlast,\r\n';
	const { rows, truncated } = parseDelimited(text, ",");
	assert.deepEqual(rows, [
		["name", "note"],
		["Smith, J", 'said "hi"\nthen left'],
		["last", ""],
	]);
	assert.equal(truncated, false);
});

test("CSV parsing stops at the row limit and says so", () => {
	const text = Array.from({ length: 50 }, (_, i) => `${i},x`).join("\n");
	const { rows, truncated } = parseDelimited(text, ",", 10);
	assert.equal(rows.length, 10);
	assert.equal(truncated, true);
});

test("the delimiter is detected", () => {
	assert.equal(detectDelimiter("a\tb\n1\t2", "x.tsv"), "\t");
	assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
	assert.equal(detectDelimiter("a,b\n1,2"), ",");
	assert.equal(detectDelimiter('"x;y",b\n"1;2",3'), ",");
});

test("the XML reader never expands DTD entities", () => {
	const xml = '<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><r>&b; &lt;ok&gt; &#x41;<![CDATA[<raw>]]></r>';
	assert.equal(textOf(parseXml(xml)), "&b; <ok> A<raw>");
});

test("the XML reader refuses deep nesting and oversized parts", () => {
	assert.throws(() => parseXml(`${"<a>".repeat(500)}${"</a>".repeat(500)}`), XmlError);
	assert.throws(() => parseXml("<a/>", { maxChars: 2, maxDepth: 10, maxNodes: 10 }), XmlError);
});

test("auto numbers, preset shapes and theme colors", () => {
	assert.equal(autoNumberLabel("arabicPeriod", 3), "3.");
	assert.equal(autoNumberLabel("alphaLcParenR", 2), "b)");
	assert.equal(autoNumberLabel("romanUcPeriod", 4), "IV.");
	assert.equal(autoNumberLabel("arabicParenBoth", 12), "(12)");
	assert.match(presetPath("ellipse", 100, 50), /^M0 25 A50 25/);
	assert.equal(presetPath("someFuturePreset", 10, 10), undefined);
	const ctx = { theme: emptyTheme(), clrMap: { tx1: "dk1", bg1: "lt1" } };
	// PowerPoint draws tx1 with a 75% tint as #898989: the tint is applied in linear light.
	const tinted = parseXml('<a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr>');
	assert.equal(colorOf(tinted, ctx), "#898989");
	assert.equal(colorOf(parseXml('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>'), ctx), "rgba(255, 0, 0, 0.5)");
});

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list) =>
	`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
		.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`)
		.join("")}</Relationships>`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function cookieDeck() {
	const zip = new JSZip();
	zip.file(
		"ppt/presentation.xml",
		`<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
	);
	zip.file("ppt/_rels/presentation.xml.rels", rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"]]));
	zip.file(
		"ppt/slideMasters/slideMaster1.xml",
		`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF5E1"/></a:solidFill></p:bgPr></p:bg><p:spTree>
		<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp>
		<p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr></p:sp>
		<p:sp><p:nvSpPr><p:cNvPr id="4" name="N"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="4"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="6553200" y="6356350"/><a:ext cx="2133600" cy="365125"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="r"/></a:lstStyle><a:p/></p:txBody></p:sp>
		</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
		<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
		<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="3200"/></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="&#8211;"/><a:defRPr sz="2800"/></a:lvl2pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`,
	);
	zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["rId1", "theme", "../theme/theme1.xml"]]));
	zip.file("ppt/theme/theme1.xml", `<a:theme ${NS}><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="C0504D"/></a:accent1></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
	// The layout's content placeholder has idx 4, like the master's slide number; it must not inherit from it.
	zip.file(
		"ppt/slideLayouts/slideLayout1.xml",
		`<p:sldLayout ${NS}><p:cSld><p:spTree>
		<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
		<p:sp><p:nvSpPr><p:cNvPr id="3" name="C"/><p:cNvSpPr/><p:nvPr><p:ph sz="half" idx="4"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="4645025" y="2174875"/><a:ext cx="4041775" cy="3951288"/></a:xfrm></p:spPr></p:sp>
		<p:sp><p:nvSpPr><p:cNvPr id="9" name="Deco"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
		</p:spTree></p:cSld></p:sldLayout>`,
	);
	zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]));
	zip.file(
		"ppt/slides/slide1.xml",
		`<p:sld ${NS}><p:cSld><p:spTree>
		<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Cookie Recipes</a:t></a:r></a:p></p:txBody></p:sp>
		<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="4"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Flour</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>sifted</a:t></a:r></a:p></p:txBody></p:sp>
		<p:pic><p:nvPicPr><p:cNvPr id="4" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr></p:pic>
		<p:pic><p:nvPicPr><p:cNvPr id="5" name="Remote"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rId3" r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:pic>
		<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1000" y="2000"/><a:ext cx="6000" cy="2000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="3000"/><a:gridCol w="3000"/></a:tblGrid>
		<a:tr h="1000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cookie</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Minutes</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
		<a:tr h="1000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Chocolate chip</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr>
		</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
		</p:spTree></p:cSld></p:sld>`,
	);
	zip.file("ppt/slides/_rels/slide1.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "image", "../media/image1.png"], ["rId3", "image", "https://example.com/track.png", true]]));
	zip.file("ppt/slides/slide2.xml", `<p:sld ${NS} show="0"><p:cSld><p:spTree/></p:cSld></p:sld>`);
	zip.file("ppt/slides/_rels/slide2.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]));
	zip.file("ppt/media/image1.png", PNG);
	return zip.generateAsync({ type: "uint8array" });
}

test("a pptx reads into positioned, styled slides", async () => {
	const deck = await readPptx(await cookieDeck());
	assert.equal(deck.width, 12192000);
	assert.equal(deck.totalSlides, 2);
	assert.equal(deck.slides[1].hidden, true);
	const [slide] = deck.slides;
	assert.deepEqual(slide.background, { type: "solid", color: "#fff5e1" });
	const shapes = slide.elements.filter((e) => e.kind === "shape");
	// The layout's own decoration draws first, in the theme's accent color.
	assert.deepEqual(shapes[0].fill, { type: "solid", color: "#c0504d" });
	const title = shapes.find((s) => s.text?.paragraphs[0].runs[0].text === "Cookie Recipes");
	assert.equal(title.box.x, 457200, "title position comes from the master");
	assert.equal(title.text.paragraphs[0].style.align, "ctr");
	assert.equal(title.text.paragraphs[0].runs[0].style.size, 44);
	assert.equal(title.text.paragraphs[0].runs[0].style.bold, true);
	assert.equal(title.text.paragraphs[0].runs[0].style.color, "#111111");
	const body = shapes.find((s) => s.text?.paragraphs[0].runs[0].text === "Flour");
	assert.equal(body.box.x, 4645025, "body position comes from the layout");
	assert.equal(body.text.anchor, "t", "an idx shared with the master's slide number does not inherit from it");
	assert.equal(body.text.paragraphs[0].bullet.text, "•");
	assert.equal(body.text.paragraphs[1].bullet.text, "–");
	assert.equal(body.text.paragraphs[1].runs[0].style.size, 28);
	assert.equal(body.text.paragraphs[0].runs[0].style.font, "Verdana");
	const pics = slide.elements.filter((e) => e.kind === "picture");
	assert.equal(pics[0].image, "ppt/media/image1.png");
	assert.equal(pics[1].image, undefined, "an external image is never fetched");
	assert.deepEqual([...deck.images.keys()], ["ppt/media/image1.png"]);
	const table = slide.elements.find((e) => e.kind === "table");
	assert.deepEqual(table.columns, [3000, 3000]);
	assert.equal(table.rows[0].cells[0].text.paragraphs[0].runs[0].style.bold, true);
	assert.equal(table.rows[1].cells[0].gridSpan, 2);
	assert.equal(table.rows[1].cells[1].merged, true);
});

test("a zip bomb in a pptx fails fast with a limit error", async () => {
	const zip = new JSZip();
	zip.file("ppt/presentation.xml", "a".repeat(40 * 1024 * 1024), { compression: "DEFLATE" });
	const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	assert.ok(bytes.length < 1024 * 1024);
	await assert.rejects(readPptx(bytes), PreviewLimitError);
});

test("a file that is not a presentation says so", async () => {
	const zip = new JSZip();
	zip.file("word/document.xml", "<w/>");
	await assert.rejects(readPptx(await zip.generateAsync({ type: "uint8array" })), /Not a PowerPoint file/);
});

// ---------------------------------------------------------------------------
// OpenDocument
// ---------------------------------------------------------------------------

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

test("an odt reads into headings, styled runs, lists, tables and package images", async () => {
	const zip = new JSZip();
	zip.file(
		"content.xml",
		`<office:document-content ${ODF_NS}><office:automatic-styles><style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#aa0000"/></style:style><text:list-style style:name="N"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/></text:list-style></office:automatic-styles>
		<office:body><office:text>
		<text:h text:outline-level="2">Cookie   Recipes</text:h>
		<text:p>A <text:span text:style-name="B">bold</text:span> claim<text:s text:c="2"/>here<text:line-break/>next <text:a xlink:href="javascript:alert(1)">bad</text:a> <text:a xlink:href="https://example.com/">good</text:a></text:p>
		<text:list text:style-name="N"><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list>
		<table:table><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Cell</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table>
		<text:p><draw:frame svg:width="2cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame><draw:frame><draw:image xlink:href="https://example.com/x.png"/></draw:frame></text:p>
		</office:text></office:body></office:document-content>`,
	);
	zip.file("Pictures/a.png", PNG);
	const doc = await readOdt(await zip.generateAsync({ type: "uint8array" }));
	const [h, p, list, table, imgs] = doc.blocks;
	assert.equal(h.heading, 2);
	assert.equal(h.runs[0].text, "Cookie Recipes", "whitespace collapses");
	const bold = p.runs.find((r) => r.text === "bold");
	assert.equal(bold.style.bold, true);
	assert.equal(bold.style.color, "#aa0000");
	assert.ok(p.runs.some((r) => r.text === "  "), "text:s keeps its spaces");
	assert.ok(p.runs.some((r) => r.br));
	assert.equal(p.runs.find((r) => r.text === "bad").href, undefined, "only http(s) and mailto links survive");
	assert.equal(p.runs.find((r) => r.text === "good").href, "https://example.com/");
	assert.equal(list.kind, "list");
	assert.equal(list.ordered, true);
	assert.equal(list.items.length, 2);
	assert.equal(table.rows[0].cells[0].colSpan, 2);
	assert.equal(imgs.runs.length, 1, "a remote image is dropped");
	assert.equal(imgs.runs[0].image, "Pictures/a.png");
	assert.ok(doc.images.has("Pictures/a.png"));
});

test("an odp reads into the slide model", async () => {
	const zip = new JSZip();
	zip.file(
		"styles.xml",
		`<office:document-styles ${ODF_NS}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="M" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`,
	);
	zip.file(
		"content.xml",
		`<office:document-content ${ODF_NS}><office:automatic-styles><style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#1f2a44"/></style:style><style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#27ae60" draw:stroke="none"/></style:style></office:automatic-styles>
		<office:body><office:presentation><draw:page draw:style-name="dp1" draw:master-page-name="M">
		<draw:frame presentation:class="title" svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Cookie Recipes</text:p></draw:text-box></draw:frame>
		<draw:custom-shape draw:style-name="gr1" svg:x="2cm" svg:y="5cm" svg:width="4cm" svg:height="2cm"><text:p>Oval</text:p><draw:enhanced-geometry draw:type="ellipse"/></draw:custom-shape>
		</draw:page></office:presentation></office:body></office:document-content>`,
	);
	const deck = await readOdp(await zip.generateAsync({ type: "uint8array" }));
	assert.equal(deck.width, 28 * 360000);
	assert.equal(deck.slides.length, 1);
	assert.deepEqual(deck.slides[0].background, { type: "solid", color: "#1f2a44" });
	const [title, oval] = deck.slides[0].elements;
	assert.equal(title.box.x, 360000);
	assert.equal(title.text.paragraphs[0].runs[0].text, "Cookie Recipes");
	assert.equal(oval.preset, "ellipse");
	assert.deepEqual(oval.fill, { type: "solid", color: "#27ae60" });
	assert.equal(oval.line, null);
});

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

test("RTF reads formatting, unicode, code pages, tables and pictures, and skips the rest", () => {
	const png = PNG.toString("hex");
	const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier New;}}{\\colortbl;\\red255\\green0\\blue0;}
{\\header Page header}{\\*\\generator Writer;}{\\info{\\title Secret}}
\\pard\\qc\\fs48\\b Title\\b0\\par
\\pard\\li720\\fi-360 Plain {\\i italic} {\\cf1 red} {\\f1 mono} caf\\'e9 \\u8364? \\u-3913?\\line next\\par
{\\field{\\*\\fldinst HYPERLINK "https://x"}{\\fldrslt link text}}\\par
\\trowd\\cellx1000\\cellx2000\\intbl A\\cell B\\cell\\row
\\pard after{\\pict\\pngblip\\picwgoal1440\\pichgoal1440 ${png}}\\par}`;
	const doc = parseRtf(rtf);
	const text = (b) => b.runs.map((r) => r.text ?? (r.br ? "\n" : "")).join("");
	const [title, body, field, table, after] = doc.blocks;
	assert.equal(text(title), "Title");
	assert.equal(title.align, "center");
	assert.equal(title.runs[0].style.size, 24);
	assert.equal(title.runs[0].style.bold, true);
	assert.equal(title.runs[0].style.font, "Helvetica");
	assert.equal(text(body), "Plain italic red mono café € \nnext");
	assert.equal(body.indentLeft, 36);
	assert.equal(body.firstLine, -18);
	assert.equal(body.runs.find((r) => r.text === "italic").style.italic, true);
	assert.equal(body.runs.find((r) => r.text === "red").style.color, "#ff0000");
	assert.equal(body.runs.find((r) => r.text === "mono").style.font, "Courier New");
	assert.equal(text(field), "link text");
	assert.equal(table.kind, "table");
	assert.deepEqual(
		table.rows.map((r) => r.map((c) => c.map(text).join(""))),
		[["A", "B"]],
	);
	assert.equal(text(after), "after");
	assert.match(after.runs[1].image, /^data:image\/png;base64,iVBOR/);
	assert.equal(after.runs[1].width, 72);
	const all = JSON.stringify(doc);
	assert.ok(!all.includes("Page header") && !all.includes("Secret") && !all.includes("Writer") && !all.includes("HYPERLINK"));
});

test("RTF refuses a file that is not RTF", () => {
	assert.throws(() => parseRtf("hello"), /Not an RTF file/);
});

// ---------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------

test("a notebook reads cells and picks the richest safe output", () => {
	const nb = parseNotebook(
		JSON.stringify({
			nbformat: 4,
			metadata: { language_info: { name: "python" } },
			cells: [
				{ cell_type: "markdown", source: ["# Hi\n", "there"], metadata: {} },
				{
					cell_type: "code",
					execution_count: 3,
					source: "1/0",
					outputs: [
						{ output_type: "stream", name: "stderr", text: ["warn\n"] },
						{ output_type: "display_data", data: { "image/png": "iVBORw0K\n", "text/plain": "<Figure>" } },
						{ output_type: "execute_result", data: { "text/html": "<b>x</b>", "text/plain": "x" } },
						{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"] },
					],
				},
			],
		}),
	);
	assert.equal(nb.language, "python");
	assert.equal(nb.cells[0].source, "# Hi\nthere");
	const outs = nb.cells[1].outputs;
	assert.equal(nb.cells[1].executionCount, 3);
	assert.deepEqual(outs.map((o) => o.kind), ["stream", "image", "html", "error"]);
	assert.equal(outs[1].data, "iVBORw0K");
	assert.equal(outs[3].text, "ZeroDivisionError: division by zero");
	assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m"), "ok");
	assert.throws(() => parseNotebook("not json"), /not valid JSON/);
});

test("notebook markdown never loads a remote image", () => {
	const md = "![logo](https://example.com/a.png) ![ref][r] ![att](attachment:p.png) `![code](https://x/y.png)`";
	const out = neutralizeRemoteImages(md, { "p.png": "data:image/png;base64,AAAA" });
	assert.ok(!/!\[[^\]]*\]\(https?:/.test(out.replace("`![code](https://x/y.png)`", "")));
	assert.match(out, /\[Image: logo\]\(https:\/\/example.com\/a.png\)/);
	assert.match(out, /\[Image: ref\]/);
	assert.match(out, /!\[att\]\(attachment:p.png\)/, "attachment references stay as written for the viewer to resolve");
	assert.match(out, /`!\[code\]\(https:\/\/x\/y.png\)`/, "code spans are left alone");
});

// ---------------------------------------------------------------------------
// Content decoding
// ---------------------------------------------------------------------------

test("content decodes from base64 or data URLs and enforces the size limit", () => {
	assert.deepEqual([...decodeBase64Content("data:application/x;base64,AQID")], [1, 2, 3]);
	assert.deepEqual([...decodeBase64Content("AQ ID\n")], [1, 2, 3]);
	assert.throws(() => decodeBase64Content("A".repeat(400), 10), PreviewLimitError);
	assert.throws(() => decodeBase64Content("not base64!"), /not base64/);
	assert.equal(readTextContent("a,b\n1,2", (t) => t.includes(",")), "a,b\n1,2");
	assert.equal(readTextContent(Buffer.from("{\\rtf1 hi}").toString("base64"), (t) => t.startsWith("{\\rtf")), "{\\rtf1 hi}");
});

// ---------------------------------------------------------------------------
// Limits found in review: every reader stays bounded by the whole file, not per part.
// ---------------------------------------------------------------------------

/** Run `fn` with some PREVIEW_LIMITS lowered, then restore them. */
async function withLimits(over, fn) {
	const saved = { ...PREVIEW_LIMITS };
	Object.assign(PREVIEW_LIMITS, over);
	try {
		return await fn();
	} finally {
		Object.assign(PREVIEW_LIMITS, saved);
	}
}

test("CSV parsing drops fields past the column limit and says so", () => {
	const { rows, wide } = parseDelimited(`${",".repeat(1000)}\na,b`, ",", 10, 500);
	assert.equal(rows[0].length, 500);
	assert.equal(wide, true);
	assert.deepEqual(rows[1], ["a", "b"]);
});

test("a deck shares one element budget across slides, master shapes included", async () => {
	const deck = await withLimits({ maxDeckElements: 5 }, async () => readPptx(await cookieDeck()));
	// The first slide spends the budget (layout decoration plus its own shapes); the second is left out.
	assert.equal(deck.slides.length, 1);
	assert.equal(deck.totalSlides, 2);
	assert.ok(deck.slides[0].elements.length <= 5);
});

test("an odt stops at the run budget and caps repeated spaces", async () => {
	const zip = new JSZip();
	const many = Array.from({ length: 50 }, (_, i) => `<text:p>p${i}<text:s text:c="100000"/></text:p>`).join("");
	zip.file("content.xml", `<office:document-content ${ODF_NS}><office:body><office:text>${many}</office:text></office:body></office:document-content>`);
	const bytes = await zip.generateAsync({ type: "uint8array" });
	const doc = await withLimits({ maxTextRuns: 20 }, () => readOdt(bytes));
	assert.equal(doc.truncated, true);
	const runs = doc.blocks.flatMap((b) => b.runs ?? []);
	assert.ok(runs.length <= 20);
	assert.ok(runs.every((r) => !r.text || r.text.length <= 100), "text:s repeats at most 100 spaces");
});

test("RTF stops at the run limit and skips \\blipuid inside a picture", () => {
	const many = `{\\rtf1 ${"{\\b x}{\\i y}".repeat(100)}\\par}`;
	const capped = parseRtf(many, 1000, 10);
	assert.equal(capped.truncated, true);
	assert.ok(capped.blocks.flatMap((b) => b.runs).length <= 10);
	const png = PNG.toString("hex");
	const word = `{\\rtf1 {\\pict{\\*\\picprop{\\sp{\\sn x}{\\sv 1}}}\\pngblip{\\*\\blipuid 7a3c00112233445566778899aabbccdd}${png}}\\par}`;
	const img = parseRtf(word).blocks[0].runs[0].image;
	assert.equal(img, `data:image/png;base64,${PNG.toString("base64")}`);
});

test("a notebook has one output budget and merges consecutive streams", () => {
	const outputs = [
		...Array.from({ length: 3 }, () => ({ output_type: "stream", name: "stdout", text: "a" })),
		{ output_type: "stream", name: "stderr", text: "e" },
		...Array.from({ length: 50 }, () => ({ output_type: "display_data", data: { "text/plain": "x" } })),
	];
	const nb = parseNotebook(JSON.stringify({ cells: [{ cell_type: "code", source: "", outputs }] }), 10, 5);
	const outs = nb.cells[0].outputs;
	assert.equal(outs[0].text, "aaa");
	assert.equal(outs[1].name, "stderr");
	assert.equal(outs.length, 5);
	assert.equal(nb.truncated, true);
});

test("an archive that understates an entry's size still stops at the streaming cap", async () => {
	const zip = new JSZip();
	zip.file("ppt/presentation.xml", "a".repeat(40 * 1024 * 1024), { compression: "DEFLATE" });
	const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	// Rewrite the uncompressed size in the local header (offset 22) and the central directory (offset 24).
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint32(22, 100, true);
	for (let i = bytes.length - 22; i >= 0; i--) {
		if (view.getUint32(i, true) === 0x02014b50) {
			view.setUint32(i + 24, 100, true);
			break;
		}
	}
	await assert.rejects(readPptx(bytes), PreviewLimitError);
});

// ---------------------------------------------------------------------------
// Review round 2: work that draws nothing, or many small things, still costs budget.
// ---------------------------------------------------------------------------

/** cookieDeck with extra XML injected into the master's shape tree. */
async function deckWithMaster(extra) {
	const zip = await JSZip.loadAsync(await cookieDeck());
	const master = await zip.file("ppt/slideMasters/slideMaster1.xml").async("string");
	zip.file("ppt/slideMasters/slideMaster1.xml", master.replace("</p:spTree>", `${extra}</p:spTree>`));
	return zip.generateAsync({ type: "uint8array" });
}

test("bare master shapes that draw nothing still spend the deck budget", async () => {
	const bytes = await deckWithMaster("<p:sp/>".repeat(10_000));
	const deck = await withLimits({ maxDeckElements: 100 }, () => readPptx(bytes));
	assert.equal(deck.slides.length, 1, "the second slide is never walked");
});

test("empty paragraphs spend runs, and one text body holds at most 2,000", async () => {
	const body = `<p:sp><p:nvSpPr><p:cNvPr id="90" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${"<a:p/>".repeat(5000)}<a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`;
	const deck = await readPptx(await deckWithMaster(body));
	const shape = deck.slides[0].elements.find((e) => e.kind === "shape" && e.box.w === 10);
	assert.equal(shape.text, undefined, "the body stopped at 2,000 paragraphs, before its one run");
	const capped = await withLimits({ maxTextRuns: 1500 }, async () => readPptx(await deckWithMaster(body)));
	assert.equal(capped.slides.length, 1, "empty paragraphs alone spend the run budget on the first slide");
});

test("pptx tables are capped by columns and cells, and every cell costs an element", async () => {
	const cells = Array.from({ length: 50 }, () => "<a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc>").join("");
	const zip = await JSZip.loadAsync(await cookieDeck());
	const slide = await zip.file("ppt/slides/slide1.xml").async("string");
	zip.file("ppt/slides/slide1.xml", slide.replace(/<a:tr h="1000"><a:tc><a:txBody><a:bodyPr\/><a:p><a:r><a:t>Cookie/, `<a:tr h="1000">${cells}</a:tr><a:tr h="1000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cookie`));
	const deck = await withLimits({ maxTableColumns: 10 }, async () => readPptx(await zip.generateAsync({ type: "uint8array" })));
	const table = deck.slides[0].elements.find((e) => e.kind === "table");
	assert.equal(table.rows[0].cells.length, 10);
});

test("odt tables and lists are capped per cell and per item", async () => {
	const zip = new JSZip();
	const row = "<table:table-cell/>".repeat(2000);
	const items = "<text:list-item/>".repeat(25_000);
	zip.file("content.xml", `<office:document-content ${ODF_NS}><office:body><office:text><table:table><table:table-row>${row}</table:table-row></table:table><text:list>${items}</text:list></office:text></office:body></office:document-content>`);
	const doc = await readOdt(await zip.generateAsync({ type: "uint8array" }));
	assert.equal(doc.blocks[0].rows[0].cells.length, 500);
	assert.ok(doc.blocks[1].items.length < 25_000);
	assert.equal(doc.truncated, true);
});

test("RTF counts line breaks, empty table paragraphs and pictures toward its cap", () => {
	const breaks = parseRtf(`{\\rtf1 ${"\\line ".repeat(500)}x\\par}`, 1000, 100);
	assert.equal(breaks.truncated, true);
	assert.ok(breaks.blocks.flatMap((b) => b.runs ?? []).length <= 100);
	const cells = parseRtf(`{\\rtf1 \\intbl${"\\par".repeat(500)}\\cell\\row}`, 1000, 100);
	assert.equal(cells.truncated, true);
	const pics = parseRtf(`{\\rtf1 ${"{\\pict\\pngblip 89}".repeat(500)}\\par}`, 1000, 100);
	assert.equal(pics.truncated, true);
});

test("notebook cell sources share a budget, and a bad attachment escape doesn't break the notebook", () => {
	const big = "x".repeat(3_000_000);
	const nb = parseNotebook(JSON.stringify({ cells: [0, 1, 2].map(() => ({ cell_type: "markdown", source: big })) }));
	assert.equal(nb.cells.length, 2);
	assert.equal(nb.truncated, true);
	assert.match(neutralizeRemoteImages("![x](attachment:%E0%A4%A)", {}), /\[Image: x\]/);
});

test("text stored as wrapped base64 is decoded, not shown as base64", () => {
	const csv = "name,score\n".concat("alice,1\n".repeat(30));
	const wrapped = Buffer.from(csv).toString("base64").replace(/(.{76})/g, "$1\n");
	assert.equal(readTextContent(wrapped, (t) => /[,\n]/.test(t)), csv);
	assert.equal(readTextContent("abcd\nefgh", (t) => t.length > 0), "abcd\nefgh", "plain text that happens to be base64-shaped stays as written");
});

test("SheetJS only sees capped parts: a duplicate name can't smuggle in the uncapped entry", async () => {
	const zip = new JSZip();
	zip.file("xl/worksheets/sheet1.xml", "a".repeat(5 * 1024 * 1024), { compression: "DEFLATE" });
	zip.file("xl/worksheets/sheetX.xml", "<small/>");
	const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	// Rename the second entry to the first one's name in both headers.
	const text = Buffer.from(bytes);
	let at = text.indexOf("sheetX.xml");
	while (at >= 0) {
		text.write("sheet1.xml", at);
		at = text.indexOf("sheetX.xml", at + 1);
	}
	const clean = await JSZip.loadAsync(await cappedWorkbookZip(new Uint8Array(text)));
	const names = Object.keys(clean.files).filter((n) => !clean.files[n].dir);
	assert.deepEqual(names, ["xl/worksheets/sheet1.xml"]);
	assert.equal(await clean.file("xl/worksheets/sheet1.xml").async("string"), "<small/>");
});

test("a large honest workbook still previews its first rows, and media is left out", async () => {
	const rows = Array.from({ length: 120_000 }, (_, i) => [i, `row ${i}`, i * 2, "some text in a cell", i % 7, i / 3, "x", "y", "z", i]);
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Big");
	const raw = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true });
	const zip = await JSZip.loadAsync(raw);
	const sheetSize = (await zip.file("xl/worksheets/sheet1.xml").async("uint8array")).length;
	assert.ok(sheetSize > 30 * 1024 * 1024, `sheet part is ${sheetSize} bytes, over the document entry cap`);
	zip.file("xl/media/image1.png", new Uint8Array(10));
	const capped = await cappedWorkbookZip(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
	assert.equal((await JSZip.loadAsync(capped)).file("xl/media/image1.png"), null);
	const read = XLSX.read(capped, { type: "array", sheetRows: 5000 });
	const sheet = read.Sheets.Big;
	clampSheet(sheet);
	assert.equal(XLSX.utils.decode_range(sheet["!ref"]).e.r, 4999);
});

// ---------------------------------------------------------------------------
// Review round 3
// ---------------------------------------------------------------------------

test("markdown image neutralizing stays linear on hostile input", () => {
	const started = Date.now();
	neutralizeRemoteImages("![".repeat(500_000), {});
	neutralizeRemoteImages(`![${"a".repeat(200_000)}`, {});
	assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test("the XML reader refuses elements with thousands of attributes", () => {
	const attrs = Array.from({ length: 300 }, (_, i) => `a${i}=""`).join(" ");
	assert.throws(() => parseXml(`<r ${attrs}/>`), XmlError);
	assert.doesNotThrow(() => parseXml(`<r ${attrs.split(" ").slice(0, 200).join(" ")}/>`));
});

test("deck text has a character budget and a table grid is capped", async () => {
	const longText = `<p:sp><p:nvSpPr><p:cNvPr id="91" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${"x".repeat(200_000)}</a:t></a:r></a:p></p:txBody></p:sp>`;
	const bytes = await deckWithMaster(longText);
	const longShape = (slide) => slide.elements.find((e) => e.kind === "shape" && e.box.w === 10);
	const deck = await readPptx(bytes);
	assert.equal(longShape(deck.slides[0]).text.paragraphs[0].runs[0].text.length, 100_000, "one run is clipped to 100,000 characters");
	const capped = await withLimits({ maxTextChars: 150_000 }, () => readPptx(bytes));
	assert.equal(capped.slides.length, 2, "the second slide draws the cached master text and spends the rest");
	const spent = await withLimits({ maxTextChars: 50_000 }, () => readPptx(bytes));
	assert.equal(longShape(spent.slides[0]).text, undefined, "a run past the budget is not drawn");
	assert.equal(spent.slides.length, 1);
	const zip = await JSZip.loadAsync(await cookieDeck());
	const slide = await zip.file("ppt/slides/slide1.xml").async("string");
	zip.file("ppt/slides/slide1.xml", slide.replace("<a:tblGrid>", `<a:tblGrid>${'<a:gridCol w="1"/>'.repeat(2000)}`));
	const grid = await readPptx(await zip.generateAsync({ type: "uint8array" }));
	assert.equal(grid.slides[0].elements.find((e) => e.kind === "table").columns.length, 500);
});

test("odp text bodies cap paragraphs and charge empty ones", async () => {
	const zip = new JSZip();
	zip.file(
		"content.xml",
		`<office:document-content ${ODF_NS}><office:body><office:presentation><draw:page><draw:frame svg:x="0cm" svg:y="0cm" svg:width="1cm" svg:height="1cm"><draw:text-box>${"<text:p/>".repeat(5000)}<text:p>x</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>`,
	);
	const deck = await readOdp(await zip.generateAsync({ type: "uint8array" }));
	const shape = deck.slides[0].elements[0];
	assert.equal(shape.text, undefined, "the body stops at 2,000 paragraphs, before its one run");
});

test("RTF applies the character cap to one long unstyled run", () => {
	const doc = parseRtf(`{\\rtf1 ${"a".repeat(2000)}\\par}`, 1000, 1000, 500);
	assert.equal(doc.truncated, true);
	assert.ok(doc.blocks.flatMap((b) => b.runs).reduce((n, r) => n + (r.text?.length ?? 0), 0) <= 600);
});

// ---------------------------------------------------------------------------
// Apple Numbers: SheetJS inflates .iwa Snappy streams itself, so their sizes are checked first.
// ---------------------------------------------------------------------------

/** One framed Snappy chunk: type 0, 3-byte length, varint declared size, then tags. */
function iwaChunk(declared, tags) {
	const varint = [];
	let v = declared;
	do {
		varint.push((v & 0x7f) | (v >= 0x80 ? 0x80 : 0));
		v = Math.floor(v / 0x80);
	} while (v > 0);
	const payload = Buffer.concat([Buffer.from(varint), tags]);
	const head = Buffer.from([0, payload.length & 255, (payload.length >> 8) & 255, (payload.length >> 16) & 255]);
	return Buffer.concat([head, payload]);
}
/** A 4-byte literal followed by `copies` copy tags of 64 bytes each (3 bytes per tag). */
function expandingTags(copies) {
	const literal = Buffer.from([(4 - 1) << 2, 1, 2, 3, 4]);
	const copy = Buffer.alloc(copies * 3);
	for (let i = 0; i < copies; i++) copy.set([((64 - 1) << 2) | 2, 4, 0], i * 3);
	return Buffer.concat([literal, copy]);
}

async function numbersWith(extraIwa) {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Cookie", "Minutes"], ["Chocolate chip", 10]]), "Cookies");
	const raw = XLSX.write(wb, { type: "array", bookType: "numbers", numbers: XLSX_ZAHL });
	const zip = await JSZip.loadAsync(raw);
	if (extraIwa) zip.file("Index/Evil.iwa", extraIwa);
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

test("an honest Numbers file passes the stream check and still reads", async () => {
	const capped = await cappedWorkbookZip(await numbersWith());
	const wb = XLSX.read(capped, { type: "array" });
	assert.equal(XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]).split("\n")[1], "Chocolate chip,10");
});

test("a Numbers stream that declares more than the cap is refused before SheetJS", async () => {
	const evil = iwaChunk(500 * 1024 * 1024, expandingTags(10));
	assert.throws(() => iwaUncompressedSize(evil, 120 * 1024 * 1024), PreviewLimitError);
	await assert.rejects(cappedWorkbookZip(await numbersWith(evil)), /Export it to XLSX/);
});

test("a Numbers stream that inflates past the cap is refused without inflating it", async () => {
	// 30,000 copy tags expand about 21x: 1.9 MB out of 90 KB in.
	const evil = iwaChunk(1000, expandingTags(30_000));
	assert.throws(() => iwaUncompressedSize(evil, 1024 * 1024), PreviewLimitError);
	const bytes = await numbersWith(evil);
	await withLimits({ maxSpreadsheetEntryBytes: 1024 * 1024 }, () => assert.rejects(cappedWorkbookZip(bytes), PreviewLimitError));
});

test("a Numbers stream whose declared and actual sizes disagree is refused", () => {
	assert.throws(() => iwaUncompressedSize(iwaChunk(10, expandingTags(2)), 1e9), /Malformed/);
	assert.equal(iwaUncompressedSize(iwaChunk(4 + 2 * 64, expandingTags(2)), 1e9), 132);
	assert.throws(() => iwaUncompressedSize(Buffer.from([0, 200, 0, 0, 1]), 1e9), /Malformed/);
});

// ---------------------------------------------------------------------------
// Series 2, round 1
// ---------------------------------------------------------------------------

test("custom-shape commands come out of one deck-wide budget", async () => {
	const path = `<a:moveTo><a:pt x="0" y="0"/></a:moveTo>${'<a:lnTo><a:pt x="1" y="1"/></a:lnTo>'.repeat(799)}`;
	const shape = `<p:sp><p:nvSpPr><p:cNvPr id="92" name="c"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12" cy="12"/></a:xfrm><a:custGeom><a:pathLst><a:path w="10" h="10">${path}</a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>`;
	const bytes = await deckWithMaster(shape);
	const commands = (slide) => (slide.elements.find((e) => e.kind === "shape" && e.box.w === 12)?.paths?.[0]?.d.match(/[ML]/g) ?? []).length;
	const capped = await withLimits({ maxDeckCommands: 700 }, () => readPptx(bytes));
	assert.equal(commands(capped.slides[0]), 700, "the shape gets what the budget has left");
	assert.equal(capped.slides.length, 1, "no slide starts once the budget is spent");
	const full = await withLimits({ maxDeckCommands: 2000 }, () => readPptx(bytes));
	assert.equal(commands(full.slides[1]), 800, "the master's shape is read once and drawn again on the next slide");
	const short = await withLimits({ maxDeckCommands: 1000 }, () => readPptx(bytes));
	assert.equal(commands(short.slides[1]), 0, "a reuse the budget can't cover draws nothing rather than overshooting");
});

test("master shapes are read once per file, and each slide shows its own slide number", async () => {
	const junk = "<a:x/>".repeat(200_000);
	const num = `<p:sp><p:nvSpPr><p:cNvPr id="93" name="n"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="13" cy="13"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld>${junk}</a:p></p:txBody></p:sp>`;
	const zip = await JSZip.loadAsync(await deckWithMaster(num));
	const pres = await zip.file("ppt/presentation.xml").async("string");
	const rels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
	const ids = Array.from({ length: 40 }, (_, i) => `<p:sldId id="${300 + i}" r:id="rX${i}"/>`).join("");
	zip.file("ppt/presentation.xml", pres.replace("</p:sldIdLst>", `${ids}</p:sldIdLst>`));
	zip.file("ppt/_rels/presentation.xml.rels", rels.replace("</Relationships>", `${Array.from({ length: 40 }, (_, i) => `<Relationship Id="rX${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>`).join("")}</Relationships>`));
	const started = Date.now();
	const deck = await readPptx(await zip.generateAsync({ type: "uint8array" }));
	assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
	assert.equal(deck.slides.length, 42);
	const run = deck.slides[5].elements.find((e) => e.kind === "shape" && e.box.w === 13).text.paragraphs[0].runs[0];
	assert.equal(run.slideNumber, true, "the number is filled in per slide when drawn");
});

test("a gradient keeps at most 64 stops", async () => {
	const stops = Array.from({ length: 300 }, (_, i) => `<a:gs pos="${i * 300}"><a:srgbClr val="00FF00"/></a:gs>`).join("");
	const zip = await JSZip.loadAsync(await cookieDeck());
	const master = await zip.file("ppt/slideMasters/slideMaster1.xml").async("string");
	zip.file("ppt/slideMasters/slideMaster1.xml", master.replace(/<p:bgPr>.*?<\/p:bgPr>/s, `<p:bgPr><a:gradFill><a:gsLst>${stops}</a:gsLst><a:lin ang="0"/></a:gradFill></p:bgPr>`));
	const deck = await readPptx(await zip.generateAsync({ type: "uint8array" }));
	assert.equal(deck.slides[0].background.stops.length, 64);
});

test("base64 text over the preview limit still decodes for download", () => {
	const csv = "a,b\n".repeat(11 * 1024 * 1024);
	const decoded = readTextContent(Buffer.from(csv).toString("base64"), (t) => t.includes(","));
	assert.equal(decoded.length, csv.length);
});

test("odt and odp table columns are charged to the document budget", async () => {
	const zip = new JSZip();
	const table = '<table:table><table:table-column table:style-name="co" table:number-columns-repeated="256"/><table:table-column table:style-name="co" table:number-columns-repeated="256"/></table:table>';
	zip.file("content.xml", `<office:document-content ${ODF_NS}><office:automatic-styles><style:style style:name="co" style:family="table-column"><style:table-column-properties style:column-width="1cm"/></style:style></office:automatic-styles><office:body><office:text>${table.repeat(2000)}</office:text></office:body></office:document-content>`);
	const doc = await readOdt(await zip.generateAsync({ type: "uint8array" }));
	const cols = doc.blocks.reduce((n, b) => n + (b.columns?.length ?? 0), 0);
	assert.ok(cols <= 20_500, `${cols} columns`);
	assert.equal(doc.truncated, true);
	const odp = new JSZip();
	const frame = '<draw:frame svg:x="0cm" svg:y="0cm" svg:width="1cm" svg:height="1cm"><table:table><table:table-column table:number-columns-repeated="64"/><table:table-column table:number-columns-repeated="64"/></table:table></draw:frame>';
	odp.file("content.xml", `<office:document-content ${ODF_NS}><office:body><office:presentation><draw:page>${frame.repeat(400)}</draw:page></office:presentation></office:body></office:document-content>`);
	const deck = await withLimits({ maxDeckElements: 1000 }, async () => readOdp(await odp.generateAsync({ type: "uint8array" })));
	const odpCols = deck.slides[0].elements.reduce((n, e) => n + (e.columns?.length ?? 0), 0);
	assert.ok(odpCols <= 1000, `${odpCols} columns`);
});

test("an archive with too many entries is refused before JSZip reads it, even with bytes prepended", async () => {
	const zip = new JSZip();
	for (let i = 0; i < 10_050; i++) zip.file(`f${i}`, "");
	const bytes = await zip.generateAsync({ type: "uint8array" });
	assert.equal(countZipEntries(bytes, 10_000), 10_001);
	await assert.rejects(readPptx(bytes), /too many entries/);
	const prepended = new Uint8Array(bytes.length + 100);
	prepended.set(bytes, 100);
	assert.equal(countZipEntries(prepended, 10_000), 10_001);
	await assert.rejects(readPptx(prepended), /too many entries/);
	const deckBytes = await cookieDeck();
	assert.equal(countZipEntries(deckBytes, 10_000), Object.keys((await JSZip.loadAsync(deckBytes)).files).length);
});

// ---------------------------------------------------------------------------
// Series 2, round 2
// ---------------------------------------------------------------------------

test("the tests exercise the JSZip and SheetJS the bundle ships", async () => {
	// scripts/build.mjs aliases both packages to Tabkyra's node_modules, which these tests import.
	const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
	assert.match(build, /xlsx: join\(packageRoot, "node_modules\/xlsx"\)/);
	assert.match(build, /jszip: join\(packageRoot, "node_modules\/jszip"\)/);
	// SafeZip stops inflating at its cap through JSZip's internal stream; without it the cap would only apply after.
	const zip = await JSZip.loadAsync(await new JSZip().file("a", "b").generateAsync({ type: "uint8array" }));
	assert.equal(typeof zip.file("a").internalStream, "function");
	const piMono = new URL("../../pi-mono/node_modules/", import.meta.url);
	for (const pkg of ["xlsx", "jszip"]) {
		const theirs = new URL(`${pkg}/package.json`, piMono);
		if (!existsSync(theirs)) continue;
		const ours = JSON.parse(readFileSync(new URL(`../node_modules/${pkg}/package.json`, import.meta.url), "utf8")).version;
		assert.equal(ours, JSON.parse(readFileSync(theirs, "utf8")).version, `${pkg} versions match pi-web-ui's`);
	}
});

test("a Numbers file's Index.zip goes through the same caps, and other nested archives are dropped", async () => {
	const inner = new JSZip();
	inner.file("Index/Document.iwa", iwaChunk(500 * 1024 * 1024, expandingTags(10)));
	const outer = new JSZip();
	outer.file("Index.zip", await inner.generateAsync({ type: "uint8array" }));
	await assert.rejects(cappedWorkbookZip(await outer.generateAsync({ type: "uint8array" })), /Export it to XLSX/);
	const honest = new JSZip();
	honest.file("Index.zip", await new JSZip().file("Index/Document.iwa", iwaChunk(132, expandingTags(2))).generateAsync({ type: "uint8array" }));
	honest.file("Data/other.zip", "PK");
	const rebuilt = await JSZip.loadAsync(await cappedWorkbookZip(await honest.generateAsync({ type: "uint8array" })));
	assert.deepEqual(Object.keys(rebuilt.files).filter((n) => !rebuilt.files[n].dir), ["Index.zip"]);
});

test("odt spans can't widen the table past its column limit", async () => {
	const zip = new JSZip();
	const row = '<table:table-row><table:table-cell table:number-columns-spanned="1000" table:number-rows-spanned="65000"/>'.concat("<table:table-cell/>".repeat(10), "</table:table-row>");
	zip.file("content.xml", `<office:document-content ${ODF_NS}><office:body><office:text><table:table>${row.repeat(3)}</table:table></office:text></office:body></office:document-content>`);
	const doc = await readOdt(await zip.generateAsync({ type: "uint8array" }));
	const cells = doc.blocks[0].rows[0].cells;
	assert.equal(cells[0].colSpan, 500);
	assert.equal(cells.length, 1, "cells past the 500th column are dropped");
	assert.equal(cells[0].rowSpan, 3, "a row span ends at the last row drawn");
	assert.equal(doc.blocks[0].rows[2].cells[0].rowSpan, 1);
});

test("pptx table spans are fitted to the column limit", () => {
	const cell = (gridSpan) => ({ gridSpan, rowSpan: 1, merged: false, borders: {} });
	const row = fitRow([cell(400), cell(400), cell(1)], 500);
	assert.deepEqual(row.map((c) => c.gridSpan), [400, 100]);
});

test("odp style chains are walked at most 32 deep", async () => {
	const styles = Array.from({ length: 50_000 }, (_, i) => `<style:style style:name="s${i}" style:family="presentation"${i ? ` style:parent-style-name="s${i - 1}"` : ""}/>`).join("");
	const frames = '<draw:frame presentation:style-name="s49999" svg:x="0cm" svg:y="0cm" svg:width="1cm" svg:height="1cm"><draw:text-box><text:p>x</text:p></draw:text-box></draw:frame>'.repeat(500);
	const zip = new JSZip();
	zip.file("content.xml", `<office:document-content ${ODF_NS}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:presentation><draw:page>${frames}</draw:page></office:presentation></office:body></office:document-content>`);
	const started = Date.now();
	const deck = await readOdp(await zip.generateAsync({ type: "uint8array" }));
	assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
	assert.equal(deck.slides[0].elements.length, 500);
});

test("notebook attachment names can't reach the object prototype", () => {
	const nb = parseNotebook(JSON.stringify({ cells: [{ cell_type: "markdown", source: "", attachments: { "p.png": { "image/png": "AAAA" } } }] }));
	const att = nb.cells[0].attachments;
	assert.equal(attachmentData(att, "attachment:constructor"), undefined);
	assert.equal(attachmentData(att, "attachment:__proto__"), undefined);
	assert.equal(attachmentData(att, "attachment:p.png"), "data:image/png;base64,AAAA");
	assert.match(neutralizeRemoteImages("![x](attachment:toString)", att), /\[Image: x\]/);
});

test("notebook text outputs have their own budget", () => {
	const outputs = Array.from({ length: 20 }, () => ({ output_type: "stream", name: "stdout", text: "x".repeat(1_000_000) }));
	const nb = parseNotebook(JSON.stringify({ cells: outputs.map((o) => ({ cell_type: "code", source: "", outputs: [o] })) }));
	const shown = nb.cells.flatMap((c) => c.outputs).reduce((n, o) => n + o.text.length, 0);
	assert.ok(shown <= 6_000_000, `${shown} characters`);
	assert.equal(nb.truncated, true);
});

// ---------------------------------------------------------------------------
// Series 2, round 3 findings (fixed after the review series; not re-reviewed)
// ---------------------------------------------------------------------------

/** cookieDeck with the first slide listed `times` more times in sldIdLst. */
async function repeatSlide(zip, times) {
	const pres = await zip.file("ppt/presentation.xml").async("string");
	const rels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
	const ids = Array.from({ length: times }, (_, i) => `<p:sldId id="${400 + i}" r:id="rR${i}"/>`).join("");
	const rel = Array.from({ length: times }, (_, i) => `<Relationship Id="rR${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`).join("");
	zip.file("ppt/presentation.xml", pres.replace("</p:sldIdLst>", `${ids}</p:sldIdLst>`));
	zip.file("ppt/_rels/presentation.xml.rels", rels.replace("</Relationships>", `${rel}</Relationships>`));
	return zip;
}

test("hostile: tables of empty rows on a slide listed many times spend the deck budget", async () => {
	const zip = await JSZip.loadAsync(await cookieDeck());
	const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="10"/></a:tblGrid>${"<a:tr/>".repeat(5000)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
	const slide = await zip.file("ppt/slides/slide1.xml").async("string");
	zip.file("ppt/slides/slide1.xml", slide.replace("</p:spTree>", `${frame.repeat(20)}</p:spTree>`));
	await repeatSlide(zip, 250);
	const deck = await readPptx(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
	const rows = deck.slides.flatMap((s) => s.elements).reduce((n, e) => n + (e.kind === "table" ? e.rows.length : 0), 0);
	assert.ok(rows <= 60_000, `${rows} table rows drawn`);
	assert.ok(deck.slides.length < 252, `${deck.slides.length} slides`);
});

test("a slide listed many times is read once", async () => {
	const zip = await JSZip.loadAsync(await cookieDeck());
	const slide = await zip.file("ppt/slides/slide1.xml").async("string");
	zip.file("ppt/slides/slide1.xml", slide.replace("<a:t>Flour</a:t></a:r>", `<a:t>Flour</a:t></a:r>${"<a:x/>".repeat(800_000)}`));
	await repeatSlide(zip, 299);
	const started = Date.now();
	const deck = await readPptx(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
	assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
	assert.equal(deck.slides.at(-1).number, deck.slides.length, "each listing keeps its own number");
});

test("a reused master never draws past what is left of the budget", async () => {
	const shapes = Array.from({ length: 30 }, (_, i) => `<p:sp><p:nvSpPr><p:cNvPr id="${200 + i}" name="d"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5" cy="5"/></a:xfrm><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>`).join("");
	const deck = await withLimits({ maxDeckElements: 50 }, async () => readPptx(await deckWithMaster(shapes)));
	const drawn = deck.slides.reduce((n, s) => n + s.elements.length, 0);
	assert.ok(drawn <= 50, `${drawn} elements drawn under a budget of 50`);
});

test("relationship ids are found under any prefix", async () => {
	const zip = await JSZip.loadAsync(await cookieDeck());
	const pres = await zip.file("ppt/presentation.xml").async("string");
	zip.file("ppt/presentation.xml", pres.replace('xmlns:r="', 'xmlns:rel="').replaceAll(" r:id=", " rel:id="));
	const deck = await readPptx(await zip.generateAsync({ type: "uint8array" }));
	assert.equal(deck.slides.length, 2);
});

test("odp tables read grouped rows and columns, header rows first", async () => {
	const zip = new JSZip();
	const table = `<table:table><table:table-columns><table:table-column table:style-name="c"/><table:table-column table:style-name="c"/></table:table-columns><table:table-rows><table:table-row><table:table-cell><text:p>body</text:p></table:table-cell></table:table-row></table:table-rows><table:table-header-rows><table:table-row><table:table-cell><text:p>head</text:p></table:table-cell></table:table-row></table:table-header-rows></table:table>`;
	zip.file("content.xml", `<office:document-content ${ODF_NS}><office:automatic-styles><style:style style:name="c" style:family="table-column"><style:table-column-properties style:column-width="2cm"/></style:style></office:automatic-styles><office:body><office:presentation><draw:page><draw:frame svg:x="0cm" svg:y="0cm" svg:width="4cm" svg:height="2cm">${table}</draw:frame></draw:page></office:presentation></office:body></office:document-content>`);
	const deck = await readOdp(await zip.generateAsync({ type: "uint8array" }));
	const t = deck.slides[0].elements[0];
	assert.deepEqual(t.columns, [720000, 720000]);
	assert.deepEqual(t.rows.map((r) => r.cells[0].text.paragraphs[0].runs[0].text), ["head", "body"]);
});

test("CSV reports the file's own row and column counts", () => {
	const text = `${"a,".repeat(799)}a\n${"x,y\n".repeat(20)}`;
	const table = parseDelimited(text, ",", 10, 500);
	assert.equal(table.totalRows, 21);
	assert.equal(table.totalColumns, 800);
});

test("viewer messages put file names in as written, $ patterns included", async () => {
	const src = (f) => readFileSync(new URL(`../src/artifacts/${f}`, import.meta.url), "utf8");
	for (const f of ["MediaArtifact.ts", "TkFileArtifact.ts", "DelimitedArtifact.ts", "preview/deck-view.ts", "NotebookArtifact.ts"]) {
		// A string replacement expands $& and $'; a function replacement doesn't.
		assert.doesNotMatch(src(f), /\.replace\(\s*"\{[a-z]+\}",(?!\s*\(\) =>)/, f);
	}
});

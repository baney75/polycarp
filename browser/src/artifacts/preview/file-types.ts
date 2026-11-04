/** Which viewer an artifact gets, decided by its file extension. */
export type ArtifactFileType =
	| "html"
	| "svg"
	| "markdown"
	| "image"
	| "pdf"
	| "excel"
	| "docx"
	| "pptx"
	| "delimited"
	| "audio"
	| "video"
	| "notebook"
	| "odt"
	| "odp"
	| "rtf"
	| "text"
	| "generic";

const IMAGE_EXT = [
	"png",
	"jpg",
	"jpeg",
	"jpe",
	"jfif",
	"pjpeg",
	"pjp",
	"gif",
	"webp",
	"bmp",
	"ico",
	"cur",
	"avif",
	"apng",
];
// Every format the bundled SheetJS reads into a workbook.
const SPREADSHEET_EXT = ["xlsx", "xls", "xlsm", "xlsb", "xltx", "xltm", "ods", "numbers"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"];
const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "ogv"];
const TEXT_EXT =
	"txt text log json jsonl ndjson xml yaml yml toml ini cfg conf env js mjs cjs ts mts cts jsx tsx py rb go rs java kt kts swift c cc cpp cxx h hpp cs php pl lua r sql css scss sass less sh bash zsh fish ps1 bat diff patch tex bib srt vtt rst adoc org graphql proto dockerfile makefile".split(
		" ",
	);

const BY_EXT = new Map<string, ArtifactFileType>();
for (const e of IMAGE_EXT) BY_EXT.set(e, "image");
for (const e of SPREADSHEET_EXT) BY_EXT.set(e, "excel");
for (const e of AUDIO_EXT) BY_EXT.set(e, "audio");
for (const e of VIDEO_EXT) BY_EXT.set(e, "video");
for (const e of TEXT_EXT) BY_EXT.set(e, "text");
for (const [e, t] of Object.entries({
	html: "html",
	svg: "svg",
	md: "markdown",
	markdown: "markdown",
	pdf: "pdf",
	docx: "docx",
	pptx: "pptx",
	pptm: "pptx",
	ppsx: "pptx",
	potx: "pptx",
	csv: "delimited",
	tsv: "delimited",
	tab: "delimited",
	ipynb: "notebook",
	odt: "odt",
	ott: "odt",
	odp: "odp",
	otp: "odp",
	rtf: "rtf",
} as const)) {
	BY_EXT.set(e, t);
}

export function fileExtension(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? filename;
	const dot = base.lastIndexOf(".");
	if (dot < 0) return base.toLowerCase();
	return base.slice(dot + 1).toLowerCase();
}

export function getArtifactFileType(filename: string): ArtifactFileType {
	return BY_EXT.get(fileExtension(filename)) ?? "generic";
}

const MIME: Record<string, string> = Object.fromEntries(
	"png=image/png apng=image/apng jpg=image/jpeg jpeg=image/jpeg jpe=image/jpeg jfif=image/jpeg pjpeg=image/jpeg pjp=image/jpeg gif=image/gif webp=image/webp bmp=image/bmp ico=image/x-icon cur=image/x-icon avif=image/avif svg=image/svg+xml mp3=audio/mpeg wav=audio/wav ogg=audio/ogg oga=audio/ogg opus=audio/ogg m4a=audio/mp4 aac=audio/aac flac=audio/flac weba=audio/webm mp4=video/mp4 m4v=video/mp4 webm=video/webm mov=video/quicktime ogv=video/ogg avi=video/x-msvideo pdf=application/pdf csv=text/csv tsv=text/tab-separated-values tab=text/tab-separated-values rtf=application/rtf ipynb=application/x-ipynb+json json=application/json xml=application/xml docx=application/vnd.openxmlformats-officedocument.wordprocessingml.document docm=application/vnd.ms-word.document.macroEnabled.12 pptx=application/vnd.openxmlformats-officedocument.presentationml.presentation pptm=application/vnd.ms-powerpoint.presentation.macroEnabled.12 ppsx=application/vnd.openxmlformats-officedocument.presentationml.slideshow potx=application/vnd.openxmlformats-officedocument.presentationml.template xlsx=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet xlsm=application/vnd.ms-excel.sheet.macroEnabled.12 xlsb=application/vnd.ms-excel.sheet.binary.macroEnabled.12 xltx=application/vnd.openxmlformats-officedocument.spreadsheetml.template xltm=application/vnd.ms-excel.template.macroEnabled.12 xls=application/vnd.ms-excel ods=application/vnd.oasis.opendocument.spreadsheet odt=application/vnd.oasis.opendocument.text ott=application/vnd.oasis.opendocument.text-template odp=application/vnd.oasis.opendocument.presentation otp=application/vnd.oasis.opendocument.presentation-template numbers=application/vnd.apple.numbers key=application/vnd.apple.keynote pages=application/vnd.apple.pages doc=application/msword ppt=application/vnd.ms-powerpoint pps=application/vnd.ms-powerpoint zip=application/zip tar=application/x-tar gz=application/gzip rar=application/vnd.rar 7z=application/x-7z-compressed"
		.split(" ")
		.map((p) => p.split("=")),
);

export function mimeTypeFor(filename: string): string {
	return MIME[fileExtension(filename)] ?? "application/octet-stream";
}

/** Formats with no preview, and what to save them as so they get one. */
const CONVERT_HINTS: Record<string, { name: string; saveAs: string }> = {
	doc: { name: "Word 97-2003 document", saveAs: "DOCX or PDF" },
	dot: { name: "Word 97-2003 template", saveAs: "DOCX or PDF" },
	wpd: { name: "WordPerfect document", saveAs: "DOCX or PDF" },
	ppt: { name: "PowerPoint 97-2003 presentation", saveAs: "PPTX or PDF" },
	pps: { name: "PowerPoint 97-2003 slide show", saveAs: "PPTX or PDF" },
	pot: { name: "PowerPoint 97-2003 template", saveAs: "PPTX or PDF" },
	key: { name: "Keynote presentation", saveAs: "PPTX or PDF (File > Export To in Keynote)" },
	pages: { name: "Pages document", saveAs: "DOCX or PDF (File > Export To in Pages)" },
	vsd: { name: "Visio drawing", saveAs: "PDF or SVG" },
	vsdx: { name: "Visio drawing", saveAs: "PDF or SVG" },
	pub: { name: "Publisher document", saveAs: "PDF" },
	odg: { name: "OpenDocument drawing", saveAs: "PDF or SVG" },
	heic: { name: "HEIC image", saveAs: "JPEG or PNG" },
	heif: { name: "HEIF image", saveAs: "JPEG or PNG" },
	tif: { name: "TIFF image", saveAs: "PNG or JPEG" },
	tiff: { name: "TIFF image", saveAs: "PNG or JPEG" },
	avi: { name: "AVI video", saveAs: "MP4 or WebM" },
	mkv: { name: "Matroska video", saveAs: "MP4 or WebM" },
	wmv: { name: "Windows Media video", saveAs: "MP4 or WebM" },
	wma: { name: "Windows Media audio", saveAs: "MP3 or M4A" },
	aiff: { name: "AIFF audio", saveAs: "WAV or MP3" },
	aif: { name: "AIFF audio", saveAs: "WAV or MP3" },
};

export function conversionHint(filename: string): { name: string; saveAs: string } | undefined {
	return CONVERT_HINTS[fileExtension(filename)];
}

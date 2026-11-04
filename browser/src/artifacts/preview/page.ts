/** A white page on a muted background, like the docx preview, for flowing documents (RTF, ODT). */
export function documentPage(doc: Document): { scroller: HTMLElement; page: HTMLElement } {
	const scroller = doc.createElement("div");
	scroller.className = "h-full overflow-auto bg-muted/40 p-3";
	const page = doc.createElement("div");
	page.style.background = "#fff";
	page.style.color = "#000";
	page.style.maxWidth = "816px";
	page.style.margin = "0 auto";
	page.style.padding = "48px 56px";
	page.style.boxShadow = "0 1px 3px rgba(0,0,0,0.15)";
	page.style.fontFamily = '"Helvetica Neue", Arial, sans-serif';
	page.style.fontSize = "16px";
	page.style.lineHeight = "1.35";
	page.style.overflowWrap = "break-word";
	page.style.minWidth = "0";
	scroller.appendChild(page);
	return { scroller, page };
}

import { i18n } from "@mariozechner/mini-lit";
import { type Deck, EMU_PER_PX } from "./pptx.js";
import { imageUrls, renderSlide } from "./slide-render.js";

/**
 * Shows a deck as a scrolling column of slides, each scaled to the panel width, with its
 * number. Returns a cleanup that disconnects the resize observer and frees image URLs.
 */
export function mountDeck(container: HTMLElement, deck: Deck): () => void {
	const doc = container.ownerDocument;
	const { urls, revoke } = imageUrls(deck);
	const naturalW = deck.width / EMU_PER_PX;
	const naturalH = deck.height / EMU_PER_PX;

	const scroller = doc.createElement("div");
	scroller.className = "h-full overflow-auto bg-muted/40";
	scroller.style.scrollbarGutter = "stable";
	scroller.tabIndex = 0;
	const header = doc.createElement("div");
	header.className = "px-3 pt-3 text-xs text-muted-foreground";
	const count =
		deck.totalSlides === 1
			? i18n("1 slide")
			: i18n("{count} slides").replace("{count}", () => String(deck.totalSlides));
	header.textContent =
		deck.slides.length < deck.totalSlides
			? `${count} · ${i18n("showing the first {count}").replace("{count}", () => String(deck.slides.length))}`
			: count;
	scroller.appendChild(header);

	const frames: { frame: HTMLElement; slideEl: HTMLElement }[] = [];
	for (const slide of deck.slides) {
		const card = doc.createElement("div");
		card.className = "px-3 py-2";
		const label = doc.createElement("div");
		label.className = "text-xs text-muted-foreground mb-1 flex gap-2";
		const num = doc.createElement("span");
		num.textContent = String(slide.number);
		label.appendChild(num);
		if (slide.hidden) {
			const hidden = doc.createElement("span");
			hidden.textContent = i18n("Hidden slide");
			label.appendChild(hidden);
		}
		const frame = doc.createElement("div");
		frame.className = "relative overflow-hidden rounded-sm shadow border border-border bg-white";
		frame.dataset.slide = String(slide.number);
		const slideEl = renderSlide(doc, deck, slide, urls);
		slideEl.style.transformOrigin = "0 0";
		slideEl.style.position = "absolute";
		slideEl.style.left = "0";
		slideEl.style.top = "0";
		if (slide.hidden) slideEl.style.opacity = "0.55";
		frame.appendChild(slideEl);
		card.append(label, frame);
		scroller.appendChild(card);
		frames.push({ frame, slideEl });
	}
	if (deck.slides.length === 0) {
		const empty = doc.createElement("div");
		empty.className = "p-6 text-sm text-muted-foreground";
		empty.textContent = i18n("This presentation has no slides.");
		scroller.appendChild(empty);
	}
	container.appendChild(scroller);

	// Frames fill the column and keep the slide's aspect ratio; the slide inside scales to the frame.
	for (const { frame } of frames) frame.style.aspectRatio = `${naturalW} / ${naturalH}`;
	const layout = () => {
		const inner = frames[0]?.frame.clientWidth ?? 0;
		if (inner <= 0) return;
		const scale = inner / naturalW;
		for (const { slideEl } of frames) slideEl.style.transform = `scale(${scale})`;
	};
	layout();
	const observer = new ResizeObserver(() => layout());
	observer.observe(scroller);
	if (frames[0]) observer.observe(frames[0].frame);
	return () => {
		observer.disconnect();
		revoke();
	};
}

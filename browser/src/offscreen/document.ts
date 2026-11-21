/**
 * The extension's one hidden page (chrome.offscreen allows a single document). It reads PDFs
 * (pdf-text.ts) and encodes tab recordings (recorder.ts). Both ask for it here, so whichever comes
 * second finds the page the first made, with the reasons both need.
 */
const PAGE = "offscreen.html";

let creating: Promise<void> | undefined;

export async function ensureOffscreen(): Promise<void> {
	const url = chrome.runtime.getURL(PAGE);
	const contexts = await chrome.runtime.getContexts?.({
		contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
		documentUrls: [url],
	});
	if (contexts?.length) return;
	creating ??= chrome.offscreen
		.createDocument({
			url: PAGE,
			reasons: ["WORKERS" as chrome.offscreen.Reason, "BLOBS" as chrome.offscreen.Reason],
			justification: "Read the text of PDFs for agents, and encode the recordings of tabs they ask for",
		})
		.finally(() => {
			creating = undefined;
		});
	await creating;
}

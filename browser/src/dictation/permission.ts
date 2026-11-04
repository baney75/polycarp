/**
 * The page that asks for the microphone once (static/mic-permission.html). A grant here holds for
 * the whole extension, the side panel included; the tab closes itself when it's done.
 */

const statusLine = document.getElementById("status");
const say = (text: string) => {
	if (statusLine) statusLine.textContent = text;
};

async function ask(): Promise<void> {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		for (const track of stream.getTracks()) track.stop();
		say("Done. Go back to the side panel and press the microphone again.");
		await chrome.runtime.sendMessage({ type: "tabkyra-mic-granted" }).catch(() => undefined);
		setTimeout(() => window.close(), 1500);
	} catch (err) {
		const blocked = err instanceof DOMException && err.name === "NotAllowedError";
		say(
			blocked
				? "The microphone is blocked for Tabkyra. Allow it with the site settings icon in the address bar, then reload this page."
				: `Couldn't open the microphone: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

void ask();

import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/jetbrains-mono/400.css";

// Copy buttons on the terminal blocks.
for (const button of document.querySelectorAll<HTMLButtonElement>("button.copy")) {
	button.addEventListener("click", async () => {
		const text = button.dataset.copy ?? "";
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select and copy";
		}
		setTimeout(() => {
			button.textContent = "Copy";
		}, 1600);
	});
}

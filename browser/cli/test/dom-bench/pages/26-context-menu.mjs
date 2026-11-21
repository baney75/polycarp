export default {
	id: "context-menu",
	title: "Right-click context menu",
	html: `<!doctype html><meta charset="utf-8"><title>Files</title>
<style>body{font:16px system-ui;margin:24px}.file{display:inline-block;border:1px solid #888;padding:12px 18px;margin:4px;cursor:default}#cm{position:fixed;display:none;background:#fff;border:1px solid #555;box-shadow:2px 2px 6px #0003}#cm div{padding:6px 14px;cursor:pointer}#cm div:hover{background:#def}</style>
<h1>My files</h1>
<div class="file" tabindex="0" role="button" aria-label="report.pdf">report.pdf</div><div class="file" tabindex="0" role="button" aria-label="notes.txt">notes.txt</div>
<div id="cm" role="menu"><div role="menuitem">Rename</div><div role="menuitem">Delete</div><div role="menuitem">Share</div></div>
<script>
window.__state = { action: null, file: null };
let current = null; const cm = document.getElementById("cm");
for (const f of document.querySelectorAll(".file")) f.addEventListener("contextmenu", (e) => { e.preventDefault(); current = f.textContent; cm.style.left = e.clientX + "px"; cm.style.top = e.clientY + "px"; cm.style.display = "block"; });
for (const m of cm.children) m.addEventListener("click", () => { window.__state.action = m.textContent; window.__state.file = current; cm.style.display = "none"; });
document.addEventListener("click", (e) => { if (!cm.contains(e.target)) cm.style.display = "none"; });
</script>`,
	task: "Delete report.pdf using its right-click menu.",
	async solve(t) {
		await t.click("report.pdf file", { role: "button", name: /report\.pdf/i, click: { button: "right" } });
		await t.click("Delete menu item", { role: "menuitem", name: /^delete$/i });
	},
	check: async (page) => (await page.eval("JSON.stringify([window.__state.action, window.__state.file])")) === '["Delete","report.pdf"]',
};

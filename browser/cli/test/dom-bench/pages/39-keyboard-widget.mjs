export default {
	id: "keyboard-widget",
	title: "Keyboard-only widget (arrow keys)",
	html: `<!doctype html><meta charset="utf-8"><title>Rating</title>
<style>body{font:16px system-ui;margin:24px}#stars{display:inline-flex;gap:4px;padding:6px;border:1px solid #888}#stars:focus{outline:2px solid #06c}.s{font-size:24px;color:#bbb}.s.on{color:#e90}</style>
<h1>Rate your visit</h1>
<div id="stars" role="slider" tabindex="0" aria-label="Rating" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0" aria-valuetext="0 stars"><span class="s">&#9733;</span><span class="s">&#9733;</span><span class="s">&#9733;</span><span class="s">&#9733;</span><span class="s">&#9733;</span></div>
<script>
window.__state = { rating: 0 };
const el = document.getElementById("stars");
function set(v) { v = Math.max(0, Math.min(5, v)); window.__state.rating = v; el.setAttribute("aria-valuenow", v); el.setAttribute("aria-valuetext", v + " stars"); [...el.children].forEach((s, i) => s.classList.toggle("on", i < v)); }
el.addEventListener("keydown", (e) => { if (e.key === "ArrowRight" || e.key === "ArrowUp") { set(window.__state.rating + 1); e.preventDefault(); } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { set(window.__state.rating - 1); e.preventDefault(); } else if (e.key === "Home") set(0); else if (e.key === "End") set(5); });
</script>`,
	task: "Set the rating to 4 stars. The control only responds to the keyboard.",
	async solve(t) {
		const s = await t.locate("rating slider", { role: "slider", name: /rating/i });
		await t.tool("click", { ref: s.ref });
		await t.tool("press", { key: "ArrowRight", repeat: 4 });
	},
	check: async (page) => (await page.eval("window.__state.rating")) === 4,
};

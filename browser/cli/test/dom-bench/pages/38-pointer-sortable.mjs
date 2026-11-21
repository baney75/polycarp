export default {
	id: "pointer-sortable",
	title: "Pointer-event sortable drag",
	html: `<!doctype html><meta charset="utf-8"><title>Playlist</title>
<style>body{font:16px system-ui;margin:24px;user-select:none}.track{display:flex;align-items:center;gap:8px;border:1px solid #888;width:300px;padding:10px;margin:4px 0;background:#fff}.handle{cursor:grab;width:20px;text-align:center}</style>
<h1>Playlist</h1>
<div id="l"><div class="track"><span class="handle" role="button" aria-label="Reorder Intro">::</span><span>Intro</span></div><div class="track"><span class="handle" role="button" aria-label="Reorder Verse">::</span><span>Verse</span></div><div class="track"><span class="handle" role="button" aria-label="Reorder Chorus">::</span><span>Chorus</span></div></div>
<script>
window.__state = { order: ["Intro", "Verse", "Chorus"] };
const l = document.getElementById("l"); let cur = null;
l.addEventListener("pointerdown", (e) => { if (e.target.classList.contains("handle")) { cur = e.target.closest(".track"); l.setPointerCapture?.(e.pointerId); } });
l.addEventListener("pointermove", (e) => { if (!cur) return; const over = [...l.children].find((c) => c !== cur && e.clientY > c.getBoundingClientRect().top && e.clientY < c.getBoundingClientRect().bottom); if (over) { const r = over.getBoundingClientRect(); l.insertBefore(cur, e.clientY < r.top + r.height / 2 ? over : over.nextSibling); } });
addEventListener("pointerup", () => { if (cur) { window.__state.order = [...l.children].map((c) => c.lastChild.textContent); cur = null; } });
</script>`,
	task: "Move Chorus to the top of the playlist, above Intro.",
	async solve(t) {
		const from = await t.locate("Reorder Chorus handle", { role: "button", name: /reorder chorus/i });
		const to = await t.locate("Reorder Intro handle", { role: "button", name: /reorder intro/i });
		const a = await t.point(from.ref);
		const b = await t.point(to.ref);
		await t.tool("drag", { from: a, to: { x: b.x, y: b.y - 12 } });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.order)")) === '["Chorus","Intro","Verse"]',
};

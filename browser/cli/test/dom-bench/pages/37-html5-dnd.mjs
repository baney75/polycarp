export default {
	id: "html5-dnd",
	title: "HTML5 drag and drop reorder",
	html: `<!doctype html><meta charset="utf-8"><title>Tasks</title>
<style>body{font:16px system-ui;margin:24px}ul{list-style:none;padding:0;width:260px}li{border:1px solid #888;padding:10px;margin:4px 0;background:#fff;cursor:grab}li.over{border-color:#06c}</style>
<h1>Sprint order</h1>
<ul id="l"><li draggable="true">Ship it</li><li draggable="true">Review PRs</li><li draggable="true">Write tests</li></ul>
<script>
window.__state = { order: ["Ship it", "Review PRs", "Write tests"] };
const l = document.getElementById("l"); let dragged = null;
l.addEventListener("dragstart", (e) => { dragged = e.target.closest("li"); e.dataTransfer.setData("text/plain", dragged.textContent); e.dataTransfer.effectAllowed = "move"; });
l.addEventListener("dragover", (e) => { e.preventDefault(); });
l.addEventListener("drop", (e) => { e.preventDefault(); const to = e.target.closest("li"); if (!dragged || !to || to === dragged) return; const r = to.getBoundingClientRect(); l.insertBefore(dragged, e.clientY < r.top + r.height / 2 ? to : to.nextSibling); window.__state.order = [...l.children].map((x) => x.textContent); });
</script>`,
	task: 'Drag "Write tests" to the top of the list, above "Ship it".',
	async solve(t) {
		// drag takes pixels only; hover reports the point an element's ref maps to.
		const from = await t.locate("Write tests list item", { role: /listitem|generic|text/i, name: /write tests/i }).catch(() => undefined);
		const to = await t.locate("Ship it list item", { role: /listitem|generic|text/i, name: /ship it/i }).catch(() => undefined);
		if (!from || !to) throw new Error("find and read_page list no ref for the draggable list items (plain li rows with no role or name), so drag has no point to start from");
		const a = await t.point(from.ref);
		const b = await t.point(to.ref);
		await t.tool("drag", { from: a, to: { x: b.x, y: b.y - 8 } });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.order)")) === '["Write tests","Ship it","Review PRs"]',
};

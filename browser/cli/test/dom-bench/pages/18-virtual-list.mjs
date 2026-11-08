export default {
	id: "virtual-list",
	title: "Virtualized list, row rendered only after scrolling",
	html: `<!doctype html><meta charset="utf-8"><title>Invoices</title>
<style>body{font:16px system-ui;margin:24px}#vp{height:240px;width:420px;overflow:auto;border:1px solid #888;position:relative}#spacer{position:relative}.row{position:absolute;left:0;right:0;height:40px;box-sizing:border-box;padding:8px;border-bottom:1px solid #ddd}.row button{float:right}</style>
<h1>Invoices</h1>
<div id="vp" role="list" aria-label="Invoice list" tabindex="0"><div id="spacer"></div></div>
<script>
window.__state = { downloaded: null };
const N = 1000, H = 40, vp = document.getElementById("vp"), sp = document.getElementById("spacer");
sp.style.height = N * H + "px";
const rows = new Map();
function draw() {
  const first = Math.max(0, Math.floor(vp.scrollTop / H) - 1), last = Math.min(N, first + 9);
  for (const [i, r] of rows) if (i < first || i >= last) { r.remove(); rows.delete(i); }
  for (let i = first; i < last; i++) {
    if (rows.has(i)) continue;
    const r = document.createElement("div"); r.className = "row"; r.setAttribute("role", "listitem"); r.style.top = i * H + "px";
    r.innerHTML = '<span>Invoice #' + (i + 1) + '</span><button type="button">Download</button>';
    r.querySelector("button").addEventListener("click", () => { window.__state.downloaded = i + 1; });
    sp.appendChild(r); rows.set(i, r);
  }
}
vp.addEventListener("scroll", draw); draw();
</script>`,
	task: "Download invoice #742 from the list.",
	async solve(t) {
		// The row is not in the DOM until the list scrolls there. scroll {ref} only scrolls an element into
		// view (the row does not exist yet) and scroll {dy} moves the window, so take the list's point from
		// hover and wheel-scroll there until the row renders.
		for (let i = 0; i < 40; i++) {
			// The snapshot names every button "Download"; the row labels are only in the page text, in the
			// same order, so the Nth "Invoice #" line belongs to the Nth Download button.
			// The wheel animates: let it settle, then read.
			await t.tool("wait", { ms: 700 });
			const snap = await t.read("all", { maxNodes: 200 });
			const rows = snap.text.split("\n").filter((l) => /^Invoice #\d+$/.test(l.trim()));
			const idx = rows.findIndex((l) => l.trim() === "Invoice #742");
			if (idx >= 0) {
				const btns = snap.nodes.filter((n) => n.role === "button" && /download/i.test(n.name));
				await t.tool("click", { ref: btns[idx].ref });
				return;
			}
			// The list's ref goes stale once its rows re-render, so find it again each time.
			const list = await t.locate("invoice list", { role: /list/i, name: /invoice/i });
			// Rows are 40 px: jump by the distance from the last row seen to the target, which converges.
			const last = Number(rows.at(-1)?.match(/\d+/)?.[0] ?? 1);
			await t.wheel(list.ref, Math.max(40, (742 - last) * 40 - 120));
		}
		throw new Error("never found invoice #742 after 40 wheel scrolls of 1000 px over the list");
	},
	check: async (page) => (await page.eval("window.__state.downloaded")) === 742,
};

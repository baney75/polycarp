export default {
	id: "pagination",
	title: "Pagination: find an item on page 3",
	html: `<!doctype html><meta charset="utf-8"><title>Catalog</title>
<style>body{font:16px system-ui;margin:24px}li{margin:4px 0}nav button{margin-right:4px}nav button[aria-current=page]{font-weight:bold}</style>
<h1>Catalog</h1><ul id="items"></ul>
<nav aria-label="Pagination"><button type="button" id="prev">Previous</button> <button type="button" data-p="1">1</button><button type="button" data-p="2">2</button><button type="button" data-p="3">3</button><button type="button" data-p="4">4</button> <button type="button" id="next">Next</button></nav>
<script>
window.__state = { opened: null, page: 1 };
const names = Array.from({ length: 40 }, (_, i) => "Gadget " + (i + 1));
function show(p) { window.__state.page = p; const ul = document.getElementById("items"); ul.innerHTML = "";
  for (const n of names.slice((p - 1) * 10, p * 10)) { const li = document.createElement("li"); li.innerHTML = '<a href="#' + n + '">' + n + '</a>'; li.firstChild.onclick = (e) => { e.preventDefault(); window.__state.opened = n; }; ul.appendChild(li); }
  for (const b of document.querySelectorAll("nav [data-p]")) b.toggleAttribute("aria-current", +b.dataset.p === p) , +b.dataset.p === p ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"); }
for (const b of document.querySelectorAll("nav [data-p]")) b.onclick = () => show(+b.dataset.p);
document.getElementById("next").onclick = () => show(Math.min(4, window.__state.page + 1));
document.getElementById("prev").onclick = () => show(Math.max(1, window.__state.page - 1));
show(1);
</script>`,
	task: "Open Gadget 27 from the catalog.",
	async solve(t) {
		for (let i = 0; i < 4; i++) {
			const hit = (await t.find("Gadget 27 link")).find((n) => n.role === "link" && /^gadget 27$/i.test(n.name));
			if (hit) return void (await t.tool("click", { ref: hit.ref }));
			await t.click("Next page button", { role: "button", name: /^next$/i });
		}
		throw new Error("Gadget 27 not found on any page");
	},
	check: async (page) => (await page.eval("window.__state.opened")) === "Gadget 27",
};

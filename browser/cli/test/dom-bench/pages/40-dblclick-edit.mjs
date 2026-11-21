export default {
	id: "dblclick-edit",
	title: "Double-click to edit a table cell",
	html: `<!doctype html><meta charset="utf-8"><title>Budget</title>
<style>body{font:16px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #888;padding:6px 14px}td input{width:80px}</style>
<h1>Budget</h1>
<table aria-label="Budget"><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>
<tr><td>Rent</td><td class="amt">1200</td></tr><tr><td>Food</td><td class="amt">400</td></tr><tr><td>Fun</td><td class="amt">150</td></tr></tbody></table>
<script>
window.__state = { cells: { Rent: "1200", Food: "400", Fun: "150" } };
for (const td of document.querySelectorAll(".amt")) td.addEventListener("dblclick", () => {
  if (td.querySelector("input")) return;
  const old = td.textContent; td.textContent = ""; const i = document.createElement("input"); i.value = old; td.appendChild(i); i.focus(); i.select();
  const commit = () => { td.textContent = i.value; window.__state.cells[td.previousElementSibling.textContent] = i.value; };
  i.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") td.textContent = old; });
  i.addEventListener("blur", () => { if (td.contains(i)) commit(); });
});
</script>`,
	task: "Change the Food amount to 450 by editing its cell.",
	async solve(t) {
		const snap = await t.read("all");
		const cell = snap.nodes.find((n) => /cell/i.test(n.role) && n.name === "400");
		if (!cell) throw new Error("read_page lists no cell named 400 for the Food amount; table cells are not elements");
		await t.tool("click", { ref: cell.ref, clickCount: 2 });
		await t.tool("press", { key: "Control+a" });
		await t.tool("type", { text: "450", submit: true });
	},
	check: async (page) => (await page.eval("window.__state.cells.Food")) === "450",
};

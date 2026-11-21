export default {
	id: "date-picker",
	title: "Custom date picker popup",
	html: `<!doctype html><meta charset="utf-8"><title>Stay</title>
<style>body{font:16px system-ui;margin:24px}#pop{display:none;border:1px solid #888;padding:8px;width:260px;background:#fff;position:absolute}
#pop.open{display:block}.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}.grid button{padding:4px}</style>
<h1>Reserve a room</h1>
<label for="ci">Check-in</label> <input id="ci" readonly placeholder="Select a date" aria-haspopup="dialog">
<div id="pop" role="dialog" aria-label="Choose date"><div><button type="button" id="prev" aria-label="Previous month">&lt;</button> <strong id="mon">December 2026</strong> <button type="button" aria-label="Next month">&gt;</button></div><div class="grid" role="grid" id="grid"></div></div>
<p id="out"></p>
<script>
window.__state = { checkin: null };
const grid = document.getElementById("grid");
for (let d = 1; d <= 31; d++) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = String(d); b.setAttribute("role", "gridcell");
  b.setAttribute("aria-label", "December " + d + ", 2026");
  b.onclick = () => { window.__state.checkin = "2026-12-" + String(d).padStart(2, "0"); document.getElementById("ci").value = "12/" + d + "/2026"; document.getElementById("pop").classList.remove("open"); };
  grid.appendChild(b);
}
document.getElementById("ci").addEventListener("click", () => document.getElementById("pop").classList.add("open"));
</script>`,
	task: "Pick December 18, 2026 as the check-in date.",
	async solve(t) {
		await t.click("check-in date field", { name: /check-in/i });
		await t.click("December 18, 2026 day", { name: /december 18, 2026/i });
	},
	check: async (page) => (await page.eval("window.__state.checkin")) === "2026-12-18",
};

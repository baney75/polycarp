export default {
	id: "combobox",
	title: "ARIA autocomplete combobox",
	html: `<!doctype html><meta charset="utf-8"><title>Shipping</title>
<style>body{font:16px system-ui;margin:24px}ul{list-style:none;margin:0;padding:0;border:1px solid #888;width:240px}li{padding:4px 8px}li[aria-selected=true]{background:#def}</style>
<h1>Shipping address</h1>
<label for="country">Country</label><br>
<input id="country" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="lb" autocomplete="off">
<ul id="lb" role="listbox" aria-label="Countries" hidden></ul>
<script>
window.__state = { country: null };
const all = ["Poland", "Portugal", "Puerto Rico", "Peru", "Panama"];
const inp = document.getElementById("country"), lb = document.getElementById("lb");
inp.addEventListener("input", () => {
  const q = inp.value.toLowerCase();
  const hits = q ? all.filter((c) => c.toLowerCase().includes(q)) : [];
  lb.innerHTML = ""; lb.hidden = !hits.length; inp.setAttribute("aria-expanded", String(hits.length > 0));
  for (const c of hits) { const li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = c; li.addEventListener("mousedown", (e) => { e.preventDefault(); }); li.addEventListener("click", () => { inp.value = c; window.__state.country = c; lb.hidden = true; }); lb.appendChild(li); }
});
</script>`,
	task: "Choose Portugal as the country (type to search, then pick it from the suggestions).",
	async solve(t) {
		await t.type("country combobox", "Por", { role: "combobox", name: /country/i });
		await t.click("Portugal option", { role: "option", name: /^portugal$/i });
	},
	check: async (page) => (await page.eval("window.__state.country")) === "Portugal",
};

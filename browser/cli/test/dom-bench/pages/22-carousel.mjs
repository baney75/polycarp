export default {
	id: "carousel",
	title: "Horizontal carousel, item offscreen",
	html: `<!doctype html><meta charset="utf-8"><title>Plans</title>
<style>body{font:16px system-ui;margin:24px}#car{display:flex;gap:16px;overflow-x:auto;width:640px;scroll-snap-type:x mandatory;border:1px solid #ccc;padding:8px}.card{flex:0 0 300px;border:1px solid #888;padding:12px;scroll-snap-align:start}</style>
<h1>Pick a plan</h1>
<div id="car" role="region" aria-label="Plans" tabindex="0">
${["Free", "Starter", "Team", "Business", "Enterprise"].map((n) => `<div class="card"><h2>${n}</h2><p>Details for ${n}.</p><button type="button" aria-label="Choose ${n} plan">Choose</button></div>`).join("")}</div>
<script>
window.__state = { plan: null };
for (const b of document.querySelectorAll(".card button")) b.onclick = () => { window.__state.plan = b.closest(".card").querySelector("h2").textContent; };
</script>`,
	task: "Choose the Enterprise plan.",
	async solve(t) {
		await t.click("Choose Enterprise plan", { role: "button", name: /enterprise/i });
	},
	check: async (page) => (await page.eval("window.__state.plan")) === "Enterprise",
};

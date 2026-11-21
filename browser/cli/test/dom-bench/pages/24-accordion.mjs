export default {
	id: "accordion",
	title: "Accordion",
	html: `<!doctype html><meta charset="utf-8"><title>Orders help</title>
<style>body{font:16px system-ui;margin:24px}.acc button.h{display:block;width:360px;text-align:left;padding:8px;border:1px solid #888;background:#eee}.panel{display:none;border:1px solid #888;padding:8px;width:344px}.panel.open{display:block}</style>
<h1>Help</h1><div class="acc">
<h2><button class="h" aria-expanded="false" aria-controls="a1" id="h1">Returns</button></h2><div class="panel" id="a1" role="region" aria-labelledby="h1"><button type="button" class="act" data-k="start return">Start a return</button></div>
<h2><button class="h" aria-expanded="false" aria-controls="a2" id="h2">Shipping</button></h2><div class="panel" id="a2" role="region" aria-labelledby="h2"><button type="button" class="act" data-k="track order">Track order</button></div>
<h2><button class="h" aria-expanded="false" aria-controls="a3" id="h3">Payments</button></h2><div class="panel" id="a3" role="region" aria-labelledby="h3"><button type="button" class="act" data-k="update card">Update card</button></div></div>
<script>
window.__state = { action: null };
for (const h of document.querySelectorAll(".h")) h.addEventListener("click", () => { const open = h.getAttribute("aria-expanded") !== "true"; h.setAttribute("aria-expanded", String(open)); document.getElementById(h.getAttribute("aria-controls")).classList.toggle("open", open); });
for (const b of document.querySelectorAll(".act")) b.onclick = () => { window.__state.action = b.dataset.k; };
</script>`,
	task: "Open the Shipping section and click Track order.",
	async solve(t) {
		await t.click("Shipping section header", { role: "button", name: /^shipping$/i });
		await t.click("Track order button", { role: "button", name: /track order/i });
	},
	check: async (page) => (await page.eval("window.__state.action")) === "track order",
};

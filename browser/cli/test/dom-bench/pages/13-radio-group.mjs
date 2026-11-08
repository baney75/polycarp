export default {
	id: "radio-group",
	title: "Custom role=radio group",
	html: `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<style>body{font:16px system-ui;margin:24px}[role=radio]{display:block;border:1px solid #888;padding:8px 12px;margin:4px 0;width:240px;cursor:pointer}[role=radio][aria-checked=true]{background:#cde}</style>
<h1>Shipping speed</h1>
<div role="radiogroup" aria-label="Shipping speed">
<div role="radio" tabindex="0" aria-checked="true">Standard (5 days)</div>
<div role="radio" tabindex="-1" aria-checked="false">Express (2 days)</div>
<div role="radio" tabindex="-1" aria-checked="false">Overnight</div></div>
<script>
window.__state = { speed: "Standard (5 days)" };
const radios = [...document.querySelectorAll("[role=radio]")];
for (const r of radios) r.addEventListener("click", () => { for (const o of radios) o.setAttribute("aria-checked", String(o === r)); window.__state.speed = r.textContent; });
</script>`,
	task: "Choose Express shipping.",
	async solve(t) {
		await t.click("Express shipping radio", { role: "radio", name: /express/i });
	},
	check: async (page) => (await page.eval("window.__state.speed")) === "Express (2 days)",
};

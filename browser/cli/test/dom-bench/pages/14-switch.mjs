export default {
	id: "switch",
	title: "role=switch toggle",
	html: `<!doctype html><meta charset="utf-8"><title>Prefs</title>
<style>body{font:16px system-ui;margin:24px}button[role=switch]{width:48px;height:26px;border-radius:13px;border:0;background:#aaa;position:relative}button[role=switch][aria-checked=true]{background:#2a7}</style>
<h1>Preferences</h1>
<div><span id="l1">Email notifications</span> <button role="switch" aria-checked="true" aria-labelledby="l1"></button></div><br>
<div><span id="l2">Dark mode</span> <button role="switch" aria-checked="false" aria-labelledby="l2"></button></div>
<script>
window.__state = { "Email notifications": true, "Dark mode": false };
for (const b of document.querySelectorAll("[role=switch]")) b.addEventListener("click", () => { const on = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", String(on)); window.__state[document.getElementById(b.getAttribute("aria-labelledby")).textContent] = on; });
</script>`,
	task: "Turn dark mode on and leave email notifications as they are.",
	async solve(t) {
		await t.click("dark mode switch", { role: "switch", name: /dark mode/i });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state)")) === JSON.stringify({ "Email notifications": true, "Dark mode": true }),
};

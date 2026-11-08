export default {
	id: "tabs",
	title: "Tabs with hidden panels",
	html: `<!doctype html><meta charset="utf-8"><title>Settings</title>
<style>body{font:16px system-ui;margin:24px}[role=tab]{padding:6px 12px;border:1px solid #888;background:#eee}[role=tab][aria-selected=true]{background:#fff;font-weight:bold}[role=tabpanel][hidden]{display:none}</style>
<h1>Settings</h1>
<div role="tablist" aria-label="Settings sections"><button role="tab" id="t1" aria-selected="true" aria-controls="p1">Profile</button><button role="tab" id="t2" aria-selected="false" aria-controls="p2">Billing</button><button role="tab" id="t3" aria-selected="false" aria-controls="p3">Security</button></div>
<div role="tabpanel" id="p1" aria-labelledby="t1"><label>Display name <input type="text" id="dn"></label></div>
<div role="tabpanel" id="p2" aria-labelledby="t2" hidden><label>Company name <input type="text" id="co"></label> <button id="sv" type="button">Save billing</button></div>
<div role="tabpanel" id="p3" aria-labelledby="t3" hidden><label>Recovery email <input type="text" id="re"></label></div>
<script>
window.__state = { company: null };
const tabs = [...document.querySelectorAll("[role=tab]")];
for (const t of tabs) t.addEventListener("click", () => { for (const o of tabs) { const on = o === t; o.setAttribute("aria-selected", String(on)); document.getElementById(o.getAttribute("aria-controls")).hidden = !on; } });
document.getElementById("sv").onclick = () => { window.__state.company = document.getElementById("co").value; };
</script>`,
	task: 'In the Billing tab, set the company name to "Acme" and save.',
	async solve(t) {
		await t.click("Billing tab", { role: "tab", name: /billing/i });
		await t.type("company name input", "Acme", { role: /textbox|input|text/i, name: /company name/i });
		await t.click("save billing button", { role: "button", name: /save billing/i });
	},
	check: async (page) => (await page.eval("window.__state.company")) === "Acme",
};

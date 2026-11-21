export default {
	id: "select-custom",
	title: "Custom div listbox select",
	html: `<!doctype html><meta charset="utf-8"><title>Ticket</title>
<style>body{font:16px system-ui;margin:24px}.sel{position:relative;display:inline-block}.trig{padding:6px 12px;border:1px solid #888;background:#fff;min-width:120px;text-align:left}
.menu{position:absolute;top:100%;left:0;border:1px solid #888;background:#fff;min-width:140px;display:none}.menu.open{display:block}.opt{padding:6px 12px;cursor:pointer}.opt:hover{background:#def}</style>
<h1>New ticket</h1>
<span id="lab">Priority</span>
<div class="sel"><div class="trig" id="trig" role="button" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="lab trig">Normal</div>
<div class="menu" id="menu" role="listbox" aria-labelledby="lab"><div class="opt" role="option">Low</div><div class="opt" role="option">Normal</div><div class="opt" role="option">High</div><div class="opt" role="option">Urgent</div></div></div>
<script>
window.__state = { priority: "Normal" };
const trig = document.getElementById("trig"), menu = document.getElementById("menu");
trig.addEventListener("click", () => { const o = menu.classList.toggle("open"); trig.setAttribute("aria-expanded", String(o)); });
for (const opt of menu.children) opt.addEventListener("click", () => { window.__state.priority = opt.textContent; trig.textContent = opt.textContent; menu.classList.remove("open"); });
</script>`,
	task: "Set the ticket priority to High.",
	async solve(t) {
		await t.click("priority dropdown", { name: /priority|normal/i, role: /button|combobox|listbox/ });
		await t.click("High option", { role: "option", name: /^high$/i });
	},
	check: async (page) => (await page.eval("window.__state.priority")) === "High",
};

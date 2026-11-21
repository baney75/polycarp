export default {
	id: "sr-only-label",
	title: "Visually hidden (sr-only) label text",
	html: `<!doctype html><meta charset="utf-8"><title>Toolbar</title>
<style>body{font:16px system-ui;margin:24px}.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.ib{width:36px;height:36px;border:1px solid #888;background:#fff;margin-right:6px}</style>
<h1>Inbox</h1>
<div role="toolbar" aria-label="Message actions"><button type="button" class="ib" id="a"><svg width="16" height="16"><rect width="16" height="16" fill="#555"/></svg><span class="sr-only">Archive message</span></button>
<button type="button" class="ib" id="d"><svg width="16" height="16"><circle cx="8" cy="8" r="8" fill="#a33"/></svg><span class="sr-only">Delete message</span></button>
<button type="button" class="ib" id="s"><svg width="16" height="16"><path d="M0 0h16v16z" fill="#36a"/></svg><span class="sr-only">Mark as spam</span></button></div>
<script>
window.__state = { action: null };
for (const b of document.querySelectorAll(".ib")) b.onclick = () => { window.__state.action = b.textContent.trim(); };
</script>`,
	task: "Mark the message as spam using the toolbar icon.",
	async solve(t) {
		await t.click("Mark as spam button", { role: "button", name: /mark as spam/i });
	},
	check: async (page) => (await page.eval("window.__state.action")) === "Mark as spam",
};

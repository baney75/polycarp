export default {
	id: "cookie-banner",
	title: "Cookie banner covering the page",
	html: `<!doctype html><meta charset="utf-8"><title>Blog</title>
<style>body{font:16px system-ui;margin:24px}#cb{position:fixed;inset:0;background:#000a;z-index:100;display:flex;align-items:flex-end}#cb .box{background:#fff;width:100%;padding:16px}</style>
<h1>Weekly digest</h1><p>Get one email a week.</p><button id="sub">Subscribe</button>
<div id="cb" role="dialog" aria-label="Cookie consent"><div class="box"><p>We use cookies to improve your experience.</p><button id="acc">Accept all</button> <button id="rej">Reject non-essential</button> <button id="man">Manage preferences</button></div></div>
<script>
window.__state = { cookies: null, subscribed: false };
for (const [id, v] of [["acc", "accepted"], ["rej", "rejected"]]) document.getElementById(id).onclick = () => { window.__state.cookies = v; document.getElementById("cb").remove(); };
document.getElementById("sub").onclick = () => { window.__state.subscribed = true; };
</script>`,
	task: "Reject the non-essential cookies, then click Subscribe.",
	async solve(t) {
		await t.click("Reject non-essential cookies button", { role: "button", name: /reject/i });
		await t.click("Subscribe button", { role: "button", name: /^subscribe$/i });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state)")) === '{"cookies":"rejected","subscribed":true}',
};

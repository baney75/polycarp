export default {
	id: "nested-scroll",
	title: "Nested scroll container, accept unlocks at the bottom",
	html: `<!doctype html><meta charset="utf-8"><title>License</title>
<style>body{font:16px system-ui;margin:24px}#tos{height:160px;width:420px;overflow:auto;border:1px solid #888;padding:8px}button:disabled{opacity:.4}</style>
<h1>License agreement</h1>
<div id="tos" tabindex="0" role="region" aria-label="License text">${Array.from({ length: 40 }, (_, i) => `<p>Clause ${i + 1}. The parties agree to the terms set out in this section.</p>`).join("")}<p id="end">End of agreement.</p></div>
<br><button id="accept" disabled>I accept</button>
<script>
window.__state = { accepted: false };
const box = document.getElementById("tos"), acc = document.getElementById("accept");
box.addEventListener("scroll", () => { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) acc.disabled = false; });
acc.onclick = () => { window.__state.accepted = true; };
</script>`,
	task: "Read through the license agreement and accept it.",
	async solve(t) {
		// Paragraph text has no ref and scroll {ref}/{dy} act on the window: wheel over the box at the point hover reports (an actions scroll step: the scroll tool takes no x/y).
		const box = await t.locate("license text region", { role: /region|group|generic/i, name: /license text/i });
		await t.wheel(box.ref, 5000);
		await t.click("I accept button", { role: "button", name: /i accept/i });
	},
	check: async (page) => (await page.eval("window.__state.accepted")) === true,
};

export default {
	id: "shadow-text",
	title: "Read text inside shadow DOM",
	html: `<!doctype html><meta charset="utf-8"><title>Status</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Service status</h1><status-card></status-card>
<form id="f"><label>Code <input id="code" type="text"></label> <button type="submit">Submit code</button></form>
<script>
window.__state = { answer: null };
customElements.define("status-card", class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: "open" });
r.innerHTML = '<div style="border:1px solid #888;padding:8px;width:300px"><h2>Incident</h2><p>Reference code: <b>QX-4821</b></p><p>Status: investigating</p></div>'; } });
document.getElementById("f").onsubmit = (e) => { e.preventDefault(); window.__state.answer = document.getElementById("code").value; };
</script>`,
	task: "Read the incident reference code from the status card and submit it in the Code box.",
	async solve(t) {
		const text = await t.text();
		const code = /Reference code:\s*([A-Z]{2}-\d+)/.exec(text)?.[1];
		if (!code) throw new Error(`get_page_text does not include the shadow DOM text; it returned ${JSON.stringify(text.slice(0, 120))}`);
		await t.type("code input", code, { role: /textbox|input|text/i, name: /^code$/i });
		await t.click("Submit code button", { role: "button", name: /submit code/i });
	},
	check: async (page) => (await page.eval("window.__state.answer")) === "QX-4821",
};

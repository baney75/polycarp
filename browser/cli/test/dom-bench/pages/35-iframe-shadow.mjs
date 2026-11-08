export default {
	id: "iframe-shadow",
	title: "Shadow DOM inside an iframe",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Cart</title><style>body{font:16px system-ui;margin:24px}iframe{border:1px solid #888;width:420px;height:120px}</style>
<h1>Cart</h1><iframe src="{{base}}/promo" title="Promo"></iframe>
<script>window.__state = { coupon: null }; addEventListener("message", (e) => { window.__state.coupon = e.data; });</script>`,
		"/promo": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><promo-box></promo-box>
<script>customElements.define("promo-box", class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: "open" });
r.innerHTML = '<label>Coupon code <input type="text"></label> <button type="button">Apply coupon</button>';
r.querySelector("button").onclick = () => parent.postMessage(r.querySelector("input").value, "*"); } });</script>`,
	},
	task: 'Apply the coupon code "SAVE10".',
	async solve(t) {
		await t.type("coupon code input", "SAVE10", { role: /textbox|input|text/i, name: /coupon code/i });
		await t.click("Apply coupon button", { role: "button", name: /apply coupon/i });
	},
	check: async (page) => (await page.eval("window.__state.coupon")) === "SAVE10",
};

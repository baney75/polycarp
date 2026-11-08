export default {
	id: "iframe-cross-origin",
	title: "Cross-origin iframe button",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Store</title>
<style>body{font:16px system-ui;margin:24px}iframe{border:1px solid #888;width:360px;height:120px}</style>
<h1>Checkout</h1><p>Pay securely with our partner.</p><iframe src="{{origin2}}/pay" title="Payment"></iframe>
<script>window.__state = { paid: false }; addEventListener("message", (e) => { if (e.data === "paid") window.__state.paid = true; });</script>`,
		"/pay": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><p>Total: $48.00</p><button type="button" id="b">Confirm payment</button>
<script>document.getElementById("b").onclick = () => parent.postMessage("paid", "*");</script>`,
	},
	task: "Confirm the payment.",
	async solve(t) {
		await t.click("Confirm payment button", { role: "button", name: /confirm payment/i });
	},
	check: async (page) => (await page.eval("window.__state.paid")) === true,
};

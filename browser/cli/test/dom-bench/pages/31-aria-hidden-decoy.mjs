export default {
	id: "aria-hidden-decoy",
	title: "aria-hidden decoy duplicate",
	html: `<!doctype html><meta charset="utf-8"><title>Cart</title>
<style>body{font:16px system-ui;margin:24px}.ghost{position:absolute;top:140px;left:300px}</style>
<h1>Your cart</h1><p>2 items, total $48.00</p>
<button id="real" type="button">Place order</button>
<div class="ghost" aria-hidden="true"><button id="decoy" type="button" tabindex="-1">Place order</button></div>
<script>
window.__state = { order: null };
document.getElementById("real").onclick = () => { window.__state.order = "real"; };
document.getElementById("decoy").onclick = () => { window.__state.order = "decoy"; };
</script>`,
	task: "Place the order.",
	async solve(t) {
		const hits = (await t.find("Place order button")).filter((n) => n.role === "button");
		if (!hits.length) throw new Error("find returned no Place order button");
		await t.tool("click", { ref: hits[0].ref });
	},
	check: async (page) => (await page.eval("window.__state.order")) === "real",
};

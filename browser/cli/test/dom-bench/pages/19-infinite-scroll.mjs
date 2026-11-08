export default {
	id: "infinite-scroll",
	title: "Infinite scroll, item appears after loading more",
	html: `<!doctype html><meta charset="utf-8"><title>Shop</title>
<style>body{font:16px system-ui;margin:24px}.item{height:90px;border-bottom:1px solid #ddd;padding:8px}#sentinel{height:10px}</style>
<h1>All products</h1><div id="items"></div><div id="sentinel"></div>
<script>
window.__state = { cart: [] , loaded: 0 };
let n = 0;
function more() { for (let i = 0; i < 10; i++) { n++; const d = document.createElement("div"); d.className = "item"; d.innerHTML = '<strong>Product ' + n + '</strong> <button type="button" aria-label="Add Product ' + n + ' to cart">Add to cart</button>'; const k = n; d.querySelector("button").onclick = () => window.__state.cart.push(k); document.getElementById("items").appendChild(d); } window.__state.loaded = n; }
more();
new IntersectionObserver((es) => { if (es[0].isIntersecting && n < 100) setTimeout(more, 50); }, { rootMargin: "100px" }).observe(document.getElementById("sentinel"));
</script>`,
	task: "Add Product 35 to the cart.",
	async solve(t) {
		for (let i = 0; i < 12; i++) {
			const hit = (await t.find("Add Product 35 to cart")).find((n) => /product 35 to cart/i.test(n.name));
			if (hit) {
				await t.tool("click", { ref: hit.ref });
				return;
			}
			await t.tool("scroll", { to: "bottom" });
			await t.tool("wait", { ms: 300 });
		}
		throw new Error("Product 35 never loaded after 12 scrolls to the bottom");
	},
	check: async (page) => JSON.stringify(await page.eval("window.__state.cart")) === "[35]",
};

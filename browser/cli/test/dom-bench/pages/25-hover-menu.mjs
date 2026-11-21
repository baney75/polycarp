export default {
	id: "hover-menu",
	title: "Hover-only menu",
	html: `<!doctype html><meta charset="utf-8"><title>Site</title>
<style>body{font:16px system-ui;margin:24px}nav ul{list-style:none;margin:0;padding:0;display:flex;gap:16px}nav li{position:relative}.sub{display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #888;min-width:140px}
nav li:hover .sub{display:block}.sub a{display:block;padding:6px 10px}</style>
<nav><ul><li><a href="/x/home">Home</a></li><li><a href="/x/products">Products</a><div class="sub"><a href="/x/pricing">Pricing</a><a href="/x/changelog">Changelog</a></div></li><li><a href="/x/about">About</a></li></ul></nav>
<p id="where">You are on Home.</p>
<script>
window.__state = { page: "home" };
for (const a of document.querySelectorAll("a")) a.addEventListener("click", (e) => { e.preventDefault(); window.__state.page = a.textContent.toLowerCase(); document.getElementById("where").textContent = "You are on " + a.textContent + "."; });
</script>`,
	task: "Open the Pricing page from the Products menu.",
	async solve(t) {
		const products = await t.locate("Products menu link", { role: "link", name: /^products$/i });
		await t.tool("hover", { ref: products.ref });
		await t.click("Pricing link", { role: "link", name: /^pricing$/i });
	},
	check: async (page) => (await page.eval("window.__state.page")) === "pricing",
};

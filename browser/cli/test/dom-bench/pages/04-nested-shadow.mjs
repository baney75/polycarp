export default {
	id: "nested-shadow",
	title: "Nested shadow roots",
	html: `<!doctype html><meta charset="utf-8"><title>Search</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Help center</h1>
<app-shell></app-shell>
<script>
window.__state = { query: null };
customElements.define("search-box", class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<input type="search" aria-label="Search articles" placeholder="Search"> <button type="button">Search now</button>';
    r.querySelector("button").addEventListener("click", () => { window.__state.query = r.querySelector("input").value; });
  }
});
customElements.define("app-shell", class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<header><slot></slot><section><search-box></search-box></section></header>';
  }
});
</script>`,
	task: 'Search the help center for "refund policy".',
	async solve(t) {
		await t.type("search articles input", "refund policy", { name: /search articles/i });
		await t.click("search now button", { role: "button", name: /search now/i });
	},
	check: async (page) => (await page.eval("window.__state.query")) === "refund policy",
};

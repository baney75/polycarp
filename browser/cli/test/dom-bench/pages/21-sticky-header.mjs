export default {
	id: "sticky-header",
	title: "Sticky header over the target",
	html: `<!doctype html><meta charset="utf-8"><title>Article</title>
<style>body{font:16px system-ui;margin:0}header{position:sticky;top:0;height:90px;background:#124;color:#fff;padding:8px 24px;z-index:10}main{padding:24px}p{height:120px}</style>
<header><strong>Daily News</strong> <nav><a href="#top">Home</a> <a href="#sports">Sports</a></nav></header>
<main><h1>Long read</h1>${Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1}. Lorem ipsum dolor sit amet.</p>`).join("")}
<button id="c" style="margin-top:0">Add comment</button>${Array.from({ length: 10 }, () => "<p>More text.</p>").join("")}</main>
<script>
window.__state = { clicked: false };
document.getElementById("c").onclick = () => { window.__state.clicked = true; };
</script>`,
	task: "Click Add comment on the article.",
	async solve(t) {
		const b = await t.locate("add comment button", { role: "button", name: /add comment/i });
		await t.tool("scroll", { ref: b.ref });
		await t.tool("click", { ref: b.ref });
	},
	check: async (page) => (await page.eval("window.__state.clicked")) === true,
};

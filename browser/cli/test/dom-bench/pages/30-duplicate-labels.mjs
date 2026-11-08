export default {
	id: "duplicate-labels",
	title: "Same label in two sections",
	html: `<!doctype html><meta charset="utf-8"><title>Contacts</title>
<style>body{font:16px system-ui;margin:24px}section{border:1px solid #aaa;padding:8px 16px;margin:12px 0;width:360px}</style>
<h1>Address book</h1>
<section aria-labelledby="hp"><h2 id="hp">Personal</h2><p>Mom - 555-0100</p><button type="button" data-s="personal">Delete</button></section>
<section aria-labelledby="hw"><h2 id="hw">Work</h2><p>Boss - 555-0199</p><button type="button" data-s="work">Delete</button></section>
<script>
window.__state = { deleted: [] };
for (const b of document.querySelectorAll("button")) b.onclick = () => window.__state.deleted.push(b.dataset.s);
</script>`,
	task: "Delete the contact in the Work section (leave Personal alone).",
	async solve(t) {
		// Both buttons are named "Delete": the section decides. Read the snapshot in order and take the
		// Delete that follows the Work heading.
		const snap = await t.read("all");
		const h = snap.nodes.findIndex((n) => /^work$/i.test(n.name));
		if (h < 0) throw new Error("the snapshot does not list the Work section heading");
		const btn = snap.nodes.slice(h).find((n) => n.role === "button" && /delete/i.test(n.name));
		await t.tool("click", { ref: btn.ref });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.deleted)")) === '["work"]',
};

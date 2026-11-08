export default {
	id: "delayed-content",
	title: "Content that appears after a delay",
	html: `<!doctype html><meta charset="utf-8"><title>Reports</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Quarterly report</h1><p id="st">Generating your report...</p><div id="slot"></div>
<script>
window.__state = { downloaded: false };
setTimeout(() => { document.getElementById("st").textContent = "Your report is ready."; const b = document.createElement("button"); b.textContent = "Download report"; b.onclick = () => { window.__state.downloaded = true; }; document.getElementById("slot").appendChild(b); }, 1500);
</script>`,
	task: "Download the report once it is ready.",
	async solve(t) {
		await t.tool("wait", { text: "Your report is ready", timeoutMs: 8000 });
		await t.click("Download report button", { role: "button", name: /download report/i });
	},
	check: async (page) => (await page.eval("window.__state.downloaded")) === true,
};

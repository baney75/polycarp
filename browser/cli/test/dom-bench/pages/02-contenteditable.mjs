export default {
	id: "contenteditable",
	title: "Contenteditable rich editor",
	html: `<!doctype html><meta charset="utf-8"><title>Compose</title>
<style>body{font:16px system-ui;margin:24px}.bar button{margin-right:4px}#body{border:1px solid #999;min-height:80px;padding:8px;margin:8px 0}</style>
<h1>New announcement</h1>
<div class="bar" role="toolbar" aria-label="Formatting"><button type="button" onclick="document.execCommand('bold')"><b>B</b><span class="sr" style="position:absolute;left:-9999px">Bold</span></button><button type="button" onclick="document.execCommand('italic')"><i>I</i><span style="position:absolute;left:-9999px">Italic</span></button></div>
<div id="body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message body" data-placeholder="Write something"></div>
<button id="post">Post announcement</button>
<script>
window.__state = { posted: null };
document.getElementById("post").onclick = () => { window.__state.posted = document.getElementById("body").innerText.trim(); };
</script>`,
	task: 'Write "Meeting moved to 3pm" in the message body of the announcement and click Post announcement.',
	async solve(t) {
		await t.type("message body editor", "Meeting moved to 3pm", { name: /message body/i });
		await t.click("post announcement button", { role: "button", name: /post announcement/i });
	},
	check: async (page) => (await page.eval("window.__state.posted")) === "Meeting moved to 3pm",
};

export default {
	id: "iframe-editor",
	title: "Contenteditable editor inside an iframe",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Forum</title><style>body{font:16px system-ui;margin:24px}iframe{border:1px solid #888;width:460px;height:180px}</style>
<h1>Reply to thread</h1><iframe src="{{base}}/editor" title="Reply editor"></iframe>
<script>window.__state = { reply: null }; addEventListener("message", (e) => { window.__state.reply = e.data; });</script>`,
		"/editor": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><div id="ed" contenteditable="true" role="textbox" aria-label="Reply text" style="border:1px solid #999;min-height:70px;padding:6px"></div><br><button type="button" id="p">Post reply</button>
<script>p.onclick = () => parent.postMessage(ed.innerText.trim(), "*");</script>`,
	},
	task: 'Write "Thanks, that fixed it" in the reply editor and post the reply.',
	async solve(t) {
		await t.type("reply text editor", "Thanks, that fixed it", { name: /reply text/i });
		await t.click("Post reply button", { role: "button", name: /post reply/i });
	},
	check: async (page) => (await page.eval("window.__state.reply")) === "Thanks, that fixed it",
};

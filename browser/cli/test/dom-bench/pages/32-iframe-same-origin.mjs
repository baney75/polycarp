export default {
	id: "iframe-same-origin",
	title: "Same-origin iframe form",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Support</title>
<style>body{font:16px system-ui;margin:24px}iframe{border:1px solid #888;width:420px;height:200px}</style>
<h1>Contact support</h1><iframe src="{{base}}/form" title="Support form"></iframe>
<script>window.__state = { sent: null }; addEventListener("message", (e) => { window.__state.sent = e.data; });</script>`,
		"/form": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui">
<label>Your name <input id="n" type="text"></label><br><br><label>Message <textarea id="m"></textarea></label><br><br><button type="button" id="s">Send message</button>
<script>document.getElementById("s").onclick = () => parent.postMessage({ name: n.value, message: m.value }, "*");</script>`,
	},
	task: 'In the support form, enter the name "Ada" and the message "Printer is down", then send it.',
	async solve(t) {
		await t.type("your name input", "Ada", { role: /textbox|input|text/i, name: /your name/i });
		await t.type("message textarea", "Printer is down", { role: /textbox|input|text/i, name: /^message$/i });
		await t.click("Send message button", { role: "button", name: /send message/i });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.sent)")) === '{"name":"Ada","message":"Printer is down"}',
};

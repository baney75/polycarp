export default {
	id: "nested-iframes",
	title: "Nested iframes (same-origin around cross-origin)",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Portal</title><style>body{font:16px system-ui;margin:24px}iframe{border:1px solid #888;width:480px;height:260px}</style>
<h1>Approvals</h1><iframe src="{{base}}/outer" title="Approvals widget"></iframe>
<script>window.__state = { approved: null }; addEventListener("message", (e) => { window.__state.approved = e.data; });</script>`,
		"/outer": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><h2>Pending</h2><iframe src="{{origin2}}/inner" title="Request 17" style="width:420px;height:140px"></iframe>
<script>addEventListener("message", (e) => parent.postMessage(e.data, "*"));</script>`,
		"/inner": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><p>Request 17: laptop purchase</p><button type="button" id="a">Approve request</button> <button type="button" id="d">Deny request</button>
<script>a.onclick = () => parent.postMessage("approved 17", "*"); d.onclick = () => parent.postMessage("denied 17", "*");</script>`,
	},
	task: "Approve request 17.",
	async solve(t) {
		await t.click("Approve request button", { role: "button", name: /approve request/i });
	},
	check: async (page) => (await page.eval("window.__state.approved")) === "approved 17",
};

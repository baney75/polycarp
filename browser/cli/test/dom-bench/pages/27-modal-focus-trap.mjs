export default {
	id: "modal-focus-trap",
	title: "Modal dialog with a focus trap",
	html: `<!doctype html><meta charset="utf-8"><title>Team</title>
<style>body{font:16px system-ui;margin:24px}#bd{position:fixed;inset:0;background:#0006;display:none;align-items:center;justify-content:center}#bd.open{display:flex}#dlg{background:#fff;padding:20px;border-radius:6px;min-width:300px}</style>
<div id="app"><h1>Team members</h1><button id="open">Invite teammate</button><button id="other">Export CSV</button></div>
<div id="bd"><div id="dlg" role="dialog" aria-modal="true" aria-labelledby="dt"><h2 id="dt">Invite by email</h2>
<label>Email <input type="email" id="em"></label><br><br><button id="send" type="button">Send invite</button> <button id="cancel" type="button">Cancel</button></div></div>
<script>
window.__state = { invited: null, bgClicks: 0 };
const bd = document.getElementById("bd"), dlg = document.getElementById("dlg");
document.getElementById("open").onclick = () => { bd.classList.add("open"); document.getElementById("em").focus(); };
document.getElementById("other").onclick = () => { window.__state.bgClicks++; };
document.getElementById("cancel").onclick = () => bd.classList.remove("open");
document.getElementById("send").onclick = () => { window.__state.invited = document.getElementById("em").value; bd.classList.remove("open"); };
document.addEventListener("focusin", (e) => { if (bd.classList.contains("open") && !dlg.contains(e.target)) document.getElementById("em").focus(); });
</script>`,
	task: "Invite ada@example.com to the team.",
	async solve(t) {
		await t.click("Invite teammate button", { role: "button", name: /invite teammate/i });
		await t.type("email input in the invite dialog", "ada@example.com", { role: /textbox|input|text/i, name: /email/i });
		await t.click("Send invite button", { role: "button", name: /send invite/i });
	},
	check: async (page) => (await page.eval("window.__state.invited")) === "ada@example.com",
};

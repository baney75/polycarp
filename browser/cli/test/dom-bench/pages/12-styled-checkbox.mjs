export default {
	id: "styled-checkbox",
	title: "Styled checkbox (hidden input + label)",
	html: `<!doctype html><meta charset="utf-8"><title>Terms</title>
<style>body{font:16px system-ui;margin:24px}.cb input{position:absolute;opacity:0;width:0;height:0}.cb .box{display:inline-block;width:20px;height:20px;border:2px solid #555;vertical-align:middle;margin-right:8px}
.cb input:checked + .box{background:#2a7}.cb{cursor:pointer}</style>
<h1>Almost done</h1>
<label class="cb"><input type="checkbox" id="tos" name="tos"><span class="box"></span>I agree to the terms of service</label><br><br>
<button id="go">Continue</button><p id="msg"></p>
<script>
window.__state = { agreed: false, continued: false };
document.getElementById("tos").addEventListener("change", (e) => { window.__state.agreed = e.target.checked; });
document.getElementById("go").onclick = () => { if (!window.__state.agreed) { document.getElementById("msg").textContent = "You must accept the terms."; return; } window.__state.continued = true; };
</script>`,
	task: "Accept the terms of service and click Continue.",
	async solve(t) {
		// The real input is zero-sized, so the snapshot lists only its label: click that.
		await t.click("I agree to the terms of service", { role: /checkbox|label/, name: /agree/i });
		await t.click("continue button", { role: "button", name: /^continue$/i });
	},
	check: async (page) => (await page.eval("window.__state.continued")) === true,
};

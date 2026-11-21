export default {
	id: "shadow-input",
	title: "Input inside an open shadow root",
	html: `<!doctype html><meta charset="utf-8"><title>Account</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Account settings</h1>
<nick-form></nick-form>
<script>
window.__state = { nickname: null };
customElements.define("nick-form", class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<style>input{padding:4px}</style><label>Nickname <input type="text" name="nick"></label> <button type="button">Save nickname</button>';
    r.querySelector("button").addEventListener("click", () => { window.__state.nickname = r.querySelector("input").value; });
  }
});
</script>`,
	task: 'Set the nickname to "ada_l" and click Save nickname.',
	async solve(t) {
		await t.type("nickname field", "ada_l", { role: /textbox|input|text/i, name: /nickname/i });
		await t.click("save nickname button", { role: "button", name: /save nickname/i });
	},
	check: async (page) => (await page.eval("window.__state.nickname")) === "ada_l",
};

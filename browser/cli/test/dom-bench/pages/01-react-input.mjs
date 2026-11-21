// A React-style controlled input: the app only learns of a value change from an input event whose
// value differs from what its value tracker last saw, so assigning .value alone changes nothing.
export default {
	id: "react-input",
	title: "React-style controlled input",
	html: `<!doctype html><meta charset="utf-8"><title>Profile</title>
<style>body{font:16px system-ui;margin:24px}label{display:block;margin:8px 0 4px}button:disabled{opacity:.5}</style>
<h1>Edit profile</h1>
<div id="root"></div>
<script>
const state = { name: "", saved: null };
window.__state = state;
const root = document.getElementById("root");
root.innerHTML = '<label for="fullname">Full name</label><input id="fullname" autocomplete="off"><p id="preview"></p><button id="save" disabled>Save profile</button>';
const input = root.querySelector("input"), preview = root.querySelector("#preview"), save = root.querySelector("#save");
const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let tracked = "";
Object.defineProperty(input, "value", { configurable: true, get() { return desc.get.call(this); }, set(v) { tracked = String(v); desc.set.call(this, v); } });
input.addEventListener("input", () => {
  const cur = desc.get.call(input);
  if (cur === tracked) return;
  tracked = cur; state.name = cur; render();
});
function render() { preview.textContent = state.name ? "Hello, " + state.name : ""; save.disabled = !state.name; }
save.addEventListener("click", () => { state.saved = state.name; preview.textContent = "Saved " + state.name; });
</script>`,
	task: 'In the Edit profile form, enter "Ada Lovelace" as the full name and click Save profile.',
	async solve(t) {
		await t.type("full name input", "Ada Lovelace", { role: /textbox|input|text/i, name: /full name/i });
		await t.click("save profile button", { role: "button", name: /save profile/i });
	},
	check: async (page) => (await page.eval("window.__state.saved")) === "Ada Lovelace",
};

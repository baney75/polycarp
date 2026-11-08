export default {
	id: "multi-chips",
	title: "Multi-select chips",
	html: `<!doctype html><meta charset="utf-8"><title>Skills</title>
<style>body{font:16px system-ui;margin:24px}.chip{display:inline-block;border:1px solid #888;border-radius:12px;padding:2px 10px;margin:2px;cursor:pointer;background:#fff}.chip[aria-pressed=true]{background:#cde}</style>
<h1>Your skills</h1>
<div role="group" aria-label="Skills">
<button type="button" class="chip" aria-pressed="false">Go</button><button type="button" class="chip" aria-pressed="false">Python</button><button type="button" class="chip" aria-pressed="false">Rust</button><button type="button" class="chip" aria-pressed="false">TypeScript</button></div>
<p>Selected: <span id="sel">none</span></p><button id="save">Save skills</button>
<script>
window.__state = { chips: [], saved: null };
for (const c of document.querySelectorAll(".chip")) c.addEventListener("click", () => {
  const on = c.getAttribute("aria-pressed") !== "true"; c.setAttribute("aria-pressed", String(on));
  window.__state.chips = [...document.querySelectorAll(".chip[aria-pressed=true]")].map((x) => x.textContent);
  document.getElementById("sel").textContent = window.__state.chips.join(", ") || "none";
});
document.getElementById("save").onclick = () => { window.__state.saved = [...window.__state.chips]; };
</script>`,
	task: "Select the Python and Rust skills and save.",
	async solve(t) {
		await t.click("Python chip", { role: "button", name: /^python$/i });
		await t.click("Rust chip", { role: "button", name: /^rust$/i });
		await t.click("save skills button", { role: "button", name: /save skills/i });
	},
	check: async (page) => JSON.stringify(await page.eval("window.__state.saved")) === JSON.stringify(["Python", "Rust"]),
};

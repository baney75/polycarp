export default {
	id: "range-slider",
	title: "Range slider set to a value",
	html: `<!doctype html><meta charset="utf-8"><title>Audio</title>
<style>body{font:16px system-ui;margin:24px}input[type=range]{width:300px}</style>
<h1>Sound settings</h1>
<label for="vol">Volume</label> <input type="range" id="vol" min="0" max="100" step="1" value="30"> <output id="o">30</output>
<script>
window.__state = { volume: 30 };
const vol = document.getElementById("vol");
vol.addEventListener("input", () => { window.__state.volume = Number(vol.value); document.getElementById("o").textContent = vol.value; });
</script>`,
	task: "Set the volume to 70.",
	async solve(t) {
		await t.fill("volume slider", "70", { name: /volume/i });
	},
	check: async (page) => (await page.eval("window.__state.volume")) === 70,
};

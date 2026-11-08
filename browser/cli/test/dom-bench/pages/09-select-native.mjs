export default {
	id: "select-native",
	title: "Native select",
	html: `<!doctype html><meta charset="utf-8"><title>Locale</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Region</h1>
<label for="c">Country</label> <select id="c" name="c"><option value="">Choose...</option><option value="us">United States</option><option value="ca">Canada</option><option value="mx">Mexico</option></select>
<script>
window.__state = { country: "" };
document.getElementById("c").addEventListener("change", (e) => { window.__state.country = e.target.value; });
</script>`,
	task: "Select Canada as the country.",
	async solve(t) {
		await t.fill("country select", "Canada", { name: /country/i });
	},
	check: async (page) => (await page.eval("window.__state.country")) === "ca",
};

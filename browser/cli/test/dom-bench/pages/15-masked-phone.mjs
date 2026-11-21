export default {
	id: "masked-phone",
	title: "Masked phone input",
	html: `<!doctype html><meta charset="utf-8"><title>Contact</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Contact details</h1>
<label for="ph">Phone</label> <input id="ph" inputmode="tel" placeholder="(555) 000-0000" autocomplete="off">
<script>
window.__state = { digits: "" };
const ph = document.getElementById("ph");
function fmt(d) { d = d.slice(0, 10); let s = ""; if (d.length) s = "(" + d.slice(0, 3); if (d.length >= 3) s += ") "; if (d.length > 3) s += d.slice(3, 6); if (d.length > 6) s += "-" + d.slice(6); return s; }
ph.addEventListener("input", () => { const d = ph.value.replace(/\\D/g, ""); window.__state.digits = d.slice(0, 10); ph.value = fmt(d); });
</script>`,
	task: "Enter the phone number 5551234567.",
	async solve(t) {
		await t.type("phone input", "5551234567", { role: /textbox|input|text/i, name: /phone/i });
	},
	check: async (page) => (await page.eval("window.__state.digits")) === "5551234567" && (await page.eval("document.getElementById('ph').value")) === "(555) 123-4567",
};

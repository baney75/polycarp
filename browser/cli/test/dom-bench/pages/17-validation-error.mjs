export default {
	id: "validation-error",
	title: "Prefilled invalid field that must be fixed",
	html: `<!doctype html><meta charset="utf-8"><title>Shipping</title>
<style>body{font:16px system-ui;margin:24px}.err{color:#b00;margin:4px 0}label{display:block;margin:8px 0 4px}</style>
<h1>Shipping address</h1>
<form id="f" novalidate><label for="street">Street</label><input id="street" value="12 Elm St"><label for="zip">ZIP code</label><input id="zip" value="6310" inputmode="numeric">
<div class="err" id="err" role="alert"></div><button type="submit">Place order</button></form>
<script>
window.__state = { submitted: null };
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const zip = document.getElementById("zip").value;
  if (!/^\\d{5}$/.test(zip)) { document.getElementById("err").textContent = "ZIP code must be 5 digits."; return; }
  document.getElementById("err").textContent = "";
  window.__state.submitted = { street: document.getElementById("street").value, zip };
});
</script>`,
	task: "The form has a wrong ZIP code. Use ZIP 63101 and place the order.",
	async solve(t) {
		await t.fill("ZIP code input", "63101", { role: /textbox|input|text/i, name: /zip/i });
		await t.click("place order button", { role: "button", name: /place order/i });
	},
	check: async (page) => JSON.stringify(await page.eval("window.__state.submitted")) === JSON.stringify({ street: "12 Elm St", zip: "63101" }),
};

export default {
	id: "disabled-submit",
	title: "Submit enables after valid input",
	html: `<!doctype html><meta charset="utf-8"><title>Newsletter</title>
<style>body{font:16px system-ui;margin:24px}button:disabled{opacity:.4}</style>
<h1>Stay in touch</h1>
<form id="f"><label for="em">Email address</label> <input id="em" type="text" autocomplete="off"> <button type="submit" id="sub" disabled>Subscribe</button></form><p id="msg"></p>
<script>
window.__state = { subscribed: null };
const em = document.getElementById("em"), sub = document.getElementById("sub");
em.addEventListener("input", () => { sub.disabled = !/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(em.value); });
document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); window.__state.subscribed = em.value; document.getElementById("msg").textContent = "Subscribed!"; });
</script>`,
	task: "Subscribe ada@example.com to the newsletter.",
	async solve(t) {
		await t.type("email address input", "ada@example.com", { role: /textbox|input|text/i, name: /email/i });
		await t.click("subscribe button", { role: "button", name: /subscribe/i });
	},
	check: async (page) => (await page.eval("window.__state.subscribed")) === "ada@example.com",
};

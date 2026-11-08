export default {
	id: "date-input",
	title: "Native date input",
	html: `<!doctype html><meta charset="utf-8"><title>Booking</title>
<style>body{font:16px system-ui;margin:24px}label{display:block;margin:8px 0 4px}</style>
<h1>Book a trip</h1>
<form id="f"><label for="dep">Departure date</label><input type="date" id="dep" name="dep"><br><br><button type="submit">Book trip</button></form>
<script>
window.__state = { booked: null };
document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); window.__state.booked = document.getElementById("dep").value; });
</script>`,
	task: "Set the departure date to December 25, 2026 and book the trip.",
	async solve(t) {
		await t.fill("departure date input", "2026-12-25", { name: /departure date/i });
		await t.click("book trip button", { role: "button", name: /book trip/i });
	},
	check: async (page) => (await page.eval("window.__state.booked")) === "2026-12-25",
};

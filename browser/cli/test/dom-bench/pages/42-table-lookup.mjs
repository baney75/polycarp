const regions = ["North", "South", "East", "West"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const rows = regions.map((r, ri) => `<tr><th scope="row">${r}</th>${months.map((m, mi) => `<td>${(ri + 3) * 1000 + (mi + 1) * 111 + (ri === 2 && mi === 3 ? 7 : 0)}</td>`).join("")}</tr>`).join("");
export default {
	id: "table-lookup",
	title: "Read a value from a table by row and column headers",
	html: `<!doctype html><meta charset="utf-8"><title>Sales</title>
<style>body{font:16px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #888;padding:6px 12px;text-align:right}</style>
<h1>Sales by region (units)</h1>
<table aria-label="Sales"><thead><tr><th></th>${months.map((m) => `<th scope="col">${m}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
<form id="f"><label>Answer <input id="ans" type="text"></label> <button type="submit">Submit answer</button></form>
<script>window.__state = { answer: null }; document.getElementById("f").onsubmit = (e) => { e.preventDefault(); window.__state.answer = document.getElementById("ans").value; };</script>`,
	task: "How many units did the East region sell in April? Enter the number in the answer box and submit.",
	async solve(t) {
		const text = await t.text();
		const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
		// get_page_text lays the table out row by row; find the header row and the East row.
		const head = lines.findIndex((l) => /\bJan\b.*\bApr\b/.test(l));
		const east = lines.find((l) => /^East\b/.test(l));
		if (head < 0 || !east) throw new Error(`could not find the header row and the East row in the page text: ${JSON.stringify(lines.slice(0, 6))}`);
		const cols = lines[head].split(/\s+/).filter(Boolean);
		const vals = east.split(/\s+/).slice(1);
		const answer = vals[cols.indexOf("Apr")];
		await t.type("answer input", answer, { role: /textbox|input|text/i, name: /answer/i });
		await t.click("Submit answer button", { role: "button", name: /submit answer/i });
	},
	check: async (page) => (await page.eval("window.__state.answer")) === "5451",
};

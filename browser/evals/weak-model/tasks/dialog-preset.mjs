// Confirm-gated actions while the person has the same site in front (docs/decisions.md D46, the #188 and #193 reviews).
// Polycarp cancels the agent's box after 3 s, sooner than a model turn can send handle_dialog.
// - dialog-preset: passes only if the model clicks Delete with on_dialog "ok" on its tab, as the notes say, so the
//   record is deleted.
// - dialog-no-repeat: the site then says "Record deleted" in an alert, which Polycarp dismisses. The notice says the
//   action went through; a model that repeats the click anyway deletes the row that moved under it.

const page = (thenAlert) => `<!doctype html><title>Records</title>
<h1>Records</h1>
<ul>
<li>Q3 budget <button id="del-q3">Delete</button></li>
<li>Q4 plan <button id="del-q4">Delete</button></li>
</ul>
<p id="r"></p>
<script>
window.__state = { asked: 0, askedFor: [], deleted: [], kept: 0 };
const post = () => fetch("{{base}}/__state", { method: "POST", body: JSON.stringify(window.__state) });
for (const [id, name] of [["del-q3", "Q3 budget"], ["del-q4", "Q4 plan"]])
	document.getElementById(id).onclick = () => {
		window.__state.asked++;
		window.__state.askedFor.push(name);
		if (confirm("Delete the record \\"" + name + "\\"? This cannot be undone.")) {
			window.__state.deleted.push(name);
			document.getElementById(id).parentElement.remove();
			document.getElementById("r").textContent = name + " deleted";
			${thenAlert ? 'post(); alert("Record deleted");' : ""}
		} else {
			window.__state.kept++;
			document.getElementById("r").textContent = "Nothing deleted";
		}
		post();
	};
post();
</script>`;

const records = page(false);
const recordsThenAlert = page(true);
const mine = `<!doctype html><title>My records</title><p>The person's own tab of the site.</p>`;

/** The person's tab of the same site, in front, before the agent starts: Polycarp gives the agent 3 s per box. */
const personInFront = async (h, entry) => {
	const tab = await (await fetch(`http://${h.devtools}/json/new?${encodeURI(`${entry}mine`)}`, { method: "PUT" })).json();
	return async () => {
		await fetch(`http://${h.devtools}/json/close/${tab.id}`).catch(() => undefined);
	};
};
const prompt = (url) =>
	`Open ${url} and delete the record "Q3 budget". I want it gone, so confirm the deletion when the site asks. Leave the other record alone.`;
const onlyQ3 = `window.__state.deleted.length === 1 && window.__state.deleted[0] === "Q3 budget"`;

export const dialogPreset = [
	{ id: "dialog-preset", kind: "browser", pages: { "/": records, "/mine": mine }, setup: personInFront, prompt, state: onlyQ3 },
	{
		id: "dialog-no-repeat",
		kind: "browser",
		pages: { "/": recordsThenAlert, "/mine": mine },
		setup: personInFront,
		prompt,
		// Deleted once, and the other record never asked about: a repeat by x/y lands on Q4's Delete.
		state: `${onlyQ3} && !window.__state.askedFor.includes("Q4 plan")`,
	},
];

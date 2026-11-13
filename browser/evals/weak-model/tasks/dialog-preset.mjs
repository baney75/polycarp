// A confirm-gated action while the person has the same site in front (docs/decisions.md D46, first-F1 of the #188
// review). Polycarp cancels the agent's box after 3 s, sooner than a model turn can send handle_dialog. The run passes
// only if the model follows the notice and repeats the click with on_dialog "ok", so the record is deleted.

const records = `<!doctype html><title>Records</title>
<h1>Records</h1>
<ul>
<li>Q3 budget <button id="del-q3">Delete</button></li>
<li>Q4 plan <button id="del-q4">Delete</button></li>
</ul>
<p id="r"></p>
<script>
window.__state = { asked: 0, deleted: [], kept: 0 };
const post = () => fetch("{{base}}/__state", { method: "POST", body: JSON.stringify(window.__state) });
for (const [id, name] of [["del-q3", "Q3 budget"], ["del-q4", "Q4 plan"]])
	document.getElementById(id).onclick = () => {
		window.__state.asked++;
		if (confirm("Delete the record \\"" + name + "\\"? This cannot be undone.")) {
			window.__state.deleted.push(name);
			document.getElementById(id).parentElement.remove();
			document.getElementById("r").textContent = name + " deleted";
		} else {
			window.__state.kept++;
			document.getElementById("r").textContent = "Nothing deleted";
		}
		post();
	};
post();
</script>`;

const mine = `<!doctype html><title>My records</title><p>The person's own tab of the site.</p>`;

export const dialogPreset = [
	{
		id: "dialog-preset",
		kind: "browser",
		pages: { "/": records, "/mine": mine },
		/** The person's tab of the same site, in front, before the agent starts: Polycarp gives the agent 3 s per box. */
		setup: async (h, entry) => {
			const tab = await (await fetch(`http://${h.devtools}/json/new?${encodeURI(`${entry}mine`)}`, { method: "PUT" })).json();
			return async () => {
				await fetch(`http://${h.devtools}/json/close/${tab.id}`).catch(() => undefined);
			};
		},
		prompt: (url) =>
			`Open ${url} and delete the record "Q3 budget". I want it gone, so confirm the deletion when the site asks. Leave the other record alone.`,
		state: `window.__state.deleted.length === 1 && window.__state.deleted[0] === "Q3 budget"`,
	},
];

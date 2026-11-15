// Computer tasks on the stub helper (evals/weak-model/stub): the real computer_* tool list, rows, refs and errors, over
// small fake apps, so they run headless anywhere and never open a window on the Mac. Each is scored by machine from
// the stub's world (what each window shows, what was applied, saved or closed), the fixture files and the answer.
// `{dir}` in a prompt is the task's folder inside the stub's handoff folder.

/** The world's windows of one app, newest last. */
const of = (world, app) => world.windows.filter((w) => w.app === app);
const verdict = (ok, why) => (ok ? { pass: true, why: [] } : { pass: false, why: [why] });
const digits = (s) => String(s).replace(/[,\s]/g, "");

/** A long report, 12 pages of 40 lines; the one fact asked for is on page 11. */
function report() {
	const pages = [];
	for (let p = 1; p <= 12; p++) {
		const lines = [`Harbor Ferry Lines annual report, page ${p}`];
		for (let i = 1; i < 40; i++) lines.push(`Section ${p}.${i}: route ${((p * 7 + i) % 9) + 1} carried ${1000 + ((p * 37 + i * 11) % 900)} passengers in week ${i}.`);
		if (p === 11) lines.splice(23, 1, "Audit reference for the harbor authority: HFL-AUD-58Z3Q (keep with the filing).");
		pages.push(lines.join("\n"));
	}
	return pages.join("\n\f");
}

export const stubTasks = [
	{
		id: "stub-tally-multiply",
		kind: "stub",
		prompt: () => "Use the Tally app to work out 1234 times 56, and tell me the result.",
		check: (world, { final }) => {
			if (!/69,?104/.test(final)) return verdict(false, "answer missing or wrong");
			return verdict(of(world, "Tally").some((w) => digits(w.state.display) === "69104" || w.state.results.some((r) => digits(r) === "69104")), "Tally never showed 69,104");
		},
	},
	{
		id: "stub-tally-sequence",
		kind: "stub",
		prompt: () => "In Tally, work out (45 + 17) x 3 and leave the result on the display.",
		check: (world) => verdict(of(world, "Tally").some((w) => w.open && digits(w.state.display) === "186"), `display not 186 (${of(world, "Tally").map((w) => w.state.display).join(", ") || "Tally never opened"})`),
	},
	{
		id: "stub-jotter-append",
		kind: "stub",
		files: { "shopping.txt": "bread\nmilk\napples\n" },
		prompt: (dir) => `Open ${dir}/shopping.txt in Jotter and add "eggs" as a new line at the end of the list. You don't need to save it.`,
		check: (world) => {
			const texts = of(world, "Jotter").map((w) => w.state.text);
			return verdict(texts.some((t) => /^bread\nmilk\napples\n+eggs\n?$/.test(t)), `text not as asked (${JSON.stringify(texts.at(-1) ?? "never opened").slice(0, 80)})`);
		},
	},
	{
		id: "stub-jotter-save",
		kind: "stub",
		files: { "todo.txt": "renew passport\nwater plants\n" },
		prompt: (dir) => `Add "call the bank" as the last line of ${dir}/todo.txt using Jotter, and save the file.`,
		check: (_world, { file }) => {
			const body = file("todo.txt");
			return verdict(/^renew passport\nwater plants\n+call the bank\n?$/.test(body), `file not saved as asked (${JSON.stringify(body).slice(0, 80)})`);
		},
	},
	{
		id: "stub-jotter-close",
		kind: "stub",
		files: { "memo.txt": "Budget request for the spring term.\nSubmitted by the grounds crew.\n" },
		prompt: (dir) => `Open ${dir}/memo.txt in Jotter, add the line "Approved" at the end, and close the window, keeping the change.`,
		check: (world, { file }) => {
			const body = file("memo.txt");
			if (!/^Budget request for the spring term\.\nSubmitted by the grounds crew\.\n+Approved\n?$/.test(body)) return verdict(false, `file not saved as asked (${JSON.stringify(body).slice(0, 80)})`);
			return verdict(of(world, "Jotter").length > 0 && of(world, "Jotter").every((w) => !w.open), "the memo window is still open");
		},
	},
	{
		id: "stub-leaflet-find",
		kind: "stub",
		files: { "report.pdf": report() },
		prompt: (dir) => `Open ${dir}/report.pdf in Leaflet and tell me the audit reference for the harbor authority.`,
		check: (world, { final }) => {
			if (!of(world, "Leaflet").length) return verdict(false, "Leaflet never opened");
			return verdict(/HFL-AUD-58Z3Q/.test(final), "answer missing or wrong");
		},
	},
	{
		id: "stub-thermo-settings",
		kind: "stub",
		prompt: () => "In the Thermo app, switch the mode to Cool, set the target temperature to 21, turn on Eco mode, and apply the settings. Leave everything else as it is.",
		check: (world) => {
			const applied = of(world, "Thermo").map((w) => w.state.applied);
			const ok = applied.some((a) => a.mode === "Cool" && Number(a.target) === 21 && a.eco === true && a.schedule === true);
			return verdict(ok, `applied settings not as asked (${JSON.stringify(applied.at(-1) ?? "never opened")})`);
		},
	},
	{
		id: "stub-roster-lookup",
		kind: "stub",
		prompt: () => "Look up Priya Shah in the Roster app and tell me her phone number.",
		check: (world, { final }) => {
			if (!/555-?0126/.test(final) || /555-?0154/.test(final)) return verdict(false, "answer missing or wrong");
			return verdict(of(world, "Roster").some((w) => w.state.selections.includes("Priya Shah")), "the number wasn't read from Priya Shah's record in Roster");
		},
	},
	// The bench's System Settings tasks (spaces/bench/tasks/settings-*.json), same goals, on the stub's System Settings:
	// the real app is once-per-user and answers needs_sandbox on the host, so these measure the model side headless.
	{
		id: "stub-settings-appearance",
		kind: "stub",
		prompt: () => "In System Settings go to the Appearance pane. Change nothing.",
		check: (world) => {
			const w = of(world, "System Settings");
			if (w.some((x) => x.state.changes.length)) return verdict(false, `a setting changed (${JSON.stringify(w.flatMap((x) => x.state.changes))})`);
			return verdict(w.some((x) => x.open && x.title === "Appearance" && x.state.pane === "Appearance"), `not on Appearance (${w.map((x) => x.title).join(", ") || "never opened"})`);
		},
	},
	{
		id: "stub-settings-two-panes",
		kind: "stub",
		prompt: () => "In System Settings open Accessibility, then its Display pane. Change nothing.",
		check: (world) => {
			const w = of(world, "System Settings");
			if (w.some((x) => x.state.changes.length)) return verdict(false, `a setting changed (${JSON.stringify(w.flatMap((x) => x.state.changes))})`);
			return verdict(w.some((x) => x.open && x.title === "Display" && x.state.pane === "Accessibility" && x.state.sub === "Display"), `not on Accessibility > Display (${w.map((x) => `${x.state.pane} > ${x.state.sub}`).join(", ") || "never opened"})`);
		},
	},
];

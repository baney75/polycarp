// Computer tasks for the weak-model eval. Only apps `polycarp-spaces agent open` starts on the host
// (TextEdit, Preview on a handoff file, Calculator), on fixture files in a folder of our own inside the
// agent handoff folder. Scored by reading the agent workspace back through the helper (`windows`,
// `snapshot`) and, for a save, the file itself. `{dir}` in a prompt is the task's fixture folder.
import { makePdf } from "../../../cli/test/helpers/pdf.mjs";

/** Every value and name in a snapshot tree, flattened, so a check can look for text anywhere in a window. */
export function treeText(node, out = []) {
	if (!node || typeof node !== "object") return out;
	for (const key of ["value", "name", "description", "title"]) if (typeof node[key] === "string") out.push(node[key]);
	if (node.native_id?.value) out.push(String(node.native_id.value));
	for (const child of node.children ?? []) treeText(child, out);
	return out;
}

const digits = (s) => s.replace(/[,\s  ]/g, "");

export const computerTasks = [
	{
		id: "calc-multiply",
		kind: "computer",
		app: "Calculator",
		prompt: () => "Use the Calculator app to work out 1234 times 56, and tell me the result.",
		answer: /69,?104/,
		windows: (texts) => texts.some((t) => digits(t).includes("69104")),
	},
	{
		id: "calc-sequence",
		kind: "computer",
		app: "Calculator",
		prompt: () => "In Calculator, work out (45 + 17) x 3 and leave the result on the display.",
		windows: (texts) => texts.some((t) => /(^|[^\d])186([^\d]|$)/.test(digits(t))),
	},
	{
		id: "textedit-append",
		kind: "computer",
		app: "TextEdit",
		files: { "shopping.txt": "bread\nmilk\napples\n" },
		prompt: (dir) => `Open ${dir}/shopping.txt in TextEdit and add "eggs" as a new line at the end of the list. You don't need to save it.`,
		windows: (texts) => texts.some((t) => /^bread\nmilk\napples\n+eggs\n?$/.test(t)),
	},
	{
		id: "textedit-read",
		kind: "computer",
		app: "TextEdit",
		files: { "invoice.txt": "INVOICE 2026-118\nBill to: Harbor Supply Co.\n\nRope, 40 m ........ $86.00\nCleats x4 ........ $31.60\nVarnish ........... $22.15\n\nTOTAL DUE: $139.75\nPayable within 30 days.\n" },
		prompt: (dir) => `What's the total due on the invoice at ${dir}/invoice.txt? Open it in TextEdit to check.`,
		answer: /139\.75/,
	},
	{
		id: "textedit-replace",
		kind: "computer",
		app: "TextEdit",
		files: { "letter.txt": "Dear Sir,\n\nThank you for your order of March 3. It ships on Friday.\n\nKind regards,\nJo\n" },
		prompt: (dir) => `In ${dir}/letter.txt, change the greeting "Dear Sir" to "Dear Ms. Park". Use TextEdit and keep the rest of the letter the same. No need to save.`,
		windows: (texts) => texts.some((t) => t.startsWith("Dear Ms. Park,\n\nThank you for your order of March 3. It ships on Friday.\n\nKind regards,\nJo")),
	},
	{
		id: "textedit-save",
		kind: "computer",
		app: "TextEdit",
		files: { "todo.txt": "renew passport\nwater plants\n" },
		prompt: (dir) => `Add "call the bank" as the last line of ${dir}/todo.txt using TextEdit, and save the file.`,
		file: { name: "todo.txt", test: (body) => /^renew passport\nwater plants\n+call the bank\n?$/.test(body) },
	},
	{
		id: "calc-toggle",
		kind: "computer",
		app: "Calculator",
		prompt: () => 'In Calculator, turn on the secondary functions (the "2nd" key) and leave it on.',
		// The switch reads value 1 when on.
		windowsTree: (tree) => {
			const hits = [];
			const walk = (n) => {
				if (!n || typeof n !== "object") return;
				if (n.role === "switch" && /secondary/i.test(n.name ?? "")) hits.push(n);
				for (const c of n.children ?? []) walk(c);
			};
			walk(tree);
			return hits.some((n) => String(n.value) === "1");
		},
	},
	{
		id: "preview-read",
		kind: "computer",
		app: "Preview",
		files: {
			"ticket.pdf": makePdf(1, 12, (_n, i) =>
				["Harbor Ferry Lines", "Boarding pass", "Passenger: J. Alvarez", "Route: Seaport - Gull Island", "Departure: 09:40", "Confirmation code: HFL-58Z3Q", "Seat: deck, unassigned"][i] ?? ""),
		},
		prompt: (dir) => `Open ${dir}/ticket.pdf in Preview and tell me the confirmation code on it.`,
		answer: /HFL-58Z3Q/,
	},
];

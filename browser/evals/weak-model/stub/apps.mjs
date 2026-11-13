// The stub's apps: small models of a calculator, a plain-text editor, a document viewer, a settings window and a contact
// list. Each renders an accessibility tree (role, name, value, states, children) where every element has a stable key,
// takes the actions a real app would (press, set a value, toggle, choose), and exports what a task scores. Nothing here
// touches the Mac: a document "saved" is written to the stub's own handoff folder and nowhere else.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const node = (key, role, name = "", extra = {}) => ({ key, role, name, value: "", states: [], children: [], ...extra });

/** Thousands separators, like the real Calculator's display. */
const grouped = (n) => {
	if (!Number.isFinite(n)) return "Error";
	const [i, f] = String(Math.round(n * 1e10) / 1e10).split(".");
	const sign = i.startsWith("-") ? "-" : "";
	const body = i.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return sign + body + (f ? `.${f}` : "");
};

/** Evaluates a calculator expression of numbers, + - × ÷ and parentheses, by precedence. */
function evaluate(tokens) {
	let i = 0;
	const peek = () => tokens[i];
	const atom = () => {
		const t = tokens[i++];
		if (t === "(") {
			const v = sum();
			if (tokens[i] === ")") i++;
			return v;
		}
		if (t === "-") return -atom();
		const v = Number(String(t ?? "").replace(/,/g, ""));
		if (Number.isNaN(v)) throw new Error("bad expression");
		return v;
	};
	const product = () => {
		let v = atom();
		while (peek() === "×" || peek() === "÷") v = tokens[i++] === "×" ? v * atom() : v / atom();
		return v;
	};
	const sum = () => {
		let v = product();
		while (peek() === "+" || peek() === "-") v = tokens[i++] === "+" ? v + product() : v - product();
		return v;
	};
	const v = sum();
	if (i !== tokens.length) throw new Error("bad expression");
	return v;
}

class Tally {
	static app = "Tally";
	constructor() {
		this.title = "Tally";
		this.tokens = [];
		this.entry = "0";
		this.fresh = true;
		this.shown = "0";
		this.results = [];
	}
	display() {
		return this.shown;
	}
	refresh() {
		const parts = [...this.tokens.map((t) => (/^[\d.]+$/.test(t) ? grouped(Number(t)) : t))];
		if (!this.fresh || !this.tokens.length) parts.push(grouped(Number(this.entry)) + (this.entry.endsWith(".") ? "." : ""));
		this.shown = parts.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
	}
	key(k) {
		const digit = /^\d$/.test(k);
		if (digit || k === ".") {
			if (this.fresh) this.entry = digit ? k : "0.";
			else if (k !== "." || !this.entry.includes(".")) this.entry = this.entry === "0" && digit ? k : this.entry + k;
			this.fresh = false;
		} else if (["+", "-", "×", "÷"].includes(k)) {
			if (!this.fresh) this.tokens.push(this.entry);
			else if (!this.tokens.length) this.tokens.push(this.entry);
			const last = this.tokens.at(-1);
			if (["+", "-", "×", "÷"].includes(last)) this.tokens[this.tokens.length - 1] = k;
			else this.tokens.push(k);
			this.fresh = true;
		} else if (k === "(") {
			this.tokens.push("(");
			this.fresh = true;
		} else if (k === ")") {
			if (!this.fresh) this.tokens.push(this.entry);
			this.tokens.push(")");
			this.fresh = true;
			this.entry = "";
		} else if (k === "=") {
			if (!this.fresh) this.tokens.push(this.entry);
			let v;
			try {
				v = evaluate(this.tokens.filter((t) => t !== ""));
			} catch {
				v = Number.NaN;
			}
			this.tokens = [];
			this.entry = Number.isFinite(v) ? String(v) : "0";
			this.fresh = true;
			this.shown = grouped(v);
			this.results.push(this.shown);
			return;
		} else if (k === "AC") {
			this.tokens = [];
			this.entry = "0";
			this.fresh = true;
		} else if (k === "C") {
			this.entry = "0";
		} else if (k === "±") {
			this.entry = this.entry.startsWith("-") ? this.entry.slice(1) : `-${this.entry}`;
			this.fresh = false;
		} else if (k === "%") {
			this.entry = String(Number(this.entry) / 100);
			this.fresh = false;
		} else return false;
		this.refresh();
		return true;
	}
	render() {
		const button = (k, name, key) => node(`b:${k}`, "button", name, { actions: ["Click"], press: () => this.key(key ?? k) });
		const pad = node("pad", "group", "", {
			children: [
				button("ac", this.tokens.length || this.entry !== "0" ? "Clear" : "All Clear", "AC"),
				button("sign", "Change Sign", "±"),
				button("pct", "Percent", "%"),
				button("div", "Divide", "÷"),
				button("open", "Open Parenthesis", "("),
				button("close", "Close Parenthesis", ")"),
				...["7", "8", "9"].map((d) => button(d, d)),
				button("mul", "Multiply", "×"),
				...["4", "5", "6"].map((d) => button(d, d)),
				button("sub", "Subtract", "-"),
				...["1", "2", "3"].map((d) => button(d, d)),
				button("add", "Add", "+"),
				button("0", "0"),
				button("dot", "Decimal", "."),
				button("eq", "Equals", "="),
			],
		});
		const display = node("display", "statictext", this.shown, { value: this.shown });
		return node("w", "window", this.title, { children: [node("screen", "group", "", { children: [display] }), pad] });
	}
	/** Keys a press may send, by name. */
	keyFor(name) {
		const map = { Return: "=", Enter: "=", "=": "=", Escape: "AC", c: "AC", "*": "×", x: "×", "/": "÷", "+": "+", "-": "-", minus: "-", plus: "+", "(": "(", ")": ")", ".": ".", period: ".", "%": "%" };
		return /^\d$/.test(name) ? name : map[name];
	}
	pressKey(name) {
		const k = this.keyFor(name);
		return k ? this.key(k) !== false : false;
	}
	export() {
		return { display: this.shown, results: this.results };
	}
}

class Jotter {
	static app = "Jotter";
	constructor(file) {
		this.file = file;
		this.name = file ? basename(file) : "Untitled";
		this.text = file ? readFileSync(file, "utf8") : "";
		this.saved = this.text;
		// A document opens with the insertion point at its start, as TextEdit's do.
		this.caret = 0;
		this.anchor = 0;
		this.sheet = false;
		this.closed = false;
		this.saves = 0;
	}
	get title() {
		return this.dirty ? `${this.name} (edited)` : this.name;
	}
	get dirty() {
		return this.text !== this.saved;
	}
	insert(s) {
		const [a, b] = [Math.min(this.caret, this.anchor), Math.max(this.caret, this.anchor)];
		this.text = this.text.slice(0, a) + s + this.text.slice(b);
		this.caret = this.anchor = a + s.length;
	}
	save() {
		if (!this.file) return false;
		writeFileSync(this.file, this.text);
		this.saved = this.text;
		this.saves++;
		return true;
	}
	lineBounds(at) {
		const start = this.text.lastIndexOf("\n", at - 1) + 1;
		const nl = this.text.indexOf("\n", at);
		return [start, nl < 0 ? this.text.length : nl];
	}
	pressKey(name) {
		const k = name.toLowerCase();
		const move = (to, extend = false) => {
			this.caret = Math.max(0, Math.min(this.text.length, to));
			if (!extend) this.anchor = this.caret;
			return true;
		};
		const [a, b] = [Math.min(this.caret, this.anchor), Math.max(this.caret, this.anchor)];
		switch (k) {
			case "cmd+s":
				return this.save();
			case "cmd+a":
				this.anchor = 0;
				this.caret = this.text.length;
				return true;
			case "cmd+down":
			case "cmd+end":
				return move(this.text.length);
			case "cmd+up":
			case "cmd+home":
				return move(0);
			case "cmd+right":
			case "end":
				return move(this.lineBounds(this.caret)[1]);
			case "cmd+left":
			case "home":
				return move(this.lineBounds(this.caret)[0]);
			case "right":
				return move(a === b ? this.caret + 1 : b);
			case "left":
				return move(a === b ? this.caret - 1 : a);
			case "down": {
				const [s, e] = this.lineBounds(this.caret);
				if (e >= this.text.length) return move(this.text.length);
				const [, e2] = this.lineBounds(e + 1);
				return move(Math.min(e + 1 + (this.caret - s), e2));
			}
			case "up": {
				const [s] = this.lineBounds(this.caret);
				if (s === 0) return move(0);
				const [s0, e0] = this.lineBounds(s - 1);
				return move(Math.min(s0 + (this.caret - s), e0));
			}
			case "return":
			case "enter":
				this.insert("\n");
				return true;
			case "tab":
				this.insert("\t");
				return true;
			case "space":
				this.insert(" ");
				return true;
			case "backspace":
			case "delete":
				if (a !== b) this.insert("");
				else if (this.caret > 0) {
					this.text = this.text.slice(0, this.caret - 1) + this.text.slice(this.caret);
					move(this.caret - 1);
				}
				return true;
			case "forwarddelete":
				if (a !== b) this.insert("");
				else this.text = this.text.slice(0, this.caret) + this.text.slice(this.caret + 1);
				return true;
			default:
				if ([...name].length === 1) {
					this.insert(name);
					return true;
				}
				if (k.startsWith("shift+") && [...name.slice(6)].length === 1) {
					this.insert(name.slice(6).toUpperCase());
					return true;
				}
				return false;
		}
	}
	render() {
		const area = node("text", "textarea", "", {
			value: this.text,
			states: ["focused"],
			editable: true,
			actions: ["SetValue"],
			set: (v) => {
				this.text = v;
				this.caret = this.anchor = v.length;
			},
			type: (s) => this.insert(s),
		});
		const children = [node("scroll", "scrollarea", "", { actions: ["Scroll"], children: [area] })];
		if (this.sheet) {
			const choose = (what) => () => {
				if (what === "save") this.save();
				if (what !== "cancel") this.closed = true;
				this.sheet = false;
				return true;
			};
			children.push(
				node("sheet", "sheet", "", {
					states: ["sheet"],
					children: [
						node("sheet:q", "statictext", `Do you want to keep the changes you made to the document "${this.name}"?`, { states: ["sheet"] }),
						node("sheet:dont", "button", "Don't Save", { states: ["sheet"], actions: ["Click"], press: choose("dont") }),
						node("sheet:cancel", "button", "Cancel", { states: ["sheet"], actions: ["Click"], press: choose("cancel") }),
						node("sheet:save", "button", "Save", { states: ["sheet"], actions: ["Click"], press: choose("save") }),
					],
				}),
			);
		}
		return node("w", "window", this.title, { children });
	}
	menu(path) {
		const p = path.toLowerCase().replace(/\s+/g, " ");
		if (p === "file > save") return this.save() ? "saved" : "nothing to save to";
		if (p === "edit > select all") return this.pressKey("cmd+a") && "selected";
		if (p === "file > close") return this.close();
		return undefined;
	}
	/** Close from the close button: a document with unsaved changes asks first. */
	close() {
		if (this.dirty) {
			this.sheet = true;
			return "sheet";
		}
		this.closed = true;
		return "closed";
	}
	export() {
		return { file: this.name, text: this.text, saved: this.saved, dirty: this.dirty, saves: this.saves, closed: this.closed, sheet: this.sheet };
	}
}

class Leaflet {
	static app = "Leaflet";
	constructor(file) {
		this.file = file;
		this.title = file ? basename(file) : "Leaflet";
		// A page per form feed; each page a list of lines.
		this.pages = (file ? readFileSync(file, "utf8") : "").split("\f").map((p) => p.split("\n").filter((l) => l.trim()));
		this.page = 1;
	}
	render() {
		const go = (d) => () => {
			const to = Math.max(1, Math.min(this.pages.length, this.page + d));
			if (to === this.page) return false;
			this.page = to;
			return true;
		};
		const toolbar = node("bar", "toolbar", "", {
			children: [
				node("prev", "button", "Previous Page", { actions: ["Click"], press: go(-1), states: this.page === 1 ? ["disabled"] : [] }),
				node("next", "button", "Next Page", { actions: ["Click"], press: go(1), states: this.page === this.pages.length ? ["disabled"] : [] }),
				node("count", "statictext", `Page ${this.page} of ${this.pages.length}`),
			],
		});
		const pages = this.pages.map((lines, i) =>
			node(`p${i + 1}`, "group", `Page ${i + 1}`, { children: lines.map((l, j) => node(`p${i + 1}:${j}`, "statictext", l)) }),
		);
		const scroll = node("scroll", "scrollarea", "", { actions: ["Scroll"], scroll: (dir) => go(dir === "down" || dir === "right" ? 1 : -1)(), children: pages });
		return node("w", "window", this.title, { children: [toolbar, scroll] });
	}
	pressKey(name) {
		const k = name.toLowerCase();
		if (["pagedown", "space", "down", "right"].includes(k)) return this.render().children[0].children[1].press();
		if (["pageup", "up", "left"].includes(k)) return this.render().children[0].children[0].press();
		return false;
	}
	export() {
		return { page: this.page };
	}
}

class Thermo {
	static app = "Thermo";
	constructor() {
		this.title = "Thermo";
		this.form = { mode: "Heat", target: "22", eco: false, schedule: true };
		this.applied = { ...this.form };
		this.status = "";
	}
	render() {
		const f = this.form;
		const changed = JSON.stringify(f) !== JSON.stringify(this.applied);
		return node("w", "window", this.title, {
			children: [
				node("now", "statictext", "Indoor now: 23.5°C"),
				node("mode", "popupbutton", "Mode", { value: f.mode, options: ["Heat", "Cool", "Fan", "Off"], actions: ["ShowMenu"], choose: (o) => (f.mode = o) }),
				node("target", "textfield", "Target temperature (°C)", {
					value: f.target,
					editable: true,
					actions: ["SetValue"],
					set: (v) => (f.target = v.trim()),
					type: (s) => (f.target = (f.target + s).trim()),
				}),
				node("eco", "switch", "Eco mode", { value: f.eco ? "1" : "0", actions: ["Click"], toggle: () => (f.eco = !f.eco) }),
				node("schedule", "checkbox", "Follow weekly schedule", { value: f.schedule ? "1" : "0", actions: ["Click"], toggle: () => (f.schedule = !f.schedule) }),
				node("revert", "button", "Revert", {
					actions: ["Click"],
					states: changed ? [] : ["disabled"],
					press: () => {
						if (!changed) return false;
						Object.assign(f, this.applied);
						this.status = "";
						return true;
					},
				}),
				node("apply", "button", "Apply", {
					actions: ["Click"],
					states: changed ? [] : ["disabled"],
					press: () => {
						if (!changed) return false;
						if (!/^\d{1,2}(\.5)?$/.test(f.target) || Number(f.target) < 10 || Number(f.target) > 30) {
							this.status = "Target must be 10 to 30";
							return true;
						}
						this.applied = { ...f };
						this.status = "Settings applied";
						return true;
					},
				}),
				...(this.status ? [node("status", "statictext", this.status)] : []),
			],
		});
	}
	pressKey() {
		return false;
	}
	export() {
		return { form: { ...this.form }, applied: { ...this.applied } };
	}
}

const PEOPLE = [
	["Ada Brooks", "555-0142", "ada@example.org"],
	["Ben Okafor", "555-0177", "ben@example.org"],
	["Carla Mendes", "555-0119", "carla@example.org"],
	["Dmitri Volkov", "555-0158", "dmitri@example.org"],
	["Elena Ruiz", "555-0103", "elena@example.org"],
	["Farah Haddad", "555-0164", "farah@example.org"],
	["Gus Lindqvist", "555-0131", "gus@example.org"],
	["Hana Sato", "555-0186", "hana@example.org"],
	["Ivan Petrov", "555-0125", "ivan@example.org"],
	["June Park", "555-0149", "june@example.org"],
	["Kofi Mensah", "555-0193", "kofi@example.org"],
	["Lena Fischer", "555-0110", "lena@example.org"],
	["Marco Rossi", "555-0168", "marco@example.org"],
	["Nadia Karim", "555-0137", "nadia@example.org"],
	["Owen Hughes", "555-0181", "owen@example.org"],
	["Priya Shah", "555-0126", "priya@example.org"],
	["Priya Sharma", "555-0154", "psharma@example.org"],
	["Quinn Avery", "555-0172", "quinn@example.org"],
	["Rosa Delgado", "555-0145", "rosa@example.org"],
	["Sam Whitaker", "555-0199", "sam@example.org"],
	["Tariq Aziz", "555-0116", "tariq@example.org"],
	["Uma Iyer", "555-0188", "uma@example.org"],
	["Victor Chen", "555-0134", "victor@example.org"],
	["Wren Calloway", "555-0161", "wren@example.org"],
];

class Roster {
	static app = "Roster";
	constructor() {
		this.title = "Roster";
		this.search = "";
		this.selected = undefined;
		this.selections = [];
	}
	render() {
		const shown = PEOPLE.filter(([n]) => n.toLowerCase().includes(this.search.toLowerCase()));
		const rows = shown.map(([name], i) =>
			node(`row:${name}`, "row", "", {
				states: this.selected === name ? ["selected"] : [],
				select: () => {
					this.selected = name;
					this.selections.push(name);
					return true;
				},
				children: [node(`cell:${name}`, "cell", "", { children: [node(`name:${name}`, "statictext", name)] })],
				ordinal: i,
			}),
		);
		const person = PEOPLE.find(([n]) => n === this.selected);
		const detail = person
			? [node("d:name", "statictext", person[0]), node("d:phone", "statictext", "Phone", { value: person[1] }), node("d:mail", "statictext", "Email", { value: person[2] })]
			: [node("d:none", "statictext", "No contact selected")];
		return node("w", "window", this.title, {
			children: [
				node("search", "searchfield", "Search", {
					value: this.search,
					editable: true,
					actions: ["SetValue"],
					set: (v) => (this.search = v),
					type: (s) => (this.search += s),
				}),
				node("list", "table", "Contacts", { actions: ["Scroll"], children: rows }),
				node("detail", "group", "Details", { children: detail }),
			],
		});
	}
	pressKey() {
		return false;
	}
	export() {
		return { selected: this.selected ?? null, selections: this.selections, search: this.search };
	}
}

/** System Settings, as its accessibility tree reads: a sidebar outline of panes (rows holding a cell and the pane's
 * name), a search field over it, the pane on the right, and Back and Forward in the toolbar. The window's title is the
 * pane's name, as in macOS. Accessibility's own panes (Display, Zoom, ...) open inside it. Every control counts what it
 * changed, so a task that says "change nothing" can be scored. */
const SIDEBAR = [
	"Wi-Fi", "Bluetooth", "Network", "VPN", "Battery", "General", "Accessibility", "Appearance", "Apple Intelligence & Siri",
	"Control Center", "Desktop & Dock", "Displays", "Menu Bar", "Spotlight", "Wallpaper", "Notifications", "Sound", "Focus",
	"Screen Time", "Lock Screen", "Privacy & Security", "Touch ID & Password", "Users & Groups", "Internet Accounts",
	"Game Center", "iCloud", "Wallet & Apple Pay", "Keyboard", "Trackpad", "Printers & Scanners",
];
const GENERAL = ["About", "Software Update", "Storage", "AirDrop & Handoff", "Login Items & Extensions", "Language & Region", "Date & Time", "Sharing", "Time Machine", "Device Management", "Startup Disk", "Transfer or Reset"];
const ACCESSIBILITY = [
	["Vision", ["VoiceOver", "Zoom", "Hover Text", "Display", "Motion", "Spoken Content", "Descriptions"]],
	["Hearing", ["Hearing Devices", "Audio", "Captions"]],
	["Motor", ["Voice Control", "Keyboard", "Pointer Control", "Switch Control"]],
	["Speech", ["Live Speech", "Vocal Shortcuts", "Personal Voice"]],
	["General", ["Siri", "Shortcut"]],
];
class Settings {
	static app = "System Settings";
	constructor() {
		this.pane = "General";
		this.sub = undefined;
		this.back = [];
		this.forward = [];
		this.visited = ["General"];
		this.search = "";
		this.changes = [];
		this.values = {
			"Appearance": "Auto", "Accent color": "Multicolor", "Highlight color": "Accent Color", "Sidebar icon size": "Medium",
			"Allow wallpaper tinting in windows": true, "Show scroll bars": "Automatically based on mouse or trackpad",
			"Increase contrast": false, "Reduce transparency": false, "Differentiate without color": false, "Text size": "Default",
			"Automatically adjust brightness": true, "True Tone": true, "Use as": "Main display",
		};
	}
	get title() {
		return this.sub ?? this.pane;
	}
	go(pane, sub) {
		if (pane === this.pane && sub === this.sub) return false;
		this.back.push([this.pane, this.sub]);
		this.forward = [];
		[this.pane, this.sub] = [pane, sub];
		this.visited.push(sub ? `${pane} > ${sub}` : pane);
		return true;
	}
	set(name, v) {
		if (this.values[name] === v) return false;
		this.changes.push({ name, from: this.values[name], to: v });
		this.values[name] = v;
		return true;
	}
	popup(key, name, options) {
		return node(key, "popupbutton", name, { value: this.values[name], options, actions: ["Press", "ShowMenu"], choose: (o) => this.set(name, o) });
	}
	switchOf(key, name) {
		return node(key, "switch", name, { value: this.values[name] ? "1" : "0", actions: ["Press"], toggle: () => this.set(name, !this.values[name]) });
	}
	radios(key, name, options) {
		return node(key, "radiogroup", name, {
			children: options.map((o) =>
				node(`${key}:${o}`, "radiobutton", o, { value: this.values[name] === o ? "1" : "0", states: this.values[name] === o ? ["selected"] : [], actions: ["Press"], press: () => this.set(name, o) }),
			),
		});
	}
	content() {
		const heading = node("c:title", "statictext", this.title, { states: ["heading"] });
		if (this.sub === "Display")
			return [
				heading,
				this.switchOf("c:contrast", "Increase contrast"),
				this.switchOf("c:transp", "Reduce transparency"),
				this.switchOf("c:color", "Differentiate without color"),
				this.popup("c:text", "Text size", ["Default", "Large", "Larger", "Largest"]),
			];
		if (this.sub) return [heading, node("c:none", "statictext", `${this.sub} options`)];
		if (this.pane === "General") return [heading, ...GENERAL.map((g) => node(`c:g:${g}`, "button", g, { actions: ["Press"], press: () => true }))];
		if (this.pane === "Accessibility")
			return [
				heading,
				...ACCESSIBILITY.map(([group, items]) =>
					node(`c:a:${group}`, "group", group, {
						children: [node(`c:a:${group}:h`, "statictext", group, { states: ["heading"] }), ...items.map((i) => node(`c:a:${group}:${i}`, "button", i, { actions: ["Press"], press: () => this.go("Accessibility", i) }))],
					}),
				),
			];
		if (this.pane === "Appearance")
			return [
				heading,
				this.radios("c:look", "Appearance", ["Auto", "Light", "Dark"]),
				this.popup("c:accent", "Accent color", ["Multicolor", "Blue", "Purple", "Pink", "Red", "Orange", "Yellow", "Green", "Graphite"]),
				this.popup("c:highlight", "Highlight color", ["Accent Color", "Blue", "Purple", "Pink", "Red", "Orange", "Yellow", "Green", "Graphite", "Other"]),
				this.popup("c:icons", "Sidebar icon size", ["Small", "Medium", "Large"]),
				this.switchOf("c:tint", "Allow wallpaper tinting in windows"),
				this.radios("c:scroll", "Show scroll bars", ["Automatically based on mouse or trackpad", "When scrolling", "Always"]),
			];
		if (this.pane === "Displays")
			return [
				heading,
				node("c:d:name", "statictext", "Built-in Display"),
				this.popup("c:d:use", "Use as", ["Main display", "Mirror for AirPlay"]),
				this.switchOf("c:d:auto", "Automatically adjust brightness"),
				this.switchOf("c:d:tone", "True Tone"),
				node("c:d:night", "button", "Night Shift…", { actions: ["Press"], press: () => true }),
			];
		return [heading, node("c:none", "statictext", `${this.pane} settings`)];
	}
	render() {
		const shown = SIDEBAR.filter((n) => n.toLowerCase().includes(this.search.toLowerCase()));
		const rows = shown.map((name, i) =>
			node(`row:${name}`, "row", "", {
				states: this.pane === name ? ["selected"] : [],
				select: () => this.go(name, undefined),
				ordinal: i,
				children: [node(`cell:${name}`, "cell", "", { children: [node(`name:${name}`, "statictext", name)] })],
			}),
		);
		return node("w", "window", this.title, {
			children: [
				node("tb", "toolbar", "", {
					children: [
						node("tb:back", "button", "Back", {
							states: this.back.length ? [] : ["disabled"],
							actions: ["Press"],
							press: () => {
								if (!this.back.length) return false;
								this.forward.push([this.pane, this.sub]);
								[this.pane, this.sub] = this.back.pop();
								return true;
							},
						}),
						node("tb:fwd", "button", "Forward", {
							states: this.forward.length ? [] : ["disabled"],
							actions: ["Press"],
							press: () => {
								if (!this.forward.length) return false;
								this.back.push([this.pane, this.sub]);
								[this.pane, this.sub] = this.forward.pop();
								return true;
							},
						}),
					],
				}),
				node("side", "group", "", {
					children: [
						node("search", "searchfield", "Search", { value: this.search, editable: true, actions: ["SetValue"], set: (v) => (this.search = v), type: (t) => (this.search += t) }),
						node("outline", "outline", "Sidebar", { actions: ["Scroll"], children: rows }),
					],
				}),
				node("content", "group", "", { children: this.content() }),
			],
		});
	}
	pressKey(name) {
		const k = name.toLowerCase();
		if (k === "cmd+[") return this.back.length ? (this.render().children[0].children[0].press(), true) : false;
		if (k === "cmd+f") return true;
		return false;
	}
	export() {
		return { pane: this.pane, sub: this.sub ?? null, title: this.title, visited: this.visited, changes: this.changes, search: this.search };
	}
}

export const APPS = { Tally, Jotter, Leaflet, Thermo, Roster, "System Settings": Settings };
/** Apps with a document: open needs a file for them, and the window's title is the file's name. */
export const DOCUMENT_APPS = new Set(["Jotter", "Leaflet"]);

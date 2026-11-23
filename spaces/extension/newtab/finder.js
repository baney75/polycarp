// The finder under the new tab's field: as you type, at most seven rows. Open tabs and windows that match come first
// (switch to it, never a duplicate), then bang completions, then the search or address Return opens. It has its own
// element (#finder) and these functions; newtab.js hands it the page's answer and the way to ask Polycarp.
// Keys: Up and Down (or Control-P and Control-N) move, Return opens, Tab fills in a bang, Esc clears.
(function (root) {
	"use strict";

	var findWait = 60;
	var labels = { tab: "Switch", terminal: "Go", window: "Go", device: "Go", bang: "Tab", search: "Search", open: "Open" };

	// opts: {field, list, page: () => the page answer, ask: (message) => Promise of a reply or null, say: (text) => void}
	function create(opts) {
		var field = opts.field;
		var list = opts.list;
		var rows = [];
		var selected = 0;
		var asked = 0;
		var sessions = [];
		var tabs = [];
		// This browser's bundle ID as the host reports it, so its own rows switch with chrome.tabs.
		var browser = null;
		// Whether the person moved the selection since the text last changed. Until they do, the top row is chosen,
		// whatever a late reply puts there, so Return opens what is first (docs/newtab.md).
		var moved = false;
		var timer = null;
		var self = null;

		function hasTabs() { return typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.query === "function"; }

		// This browser's own tabs, this new tab left out.
		function readTabs() {
			if (!hasTabs()) return Promise.resolve([]);
			return new Promise(function (resolve) {
				try {
					chrome.tabs.getCurrent(function (me) {
						chrome.tabs.query({}, function (all) {
							var mine = me ? me.id : -1;
							resolve((all || []).filter(function (t) { return t.id !== mine; }).map(function (t) {
								return { id: t.id, windowId: t.windowId, title: t.title || "", url: t.url || "" };
							}));
						});
					});
				} catch (e) {
					resolve([]);
				}
			});
		}

		function key(row) { return row.kind + ":" + (row.id || "") + ":" + row.title + ":" + (row.url || row.trigger || ""); }

		function draw() {
			var was = moved && rows[selected] ? key(rows[selected]) : null;
			var page = opts.page();
			rows = PolycarpNewTab.rows(field.value, { engine: page.engine || page.searchURL, bangs: page.bangs, sessions: sessions, tabs: tabs,
				browser: browser });
			var again = was === null ? -1 : rows.map(key).indexOf(was);
			selected = again >= 0 ? again : 0;
			if (again < 0) moved = false;
			list.textContent = "";
			rows.forEach(function (row, i) {
				var li = document.createElement("li");
				li.id = "finder-row-" + i;
				li.className = "finder-row";
				li.setAttribute("role", "option");
				var what = document.createElement("span");
				what.className = "finder-what";
				what.textContent = row.title;
				var where = document.createElement("span");
				where.className = "finder-where";
				where.textContent = [row.app && row.app !== row.detail ? row.app : "", row.detail, row.workspace ? "workspace " + row.workspace : ""]
					.filter(Boolean).join(" · ");
				var label = document.createElement("span");
				label.className = "finder-key";
				label.textContent = labels[row.kind] || "Go";
				li.appendChild(what);
				li.appendChild(where);
				li.appendChild(label);
				li.addEventListener("mousemove", function () { if (selected !== i) { selected = i; moved = true; mark(); } });
				li.addEventListener("mousedown", function (e) { e.preventDefault(); selected = i; open(rows[i]); });
				list.appendChild(li);
			});
			list.hidden = rows.length === 0;
			field.setAttribute("aria-expanded", rows.length ? "true" : "false");
			mark();
		}

		function mark() {
			Array.prototype.forEach.call(list.children, function (li, i) {
				li.classList.toggle("on", i === selected);
				li.setAttribute("aria-selected", i === selected ? "true" : "false");
			});
			if (rows.length) field.setAttribute("aria-activedescendant", "finder-row-" + selected);
			else field.removeAttribute("aria-activedescendant");
		}

		// Draws now from what it has, then asks Polycarp and this browser once typing pauses.
		function update() {
			moved = false;
			draw();
			clearTimeout(timer);
			var text = field.value.trim();
			if (!text) { sessions = []; return; }
			var mine = ++asked;
			timer = setTimeout(function () {
				Promise.all([opts.ask({ op: "find", q: text }), readTabs()]).then(function (got) {
					if (mine !== asked) return;
					sessions = got[0] && got[0].ok && Array.isArray(got[0].items) ? got[0].items : [];
					if (got[0] && got[0].ok && typeof got[0].browser === "string") browser = got[0].browser;
					tabs = got[1];
					draw();
				});
			}, findWait);
		}

		function closeThisTab() {
			if (!hasTabs()) return;
			try { chrome.tabs.getCurrent(function (me) { if (me) chrome.tabs.remove(me.id); }); } catch (e) { /* stays open */ }
		}

		function open(row) {
			if (!row) return;
			if (row.kind === "bang") return complete(row);
			if (row.url) return location.assign(row.url);
			if (row.tab && hasTabs()) return switchTab(row);
			viaPolycarp(row);
		}

		// This browser's tab: activate it and its window, and close this new tab only once the switch took. A tab
		// closed since the list was drawn fails without throwing (lastError), so then Polycarp or the search goes instead.
		function switchTab(row) {
			var failed = function () { if (row.id) viaPolycarp(row); else instead(); };
			try {
				chrome.tabs.update(row.tab.id, { active: true }, function (tab) {
					if ((chrome.runtime && chrome.runtime.lastError) || !tab) return failed();
					if (!chrome.windows) return closeThisTab();
					chrome.windows.update(row.tab.windowId, { focused: true }, function () {
						void (chrome.runtime && chrome.runtime.lastError); // the tab is in front either way
						closeThisTab();
					});
				});
			} catch (e) {
				failed();
			}
		}

		function viaPolycarp(row) {
			if (!row.id) return instead();
			opts.ask({ op: "focus", id: row.id }).then(function (r) {
				if (r && r.ok) return closeThisTab();
				opts.say(r && r.error ? "Polycarp couldn’t go there: " + r.error : "Polycarp isn’t running, so it can’t go there.");
			});
		}

		// What Return does with the text (the last row), when the row chosen can't be reached.
		function instead() {
			var last = rows[rows.length - 1];
			if (last && last.url) return location.assign(last.url);
			opts.say("That tab is gone.");
		}

		function complete(row) {
			field.value = "!" + row.trigger + " ";
			update();
		}

		function move(by) {
			if (!rows.length) return;
			moved = true;
			selected = (selected + by + rows.length) % rows.length;
			mark();
		}

		function clear() {
			field.value = "";
			sessions = [];
			asked++;
			update();
		}

		// A key in the field: true when the finder took it.
		function keydown(e) {
			if (e.isComposing) return false;
			var ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
			if (e.key === "ArrowDown" || (ctrl && e.key === "n")) { move(1); return true; }
			if (e.key === "ArrowUp" || (ctrl && e.key === "p")) { move(-1); return true; }
			if (e.key === "Enter") { open(rows[selected]); return true; }
			if (e.key === "Escape" && field.value) { clear(); return true; }
			if (e.key === "Tab" && !e.shiftKey) {
				var bang = rows[selected] && rows[selected].kind === "bang" ? rows[selected] : rows.filter(function (r) { return r.kind === "bang"; })[0];
				if (bang) { complete(bang); return true; }
			}
			return false;
		}

		self = { update: update, keydown: keydown, open: function () { open(rows[selected]); }, rows: function () { return rows; } };
		return self;
	}

	root.PolycarpFinder = { create: create };
})(typeof globalThis !== "undefined" ? globalThis : this);

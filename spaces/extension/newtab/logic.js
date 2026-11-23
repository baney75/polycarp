// What the new tab's one field does with what you typed, apart from the page so tests can run it
// (NewTabPageTests loads this file in JavaScriptCore). No DOM and no chrome.* here.
// It mirrors OneSearch in Polycarp (Sources/BaneySpacesCore/OneSearch.swift): the same bangs, the same address rule,
// the same encoding and the same ranking, so the new tab and the launcher answer alike.
(function (root) {
	"use strict";

	var fallbackSearch = "https://duckduckgo.com/?q={query}";
	var limit = 7;
	var sessionFloor = 500;

	// An address someone typed: a scheme, localhost, an IP, or a dotted host with no spaces.
	var withScheme = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
	var local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/\S*)?$/i;
	var ip = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?(\/\S*)?$/;
	var host = /^([a-z0-9-]+\.)+[a-z]{2,63}(:\d{1,5})?(\/\S*)?$/i;

	// Bangs.encode: everything but ASCII letters, digits and - . _ ~ is percent-encoded.
	function encode(s) {
		try {
			return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); });
		} catch (e) {
			return "";
		}
	}

	// Bangs.safeURL: a bang only opens web addresses and Apple Maps.
	function safe(u) { return typeof u === "string" && /^(https?|maps):/i.test(u) ? u : null; }

	// Bangs.parse: "!yt cats" and "cats !yt" both give {trigger: "yt", terms: "cats"}.
	function parse(text) {
		var words = String(text || "").split(/\s+/).filter(Boolean);
		if (!words.length) return null;
		function trigger(w) { return w.length > 1 && w.charAt(0) === "!" ? w.slice(1).toLowerCase() : null; }
		var t = trigger(words[0]);
		if (t) return { trigger: t, terms: words.slice(1).join(" ") };
		if (words.length > 1 && (t = trigger(words[words.length - 1]))) return { trigger: t, terms: words.slice(0, -1).join(" ") };
		return null;
	}

	function find(trigger, list) {
		var t = String(trigger).toLowerCase();
		for (var i = 0; i < list.length; i++) if (list[i] && list[i].trigger === t) return list[i];
		return null;
	}

	// Bang.address: the words in the template, or with none the bang's home (else its site).
	function address(b, terms) {
		var t = String(terms || "").trim();
		if (!t) {
			if (b.home && safe(b.home)) return b.home;
			var bare = b.url.split("{q}").join("");
			var site = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)/i.exec(bare);
			return site ? safe(site[1] + "/") : safe(bare);
		}
		return safe(b.url.split("{q}").join(encode(t)));
	}

	// The launcher's row titles, word for word.
	function title(b, terms) {
		if (!terms) return "Open " + b.name;
		return (b.agent ? "Ask " + b.name + " " : "Search " + b.name + " for ") + "“" + terms + "”";
	}

	// The engine from the host ({name, url with {q}}), or a template with {query}, or DuckDuckGo.
	function engineOf(e) {
		if (e && typeof e === "object" && typeof e.url === "string" && e.url.indexOf("{q}") >= 0 && safe(e.url)) {
			return { name: String(e.name || hostName(e.url)), url: e.url, agent: !!e.agent };
		}
		var t = typeof e === "string" && e.indexOf("{query}") >= 0 && /^https:\/\//.test(e) ? e : fallbackSearch;
		return { name: hostName(t), url: t.split("{query}").join("{q}"), agent: false };
	}

	function hostName(u) {
		var m = /^[a-z]+:\/\/([^\/?#:]+)/i.exec(u);
		var h = m ? m[1] : u;
		return h.indexOf("www.") === 0 ? h.slice(4) : h;
	}

	// Return: what the typed text does with no row picked. {kind: "none"}, or {kind: "open"|"search", url, title}.
	// `engine` is the host's engine or a template; `bangs` the host's list. A bang it doesn't list goes to DuckDuckGo,
	// which knows thousands, so bangs work with no host too.
	function act(typed, engine, bangs) {
		var text = String(typed || "").trim();
		if (!text) return { kind: "none" };
		var list = Array.isArray(bangs) ? bangs : [];
		var p = parse(text);
		if (p) {
			var b = find(p.trigger, list);
			if (b) {
				var u = address(b, p.terms);
				return u ? { kind: "search", url: u, title: title(b, p.terms), agent: !!b.agent } : { kind: "none" };
			}
			var words = ("!" + p.trigger + " " + p.terms).trim();
			return { kind: "search", url: "https://duckduckgo.com/?q=" + encode(words),
				title: "Search with !" + p.trigger + (p.terms ? " for “" + p.terms + "”" : "") };
		}
		if (withScheme.test(text)) {
			// A page may only send itself to the web; file:, chrome: and the rest would fail without a word.
			if (/^https?:/i.test(text)) return { kind: "open", url: text, title: "Open " + text };
		} else if (local.test(text) || ip.test(text)) {
			return { kind: "open", url: "http://" + text, title: "Open " + text };
		} else if (host.test(text)) {
			return { kind: "open", url: "https://" + text, title: "Open " + text };
		}
		var e = engineOf(engine);
		return { kind: "search", url: e.url.split("{q}").join(encode(text)), title: title(e, text), agent: e.agent };
	}

	// Fuzzy.score: higher is better, null is no match. The launcher's matcher, so a row ranks the same in both.
	function fold(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }

	function score(query, name) {
		var q = fold(query);
		if (!q) return 0;
		var n = fold(name);
		var count = Array.from(n).length;
		var words = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
		var initials = words.map(function (w) { return Array.from(w)[0]; }).join("");
		var size = Math.min(count, 99);
		if (n === q) return 1000;
		if (n.indexOf(q) === 0) return 900 - size;
		if (words.some(function (w) { return w.indexOf(q) === 0; })) return 700 - size;
		if (initials.indexOf(q) === 0) return 600 - size;
		if (n.indexOf(q) >= 0) return 500 - size;
		var gaps = 0, from = 0, last = -1;
		for (var i = 0; i < q.length; i++) {
			if (q[i] === " ") continue;
			var at = n.indexOf(q[i], from);
			if (at < 0) return null;
			if (last >= 0) gaps += at - last - 1;
			last = at;
			from = at + 1;
		}
		return Math.max(1, 300 - gaps * 10 - size);
	}

	// Bangs.suggest: triggers that start with what's typed, shortest first, then names that match well.
	function suggest(partial, list, most) {
		var p = String(partial).toLowerCase();
		if (!p) return list.slice(0, most);
		var byTrigger = list.filter(function (b) { return b.trigger.indexOf(p) === 0; })
			.sort(function (a, b) { return a.trigger.length - b.trigger.length; });
		var byName = list.filter(function (b) { var s = score(p, b.name); return b.trigger.indexOf(p) !== 0 && s !== null && s >= 500; });
		return byTrigger.concat(byName).slice(0, most);
	}

	// While the trigger is still being typed ("!", "!yo"): Tab fills one in.
	function completions(typed, bangs, most) {
		var t = String(typed || "").trim();
		if (t.charAt(0) !== "!" || /\s/.test(t) || most <= 0) return [];
		return suggest(t.slice(1), Array.isArray(bangs) ? bangs : [], most);
	}

	// OneSearch.findsSessions: not empty, not a bang, not a "?" question.
	function findsSessions(typed) {
		var t = String(typed || "").trim();
		return !!t && t.charAt(0) !== "!" && t.charAt(0) !== "?" && !parse(t);
	}

	// URLDisplay.short: "github.com/baney75" for a URL, how the session engine names a tab's page.
	function short(url) {
		var m = /^[a-z]+:\/\/([^\/?#:]+)(:\d+)?([^?#]*)/i.exec(String(url || ""));
		if (!m) return String(url || "");
		var h = m[1].indexOf("www.") === 0 ? m[1].slice(4) : m[1];
		var s = h + (m[3] === "/" ? "" : m[3]);
		return Array.from(s).length > 60 ? Array.from(s).slice(0, 59).join("") + "…" : s;
	}

	function best(text, names) {
		var top = null;
		names.forEach(function (n) { if (n) { var s = score(text, n); if (s !== null && (top === null || s > top)) top = s; } });
		return top;
	}

	// The finder's rows, at most `limit`, in order: open tabs and windows that match (this browser's own tabs switch
	// with chrome.tabs; the session engine's rows through Polycarp), then bang completions, then what Return does.
	// ctx: {engine, bangs, sessions: the host's find items, tabs: this browser's tabs {id, windowId, title, url},
	// browser: this browser's bundle ID from the find reply, or null}.
	function rows(typed, ctx) {
		ctx = ctx || {};
		var text = String(typed || "").trim();
		if (!text) return [];
		var max = ctx.limit || limit;
		var last = act(text, ctx.engine, ctx.bangs);
		var room = max - (last.kind === "none" ? 0 : 1);
		var out = [];
		if (findsSessions(text)) {
			var tabs = (Array.isArray(ctx.tabs) ? ctx.tabs : []).filter(function (t) { return t && t.title && /^https?:/i.test(t.url || ""); });
			var used = {};
			var found = [];
			(Array.isArray(ctx.sessions) ? ctx.sessions : []).forEach(function (s, i) {
				var sc = best(text, [s.title, (s.app || "") + " " + s.title, s.detail]);
				if (sc === null || sc < sessionFloor) return;
				var mine = null;
				// A session row is this browser's own tab only when it comes from this browser (ctx.browser, the bundle
				// ID the host reports); a tab with the same title in another browser goes through Polycarp. When the
				// host can't tell which browser it is, the row still goes through Polycarp and the look-alike tab
				// here isn't listed twice.
				var here = !!ctx.browser && s.bundleID === ctx.browser;
				if (s.kind === "tab" && (here || !ctx.browser)) {
					for (var j = 0; j < tabs.length; j++) {
						if (!used[j] && (tabs[j].title === s.title || (s.detail && short(tabs[j].url) === s.detail))) {
							used[j] = true;
							if (here) mine = tabs[j];
							break;
						}
					}
				}
				found.push({ score: sc, order: i, row: { kind: s.kind || "window", title: s.title, detail: s.detail || s.app || "", app: s.app || "",
					id: s.id, workspace: s.workspace || 0, tab: mine ? { id: mine.id, windowId: mine.windowId } : null } });
			});
			tabs.forEach(function (t, j) {
				if (used[j]) return;
				var sc = best(text, [t.title, short(t.url)]);
				if (sc === null || sc < sessionFloor) return;
				found.push({ score: sc, order: 1000 + j, row: { kind: "tab", title: t.title, detail: short(t.url), app: "", id: null, workspace: 0,
					tab: { id: t.id, windowId: t.windowId } } });
			});
			found.sort(function (a, b) { return a.score !== b.score ? b.score - a.score : a.order - b.order; });
			out = found.slice(0, Math.max(0, room)).map(function (f) { return f.row; });
		}
		completions(text, ctx.bangs, room - out.length).forEach(function (b) {
			out.push({ kind: "bang", title: b.name, detail: "!" + b.trigger, trigger: b.trigger, agent: !!b.agent });
		});
		if (last.kind !== "none") out.push({ kind: last.kind, title: last.title, detail: hostName(last.url), url: last.url, agent: !!last.agent });
		return out;
	}

	root.PolycarpNewTab = {
		act: act, rows: rows, parse: parse, encode: encode, score: score, short: short, completions: completions,
		engineOf: engineOf, fallbackSearch: fallbackSearch, limit: limit
	};
})(typeof globalThis !== "undefined" ? globalThis : this);

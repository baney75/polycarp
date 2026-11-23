// The new tab's paper: what lies behind the field and the verse (`paper` in surfaces.json, docs/newtab.md). Polycarp
// sends it in the page reply as {color}, {scene} or {image} (a data: URL it made small). The last one is kept in
// chrome.storage.local and painted first, so a new tab never waits on Polycarp to look right, and nothing comes from
// the network. chrome.storage answers late, after the first frame, so a tiny mark of it (its kind, and its color or
// scene) is also kept in localStorage and painted before that frame: no flash of the page without its paper. Pure parts first, so NewTabPageTests can run them in JavaScriptCore with a stand-in element and storage.
(function (root) {
	"use strict";

	var cacheKey = "polycarpNewTabPaper";
	var markKey = "polycarpNewTabPaperMark";
	// Set once the page reply is painted: the kept paper, answering after it, is older and must not cover it.
	var taken = false;
	var scenes = ["field", "olive", "water", "parchment", "solid"];
	var colorShape = /^#[0-9a-f]{6}$/i;
	// Only a JPEG Polycarp made, as base64: nothing in it can close the CSS url() it goes in.
	var imageShape = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+={0,2}$/;

	// A paper as Polycarp sends it, or null when it is anything else.
	function valid(p) {
		if (!p || typeof p !== "object") return null;
		if (typeof p.color === "string" && colorShape.test(p.color)) return { color: p.color };
		if (typeof p.scene === "string" && scenes.indexOf(p.scene) >= 0) return { scene: p.scene };
		if (typeof p.image === "string" && imageShape.test(p.image)) return { image: p.image };
		return null;
	}

	// Paints `paper` on `el` (the page's #paper layer) and marks `body` so the scrim and the panel show. No paper
	// clears both. Returns what it painted: "color", "scene", "image" or "none".
	function paint(el, body, paper) {
		var p = valid(paper);
		el.style.backgroundColor = "";
		el.style.backgroundImage = "";
		el.setAttribute("data-scene", "");
		var kind = p ? (p.color ? "color" : p.scene ? "scene" : "image") : "none";
		if (p && p.color) el.style.backgroundColor = p.color;
		if (p && p.scene) el.setAttribute("data-scene", p.scene);
		if (p && p.image) el.style.backgroundImage = "url(\"" + p.image + "\")";
		el.setAttribute("data-paper", kind);
		if (body) body.setAttribute("data-paper", kind);
		return kind;
	}

	// The mark kept for `p`: its kind, with its color or scene. A picture is too large for it, so its mark is the kind
	// alone, which still brings the scrim and the panel up from the first frame.
	function mark(p) {
		var v = valid(p);
		if (!v) return null;
		if (v.color) return { kind: "color", color: v.color };
		if (v.scene) return { kind: "scene", scene: v.scene };
		return { kind: "image" };
	}

	function keepMark(marks, p) {
		if (!marks) return;
		try {
			var m = mark(p);
			if (m) marks.setItem(markKey, JSON.stringify(m)); else marks.removeItem(markKey);
		} catch (e) { /* no mark, the kept paper still comes */ }
	}

	// Paints the mark in `marks` (localStorage) at once. Returns what it painted, "none" without a mark.
	function paintMark(el, body, marks) {
		var m = null;
		try { m = marks ? JSON.parse(marks.getItem(markKey) || "null") : null; } catch (e) { m = null; }
		if (m && m.kind === "color") return paint(el, body, { color: m.color });
		if (m && m.kind === "scene") return paint(el, body, { scene: m.scene });
		if (m && m.kind === "image") {
			paint(el, body, null);
			el.setAttribute("data-paper", "image");
			if (body) body.setAttribute("data-paper", "image");
			return "image";
		}
		return "none";
	}

	// Paints the mark now, then the kept paper when storage answers, then calls `done` with what it painted. Once the
	// page reply is taken, the kept paper is older: it is left unpainted and `done` gets "taken".
	function start(el, body, storage, done, marks) {
		var finish = typeof done === "function" ? done : function () {};
		paintMark(el, body, marks);
		try {
			storage.get(cacheKey, function (items) {
				if (taken) return finish("taken");
				var p = items && items[cacheKey];
				keepMark(marks, p);
				finish(paint(el, body, p));
			});
		} catch (e) {
			finish("none");
		}
	}

	// Takes the paper out of a page reply: paints it, keeps it (or forgets the kept one when there is none) and gives
	// back the reply without it, so the page's own cache stays small. A reply that isn't a page leaves the paper alone.
	function take(el, body, storage, reply, marks) {
		if (!reply || !reply.ok) return reply;
		taken = true;
		var p = valid(reply.paper);
		paint(el, body, p);
		keepMark(marks, p);
		try {
			if (p) {
				var items = {};
				items[cacheKey] = p;
				storage.set(items);
			} else {
				storage.remove(cacheKey);
			}
		} catch (e) { /* no cache, still painted */ }
		var rest = {};
		for (var k in reply) if (k !== "paper" && Object.prototype.hasOwnProperty.call(reply, k)) rest[k] = reply[k];
		return rest;
	}

	var api = { cacheKey: cacheKey, markKey: markKey, valid: valid, paint: paint, start: start, take: take };

	// On the page: paint the mark and then the kept paper now, and hand newtab.js `took` for the reply.
	if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
		var el = document.getElementById("paper");
		var marks = null;
		try { marks = root.localStorage || null; } catch (e) { marks = null; }
		if (el) {
			start(el, document.body, chrome.storage.local, null, marks);
			api.took = function (reply) { return take(el, document.body, chrome.storage.local, reply, marks); };
		}
	}
	if (!api.took) api.took = function (reply) { return reply; };

	root.PolycarpPaper = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

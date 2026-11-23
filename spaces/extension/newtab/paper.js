// The new tab's paper: what lies behind the field and the verse (`paper` in surfaces.json, docs/newtab.md). Polycarp
// sends it in the page reply as {color}, {scene} or {image} (a data: URL it made small). The last one is kept in
// chrome.storage.local and painted first, so a new tab never waits on Polycarp to look right, and nothing comes from
// the network. Pure parts first, so NewTabPageTests can run them in JavaScriptCore with a stand-in element and storage.
(function (root) {
	"use strict";

	var cacheKey = "polycarpNewTabPaper";
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

	// Paints the kept paper, then calls `done` with what it painted.
	function start(el, body, storage, done) {
		var finish = typeof done === "function" ? done : function () {};
		try {
			storage.get(cacheKey, function (items) {
				finish(paint(el, body, items && items[cacheKey]));
			});
		} catch (e) {
			finish("none");
		}
	}

	// Takes the paper out of a page reply: paints it, keeps it (or forgets the kept one when there is none) and gives
	// back the reply without it, so the page's own cache stays small. A reply that isn't a page leaves the paper alone.
	function take(el, body, storage, reply) {
		if (!reply || !reply.ok) return reply;
		var p = valid(reply.paper);
		paint(el, body, p);
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

	var api = { cacheKey: cacheKey, valid: valid, paint: paint, start: start, take: take };

	// On the page: paint the kept paper now, and hand newtab.js `took` for the reply.
	if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
		var el = document.getElementById("paper");
		if (el) {
			start(el, document.body, chrome.storage.local);
			api.took = function (reply) { return take(el, document.body, chrome.storage.local, reply); };
		}
	}
	if (!api.took) api.took = function (reply) { return reply; };

	root.PolycarpPaper = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

// What the new tab's one field does with what you typed, apart from the page so tests can run it
// (NewTabPageTests loads this file in JavaScriptCore). No DOM and no chrome.* here.
(function (root) {
	"use strict";

	var fallbackSearch = "https://duckduckgo.com/?q={query}";

	// An address someone typed: a scheme, localhost, an IP, or a dotted host with no spaces.
	var withScheme = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
	var local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/\S*)?$/i;
	var ip = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?(\/\S*)?$/;
	var host = /^([a-z0-9-]+\.)+[a-z]{2,63}(:\d{1,5})?(\/\S*)?$/i;

	// Return: where to go. Cmd or Ctrl with Return: name this workspace with the words.
	// Returns {kind: "none"}, {kind: "open", url}, {kind: "search", url} or {kind: "name", text}.
	function act(typed, template, nameIt) {
		var text = String(typed || "").trim();
		if (!text) return { kind: "none" };
		if (nameIt) return { kind: "name", text: text };
		if (withScheme.test(text)) {
			// A page may only send itself to the web; file:, chrome: and the rest would fail without a word.
			return /^https?:/i.test(text) ? { kind: "open", url: text } : search(text, template);
		}
		if (local.test(text) || ip.test(text)) return { kind: "open", url: "http://" + text };
		if (host.test(text)) return { kind: "open", url: "https://" + text };
		return search(text, template);
	}

	function search(text, template) {
		var t = typeof template === "string" && template.indexOf("{query}") >= 0 && /^https:\/\//.test(template) ? template : fallbackSearch;
		return { kind: "search", url: t.replace("{query}", encodeURIComponent(text)) };
	}

	root.PolycarpNewTab = { act: act, fallbackSearch: fallbackSearch };
})(typeof globalThis !== "undefined" ? globalThis : this);

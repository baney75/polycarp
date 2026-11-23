// The new tab page: one field, the finder under it (finder.js) and the day's verse. It asks Polycarp on this Mac over
// native messaging (com.polycarp.newtab, docs/newtab.md) and paints the last answer first, so the page is never blank
// while it waits.
(function () {
	"use strict";

	var host = "com.polycarp.newtab";
	var cacheKey = "polycarpNewTabPage";
	var hintText = "\u2191 \u2193 to move, Return to open, Tab to fill in a bang, Esc to clear.";

	var field = document.getElementById("field");
	var form = document.getElementById("ask");
	var hint = document.getElementById("hint");
	var verse = document.getElementById("verse");
	var page = { question: field.placeholder, searchURL: PolycarpNewTab.fallbackSearch, engine: null, bangs: [], verse: null };

	function ask(message) {
		return new Promise(function (resolve) {
			try {
				chrome.runtime.sendNativeMessage(host, message, function (reply) {
					resolve(chrome.runtime.lastError || !reply ? null : reply);
				});
			} catch (e) {
				resolve(null);
			}
		});
	}

	function say(text) {
		hint.textContent = text;
		hint.className = "hint" + (text ? " on" : "");
	}

	function render(p) {
		if (!p || !p.ok) return;
		page = p;
		if (typeof p.question === "string" && p.question) {
			field.placeholder = p.question;
			document.querySelector("label[for=field]").textContent = p.question;
		}
		if (p.verse && p.verse.text) {
			document.getElementById("verse-text").textContent = "“" + p.verse.text + "”";
			document.getElementById("verse-ref").textContent = p.verse.ref + " · BSB";
			verse.hidden = false;
		} else {
			verse.hidden = true;
		}
	}

	try { render(JSON.parse(localStorage.getItem(cacheKey) || "null")); } catch (e) { /* a private window: no cache */ }

	ask({ op: "page" }).then(function (p) {
		if (!p || !p.ok) return;
		p = PolycarpPaper.took(p);
		render(p);
		try { localStorage.setItem(cacheKey, JSON.stringify(p)); } catch (e) { /* no cache, still fine */ }
	});

	var finder = PolycarpFinder.create({ field: field, list: document.getElementById("finder"), ask: ask, say: say,
		page: function () { return page; } });

	field.addEventListener("input", function () {
		say(field.value.trim() ? hintText : "");
		finder.update();
	});

	field.addEventListener("keydown", function (e) {
		if (!finder.keydown(e)) return;
		e.preventDefault();
		if (!field.value.trim()) say("");
	});
	form.addEventListener("submit", function (e) {
		e.preventDefault();
		finder.open();
	});
})();

// The new tab page: one field and the day's verse. It asks Polycarp on this Mac over native messaging
// (com.polycarp.newtab, docs/newtab.md) and paints the last answer first, so the page is never blank while it waits.
(function () {
	"use strict";

	var host = "com.polycarp.newtab";
	var cacheKey = "polycarpNewTabPage";
	var hintText = "Return to search or open the address.";

	var field = document.getElementById("field");
	var form = document.getElementById("ask");
	var hint = document.getElementById("hint");
	var verse = document.getElementById("verse");
	var page = { question: field.placeholder, searchURL: PolycarpNewTab.fallbackSearch, verse: null };

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
		render(p);
		try { localStorage.setItem(cacheKey, JSON.stringify(p)); } catch (e) { /* no cache, still fine */ }
	});

	field.addEventListener("input", function () {
		say(field.value.trim() ? hintText : "");
	});

	function go() {
		var a = PolycarpNewTab.act(field.value, page.searchURL);
		if (a.kind === "none") return;
		location.assign(a.url);
	}

	field.addEventListener("keydown", function (e) {
		if (e.key !== "Enter" || e.isComposing) return;
		e.preventDefault();
		go();
	});
	form.addEventListener("submit", function (e) {
		e.preventDefault();
		go();
	});
})();

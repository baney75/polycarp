// The new tab page: one field and the day's verse. It asks Polycarp on this Mac over native messaging
// (com.polycarp.newtab, docs/newtab.md) and paints the last answer first, so the page is never blank while it waits.
(function () {
	"use strict";

	var host = "com.polycarp.newtab";
	var cacheKey = "polycarpNewTabPage";
	var mac = /Mac/i.test(navigator.platform || navigator.userAgent);
	var keyName = mac ? "⌘Return" : "Ctrl+Return";
	var hintText = "Return to search. " + keyName + " names this hour.";

	var field = document.getElementById("field");
	var form = document.getElementById("ask");
	var hint = document.getElementById("hint");
	var chips = document.getElementById("chips");
	var verse = document.getElementById("verse");
	var page = { question: field.placeholder, searchURL: PolycarpNewTab.fallbackSearch, verse: null, chips: [], workspace: null };

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

	function say(text, kind) {
		hint.textContent = text;
		hint.className = "hint" + (text ? " on" : "") + (kind ? " " + kind : "");
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
		chips.textContent = "";
		(p.chips || []).forEach(function (c) {
			var b = document.createElement("button");
			b.type = "button";
			b.textContent = c.purpose;
			b.title = "Workspace " + c.workspace;
			if (c.workspace === p.workspace) b.setAttribute("aria-current", "true");
			b.addEventListener("click", function () {
				ask({ op: "go", workspace: c.workspace }).then(function (r) {
					if (!r || !r.ok) say(r && r.error ? r.error : "Polycarp isn't answering.", "error");
				});
			});
			chips.appendChild(b);
		});
		chips.hidden = chips.childElementCount === 0;
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

	function go(nameIt) {
		var a = PolycarpNewTab.act(field.value, page.searchURL, nameIt);
		if (a.kind === "none") return;
		if (a.kind === "name") {
			ask({ op: "name", text: a.text }).then(function (r) {
				if (r && r.ok) {
					field.value = "";
					say("Workspace " + r.workspace + " is for " + r.purpose + ".", "done");
				} else {
					say(r && r.error ? r.error : "Polycarp isn't answering, so nothing was named.", "error");
				}
			});
			return;
		}
		location.assign(a.url);
	}

	field.addEventListener("keydown", function (e) {
		if (e.key !== "Enter" || e.isComposing) return;
		e.preventDefault();
		go(e.metaKey || e.ctrlKey);
	});
	form.addEventListener("submit", function (e) {
		e.preventDefault();
		go(false);
	});
})();

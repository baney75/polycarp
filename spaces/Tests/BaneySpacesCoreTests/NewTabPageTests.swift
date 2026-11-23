import BaneySpacesCore
import CryptoKit
import JavaScriptCore
import XCTest

/// The new tab page's own files (extension/newtab, inside the Polycarp extension): the field logic run as the page runs
/// it, and the manifest the host trusts.
final class NewTabPageTests: XCTestCase {
    private func logic() throws -> JSContext {
        let ctx = try XCTUnwrap(JSContext())
        ctx.exceptionHandler = { _, e in XCTFail("logic.js threw: \(e?.toString() ?? "?")") }
        ctx.evaluateScript(try Repo.text("extension/newtab/logic.js"))
        return ctx
    }

    private func act(_ ctx: JSContext, _ typed: String, template: String = "https://duckduckgo.com/?q={query}",
                     cmd: Bool = false) -> (kind: String, value: String) {
        let r = ctx.objectForKeyedSubscript("PolycarpNewTab").objectForKeyedSubscript("act")
            .call(withArguments: [typed, template, cmd])!
        let kind = r.objectForKeyedSubscript("kind").toString() ?? ""
        let value = r.objectForKeyedSubscript("url")
        return (kind, value?.isUndefined == false ? value!.toString() : "")
    }

    func testReturnOpensAnAddressAndSearchesEverythingElse() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "  ").kind, "none")
        XCTAssertEqual(act(ctx, "https://dbaney.com/polycarp").value, "https://dbaney.com/polycarp")
        XCTAssertEqual(act(ctx, "dbaney.com").value, "https://dbaney.com")
        XCTAssertEqual(act(ctx, "github.com/baney75/polycarp").value, "https://github.com/baney75/polycarp")
        XCTAssertEqual(act(ctx, "localhost:3000/x").value, "http://localhost:3000/x")
        XCTAssertEqual(act(ctx, "192.168.1.4:8080").value, "http://192.168.1.4:8080")
        let s = act(ctx, "purity of heart")
        XCTAssertEqual(s.kind, "search")
        XCTAssertEqual(s.value, "https://duckduckgo.com/?q=purity%20of%20heart")
        XCTAssertEqual(act(ctx, "Psalm 118:24").kind, "search", "a verse reference is words, not a host")
        XCTAssertEqual(act(ctx, "e.g. lilies").kind, "search", "words with spaces are never an address")
    }

    func testOnlyAWebAddressIsOpened() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "javascript:alert(1)").kind, "search")
        XCTAssertEqual(act(ctx, "data:text/html,hi").kind, "search")
        XCTAssertEqual(act(ctx, "ftp://example.com").kind, "search")
        XCTAssertEqual(act(ctx, "chrome://settings").kind, "search", "a page can't open browser pages")
        XCTAssertEqual(act(ctx, "file:///Users/me/notes.pdf").kind, "search", "nor files")
    }

    func testTheSearchUsesTheConfiguredTemplateOrFallsBack() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "a&b", template: "https://search.brave.com/search?q={query}&source=web").value,
                       "https://search.brave.com/search?q=a%26b&source=web")
        XCTAssertEqual(act(ctx, "x", template: "http://evil.example/?q={query}").value, "https://duckduckgo.com/?q=x",
                       "only an https template with {query}")
        XCTAssertEqual(act(ctx, "x", template: "https://no-slot.example/").value, "https://duckduckgo.com/?q=x")
    }

    /// 2026-11-22: the page never asks what the hour is for. Cmd+Return names nothing; it opens or searches like Return,
    /// and the page has no question, no naming and no workspace chips.
    func testThePageNeverAsksWhatTheHourIsFor() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "Gannon letter", cmd: true).kind, "search")
        XCTAssertEqual(act(ctx, "dbaney.com", cmd: true).kind, "open")
        for file in ["newtab/newtab.html", "newtab/newtab.js", "newtab/logic.js", "newtab/finder.js", "manifest.json"] {
            let text = try Repo.text("extension/\(file)").lowercased()
            for word in ["this hour", "is for", "purpose", "chips", "op: \"name\"", "op: \"go\"", "one " + "thing"] {
                XCTAssertFalse(text.contains(word), "\(file) still says \(word)")
            }
        }
    }

    // MARK: One search: the page does what the launcher does

    /// The host's `page` reply as the page gets it.
    private func page(_ s: Surfaces = .defaults, bangs: [Bang] = Bangs.builtIn) -> String {
        String(decoding: NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: .init(surfaces: { s }, bangs: { bangs })), as: UTF8.self)
    }

    /// `PolycarpNewTab.act` with the page reply's engine and bangs, as newtab.js calls it.
    private func act(_ ctx: JSContext, _ typed: String, page: String) -> [String: Any] {
        ctx.setObject(typed, forKeyedSubscript: "typed" as NSString)
        ctx.setObject(page, forKeyedSubscript: "pageText" as NSString)
        let r = ctx.evaluateScript("(function () { var p = JSON.parse(pageText); return PolycarpNewTab.act(typed, p.engine, p.bangs); })()")
        return r?.toDictionary() as? [String: Any] ?? [:]
    }

    func testABangOnTheNewTabGoesWhereTheLauncherSendsIt() throws {
        let ctx = try logic()
        let p = page()
        XCTAssertEqual(act(ctx, "!yt cats", page: p)["url"] as? String, "https://www.youtube.com/results?search_query=cats")
        XCTAssertEqual(act(ctx, "cats !yt", page: p)["url"] as? String, "https://www.youtube.com/results?search_query=cats")
        XCTAssertEqual(act(ctx, "!w Erie", page: p)["url"] as? String, "https://en.wikipedia.org/wiki/Special:Search?search=Erie")
        XCTAssertEqual(act(ctx, "!gh", page: p)["url"] as? String, "https://github.com/", "a bang with no words opens the site")
        XCTAssertEqual(act(ctx, "!zzz words", page: p)["url"] as? String, "https://duckduckgo.com/?q=%21zzz%20words",
                       "a bang it doesn't list goes to DuckDuckGo")
        // A bang of your own from bangs.json comes through the reply too.
        let mine = page(bangs: Bangs.all(custom: [Bang(trigger: "jira", name: "Jira", url: "https://acme.example/browse/{q}")]))
        XCTAssertEqual(act(ctx, "!jira PC-12", page: mine)["url"] as? String, "https://acme.example/browse/PC-12")
    }

    func testAnAgentBangAsksTheQuestionInANewChat() throws {
        let ctx = try logic()
        let r = act(ctx, "!claude why is the sky blue", page: page())
        XCTAssertEqual(r["url"] as? String, "https://claude.ai/new?q=why%20is%20the%20sky%20blue")
        XCTAssertEqual(r["agent"] as? Bool, true)
        XCTAssertEqual(r["title"] as? String, "Ask Claude \u{201C}why is the sky blue\u{201D}")
        XCTAssertEqual(act(ctx, "!chatgpt", page: page())["url"] as? String, "https://chatgpt.com/", "no words opens the agent's home")
    }

    func testTheEngineSettingIsWhereAPlainSearchGoes() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "purity of heart", page: page())["url"] as? String, "https://www.google.com/search?q=purity%20of%20heart",
                       "Google until chosen, as in the launcher")
        var s = Surfaces.defaults
        s.search.engine = "kagi"
        XCTAssertEqual(act(ctx, "a&b", page: page(s))["url"] as? String, "https://kagi.com/search?q=a%26b")
        XCTAssertEqual(act(ctx, "a&b", page: page(s))["title"] as? String, "Search Kagi for \u{201C}a&b\u{201D}")
        s.search.engine = "https://search.brave.com/search?q={query}&source=web"
        XCTAssertEqual(act(ctx, "x y", page: page(s))["url"] as? String, "https://search.brave.com/search?q=x%20y&source=web")
        // A file that sets only newtab.searchURL keeps searching there: the host resolves it, the page follows.
        guard case .success(let legacy) = Surfaces.check(try SurfaceValue.parse(Data(#"{"newtab":{"searchURL":"https://duckduckgo.com/?q={query}"}}"#.utf8)).get()) else {
            return XCTFail("the legacy file should check")
        }
        XCTAssertEqual(act(ctx, "lilies", page: page(legacy.surfaces))["url"] as? String, "https://duckduckgo.com/?q=lilies")
    }

    /// The page's copy (logic.js) and OneSearch answer every input alike: same address, same title.
    func testThePageAndTheLauncherAgreeOnEveryInput() throws {
        let ctx = try logic()
        let p = page()
        let bangs = Bangs.builtIn
        let engine = OneSearch.engine(Surfaces.defaults.search.engine, bangs: bangs)
        for typed in ["!yt cats", "cats !yt", "!claude why is the sky blue", "!zzz words", "!gh", "!maps Erie PA", "!am Erie",
                      "a&b (c)! it's *", "Caf\u{00E9} cr\u{00E8}me", "dbaney.com", "localhost:3000", "192.168.1.4:8080",
                      "https://dbaney.com/x", "ftp://example.com", "Psalm 118:24", "100% sure #1", "!brave pine"] {
            let swift = try XCTUnwrap(OneSearch.action(typed, engine: engine, bangs: bangs), typed)
            let js = act(ctx, typed, page: p)
            XCTAssertEqual(js["url"] as? String, swift.url, typed)
            XCTAssertEqual(js["title"] as? String, swift.title, typed)
            XCTAssertEqual(js["kind"] as? String, swift.kind, typed)
        }
    }

    /// The finder's rows: open tabs and windows first (this browser's own tab switches with chrome.tabs), then bang
    /// completions, then the search, at most seven; the same order and titles as `polycarp-spaces search`.
    func testTheFinderListsTabsThenBangsThenTheSearch() throws {
        let ctx = try logic()
        let sessions = """
        [{"id":"tab:com.example.browser:1:2","kind":"tab","title":"Inbox - Gmail","detail":"mail.google.com/mail/u/0","app":"Browser"},
         {"id":"win:5","kind":"window","title":"Notes about Gmail","app":"Notes","workspace":3}]
        """
        let tabs = #"[{"id":9,"windowId":1,"title":"Inbox - Gmail","url":"https://mail.google.com/mail/u/0"},{"id":10,"windowId":1,"title":"Support for Gmail users","url":"https://support.google.com/mail"}]"#
        ctx.setObject(page(), forKeyedSubscript: "pageText" as NSString)
        func rows(_ typed: String, withTabs: Bool = true) -> [[String: Any]] {
            ctx.setObject(typed, forKeyedSubscript: "typed" as NSString)
            let r = ctx.evaluateScript("""
                (function () { var p = JSON.parse(pageText);
                  return PolycarpNewTab.rows(typed, {engine: p.engine, bangs: p.bangs, sessions: \(sessions), tabs: \(withTabs ? tabs : "[]")}); })()
                """)
            return r?.toArray() as? [[String: Any]] ?? []
        }
        let g = rows("gmail")
        XCTAssertEqual(g.map { $0["kind"] as? String }, ["tab", "window", "tab", "search"])
        XCTAssertEqual((g[0]["tab"] as? [String: Any])?["id"] as? Int, 9, "the session engine's tab is this browser's tab: chrome.tabs switches")
        XCTAssertEqual(g[0]["id"] as? String, "tab:com.example.browser:1:2")
        XCTAssertNil(g[1]["tab"] as? [String: Any], "a window in another app goes through Polycarp")
        XCTAssertEqual(g[2]["title"] as? String, "Support for Gmail users", "a tab only this browser has still shows")
        XCTAssertEqual(g[3]["title"] as? String, "Search Google for \u{201C}gmail\u{201D}")
        let y = rows("!y")
        XCTAssertEqual(y.first?["kind"] as? String, "bang")
        XCTAssertEqual(y.first?["trigger"] as? String, "yt")
        XCTAssertLessThanOrEqual(y.count, 7)
        XCTAssertEqual(rows("!yt cats").map { $0["kind"] as? String }, ["search"], "a bang finds no tabs")
        XCTAssertEqual(rows("").count, 0)
        // Without this browser's tabs, the order and titles are what `polycarp-spaces search` prints.
        var notes = Item(id: "win:5", bundleID: "com.apple.Notes", appName: "Notes", role: .other, kind: .window, group: "n", title: "Notes about Gmail")
        notes.workspace = 3
        let items = [Item(id: "tab:com.example.browser:1:2", bundleID: "com.example.browser", appName: "Browser", role: .browser, kind: .tab,
                          group: "g", title: "Inbox - Gmail", detail: "mail.google.com/mail/u/0"), notes]
        let engine = OneSearch.engine("g", bangs: Bangs.builtIn)
        for typed in ["gmail", "!y", "inbox", "notes", "!yt cats", "dbaney.com"] {
            let swift = OneSearch.results(typed, items: items, engine: engine, bangs: Bangs.builtIn)
            let js = rows(typed, withTabs: false)
            XCTAssertEqual(js.map { $0["title"] as? String }, swift.map(\.title), typed)
            XCTAssertEqual(js.map { $0["kind"] as? String }, swift.map(\.kind), typed)
        }
    }

    func testTheFinderIsItsOwnElementWithTheKeys() throws {
        let html = try Repo.text("extension/newtab/newtab.html")
        XCTAssertTrue(html.contains(#"<ul id="finder""#) && html.contains(#"aria-controls="finder""#))
        XCTAssertTrue(html.contains(#"<script src="finder.js"></script>"#))
        let finder = try Repo.text("extension/newtab/finder.js")
        for key in [#""ArrowDown""#, #""ArrowUp""#, #"e.key === "n""#, #"e.key === "p""#, #""Enter""#, #""Tab""#, #""Escape""#,
                    #"op: "find""#, #"op: "focus""#, "chrome.tabs.update", "chrome.tabs.query"] {
            XCTAssertTrue(finder.contains(key), "finder.js lacks \(key)")
        }
    }

    /// Chrome derives an unpacked extension's ID from its manifest key; the host's manifest allows only that ID. If the
    /// key and `NewTabHost.extensionID` ever part, the page can't reach Polycarp.
    func testTheManifestKeyGivesTheIDTheHostAllows() throws {
        let data = try XCTUnwrap(Repo.text("extension/manifest.json").data(using: .utf8))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let key = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(manifest["key"] as? String)))
        let hex = SHA256.hash(data: key).prefix(16).map { String(format: "%02x", $0) }.joined()
        let letters = Array("abcdefghijklmnop")
        let id = String(hex.map { letters[Int(String($0), radix: 16)!] })
        XCTAssertEqual(id, NewTabHost.extensionID)
        XCTAssertEqual((manifest["chrome_url_overrides"] as? [String: String])?["newtab"], "newtab/newtab.html")
        XCTAssertTrue((manifest["permissions"] as? [String] ?? []).contains("nativeMessaging"), "the page talks to Polycarp")
    }

    func testThePageLoadsNothingFromTheNetwork() throws {
        for file in ["newtab.html", "newtab.css", "newtab.js", "logic.js", "finder.js"] {
            let text = try Repo.text("extension/newtab/\(file)")
            for line in text.split(separator: "\n") where line.contains("http://") || line.contains("https://") {
                let s = String(line)
                // logic.js names URL shapes and the fallback search; nothing is fetched from them.
                XCTAssertTrue(file == "logic.js", "\(file): \(s)")
            }
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "\(file): no dashes")
        }
    }
}

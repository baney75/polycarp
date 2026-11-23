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
        [{"id":"tab:com.example.browser:1:2","kind":"tab","title":"Inbox - Gmail","detail":"mail.google.com/mail/u/0","app":"Browser","bundleID":"com.example.browser"},
         {"id":"win:5","kind":"window","title":"Notes about Gmail","app":"Notes","workspace":3}]
        """
        let tabs = #"[{"id":9,"windowId":1,"title":"Inbox - Gmail","url":"https://mail.google.com/mail/u/0"},{"id":10,"windowId":1,"title":"Support for Gmail users","url":"https://support.google.com/mail"}]"#
        ctx.setObject(page(), forKeyedSubscript: "pageText" as NSString)
        func rows(_ typed: String, withTabs: Bool = true, browser: String? = "com.example.browser") -> [[String: Any]] {
            ctx.setObject(typed, forKeyedSubscript: "typed" as NSString)
            let b = browser.map { "\"\($0)\"" } ?? "null"
            let r = ctx.evaluateScript("""
                (function () { var p = JSON.parse(pageText);
                  return PolycarpNewTab.rows(typed, {engine: p.engine, bangs: p.bangs, sessions: \(sessions), tabs: \(withTabs ? tabs : "[]"), browser: \(b)}); })()
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
        // The same title in another browser: that browser's row goes through Polycarp, and this browser's tab is its
        // own row, so both can be reached.
        let other = rows("gmail", browser: "com.other.browser")
        XCTAssertEqual(other.map { $0["kind"] as? String }, ["tab", "tab", "window", "tab", "search"])
        XCTAssertNil(other[0]["tab"] as? [String: Any], "a row from another browser never switches a tab here")
        XCTAssertEqual(other[0]["id"] as? String, "tab:com.example.browser:1:2")
        XCTAssertEqual((other[1]["tab"] as? [String: Any])?["id"] as? Int, 9, "this browser's own Inbox tab, listed as well")
        XCTAssertNil(other[1]["id"] as? String)
        // A host that can't tell the browser: the row goes through Polycarp, and its look-alike isn't listed twice.
        let unknown = rows("gmail", browser: nil)
        XCTAssertEqual(unknown.map { $0["kind"] as? String }, ["tab", "window", "tab", "search"])
        XCTAssertNil(unknown[0]["tab"] as? [String: Any])
        XCTAssertEqual(unknown[2]["title"] as? String, "Support for Gmail users")
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

    // MARK: Paper (paper.js)

    /// paper.js in JavaScriptCore, with a stand-in for the #paper layer, the body and chrome.storage.local.
    private func paperPage() throws -> JSContext {
        let ctx = try XCTUnwrap(JSContext())
        ctx.exceptionHandler = { _, e in XCTFail("paper.js threw: \(e?.toString() ?? "?")") }
        ctx.evaluateScript("""
            function element() {
                var attrs = {};
                return { style: { backgroundColor: "", backgroundImage: "" }, attrs: attrs,
                         setAttribute: function (k, v) { attrs[k] = String(v); }, getAttribute: function (k) { return attrs[k]; } };
            }
            var layer = element(), body = element();
            var stored = {}, writes = 0, removes = 0;
            var storage = {
                get: function (key, cb) { var o = {}; if (key in stored) o[key] = stored[key]; cb(o); },
                set: function (items) { writes++; for (var k in items) stored[k] = items[k]; },
                remove: function (key) { removes++; delete stored[key]; }
            };
            // chrome.storage answers after the first frame; `late` holds its answer until the test lets it go.
            var held = null;
            var late = {
                get: function (key, cb) { held = function () { var o = {}; if (key in stored) o[key] = stored[key]; cb(o); }; },
                set: storage.set, remove: storage.remove
            };
            var marked = {};
            var marks = {
                getItem: function (k) { return k in marked ? marked[k] : null; },
                setItem: function (k, v) { marked[k] = String(v); },
                removeItem: function (k) { delete marked[k]; }
            };
            """)
        ctx.evaluateScript(try Repo.text("extension/newtab/paper.js"))
        return ctx
    }

    @discardableResult private func js(_ ctx: JSContext, _ code: String) -> String { ctx.evaluateScript(code)?.toString() ?? "" }

    func testTheKeptPaperIsPaintedFirstWithoutAskingPolycarp() throws {
        let ctx = try paperPage()
        let key = js(ctx, "PolycarpPaper.cacheKey")
        XCTAssertEqual(key, "polycarpNewTabPaper")
        js(ctx, ##"stored[PolycarpPaper.cacheKey] = {color: "#112233"}; var got; PolycarpPaper.start(layer, body, storage, function (k) { got = k; });"##)
        XCTAssertEqual(js(ctx, "got"), "color")
        XCTAssertEqual(js(ctx, "layer.style.backgroundColor"), "#112233")
        XCTAssertEqual(js(ctx, "body.getAttribute('data-paper')"), "color", "the body is marked, so the scrim and panel show")

        let image = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        js(ctx, "stored[PolycarpPaper.cacheKey] = {image: \"\(image)\"}; PolycarpPaper.start(layer, body, storage, function (k) { got = k; });")
        XCTAssertEqual(js(ctx, "got"), "image")
        XCTAssertEqual(js(ctx, "layer.style.backgroundImage"), "url(\"\(image)\")")
        XCTAssertEqual(js(ctx, "layer.style.backgroundColor"), "", "the color before it is cleared")

        js(ctx, #"stored[PolycarpPaper.cacheKey] = {scene: "olive"}; PolycarpPaper.start(layer, body, storage, function (k) { got = k; });"#)
        XCTAssertEqual(js(ctx, "layer.getAttribute('data-scene')"), "olive")
        XCTAssertEqual(js(ctx, "layer.style.backgroundImage"), "")

        js(ctx, "delete stored[PolycarpPaper.cacheKey]; PolycarpPaper.start(layer, body, storage, function (k) { got = k; });")
        XCTAssertEqual(js(ctx, "got"), "none", "nothing kept, nothing painted: the page as before paper")
        XCTAssertEqual(js(ctx, "layer.getAttribute('data-paper')"), "none")
    }

    func testOnlyAPaperPolycarpCouldSendIsPainted() throws {
        let ctx = try paperPage()
        for bad in [#"{color: "red"}"#, ##"{color: "#11223344"}"##, #"{scene: "beach"}"#, #"{image: "https://example.com/a.jpg"}"#,
                    #"{image: 'data:image/jpeg;base64,AA") , url("https://example.com/x'}"#, #"{image: "data:image/svg+xml;base64,AAAA"}"#,
                    "null", "42"] {
            XCTAssertEqual(js(ctx, "PolycarpPaper.paint(layer, body, \(bad))"), "none", bad)
            XCTAssertEqual(js(ctx, "layer.style.backgroundImage"), "", bad)
        }
    }

    func testThePageReplyIsPaintedKeptAndLeftOutOfThePagesOwnCache() throws {
        let ctx = try paperPage()
        js(ctx, ##"var rest = PolycarpPaper.take(layer, body, storage, {ok: true, question: "Q", paper: {color: "#445566"}});"##)
        XCTAssertEqual(js(ctx, "layer.style.backgroundColor"), "#445566")
        XCTAssertEqual(js(ctx, "stored[PolycarpPaper.cacheKey].color"), "#445566")
        XCTAssertEqual(js(ctx, "'paper' in rest"), "false")
        XCTAssertEqual(js(ctx, "rest.question"), "Q")
        js(ctx, #"PolycarpPaper.take(layer, body, storage, {ok: true, question: "Q"});"#)
        XCTAssertEqual(js(ctx, "PolycarpPaper.cacheKey in stored"), "false", "no paper in the reply forgets the kept one")
        XCTAssertEqual(js(ctx, "layer.getAttribute('data-paper')"), "none")
        js(ctx, #"var w = writes, r = removes; PolycarpPaper.take(layer, body, storage, {ok: false});"#)
        XCTAssertEqual(js(ctx, "writes === w && removes === r"), "true", "a failed reply leaves the paper alone")
        XCTAssertEqual(js(ctx, "typeof PolycarpPaper.took"), "function")
    }

    func testAKeptPaperAnsweringLateNeverCoversThePageReply() throws {
        let ctx = try paperPage()
        js(ctx, ##"stored[PolycarpPaper.cacheKey] = {color: "#112233"}; var got; PolycarpPaper.start(layer, body, late, function (k) { got = k; });"##)
        js(ctx, ##"PolycarpPaper.take(layer, body, late, {ok: true, paper: {color: "#445566"}});"##)
        js(ctx, "held();")
        XCTAssertEqual(js(ctx, "layer.style.backgroundColor"), "#445566", "the reply is newer than the kept paper")
        XCTAssertEqual(js(ctx, "got"), "taken")
        XCTAssertEqual(js(ctx, "stored[PolycarpPaper.cacheKey].color"), "#445566")
    }

    func testTheMarkPaintsBeforeStorageAnswers() throws {
        let ctx = try paperPage()
        XCTAssertEqual(js(ctx, "PolycarpPaper.markKey"), "polycarpNewTabPaperMark")
        // The reply keeps a mark of its paper.
        js(ctx, ##"PolycarpPaper.take(layer, body, storage, {ok: true, paper: {color: "#445566"}}, marks);"##)
        XCTAssertEqual(js(ctx, "JSON.parse(marked[PolycarpPaper.markKey]).color"), "#445566")
        XCTAssertEqual(js(ctx, "JSON.parse(marked[PolycarpPaper.markKey]).kind"), "color")

        // A new page: the mark is painted before storage has answered at all.
        let next = try paperPage()
        js(next, ##"marked[PolycarpPaper.markKey] = JSON.stringify({kind: "color", color: "#445566"}); stored[PolycarpPaper.cacheKey] = {color: "#445566"};"##)
        js(next, "PolycarpPaper.start(layer, body, late, null, marks);")
        XCTAssertEqual(js(next, "layer.style.backgroundColor"), "#445566", "painted at once, no frame without it")
        XCTAssertEqual(js(next, "body.getAttribute('data-paper')"), "color")

        js(next, ##"marked[PolycarpPaper.markKey] = JSON.stringify({kind: "scene", scene: "olive"}); PolycarpPaper.start(layer, body, late, null, marks);"##)
        XCTAssertEqual(js(next, "layer.getAttribute('data-scene')"), "olive")

        // A picture's mark is its kind alone; the picture follows from storage.
        let image = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        js(next, "stored[PolycarpPaper.cacheKey] = {image: \"\(image)\"}; PolycarpPaper.take(layer, body, storage, {ok: true, paper: {image: \"\(image)\"}}, marks);")
        XCTAssertEqual(js(next, "marked[PolycarpPaper.markKey]"), #"{"kind":"image"}"#, "no picture in localStorage")
        let third = try paperPage()
        js(third, ##"marked[PolycarpPaper.markKey] = '{"kind":"image"}'; stored[PolycarpPaper.cacheKey] = {image: "\##(image)"};"##)
        js(third, "PolycarpPaper.start(layer, body, late, null, marks);")
        XCTAssertEqual(js(third, "body.getAttribute('data-paper')"), "image", "the scrim and panel are up from the first frame")
        XCTAssertEqual(js(third, "layer.style.backgroundImage"), "")
        js(third, "held();")
        XCTAssertEqual(js(third, "layer.style.backgroundImage"), "url(\"\(image)\")")

        // A mark that isn't one paints nothing, and no paper forgets the mark.
        for bad in [#"'{"kind":"color","color":"red"}'"#, #"'{"kind":"scene","scene":"beach"}'"#, "'not json'"] {
            let page = try paperPage()
            // As newtab.html starts it.
            js(page, "layer.setAttribute('data-paper', 'none'); marked[PolycarpPaper.markKey] = \(bad); PolycarpPaper.start(layer, body, late, null, marks);")
            XCTAssertEqual(js(page, "layer.getAttribute('data-paper')"), "none", bad)
        }
        js(ctx, #"PolycarpPaper.take(layer, body, storage, {ok: true}, marks);"#)
        XCTAssertEqual(js(ctx, "PolycarpPaper.markKey in marked"), "false")
    }

    func testThePageLoadsNothingFromTheNetwork() throws {
        for file in ["newtab.html", "newtab.css", "newtab.js", "logic.js", "finder.js", "paper.js"] {
            let text = try Repo.text("extension/newtab/\(file)")
            for line in text.split(separator: "\n") where line.contains("http://") || line.contains("https://") {
                let s = String(line)
                // logic.js names URL shapes and the fallback search; nothing is fetched from them.
                XCTAssertTrue(file == "logic.js", "\(file): \(s)")
            }
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "\(file): no dashes")
        }
    }

    // MARK: The finder driven: create(), keys and late replies

    /// logic.js and finder.js over a stand-in page: a field and a list with just the DOM finder.js touches, timers run
    /// by hand (`runTimers()`), `ask` that answers only when the test says (`answer(i, reply)`), and `location.assign`
    /// recorded. `chromeStub` defines `chrome` when the test needs this browser's tabs.
    private func finder(chromeStub: String = "") throws -> JSContext {
        let ctx = try logic()
        ctx.exceptionHandler = { _, e in XCTFail("JS threw: \(e?.toString() ?? "?")") }
        ctx.setObject(page(), forKeyedSubscript: "pageText" as NSString)
        ctx.evaluateScript("""
            var timers = [];
            function setTimeout(f) { timers.push(f); return timers.length; }
            function clearTimeout(id) { if (id) timers[id - 1] = null; }
            function runTimers() { var t = timers; timers = []; t.forEach(function (f) { if (f) f(); }); }
            function el() {
              var e = { children: [], hidden: false, attrs: {}, value: "", text: "", className: "", on: false,
                setAttribute: function (k, v) { e.attrs[k] = v; }, removeAttribute: function (k) { delete e.attrs[k]; },
                appendChild: function (c) { e.children.push(c); }, addEventListener: function () {} };
              e.classList = { toggle: function (c, v) { e.on = !!v; } };
              Object.defineProperty(e, "textContent", { get: function () { return e.text; },
                set: function (v) { e.text = v; if (v === "") e.children = []; } });
              return e;
            }
            var document = { createElement: function () { return el(); } };
            var assigned = [];
            var location = { assign: function (u) { assigned.push(u); } };
            var asks = [], answers = [], said = [];
            function ask(m) { asks.push(m); return new Promise(function (r) { answers.push(r); }); }
            function answer(i, reply) { answers[i](reply); }
            var field = el(), list = el();
            var pageAnswer = JSON.parse(pageText);
            \(chromeStub)
            """)
        ctx.evaluateScript(try Repo.text("extension/newtab/finder.js"))
        ctx.evaluateScript("""
            var finder = PolycarpFinder.create({ field: field, list: list, ask: ask, say: function (t) { said.push(t); },
              page: function () { return pageAnswer; } });
            function type(text) { field.value = text; finder.update(); }
            function key(k) { return finder.keydown({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }); }
            function chosen() { return finder.rows().map(function (r, i) { return list.children[i] && list.children[i].on ? r.kind : null; })
              .filter(function (k) { return k; }); }
            """)
        return ctx
    }

    @discardableResult
    private func js(_ ctx: JSContext, _ script: String) -> JSValue? { ctx.evaluateScript(script) }

    /// Typing fast and pressing Return after the find reply lands opens the top row (the open tab), not the search row
    /// that was first before the reply (review second-F6).
    func testReturnOpensTheTopRowWhenTheFindReplyLandsLate() throws {
        let ctx = try finder()
        let reply = #"{"ok":true,"partial":false,"browser":"com.example.browser","items":[{"id":"tab:com.other.browser:1:2","kind":"tab","title":"Inbox - Gmail","app":"Other","bundleID":"com.other.browser"}]}"#
        js(ctx, #"type("g"); type("gm"); type("gmail"); runTimers();"#)
        XCTAssertEqual(js(ctx, "finder.rows().map(function (r) { return r.kind; }).join()")?.toString(), "search", "before the reply")
        XCTAssertEqual(js(ctx, "asks.length")?.toInt32(), 1, "one find for the text as it stands")
        js(ctx, "answer(0, \(reply));")
        XCTAssertEqual(js(ctx, "finder.rows().map(function (r) { return r.kind; }).join()")?.toString(), "tab,search")
        XCTAssertEqual(js(ctx, "chosen().join()")?.toString(), "tab", "the top row is chosen once the reply lands")
        js(ctx, #"key("Enter");"#)
        XCTAssertEqual(js(ctx, "JSON.stringify(asks[1])")?.toString(), #"{"op":"focus","id":"tab:com.other.browser:1:2"}"#)
        XCTAssertEqual(js(ctx, "assigned.length")?.toInt32(), 0, "no search opened")
    }

    /// Once the person moves, a late reply keeps their row chosen; new text starts again at the top.
    func testAMovedSelectionSurvivesALateReplyAndNewTextStartsAtTheTop() throws {
        let ctx = try finder()
        let reply = #"{"ok":true,"items":[{"id":"win:5","kind":"window","title":"Notes about Gmail","app":"Notes","bundleID":"com.apple.Notes"}]}"#
        // Moved before the reply: the row they chose stays chosen when the reply adds rows above it.
        js(ctx, #"type("gmail"); key("ArrowDown"); runTimers(); answer(0, \#(reply));"#)
        XCTAssertEqual(js(ctx, "finder.rows().map(function (r) { return r.kind; }).join()")?.toString(), "window,search")
        XCTAssertEqual(js(ctx, "chosen().join()")?.toString(), "search", "a moved selection stays put")
        js(ctx, #"key("Enter");"#)
        XCTAssertEqual(js(ctx, "assigned[0]")?.toString(), "https://www.google.com/search?q=gmail")
        // New text starts again at the top.
        js(ctx, #"type("gmail "); runTimers(); answer(1, \#(reply));"#)
        XCTAssertEqual(js(ctx, "chosen().join()")?.toString(), "window", "typing again starts at the top")
    }

    /// A tab of this browser that closed since the list was drawn: the switch fails through lastError, the new tab
    /// stays, and Return's search goes instead; a switch that takes closes the new tab (review first-F2).
    func testASwitchToATabThatIsGoneKeepsTheNewTab() throws {
        let ctx = try finder(chromeStub: """
            var removed = [], gone = true;
            var chrome = { runtime: { lastError: null },
              tabs: {
                getCurrent: function (cb) { cb({ id: 99 }); },
                query: function (q, cb) { cb([{ id: 9, windowId: 1, title: "Inbox - Gmail", url: "https://mail.google.com/mail/u/0" }, { id: 99, windowId: 1, title: "New Tab", url: "chrome://newtab/" }]); },
                update: function (id, props, cb) {
                  if (gone) { chrome.runtime.lastError = { message: "No tab with id: " + id }; cb(undefined); chrome.runtime.lastError = null; }
                  else cb({ id: id });
                },
                remove: function (id) { removed.push(id); } },
              windows: { update: function (id, props, cb) { if (cb) cb({}); } } };
            """)
        js(ctx, #"type("gmail"); runTimers(); answer(0, {"ok":true,"items":[],"browser":"com.example.browser"});"#)
        XCTAssertEqual(js(ctx, "finder.rows().map(function (r) { return r.kind; }).join()")?.toString(), "tab,search")
        js(ctx, #"key("Enter");"#)
        XCTAssertEqual(js(ctx, "removed.length")?.toInt32(), 0, "the new tab stays when the switch failed")
        XCTAssertEqual(js(ctx, "assigned[0]")?.toString(), "https://www.google.com/search?q=gmail", "the search goes instead")
        js(ctx, #"gone = false; key("Enter");"#)
        XCTAssertEqual(js(ctx, "removed.join()")?.toString(), "99", "a switch that took closes the new tab")
    }
}

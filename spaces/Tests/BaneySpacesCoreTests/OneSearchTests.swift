import XCTest
@testable import BaneySpacesCore

/// One search (`OneSearch`): one engine setting, one bang table, one ranking for the launcher, the new tab page and
/// `polycarp-spaces search`. The page's own copy is checked against this in `NewTabPageTests`.
final class OneSearchTests: XCTestCase {
    private func surfaces(_ json: String) throws -> Surfaces {
        guard case .success(let c) = Surfaces.check(try SurfaceValue.parse(Data(json.utf8)).get()) else {
            throw XCTSkip("unreachable: \(json) should check")
        }
        return c.surfaces
    }

    private func item(_ id: String, _ kind: Item.Kind, _ title: String, app: String = "Helium", detail: String = "", workspace: Int = 0) -> Item {
        var i = Item(id: id, bundleID: "net.imput.helium", appName: app, role: .browser, kind: kind, group: "g", title: title, detail: detail)
        i.workspace = workspace
        return i
    }

    // MARK: The setting

    func testTheEngineIsGoogleUntilChosenAndTakesABangOrATemplate() throws {
        XCTAssertEqual(Surfaces.defaults.search.engine, "g")
        XCTAssertEqual(try surfaces(#"{"search":{"engine":"kagi"}}"#).search.engine, "kagi")
        XCTAssertEqual(try surfaces(#"{"search":{"engine":"https://search.brave.com/search?q={query}"}}"#).search.engine,
                       "https://search.brave.com/search?q={query}")
        for bad in [#""!g""#, #""Google""#, #""http://x.com/?q={query}""#, #""https://x.com/""#, "3", #""""#] {
            guard case .failure(let e) = Surfaces.check(try SurfaceValue.parse(Data(#"{"search":{"engine":\#(bad)}}"#.utf8)).get()) else {
                return XCTFail("\(bad) was taken")
            }
            XCTAssertEqual(e.issues.first?.path, "search.engine", bad)
        }
    }

    /// A file from before search.engine keeps searching where newtab.searchURL said; search.engine wins once set.
    func testNewtabSearchURLIsTheFallbackAndSearchEngineWins() throws {
        let brave = "https://search.brave.com/search?q={query}"
        XCTAssertEqual(try surfaces(#"{"newtab":{"searchURL":"\#(brave)"}}"#).search.engine, brave)
        XCTAssertEqual(try surfaces(#"{"newtab":{"searchURL":"\#(brave)"},"search":{"engine":"ddg"}}"#).search.engine, "ddg")
        XCTAssertEqual(try surfaces(#"{"newtab":{"verse":false}}"#).search.engine, "g")
    }

    func testTheSchemaAndFieldListCarryTheEngine() throws {
        let f = try XCTUnwrap(SurfaceField.byPath["search.engine"])
        XCTAssertEqual(f.kind, .engine)
        XCTAssertEqual(f.defaultValue, .string("g"))
        let schema = Surfaces.schema.json(pretty: false)
        XCTAssertTrue(schema.contains("search.engine"), "the schema names the field")
    }

    // MARK: The engine

    func testTheEngineResolvesAgainstTheBangs() {
        let bangs = Bangs.builtIn
        XCTAssertEqual(OneSearch.engine("g", bangs: bangs).name, "Google")
        XCTAssertEqual(OneSearch.engine("kagi", bangs: bangs).url, "https://kagi.com/search?q={q}")
        XCTAssertEqual(OneSearch.engine("brave", bangs: bangs).name, "Brave Search")
        let t = OneSearch.engine("https://www.startpage.com/do/search?q={query}", bangs: bangs)
        XCTAssertEqual(t.name, "startpage.com")
        XCTAssertEqual(OneSearch.template(t), "https://www.startpage.com/do/search?q={query}")
        // A trigger only DuckDuckGo knows still searches there.
        XCTAssertEqual(OneSearch.engine("ecosia", bangs: bangs).address(for: "trees")?.absoluteString, "https://duckduckgo.com/?q=%21ecosia%20trees")
        // A custom bang can be the engine.
        let mine = Bangs.all(custom: [Bang(trigger: "me", name: "Mine", url: "https://me.example/?s={q}")])
        XCTAssertEqual(OneSearch.engine("me", bangs: mine).address(for: "a b")?.absoluteString, "https://me.example/?s=a%20b")
        XCTAssertTrue(Bangs.engines.map(\.trigger).starts(with: ["g", "ddg", "brave", "kagi"]))
    }

    // MARK: Return

    func testReturnIsABangAnAddressOrTheEngine() {
        let bangs = Bangs.builtIn
        let g = OneSearch.engine("g", bangs: bangs)
        XCTAssertEqual(OneSearch.action("!yt cats", engine: g, bangs: bangs)?.url, "https://www.youtube.com/results?search_query=cats")
        XCTAssertEqual(OneSearch.action("cats !yt", engine: g, bangs: bangs)?.title, "Search YouTube for \u{201C}cats\u{201D}")
        let ask = OneSearch.action("!claude why is the sky blue", engine: g, bangs: bangs)
        XCTAssertEqual(ask?.url, "https://claude.ai/new?q=why%20is%20the%20sky%20blue")
        XCTAssertEqual(ask?.agent, true)
        XCTAssertEqual(ask?.title, "Ask Claude \u{201C}why is the sky blue\u{201D}")
        XCTAssertEqual(OneSearch.action("!zzz words", engine: g, bangs: bangs)?.url, "https://duckduckgo.com/?q=%21zzz%20words")
        XCTAssertEqual(OneSearch.action("!gh", engine: g, bangs: bangs)?.url, "https://github.com/")
        XCTAssertEqual(OneSearch.action("dbaney.com", engine: g, bangs: bangs)?.kind, "open")
        XCTAssertEqual(OneSearch.action("localhost:3000/x", engine: g, bangs: bangs)?.url, "http://localhost:3000/x")
        XCTAssertEqual(OneSearch.action("javascript:alert(1)", engine: g, bangs: bangs)?.kind, "search")
        XCTAssertEqual(OneSearch.action("purity of heart", engine: g, bangs: bangs)?.url, "https://www.google.com/search?q=purity%20of%20heart")
        XCTAssertNil(OneSearch.action("  ", engine: g, bangs: bangs))
    }

    // MARK: Rows

    func testRowsAreOpenTabsThenCompletionsThenTheSearchAtMostSeven() {
        let bangs = Bangs.builtIn
        let g = OneSearch.engine("g", bangs: bangs)
        let items = [item("tab:h:1:1", .tab, "Inbox - Gmail", detail: "mail.google.com/mail/u/0"),
                     item("win:5", .window, "Notes about Gmail", app: "Notes", workspace: 3),
                     item("tab:h:1:2", .tab, "Weather"),
                     item("ghostty:a", .terminal, "gnome", app: "Ghostty")]
        let r = OneSearch.results("gmail", items: items, engine: g, bangs: bangs)
        XCTAssertEqual(r.map(\.kind), ["tab", "window", "search"])
        XCTAssertEqual(r[0].id, "tab:h:1:1")
        XCTAssertEqual(r[1].workspace, 3)
        XCTAssertEqual(r.last?.title, "Search Google for \u{201C}gmail\u{201D}")
        // Letters scattered through a title don't make a switch row.
        XCTAssertEqual(OneSearch.results("gml", items: items, engine: g, bangs: bangs).map(\.kind), ["search"])
        // A bang being typed: completions and the action, no sessions.
        let y = OneSearch.results("!y", items: items, engine: g, bangs: bangs)
        XCTAssertEqual(y.first?.kind, "bang")
        XCTAssertEqual(y.first?.trigger, "yt")
        XCTAssertLessThanOrEqual(y.count, OneSearch.limit)
        XCTAssertEqual(y.last?.kind, "search")
        let many = (0..<20).map { item("tab:h:2:\($0)", .tab, "Gmail \($0)") }
        let capped = OneSearch.results("gmail", items: many, engine: g, bangs: bangs)
        XCTAssertEqual(capped.count, 7)
        XCTAssertEqual(capped.last?.kind, "search", "the search row always stays")
        XCTAssertEqual(OneSearch.results("", items: many, engine: g, bangs: bangs), [])
    }

    func testAResultIsOneJSONLine() {
        let r = OneSearch.Result(kind: "search", title: "Search Google for \u{201C}a\u{201D}", url: "https://www.google.com/search?q=a")
        XCTAssertEqual(r.jsonLine, #"{"kind":"search","title":"Search Google for “a”","url":"https://www.google.com/search?q=a"}"#)
        XCTAssertFalse(r.jsonLine.contains("\n"))
    }

    func testCustomBangsLoadFromTheSupportFolder() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("onesearch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(Bangs.load(supportDir: dir), Bangs.builtIn, "no file is the built-ins")
        try Data(#"[{"trigger":"yt","name":"Mine","url":"https://me.example/?v={q}"}]"#.utf8).write(to: Bangs.customFile(supportDir: dir))
        XCTAssertEqual(Bangs.find("yt", in: Bangs.load(supportDir: dir))?.name, "Mine", "yours replace a built-in")
    }
}

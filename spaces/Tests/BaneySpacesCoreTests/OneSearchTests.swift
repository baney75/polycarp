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

    // MARK: The launcher's engine from before search.engine (review first-F1)

    private func loaded(_ json: String) throws -> SurfacesFile.Loaded {
        let tree = try SurfaceValue.parse(Data(json.utf8)).get()
        guard case .success(let c) = Surfaces.check(tree) else { throw XCTSkip("unreachable: \(json) should check") }
        return .document(.init(tree: tree, surfaces: c.surfaces, warnings: []))
    }

    func testTheOldLauncherEngineMovesUnlessTheFileChoseOne() throws {
        let ddg = "https://duckduckgo.com/?q={query}"
        XCTAssertEqual(OneSearch.moveOldEngine(nil, file: .missing), .keep, "nothing to move")
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: .missing), .write("b"))
        XCTAssertEqual(OneSearch.moveOldEngine("g", file: .missing), .forget, "Google is already in force")
        // A full file from `surfaces get` carries newtab.searchURL at its default: nobody chose it, so the launcher's
        // choice moves, Google included (else the default DuckDuckGo would take over the launcher).
        let full = try loaded(#"{"newtab":{"searchURL":"\#(ddg)"}}"#)
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: full), .write("b"))
        XCTAssertEqual(OneSearch.moveOldEngine("g", file: full), .write("g"))
        // A newtab.searchURL someone set, or a search.engine, is a choice in the file: it wins and the old key goes.
        let brave = try loaded(#"{"newtab":{"searchURL":"https://search.brave.com/search?q={query}"}}"#)
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: brave), .forget)
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: try loaded(#"{"search":{"engine":"kagi"}}"#)), .forget)
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: try loaded(#"{"newtab":{"verse":false}}"#)), .write("b"))
        // A file that can't be read now keeps the key for next time.
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: .failed("busy")), .keep)
        XCTAssertEqual(OneSearch.moveOldEngine("b", file: .rejected("too big")), .keep)
    }

    // MARK: polycarp-spaces search's arguments (review first-F4, second-F7)

    func testSearchArgumentsTakeFlagsOnlyBeforeTheSeparator() {
        let a = OneSearch.Arguments(["--json", "gmail", "inbox"])
        XCTAssertTrue(a.json); XCTAssertFalse(a.open); XCTAssertEqual(a.text, "gmail inbox"); XCTAssertFalse(a.asksHelp)
        XCTAssertTrue(OneSearch.Arguments(["cats", "--open"]).open, "a flag anywhere before --")
        XCTAssertTrue(OneSearch.Arguments(["help"]).asksHelp)
        XCTAssertTrue(OneSearch.Arguments(["--json", "-h"]).asksHelp)
        XCTAssertFalse(OneSearch.Arguments(["help", "me"]).asksHelp, "help with more words is a search")
        // What polycarp mcp sends: flags, then --, then the query whole.
        let mcp = OneSearch.Arguments(["--open", "--json", "--", "--open"])
        XCTAssertTrue(mcp.open); XCTAssertTrue(mcp.json); XCTAssertEqual(mcp.text, "--open")
        let help = OneSearch.Arguments(["--json", "--", "help"])
        XCTAssertFalse(help.asksHelp, "help after -- is searched for")
        XCTAssertEqual(help.text, "help")
        XCTAssertFalse(OneSearch.Arguments(["--", "--json"]).json)
    }

    func testOpenPassesOverBangCompletions() {
        let bangs = Bangs.builtIn
        let g = OneSearch.engine("g", bangs: bangs)
        let y = OneSearch.results("!y", items: [], engine: g, bangs: bangs)
        XCTAssertEqual(y.first?.kind, "bang")
        XCTAssertEqual(OneSearch.toOpen(y)?.kind, "search", "a completion only fills in its bang, so --open goes on")
        XCTAssertEqual(OneSearch.toOpen(y)?.url, "https://duckduckgo.com/?q=%21y")
        let items = [item("tab:h:1:1", .tab, "Inbox - Gmail")]
        XCTAssertEqual(OneSearch.toOpen(OneSearch.results("gmail", items: items, engine: g, bangs: bangs))?.id, "tab:h:1:1")
        XCTAssertNil(OneSearch.toOpen([]))
    }

    // "x.com" in the launcher opens x.com in the main browser, ahead of apps and files (Donovan, 2026-11-24).
    func testATypedWebsiteOpensFirstAndAFileNameDoesNot() {
        for typed in ["x.com", "X.com", "youtube.com", "claude.ai", "news.ycombinator.com", "www.example.md", "x.com/home",
                      "localhost:3000", "192.168.1.20", "https://notes.md", "github.io"] {
            XCTAssertEqual(OneSearch.typedSite(typed)?.sure, true, typed)
        }
        XCTAssertEqual(OneSearch.typedSite("x.com")?.url.absoluteString, "https://x.com")
        XCTAssertEqual(OneSearch.typedSite("  x.com/home ")?.url.absoluteString, "https://x.com/home")
        for typed in ["notes.md", "Xcode.app", "install.sh", "report.zip", "main.rs", "build.py"] {
            XCTAssertEqual(OneSearch.typedSite(typed)?.sure, false, typed)
        }
        for typed in ["x", "polycarp", "two words.com", "ftp://x.com", "", "x.c"] {
            XCTAssertNil(OneSearch.typedSite(typed), typed)
        }
    }
}

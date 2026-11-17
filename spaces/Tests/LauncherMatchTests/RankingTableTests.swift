import XCTest
@testable import LauncherMatch

/// What comes up first for what was typed, over a launcher index shaped like a real Mac's: the
/// apps, Polycarp's commands and menus, nine workspaces and a few windows. Each row is one query
/// and the entry that must be the top hit. Typos of one letter, acronyms and words typed apart
/// are all here.
enum RankingTable {
    static let apps = [
        "1Password", "Activity Monitor", "App Store", "Calculator", "Calendar", "ChatGPT", "Chess", "Claude",
        "Cursor", "Discord", "Docker", "FaceTime", "Figma", "Finder", "Firefox", "Font Book", "Ghostty",
        "GitHub Desktop", "Google Chrome", "Helium", "Keynote", "Mail", "Maps", "Messages", "Music", "Notes",
        "Notion", "Numbers", "Obsidian", "Pages", "Photo Booth", "Photos", "Preview", "Proton Drive",
        "Proton Mail", "Proton Pass", "Reminders", "Safari", "Signal", "Slack", "Spotify", "System Settings",
        "T3 Code", "Tailscale", "Terminal", "TextEdit", "Visual Studio Code", "Xcode", "Zoom",
    ]
    static let commands = [
        "Lock Screen", "Sleep", "Restart…", "Shut Down…", "Log Out…", "Toggle Dark Mode", "Take a Screenshot",
        "New Claude Session", "New Terminal", "Show All Workspaces", "Bring Every Window Back",
        "Turn Off Workspace Dock", "Polycarp Settings",
    ]
    static let menus = ["Search the Web", "Apps", "Files", "Install", "Remove", "Update", "System", "Workspaces"]
    static let workspaces: [Int: [String]] = [1: ["Ghostty", "Helium"], 2: ["Slack", "Mail"], 3: ["T3 Code"], 4: [],
                                              5: ["Spotify"], 6: [], 7: [], 8: [], 9: ["Proton Pass"]]
    static let windows: [(id: String, title: String, app: String, detail: String)] = [
        ("w:inbox", "Inbox - Proton Mail", "Helium", ""),
        ("w:polycarp", "polycarp", "Ghostty", "~/Projects/polycarp"),
        ("w:invoice", "Invoice 2026-11.pdf", "Preview", ""),
    ]

    static func index() -> LauncherIndex {
        LauncherIndex(apps.map { .app(id: "app:\($0)", name: $0) }
            + commands.map { .command(id: "cmd:\($0)", title: $0) }
            + menus.map { .menu(id: "menu:\($0)", title: $0) }
            + workspaces.keys.sorted().map { .workspace(id: "ws:\($0)", number: $0, apps: workspaces[$0]!) }
            + windows.map { .window(id: $0.id, title: $0.title, app: $0.app, detail: $0.detail) })
    }

    /// Query, then the id that must come first.
    static let cases: [(String, String)] = [
        ("saf", "app:Safari"),
        ("safari", "app:Safari"),
        ("vsc", "app:Visual Studio Code"),
        ("xc", "app:Xcode"),
        ("sys set", "app:System Settings"),
        ("ss", "app:System Settings"),
        ("lock", "cmd:Lock Screen"),
        ("lck", "cmd:Lock Screen"),
        ("dark", "cmd:Toggle Dark Mode"),
        ("tdm", "cmd:Toggle Dark Mode"),
        ("shut", "cmd:Shut Down…"),
        ("new term", "cmd:New Terminal"),
        ("new cl", "cmd:New Claude Session"),
        ("dock", "app:Docker"),
        ("turn off dock", "cmd:Turn Off Workspace Dock"),
        ("bring back", "cmd:Bring Every Window Back"),
        ("3", "ws:3"),
        ("ws 3", "ws:3"),
        ("workspace 5", "ws:5"),
        ("gh", "app:Ghostty"),
        ("ghosty", "app:Ghostty"),
        ("calc", "app:Calculator"),
        ("cal", "app:Calendar"),
        ("am", "app:Activity Monitor"),
        ("mon", "app:Activity Monitor"),
        ("tc", "app:T3 Code"),
        ("t3", "app:T3 Code"),
        ("1p", "app:1Password"),
        ("pp", "app:Proton Pass"),
        ("pm", "app:Proton Mail"),
        ("claude", "app:Claude"),
        ("fontbook", "app:Font Book"),
        ("msg", "app:Messages"),
        ("ft", "app:FaceTime"),
        ("spot", "app:Spotify"),
        ("ter", "app:Terminal"),
        ("files", "menu:Files"),
        ("inst", "menu:Install"),
        ("inbox", "w:inbox"),
        ("ghostty polycarp", "w:polycarp"),
        ("invoice", "w:invoice"),
        // One letter wrong, swapped, extra or missing.
        ("safaru", "app:Safari"),
        ("chorme", "app:Google Chrome"),
        ("slakc", "app:Slack"),
        ("termimal", "app:Terminal"),
        ("obsidain", "app:Obsidian"),
        ("discrod", "app:Discord"),
        ("spotiffy", "app:Spotify"),
        ("calendr", "app:Calendar"),
    ]
}

final class RankingTableTests: XCTestCase {
    func testEveryQueryPutsItsEntryFirst() {
        let index = RankingTable.index()
        var wrong: [String] = []
        for (query, expected) in RankingTable.cases {
            let top = index.search(query, limit: 3)
            if top.first?.id != expected {
                wrong.append("\"\(query)\": wanted \(expected), got \(top.map { "\($0.id) \($0.score)" })")
            }
        }
        XCTAssertGreaterThanOrEqual(RankingTable.cases.count, 30)
        XCTAssert(wrong.isEmpty, "\(wrong.count) of \(RankingTable.cases.count) wrong:\n" + wrong.joined(separator: "\n"))
    }

    func testLettersOutOfOrderOrMissingDoNotMatch() {
        XCTAssertNil(Match.score("zzz", "Safari"))
        XCTAssertNil(Match.score("ab", "ba"))
        // A typo is forgiven only in a word of four letters or more.
        XCTAssertNil(Match.score("sfx", "Safari"))
        XCTAssertNotNil(Match.score("safxri", "Safari"))
        // Two typos are too many.
        XCTAssertNil(Match.score("sxfxri", "Safari"))
        XCTAssertEqual(Match.score("", "Anything"), 0)
    }

    func testCaseAndAccentsDoNotMatter() throws {
        let plain = try XCTUnwrap(Match.score("cafe", "Café Notes"))
        XCTAssertEqual(Match.score("CAFÉ", "café notes"), plain)
        XCTAssertNotNil(Match.score("uber", "Über"))
    }

    func testABetterPlacementWins() throws {
        // Start of the name over the start of a later word over the middle of a word.
        let start = try XCTUnwrap(Match.score("co", "Code"))
        let word = try XCTUnwrap(Match.score("co", "Visual Studio Code"))
        let middle = try XCTUnwrap(Match.score("co", "Xcode"))
        XCTAssertGreaterThan(start, word)
        XCTAssertGreaterThan(word, middle)
        // Initials beat the same letters run together inside a word.
        XCTAssertGreaterThan(try XCTUnwrap(Match.score("vsc", "Visual Studio Code")), try XCTUnwrap(Match.score("vsc", "Ovscan")))
        // A typo scores under a clean match of the same word.
        XCTAssertGreaterThan(try XCTUnwrap(Match.score("safar", "Safari")), try XCTUnwrap(Match.score("safaru", "Safari")))
        // camelCase and digits start words too.
        XCTAssertGreaterThan(try XCTUnwrap(Match.score("hd", "GitHubDesktop")), try XCTUnwrap(Match.score("hd", "Shadow")))
    }

    func testBoostLiftsAnEntryOnlyWhenSomethingWasTyped() {
        let index = RankingTable.index()
        XCTAssertEqual(index.search("cal", limit: 1).first?.id, "app:Calendar")
        XCTAssertEqual(index.search("cal", limit: 1, boost: { $0 == "app:Calculator" ? 30 : 0 }).first?.id, "app:Calculator")
        XCTAssertEqual(index.search("", limit: 1, boost: { $0 == "app:Zoom" ? 30 : 0 }).first?.id, "app:1Password")
    }

    func testKindsNarrowTheSearch() {
        let index = RankingTable.index()
        XCTAssertEqual(index.search("slack", kinds: [.workspace]).map(\.id), ["ws:2"])
        XCTAssertEqual(index.search("slack").first?.id, "app:Slack")
    }
}

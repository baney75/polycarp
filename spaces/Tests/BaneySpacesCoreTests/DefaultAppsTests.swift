import XCTest
@testable import BaneySpacesCore

/// Launch Services and the disk as a table.
final class FakeInstalledApps: InstalledApps {
    var apps: [String: String]
    var system: [AppRole.SystemQuestion: String]
    var commands: [String: String]

    init(_ apps: [String: String] = [:], system: [AppRole.SystemQuestion: String] = [:], commands: [String: String] = [:]) {
        self.apps = apps; self.system = system; self.commands = commands
    }

    func appName(_ bundle: String) -> String? { apps[bundle] }
    func systemDefault(_ question: AppRole.SystemQuestion) -> String? { system[question] }
    func commandPath(_ names: [String]) -> String? { names.lazy.compactMap { self.commands[$0] }.first }
}

final class DefaultAppsTests: XCTestCase {
    private let safari = "com.apple.Safari", firefox = "org.mozilla.firefox", helium = "net.imput.helium"

    private func resolve(_ role: AppRole, _ choice: String?, _ on: FakeInstalledApps) -> ResolvedDefault {
        DefaultAppResolver.resolve(role, choice: choice.flatMap { DefaultApp(id: $0, role: role) }, installed: on)
    }

    func testYourChoiceComesFirstThenMacOSThenTheCatalog() {
        let mac = FakeInstalledApps([safari: "Safari", firefox: "Firefox", helium: "Helium"], system: [.scheme("http"): firefox])
        XCTAssertEqual(resolve(.browser, helium, mac).app?.app, .app(helium))
        XCTAssertEqual(resolve(.browser, helium, mac).source, .you)
        XCTAssertEqual(resolve(.browser, nil, mac).app?.app, .app(firefox))
        XCTAssertEqual(resolve(.browser, nil, mac).source, .system)
        mac.system = [:]
        XCTAssertEqual(resolve(.browser, nil, mac).app?.app, .app(safari), "the catalog's order, not the table's")
        XCTAssertEqual(resolve(.browser, nil, mac).source, .firstInstalled)
        XCTAssertNil(resolve(.browser, nil, FakeInstalledApps()).app)
        XCTAssertEqual(resolve(.browser, nil, FakeInstalledApps()).source, .none)
    }

    func testEachRoleAsksMacOSItsOwnQuestion() {
        let mac = FakeInstalledApps(["x.http": "H", "x.mail": "M", "x.cal": "C", "x.text": "T", "x.dir": "D", "com.googlecode.iterm2": "iTerm2"],
            system: [.scheme("http"): "x.http", .scheme("mailto"): "x.mail", .scheme("webcal"): "x.cal", .type("public.plain-text"): "x.text",
                     .type("public.folder"): "x.dir", .type("public.unix-executable"): "com.googlecode.iterm2"])
        let want: [AppRole: String] = [.browser: "H", .mail: "M", .calendar: "C", .editor: "T", .files: "D", .terminal: "iTerm2"]
        for role in AppRole.allCases { XCTAssertEqual(resolve(role, nil, mac).app?.name, want[role], role.rawValue) }
    }

    func testAChoiceThatIsGoneFallsThroughAndSaysSo() {
        let mac = FakeInstalledApps([safari: "Safari"], system: [.scheme("http"): safari])
        let r = resolve(.browser, firefox, mac)
        XCTAssertEqual(r.app?.app, .app(safari))
        XCTAssertEqual(r.source, .system)
        XCTAssertEqual(r.gone, .app(firefox))
        XCTAssertEqual(r.said, "Firefox isn't installed. Using Safari until it is back.")
        mac.apps[firefox] = "Firefox"
        XCTAssertEqual(resolve(.browser, firefox, mac).source, .you, "installed again, it is back")
        XCTAssertNil(resolve(.browser, firefox, mac).gone)
    }

    func testASystemDefaultThatIsGoneIsNoAnswer() {
        let mac = FakeInstalledApps([safari: "Safari"], system: [.scheme("http"): firefox])
        XCTAssertEqual(resolve(.browser, nil, mac).app?.app, .app(safari))
        XCTAssertEqual(resolve(.browser, nil, mac).source, .firstInstalled)
    }

    func testAnyInstalledAppCanBeChosenAndIsListedOnce() {
        let mac = FakeInstalledApps(["org.example.odd": "Odd", safari: "Safari"])
        let r = resolve(.browser, "org.example.odd", mac)
        XCTAssertEqual(r.app?.name, "Odd")
        XCTAssertEqual(r.candidates.map(\.name), ["Safari", "Odd"])
        XCTAssertEqual(resolve(.browser, safari, mac).candidates.map(\.name), ["Safari"])
    }

    func testOneRolesChoiceLeavesTheOthers() {
        let mac = FakeInstalledApps(["com.microsoft.Outlook": "Outlook", "com.apple.mail": "Mail", "com.apple.iCal": "Calendar"])
        XCTAssertEqual(resolve(.mail, "com.microsoft.Outlook", mac).app?.name, "Outlook")
        XCTAssertEqual(resolve(.calendar, nil, mac).app?.name, "Calendar")
    }

    func testNoAgentIsChosenForYou() {
        let mac = FakeInstalledApps(["com.anthropic.claudefordesktop": "Claude"], commands: ["claude": "/b/claude", "codex": "/b/codex"])
        let r = resolve(.agent, nil, mac)
        XCTAssertNil(r.app)
        XCTAssertEqual(r.source, .none)
        XCTAssertEqual(r.candidates.map(\.name), ["Claude Code", "Codex", "Claude"])
        XCTAssertEqual(resolve(.agent, "codex", mac).app?.path, "/b/codex")
        let gone = resolve(.agent, "grok", mac)
        XCTAssertNil(gone.app, "a gone agent isn't replaced by another one")
        XCTAssertEqual(gone.said, "Grok isn't installed. Nothing is chosen until it is back.")
    }

    func testAProgramIsFoundUnderAnyOfItsNames() {
        XCTAssertEqual(resolve(.agent, "gemini", FakeInstalledApps(commands: ["gemini": "/b/gemini"])).app?.path, "/b/gemini")
        XCTAssertEqual(resolve(.agent, "gemini", FakeInstalledApps(commands: ["gemini": "/b/gemini", "agy": "/b/agy"])).app?.path, "/b/agy")
    }

    func testTerminalAsMacOSShipsItIsNoChoice() {
        let shell = AppRole.SystemQuestion.type("public.unix-executable")
        let mac = FakeInstalledApps(["com.apple.Terminal": "Terminal", "net.kovidgoyal.kitty": "kitty", "x.editor": "Ed"], system: [shell: "com.apple.Terminal"])
        XCTAssertEqual(resolve(.terminal, nil, mac).app?.name, "kitty")
        mac.system[shell] = "x.editor"
        XCTAssertEqual(resolve(.terminal, nil, mac).app?.name, "kitty", "an editor that opens scripts is no terminal")
        mac.system[shell] = "NET.kovidgoyal.kitty"
        XCTAssertEqual(resolve(.terminal, nil, mac).source, .system)
        mac.apps["net.kovidgoyal.kitty"] = nil
        XCTAssertEqual(resolve(.terminal, nil, mac).app?.name, "Terminal")
        XCTAssertEqual(resolve(.terminal, "com.apple.Terminal", mac).source, .you)
    }

    func testAProgramOpensInATerminalThatCanRunIt() {
        let mac = FakeInstalledApps(["dev.warp.Warp-Stable": "Warp", "com.apple.Terminal": "Terminal", "org.alacritty": "Alacritty"])
        func pick(_ id: String) -> String? { DefaultAppResolver.terminalForCommands(choice: .app(id), installed: mac)?.name }
        XCTAssertEqual(pick("com.apple.Terminal"), "Terminal")
        XCTAssertEqual(pick("dev.warp.Warp-Stable"), "Alacritty")
        let warp = resolve(.terminal, "dev.warp.Warp-Stable", mac)
        XCTAssertEqual(warp.app?.note, "Can't be told what to run, so programs open in another terminal")
        XCTAssertEqual(warp.candidates.filter { $0.note == nil }.map(\.name), ["Alacritty", "Terminal"])
        mac.apps["x.term"] = "Own"
        XCTAssertEqual(pick("x.term"), "Alacritty", "nor one the catalog doesn't know")
        mac.apps["com.googlecode.iterm2"] = "iTerm2"
        mac.apps["com.mitchellh.ghostty"] = "Ghostty"
        mac.system[.type("public.unix-executable")] = "com.googlecode.iterm2"
        XCTAssertEqual(pick("x.gone"), "iTerm2", "macOS's own terminal before the first installed one")
    }

    func testSpellings() {
        XCTAssertEqual(DefaultApp(id: "claude", role: .agent), .command("claude"))
        XCTAssertEqual(DefaultApp(id: "nvim", role: .editor), .command("nvim"))
        XCTAssertNil(DefaultApp(id: "claude", role: .browser), "a program does only the job it is listed for")
        XCTAssertNil(DefaultApp(id: "rm", role: .agent))
        for bad in ["", "Ghostty", ".x", "x.", "a b.c", "a/b.c", "$(x).y", "com.x\n", "com.\u{e9}"] {
            XCTAssertNil(DefaultApp(id: bad, role: .terminal), bad.debugDescription)
        }
        XCTAssertEqual(DefaultApp(id: "COM.apple.terminal", role: .terminal), .app("com.apple.Terminal"), "one app in any case")
        XCTAssertEqual(DefaultApp(id: "com.apple.terminal", role: .browser), .app("com.apple.terminal"))
        XCTAssertEqual(DefaultApp(id: "dev.warp.Warp-Stable", role: .terminal)?.id, "dev.warp.Warp-Stable")
    }

    func testTheCatalogNamesEachAppOncePerRole() {
        for role in AppRole.allCases {
            let ids = DefaultAppCatalog.entries(role).map(\.app)
            XCTAssertEqual(Set(ids).count, ids.count, role.rawValue)
            XCTAssertFalse(ids.isEmpty, role.rawValue)
            for app in ids { XCTAssertEqual(DefaultApp(id: app.id, role: role), app, app.id) }
        }
        XCTAssertTrue(DefaultAppCatalog.runsCommands.allSatisfy { b in DefaultAppCatalog.entries(.terminal).contains { $0.app == .app(b) } })
    }
}

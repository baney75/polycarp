import XCTest
@testable import BaneySpacesCore

final class RoleSearchTests: XCTestCase {
    private func c(_ app: DefaultApp, _ name: String) -> DefaultCandidate { DefaultCandidate(app: app, name: name, path: nil, note: nil) }
    private var resolved: [AppRole: ResolvedDefault] {
        func r(_ role: AppRole, _ app: DefaultCandidate?, _ s: ResolvedDefault.Source) -> ResolvedDefault {
            ResolvedDefault(role: role, app: app, source: s, gone: nil, candidates: app.map { [$0] } ?? [])
        }
        return [.browser: r(.browser, c(.app("org.mozilla.firefox"), "Firefox"), .you), .terminal: r(.terminal, c(.app("com.mitchellh.ghostty"), "Ghostty"), .firstInstalled),
                .agent: r(.agent, nil, .none), .mail: r(.mail, c(.app("com.apple.mail"), "Mail"), .system), .notes: r(.notes, nil, .none)]
    }
    private func ids(_ q: String) -> [String] { RoleSearch.rows(q, resolved, folder: "~/work").map(\.id) }

    func testARoleByItsName() {
        for q in ["bro", "browser", "open browser", "Browser", "web"] { XCTAssertEqual(ids(q), ["role:browser"], q) }
        XCTAssertEqual(ids("email"), ["role:mail"])
        XCTAssertEqual(ids("agent"), ["role:agent"], "unset, it asks")
        XCTAssertEqual(ids("notes"), [], "nothing to open")
        for q in ["", "b", "br", "browsers", "firefox", "open", "open browser now", "set", "brow ser"] { XCTAssertEqual(ids(q), [], q) }
        let row = RoleSearch.rows("browser", resolved, folder: nil)[0]
        XCTAssertEqual([row.title, row.subtitle], ["Firefox", "Your browser · You chose it"])
        XCTAssertEqual(row.action, .open(.browser))
    }

    func testChoosingIsSettings() {
        XCTAssertEqual(ids("set default browser"), ["role-set:browser"])
        XCTAssertEqual(ids("default mail"), ["role-set:mail"])
        XCTAssertEqual(ids("set def").count, AppRole.allCases.count)
        XCTAssertEqual(RoleSearch.rows("default agent", resolved, folder: nil).map(\.action), [.choose(.agent)])
    }

    func testTerminalHere() {
        XCTAssertEqual(ids("terminal"), ["role:terminal"])
        XCTAssertEqual(ids("open terminal"), ["role:terminal", "role:terminal-here"])
        XCTAssertEqual(ids("open terminal here"), ["role:terminal-here"])
        XCTAssertEqual(RoleSearch.rows("terminal here", resolved, folder: "~/work").map(\.subtitle), ["Ghostty · ~/work"])
    }

    func testAPromptForTheAgent() {
        XCTAssertEqual(RoleSearch.prompt("> fix the build"), "fix the build")
        XCTAssertEqual(RoleSearch.prompt(">agent fix --all \"$(x)\""), "fix --all \"$(x)\"")
        XCTAssertEqual(RoleSearch.prompt("> Agent fix"), "fix")
        XCTAssertEqual(RoleSearch.prompt("> agents are fun"), "agents are fun")
        XCTAssertEqual(RoleSearch.prompt("> agent"), "agent")
        for none in ["", ">", " > ", "fix > this"] { XCTAssertNil(RoleSearch.prompt(none), none) }
        XCTAssertEqual(RoleSearch.ask("hi", resolved[.agent]).title, "Ask your agent “hi”")
        XCTAssertEqual(RoleSearch.ask("hi", resolved[.agent]).action, .ask("hi"))
    }

    func testTheWebAgentIsYourAgentWhereItHasAPage() {
        XCTAssertEqual(RoleSearch.webAgent(.command("codex")), "chatgpt")
        XCTAssertEqual(RoleSearch.webAgent(.command("claude")), "claude")
        XCTAssertNil(RoleSearch.webAgent(.command("pi")))
        XCTAssertNil(RoleSearch.webAgent(nil))
        for id in [DefaultApp.command("claude"), .command("codex"), .command("grok"), .command("copilot")] {
            XCTAssertNotNil(Bangs.agents.first { $0.trigger == RoleSearch.webAgent(id) })
        }
    }

    /// Everything in Polycarp that opens a page, a terminal or an agent goes by the choice.
    func testTheAppUsesTheChoice() throws {
        let launcher = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        let browser = try XCTUnwrap(SourceText.block(after: "static var browser: URL? ", in: launcher))
        XCTAssertTrue(browser.contains("resolved[.browser]?.app?.path"))
        XCTAssertEqual(launcher.components(separatedBy: #"urlForApplication(toOpen: URL(string: "https:"#).count, 2, "asked of macOS only there")
        let open = try XCTUnwrap(SourceText.block(after: "static func openInBrowser(_ url: URL) ", in: launcher))
        XCTAssertTrue(open.contains("let browser else {") && open.contains("withApplicationAt: browser"))
        XCTAssertTrue(launcher.contains(#"RoleSearch.webAgent(DefaultAppsStore.shared.now.resolved[.agent]?.app?.app) ?? "claude""#))
        let session = try SourceText.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("resolved[.browser]?.source == .you { Launcher.openInBrowser(url) }"))
        let main = try XCTUnwrap(SourceText.block(after: "static func mainBrowser(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> String? ", in: session))
        XCTAssertTrue(main.contains("if case .app(let yours)? = DefaultAppsStore.shared.now.resolved[.browser]?.app?.app { return yours }"))
        XCTAssertTrue(launcher.contains("let terminal = DefaultAppsStore.shared.now.programs"))
        XCTAssertTrue(launcher.contains("RoleOpener.start(a.command, at: path, in: NSHomeDirectory())"))
    }

    /// Only Return sends a prompt, and it goes as it was typed to the one place that takes it as an argument.
    func testAPromptWaitsForReturn() throws {
        let launcher = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        XCTAssertEqual(launcher.components(separatedBy: "askAgent(").count, 2)
        let item = try XCTUnwrap(SourceText.block(after: "private func roleItem(_ r: RoleSearch.Row) -> LauncherItem ", in: launcher))
        let run = try XCTUnwrap(item.range(of: "run: { [weak self] in")), ask = try XCTUnwrap(item.range(of: "self.actions.askAgent(prompt)"))
        XCTAssertTrue(run.lowerBound < ask.lowerBound)
        XCTAssertTrue(item.contains("RoleOpener.key(role, new: true)"), "⌘Return opens a new window")
        XCTAssertEqual(RoleSearch.rows("open terminal here", resolved, folder: nil).map(\.role), [.terminal])
        XCTAssertEqual(RoleSearch.ask("x", nil).role, .agent)
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("RoleOpener.person(RoleRequest(role: .agent, prompt: $0, folder: self?.terminalFolder))"))
        XCTAssertTrue(app.contains("self?.setup.model.tab = .defaults"))
    }
}

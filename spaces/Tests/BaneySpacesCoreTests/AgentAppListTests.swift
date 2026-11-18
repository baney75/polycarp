@testable import BaneySpacesCore
import XCTest

/// Apps Donovan lets agents open on the agent workspace beyond the three built-ins (council gap A1: "agents can open only
/// three test apps"). Only his click on Allow in Polycarp's sheet adds one (review of #496, first-F1); each is refused by
/// kind and by what its bundle says it is, and its open must start a new copy (second-F6).
final class AgentAppListTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-agent-apps-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        AgentAppGrants.replace([])
    }

    override func tearDownWithError() throws {
        AgentAppGrants.replace([])
        try? FileManager.default.removeItem(at: dir)
    }

    /// A made-up app bundle with this Info.plist.
    private func app(_ name: String, _ info: [String: Any]) throws -> URL {
        let url = dir.appendingPathComponent("\(name).app")
        try FileManager.default.createDirectory(at: url.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        let plist = try PropertyListSerialization.data(fromPropertyList: info.merging(["CFBundlePackageType": "APPL"]) { a, _ in a }, format: .xml, options: 0)
        try plist.write(to: url.appendingPathComponent("Contents/Info.plist"))
        return url
    }

    /// The gate every caller uses opens an app once Donovan allowed it, and not before.
    func testAnAllowedAppOpensOnTheAgentWorkspace() throws {
        let grapher = try app("Grapher", ["CFBundleIdentifier": "com.apple.grapher", "LSApplicationCategoryType": "public.app-category.education"])
        func open() -> Result<[String], HandsError> {
            AgentOpenGate.check(app: "Grapher", bundle: "com.apple.grapher", targets: [], handoff: dir.appendingPathComponent("handoff"), appURL: grapher)
        }
        guard case .failure(let before) = open() else { return XCTFail("an app Donovan never allowed opened") }
        XCTAssertEqual(before.code, .needsSandbox)
        AgentAppGrants.replace(["com.apple.grapher"])
        guard case .success(let files) = open() else { return XCTFail("an allowed app was refused") }
        XCTAssertEqual(files, [])
        XCTAssertTrue(AgentAppPolicy.needsSeparateInstance(bundle: "com.apple.grapher"), "a separate copy")
        XCTAssertTrue(AgentAppPolicy.isListed(bundle: "com.apple.grapher"), "checked again after the launch")
        XCTAssertFalse(AgentAppPolicy.isListed(bundle: "com.apple.TextEdit"), "a built-in was checked one by one")
    }

    /// first-F1: the old file grants nothing. An agent with a shell could write it, so Polycarp never reads it.
    func testNoFileAnAgentCanWriteGrantsAnOpen() throws {
        let config = dir.appendingPathComponent("config")
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        try Data("apps = [\"com.apple.grapher\"]\n".utf8).write(to: config.appendingPathComponent("agent-apps.toml"))
        setenv("POLYCARP_CONFIG_DIR", config.path, 1)
        defer { unsetenv("POLYCARP_CONFIG_DIR") }
        let grapher = try app("Grapher", ["CFBundleIdentifier": "com.apple.grapher"])
        XCTAssertEqual(AgentAppPolicy.refusal(app: "Grapher", bundle: "com.apple.grapher", appURL: grapher)?.code, .needsSandbox)
        let core = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("Sources/BaneySpacesCore/Hands/AgentAppList.swift"), encoding: .utf8)
        let policies = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("Sources/BaneySpacesCore/Hands/Policies.swift"), encoding: .utf8)
        for src in [core, policies] {
            XCTAssertFalse(src.contains("contents(atPath"), "first-F1: no grant is read from a file")
            XCTAssertFalse(src.contains("AgentAppList.load"))
        }
    }

    /// first-F1: only the app changes the list, only after a real click, and it reads its saved copy once at launch.
    func testOnlyDonovansClickInPolycarpAddsAnApp() throws {
        let router = try CursorSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let ask = try XCTUnwrap(HandsSourceTests.between("func askToAllow(target: String, verb: String) -> HandsEnvelope {", "AgentAppGrants.replace(AgentAppGrants.current.union([bundle]))", in: router))
        XCTAssertTrue(ask.contains("guard host.askToAllow(name) else {"), "the add follows the sheet")
        let delegate = try CursorSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate.contains("askToAllow: { AppAllowConsent.ask(app: $0) },"))
        XCTAssertEqual(delegate.components(separatedBy: "AgentAppGrants.loadSaved()").count, 2, "read once, at launch")
        let consent = try CursorSourceTests.code("Sources/BaneySpaces/LendConsent.swift")
        let sheet = try XCTUnwrap(HandsSourceTests.between("enum AppAllowConsent {", "enum AccessConsent {", in: consent))
        XCTAssertTrue(sheet.contains("if let why = LendConsent.notByHand(alert: alert, button: button, enabledAt: enabledAt) { return refuse(why) }"), "a real click only")
        XCTAssertTrue(sheet.contains("alert.addButton(withTitle: \"Don't Allow\")"), "the default (Return) refuses")
        XCTAssertLessThan(try XCTUnwrap(sheet.range(of: "\"Don't Allow\"")).lowerBound, try XCTUnwrap(sheet.range(of: "withTitle: \"Allow\"")).lowerBound)
        XCTAssertTrue(sheet.contains("button.isEnabled = false"))
        // Nothing else in the app writes the list.
        var writers = 0
        for file in ["Sources/BaneySpaces/Hands/HandsRouter.swift", "Sources/BaneySpaces/AppDelegate.swift", "Sources/BaneySpaces/Session/SessionController.swift"] {
            writers += try CursorSourceTests.code(file).components(separatedBy: "AgentAppGrants.save()").count - 1
        }
        XCTAssertEqual(writers, 2, "after the click, and on a removal")
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "allow-ask", args: ["add", "Grapher"])), "never from another Mac")
    }

    /// The saved copy the app reads at launch keeps only bundle ids of kinds that may be allowed.
    func testTheSavedCopyIsReadStrictly() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "polycarp-agent-apps-test-\(UUID().uuidString)"))
        defaults.set(["com.apple.grapher", "not an id", "com.apple.Terminal", "net.kovidgoyal.kitty"], forKey: AgentAppGrants.defaultsKey)
        AgentAppGrants.loadSaved(defaults)
        XCTAssertEqual(AgentAppGrants.current, ["com.apple.grapher"])
        AgentAppGrants.replace(["org.videolan.vlc", "com.apple.grapher"])
        AgentAppGrants.save(defaults)
        XCTAssertEqual(defaults.stringArray(forKey: AgentAppGrants.defaultsKey), ["com.apple.grapher", "org.videolan.vlc"])
    }

    /// first-F1: every id the review found passing, and a browser, terminal or code runner that no list names, is refused
    /// even when allowed, under any spelling.
    func testAKindThatIsNeverAnAgentsStaysRefusedWhenAllowed() throws {
        let never = ["com.apple.Terminal", "COM.APPLE.TERMINAL", "com.mitchellh.ghostty", "com.apple.Safari", "com.1password.1password",
                     "com.apple.systempreferences", "com.apple.ScriptEditor2", "com.apple.dt.Xcode", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92",
                     "com.apple.finder", "com.apple.mail", "com.tinyspeck.slackmacgap", "com.baney.polycarp", "com.anthropic.claudefordesktop",
                     // From the review of #496 (first-F1): each passed the old list.
                     "company.thebrowser.dia", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly", "com.apple.SafariTechnologyPreview",
                     "app.zen-browser.zen", "com.kagi.kagimacOS", "com.duckduckgo.macos.browser", "net.kovidgoyal.kitty", "org.alacritty",
                     "com.github.wez.wezterm", "com.vscodium", "com.barebones.bbedit", "org.hammerspoon.Hammerspoon", "com.raycast.macos",
                     "com.stairways.keyboardmaestro.editor", "com.apple.Home", "com.apple.findmy", "com.apple.freeform", "com.apple.iBooksX"]
        AgentAppGrants.replace(Set(never))
        XCTAssertEqual(AgentAppGrants.current, [], "none can even be kept")
        for b in never {
            XCTAssertNotNil(AgentAppPolicy.neverListed(bundle: b), b)
            let e = AgentAppPolicy.refusal(app: "X", bundle: b, added: Set(never))
            XCTAssertEqual(e?.code, .needsSandbox, b)
            XCTAssertFalse(e?.suggestion.contains("agent allow X") ?? true, "\(b): never suggest allowing it")
            XCTAssertFalse(AgentAppPolicy.needsSeparateInstance(bundle: b, added: Set(never)), b)
        }
        // By what it is: an app no list names.
        let browser = try app("Surf", ["CFBundleIdentifier": "com.example.surf", "CFBundleURLTypes": [["CFBundleURLSchemes": ["HTTPS", "http"]]]])
        let editor = try app("Edit", ["CFBundleIdentifier": "com.example.edit", "LSApplicationCategoryType": "public.app-category.developer-tools"])
        let once = try app("Once", ["CFBundleIdentifier": "com.example.once", "LSMultipleInstancesProhibited": true])
        let fine = try app("Fine", ["CFBundleIdentifier": "com.example.fine", "CFBundleURLTypes": [["CFBundleURLSchemes": ["fine"]]]])
        let added: Set<String> = ["com.example.surf", "com.example.edit", "com.example.once", "com.example.fine", "com.example.gone"]
        XCTAssertTrue(try XCTUnwrap(AgentAppPolicy.refusal(app: "Surf", bundle: "com.example.surf", appURL: browser, added: added)).message.contains("browser"))
        XCTAssertTrue(try XCTUnwrap(AgentAppPolicy.refusal(app: "Edit", bundle: "com.example.edit", appURL: editor, added: added)).message.contains("developer tool"))
        XCTAssertTrue(try XCTUnwrap(AgentAppPolicy.refusal(app: "Once", bundle: "com.example.once", appURL: once, added: added)).message.contains("one copy only"))
        XCTAssertNil(AgentAppPolicy.refusal(app: "Fine", bundle: "com.example.fine", appURL: fine, added: added))
        XCTAssertNotNil(AgentAppPolicy.refusal(app: "Gone", bundle: "com.example.gone", appURL: nil, added: added), "no bundle to read: refused")
    }

    /// second-F6: an allowed app's open that started no copy of its own, or reached Donovan's running copy, is refused.
    func testAnAllowedAppMustStartItsOwnCopy() throws {
        XCTAssertNil(ListedOpen.refusal(app: "VLC", newCopies: 1, oldCopyWindows: 0))
        XCTAssertEqual(ListedOpen.refusal(app: "Obsidian", newCopies: 0, oldCopyWindows: 0)?.code, .needsSandbox, "a single-instance lock handed it over")
        XCTAssertEqual(ListedOpen.refusal(app: "Notion", newCopies: 1, oldCopyWindows: 1)?.code, .needsSandbox, "his copy opened a window")
        let router = try CursorSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("let listed = access != .full && AgentAppPolicy.isListed(bundle: bundle)"))
        XCTAssertTrue(router.contains("if let e = ListedOpen.refusal(app: display, newCopies: now.subtracting(pidsBefore).count, oldCopyWindows: old.count) {"))
    }

    /// second-F6: "restores nothing it saved" is promised only for the built-ins.
    func testOnlyTheBuiltInsArePromisedToRestoreNothing() throws {
        let readme = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("README.md"), encoding: .utf8)
        let skill = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("skill/SKILL.md"), encoding: .utf8)
        let core = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("Sources/BaneySpacesCore/Hands/AgentAppList.swift"), encoding: .utf8)
        for (name, text) in [("README", readme), ("SKILL", skill), ("AgentAppList", core)] {
            XCTAssertFalse(text.contains("agent-apps.toml"), "\(name): the file is gone")
            XCTAssertFalse(text.contains("Each listed app starts as a separate copy that restores nothing"), name)
        }
        XCTAssertTrue(readme.contains("the three built-in apps are known to restore nothing"))
    }

    /// An app Donovan hasn't allowed says how to ask him, and lists what may open now.
    func testTheRefusalSaysHowDonovanAllowsAnApp() throws {
        let e = try XCTUnwrap(AgentAppPolicy.refusal(app: "Grapher", bundle: "com.apple.grapher", added: ["org.videolan.vlc"]))
        XCTAssertTrue(e.message.contains("Donovan hasn't allowed it"), e.message)
        XCTAssertTrue(e.suggestion.contains("`polycarp-spaces agent allow Grapher`: Polycarp asks Donovan in a sheet"), e.suggestion)
        XCTAssertTrue(e.suggestion.contains("Calculator, and org.videolan.vlc"), e.suggestion)
    }
}

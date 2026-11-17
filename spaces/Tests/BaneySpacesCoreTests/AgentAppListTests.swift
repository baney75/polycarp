import BaneySpacesCore
import XCTest

/// `agent-apps.toml`: apps Donovan lets agents open on the agent workspace (council gap A1: "agents can open only three
/// test apps"). A listed app opens as a separate copy; a kind that is never an agent's stays refused when listed.
final class AgentAppListTests: XCTestCase {
    private var dir: URL!
    private var savedEnv: String?

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-agent-apps-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        savedEnv = ProcessInfo.processInfo.environment["POLYCARP_CONFIG_DIR"]
        setenv("POLYCARP_CONFIG_DIR", dir.path, 1)
    }

    override func tearDownWithError() throws {
        if let savedEnv { setenv("POLYCARP_CONFIG_DIR", savedEnv, 1) } else { unsetenv("POLYCARP_CONFIG_DIR") }
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ text: String) throws {
        try Data(text.utf8).write(to: dir.appendingPathComponent(AgentAppList.name))
    }

    /// The gate every caller uses (`AgentOpenGate.check`, as on main) opens an app once Donovan lists it, and not before.
    func testAListedAppOpensOnTheAgentWorkspace() throws {
        let handoff = dir.appendingPathComponent("handoff")
        func open() -> Result<[String], HandsError> {
            AgentOpenGate.check(app: "Grapher", bundle: "com.apple.grapher", targets: [], handoff: handoff)
        }
        guard case .failure(let before) = open() else { return XCTFail("an unlisted app opened") }
        XCTAssertEqual(before.code, .needsSandbox)
        try write("# apps agents may open\napps = [\n  \"com.apple.grapher\", # Grapher\n  \"org.videolan.vlc\",\n]\n")
        guard case .success(let files) = open() else { return XCTFail("a listed app was refused") }
        XCTAssertEqual(files, [])
        XCTAssertTrue(AgentAppPolicy.needsSeparateInstance(bundle: "com.apple.grapher"), "a separate copy that restores nothing")
        XCTAssertTrue(AgentAppPolicy.needsSeparateInstance(bundle: "org.videolan.vlc"))
        XCTAssertFalse(AgentAppPolicy.needsSeparateInstance(bundle: "com.example.Unlisted"))
    }

    /// The scope guard holds: a browser, a shell, a password manager, an app that runs code or holds his accounts, or
    /// Polycarp itself is refused even when listed, under any spelling.
    func testAKindThatIsNeverAnAgentsStaysRefusedWhenListed() throws {
        let never = ["com.apple.Terminal", "COM.APPLE.TERMINAL", "com.mitchellh.ghostty", "net.imput.helium", "com.apple.Safari", "com.1password.1password",
                     "com.apple.systempreferences", "com.apple.ScriptEditor2", "com.apple.dt.Xcode", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92",
                     "com.apple.finder", "com.apple.mail", "com.tinyspeck.slackmacgap", "com.baney.polycarp", "com.anthropic.claudefordesktop"]
        try write("apps = [" + never.map { "\"\($0)\"" }.joined(separator: ", ") + "]")
        let list = AgentAppList.load()
        XCTAssertEqual(list.apps, [])
        XCTAssertEqual(list.problems.count, never.count)
        for b in never {
            let e = AgentAppPolicy.refusal(app: "X", bundle: b, added: Set(never))
            XCTAssertEqual(e?.code, .needsSandbox, b)
            XCTAssertFalse(e?.suggestion.contains("agent-apps.toml") ?? true, "\(b): never suggest listing it")
            XCTAssertFalse(AgentAppPolicy.needsSeparateInstance(bundle: b, added: Set(never)), b)
        }
    }

    func testTheFileIsReadStrictly() {
        XCTAssertEqual(AgentAppList.parse("").apps, [])
        XCTAssertEqual(AgentAppList.parse("[other]\nx = 1\n").apps, [])
        XCTAssertEqual(AgentAppList.parse("apps = [\"com.apple.grapher\"]").apps, ["com.apple.grapher"])
        XCTAssertEqual(AgentAppList.parse("# apps = [\"com.apple.grapher\"]").apps, [], "a commented line lists nothing")
        let bad = AgentAppList.parse("apps = [grapher, \"not an id\", \"com.apple.grapher\"]")
        XCTAssertEqual(bad.apps, ["com.apple.grapher"])
        XCTAssertEqual(bad.problems.count, 2)
        XCTAssertEqual(AgentAppList.parse("apps = [\"com.apple.grapher\"").problems, ["apps: the list has no closing ]"])
    }

    /// An unlisted app's refusal tells the agent where Donovan can allow it, and lists what it may open now.
    func testTheRefusalSaysHowDonovanAllowsAnApp() throws {
        let e = try XCTUnwrap(AgentAppPolicy.refusal(app: "Grapher", bundle: "com.apple.grapher", added: ["org.videolan.vlc"]))
        XCTAssertTrue(e.message.contains("hasn't listed it in agent-apps.toml"), e.message)
        XCTAssertTrue(e.suggestion.contains("\"com.apple.grapher\" to the apps list in ~/.config/polycarp/agent-apps.toml"), e.suggestion)
        XCTAssertTrue(e.suggestion.contains("Calculator, and org.videolan.vlc"), e.suggestion)
    }
}

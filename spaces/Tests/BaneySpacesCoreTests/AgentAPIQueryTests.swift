import BaneySpacesCore
import CoreGraphics
import XCTest

/// The agent API's queries as `AgentAPI.result` builds them, validated against `spec/agent-api.schema.json`, and the
/// scope rule: a window outside the caller's scope is in no list, and the focused one is reported as null.
final class AgentAPIQueryTests: XCTestCase {
    static let main = "37D8832A-2D66-02CA-B9F7-8F30A301B230", side = "5A1D0C4E-0000-4000-8000-00000000BEEF"

    static func facts() -> AgentAPI.Facts {
        let mine = AgentAPI.WindowFacts(window: HandsWindow(id: 4211, pid: 901, app: "TextEdit", bundle: "com.apple.TextEdit", title: "Untitled", workspace: 9),
                                        frame: CGRect(x: 0, y: 33, width: 756.5, height: 949))
        let his = AgentAPI.WindowFacts(window: HandsWindow(id: 77, pid: 300, app: "Helium", bundle: "net.imput.helium", title: "Bank statement", workspace: 1),
                                       frame: CGRect(x: 10, y: 40, width: 1200, height: 800))
        let other = AgentAPI.WindowFacts(window: HandsWindow(id: 78, pid: 301, app: "Ghostty", bundle: "com.mitchellh.ghostty", title: "zsh", workspace: 2),
                                         frame: nil, minimized: true)
        return AgentAPI.Facts(windows: [his, other, mine], current: 1, shown: [main: 1, side: 2], focusedDisplay: main, focusedWindow: 77,
                              agentWorkspace: 9, names: [3: "Writing"],
                              displays: [.init(id: main, name: "Built-in Retina Display", frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                                               visible: CGRect(x: 0, y: 33, width: 1512, height: 949), scale: 2),
                                         .init(id: side, name: "Sidecar", frame: CGRect(x: 1512, y: 0, width: 1366, height: 1024),
                                               visible: CGRect(x: 1512, y: 0, width: 1366, height: 1024), scale: 2)],
                              theme: .init(theme: "baneyspaces", palette: "auto"), savedLayouts: ["review", "dev"])
    }

    static let agentView = AgentAPI.View(access: .standard, inScope: [4211])
    static let fullView = AgentAPI.View(access: .full, inScope: [4211, 77, 78])

    func testEveryQueryValidatesAgainstTheSchemaInBothScopes() throws {
        let schema = try AgentAPISchema.load()
        for view in [Self.agentView, Self.fullView] {
            for q in AgentAPI.Query.allCases {
                let json = AgentAPI.result(q, Self.facts(), view).text
                XCTAssertEqual(schema.problems(json: json, against: "\(q.rawValue)_result"), [], "\(q.rawValue) in scope \(view.scope)")
            }
        }
    }

    func testAWindowOutOfScopeIsInNoListAndItsTitleNeverLeaves() {
        let f = Self.facts()
        let text = AgentAPI.result(.state, f, Self.agentView).text
        XCTAssertFalse(text.contains("Bank statement"))
        XCTAssertFalse(text.contains("Helium"))
        XCTAssertFalse(text.contains("\"id\":77"))
        let data = AgentAPI.result(.state, f, Self.agentView)
        XCTAssertEqual(data["scope"]?.string, "agent")
        XCTAssertEqual(data["windows"]?.array?.compactMap { $0["id"]?.int }, [4211])
        XCTAssertEqual(data["focused"]?["window"], .null, "Donovan's focused window is out of scope")
        let ws1 = data["workspaces"]?.array?.first { $0["number"]?.int == 1 }
        XCTAssertEqual(ws1?["windows"]?.int, 1, "counts stay: they say nothing about the window")
        XCTAssertEqual(ws1?["window_ids"]?.array, [])
    }

    func testFullAccessSeesEveryWindowAndTheFocusedOne() {
        let data = AgentAPI.result(.state, Self.facts(), Self.fullView)
        XCTAssertEqual(data["scope"]?.string, "all")
        XCTAssertEqual(data["windows"]?.array?.compactMap { $0["id"]?.int }, [77, 78, 4211])
        XCTAssertEqual(data["focused"]?["window"]?.int, 77)
        let helium = data["windows"]?.array?.first { $0["id"]?.int == 77 }
        XCTAssertEqual(helium?["focused"]?.bool, true)
        XCTAssertEqual(helium?["display"]?.string, Self.main)
    }

    func testDisplaysAndWorkspacesSayWhatEachDisplayShows() {
        let data = AgentAPI.result(.state, Self.facts(), Self.agentView)
        let displays = data["displays"]?.array ?? []
        XCTAssertEqual(displays.map { $0["workspace"]?.int }, [1, 2])
        XCTAssertEqual(displays.map { $0["main"]?.bool }, [true, false])
        XCTAssertEqual(displays.map { $0["focused"]?.bool }, [true, false])
        let rows = data["workspaces"]?.array ?? []
        XCTAssertEqual(rows.count, 9)
        XCTAssertEqual(rows.filter { $0["shown"]?.bool == true }.compactMap { $0["number"]?.int }, [1, 2])
        XCTAssertEqual(rows[1]["display"]?.string, Self.side)
        XCTAssertEqual(rows[2]["name"]?.string, "Writing")
        XCTAssertEqual(rows[8]["agent"]?.bool, true)
        XCTAssertEqual(rows[8]["window_ids"]?.array, [.int(4211)])
        let agentWindow = data["windows"]?.array?.first
        XCTAssertEqual(agentWindow?["display"], .null, "the agent workspace is out of sight")
        XCTAssertEqual(agentWindow?["agent"]?.bool, true)
        XCTAssertEqual(agentWindow?["frame"]?["width"], .double(756.5))
    }

    func testLayoutAndThemeQueries() {
        let layout = AgentAPI.result(.layout, Self.facts(), Self.fullView)
        XCTAssertEqual(layout["layout"]?["workspaces"]?.array?.compactMap { $0["number"]?.int }, [1, 2, 9])
        XCTAssertEqual(layout["layout"]?["saved"]?.array, [.string("dev"), .string("review")])
        var f = Self.facts()
        f.theme.polycarp = (name: "dawn", title: "Dawn", mode: "light")
        let theme = AgentAPI.result(.theme, f, Self.agentView)
        XCTAssertEqual(theme["theme"]?["polycarp_theme"]?["name"]?.string, "dawn")
        XCTAssertTrue(AgentAPI.text(.theme, theme).contains("Polycarp theme Dawn draws instead"))
    }

    func testTheTextFormIsShortAndScoped() {
        let text = AgentAPI.text(.state, AgentAPI.result(.state, Self.facts(), Self.agentView))
        XCTAssertTrue(text.hasPrefix("scope: agent (access default)"))
        XCTAssertTrue(text.contains("window 4211\tworkspace 9\tTextEdit\tUntitled"))
        XCTAssertFalse(text.contains("Bank statement"))
    }

    func testQueryIsAReadOnlyToolOverMCPAndOnTheCommandLine() throws {
        let tool = try XCTUnwrap(HandsTools.tool(verb: "query"))
        XCTAssertFalse(tool.acts)
        XCTAssertFalse(AgentAccessGate.changes.contains("query"), "Read Only may query")
        let listed = HandsMCP.toolList().array?.first { $0["name"]?.string == "query" }
        XCTAssertEqual(listed?["annotations"]?["readOnlyHint"]?.bool, true)
        guard case .success(let r) = HandsParse.command(["query", "displays"]) else { return XCTFail("query displays didn't parse") }
        XCTAssertEqual(r.string("what"), "displays")
    }
}

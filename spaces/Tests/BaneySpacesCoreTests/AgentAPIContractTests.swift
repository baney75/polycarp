import XCTest

/// `spec/agent-api.md` and `spec/agent-api.schema.json`: the contract the Mac app and the Windows daemon follow. These
/// checks need no display: the doc names a schema entry for every query, command and event, the doc's examples validate,
/// and the validator rejects what the contract forbids (so a passing check means something).
final class AgentAPIContractTests: XCTestCase {
    static let queries = ["windows", "workspaces", "displays", "focused", "layout", "theme", "state"]
    static let commands = ["switch": "switch_result", "focus": "focus_result", "move": "move_result", "frame": "frame_result",
                           "layout": "layout_command_result", "theme-set": "theme_set_result"]
    static let events = ["hello", "workspace_switched", "window_focused", "window_created", "window_closed", "window_moved",
                         "theme_changed", "lagged"]

    var doc: String { (try? Repo.text("spec/agent-api.md")) ?? "" }

    func testTheDocNamesEveryQueryCommandAndEventAndTheSchemaHasEach() throws {
        let schema = try AgentAPISchema.load()
        for q in Self.queries {
            XCTAssertTrue(doc.contains("| `\(q)` | `\(q)_result` |"), "the doc's query table lacks \(q)")
            XCTAssertNotNil(schema.defs["\(q)_result"], "no $defs/\(q)_result")
        }
        for (c, def) in Self.commands {
            XCTAssertTrue(doc.contains("| `\(c)` |"), "the doc's command table lacks \(c)")
            XCTAssertNotNil(schema.defs[def], "no $defs/\(def)")
        }
        let eventDef = try XCTUnwrap(schema.defs["event"] as? [String: Any])
        let branches = (eventDef["oneOf"] as? [[String: Any]] ?? []).compactMap { b in
            ((b["properties"] as? [String: Any])?["type"] as? [String: Any])?["const"] as? String
        }
        for e in Self.events {
            XCTAssertTrue(doc.contains("| `\(e)` |"), "the doc's event table lacks \(e)")
            XCTAssertTrue(branches.contains(e), "the event schema has no branch for \(e)")
        }
    }

    func testEveryRefInTheSchemaResolves() throws {
        let text = try Repo.text("spec/agent-api.schema.json")
        let schema = try AgentAPISchema.load()
        let refs = text.components(separatedBy: "\"$ref\": \"#/$defs/").dropFirst().map { String($0.prefix { $0 != "\"" }) }
        XCTAssertFalse(refs.isEmpty)
        for r in Set(refs) { XCTAssertNotNil(schema.defs[r], "$ref to a missing $defs/\(r)") }
    }

    func testTheDocsExamplesValidate() throws {
        let schema = try AgentAPISchema.load()
        let blocks = doc.components(separatedBy: "```json\n").dropFirst().map { $0.components(separatedBy: "\n```")[0] }
        XCTAssertEqual(blocks.count, 2)
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(blocks[0].utf8)) as? [String: Any])
        XCTAssertEqual(schema.problems(try XCTUnwrap(envelope["data"]), against: "focused_result"), [])
        XCTAssertEqual(schema.problems(json: blocks[1], against: "event"), [])
    }

    func testAFullStateValidatesAndUnknownFieldsAreAllowed() throws {
        let schema = try AgentAPISchema.load()
        XCTAssertEqual(schema.problems(json: Self.state, against: "state_result"), [])
        var withExtra = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.state.utf8)) as? [String: Any])
        withExtra["added_in_a_later_build"] = ["anything": true]
        XCTAssertEqual(schema.problems(withExtra, against: "state_result"), [], "clients ignore unknown fields, so the schema allows them")
        XCTAssertEqual(schema.problems(json: #"{"version":1,"seq":3,"at":1,"type":"a_type_from_later","data":{}}"#, against: "event"), [],
                       "an unknown event type is allowed")
    }

    func testTheValidatorRejectsWhatTheContractForbids() throws {
        let schema = try AgentAPISchema.load()
        let noTitle = Self.window.replacingOccurrences(of: #""title":"Untitled","#, with: "")
        XCTAssertTrue(schema.problems(json: noTitle, against: "window").contains("$.title: missing"))
        XCTAssertFalse(schema.problems(json: Self.state.replacingOccurrences(of: #""version":1"#, with: #""version":2"#), against: "state_result").isEmpty)
        XCTAssertFalse(schema.problems(json: Self.window.replacingOccurrences(of: #""workspace":9"#, with: #""workspace":10"#), against: "window").isEmpty)
        XCTAssertFalse(schema.problems(json: #"{"version":1,"seq":0,"at":1,"type":"hello","data":{"scope":"agent"}}"#, against: "event").isEmpty,
                       "a hello without its state is not a hello")
        XCTAssertFalse(schema.problems(json: #"{"version":1,"seq":1,"at":1,"type":"workspace_switched","data":{"display":null,"from":1,"to":0}}"#, against: "event").isEmpty)
        XCTAssertFalse(schema.problems(json: #"{"version":1,"action":"save","name":"has space"}"#, against: "layout_command_result").isEmpty)
        XCTAssertFalse(schema.problems(json: #"{"version":1,"scope":"everything","access":"full","displays":[]}"#, against: "displays_result").isEmpty)
    }

    static let display = #"{"id":"37D8832A-2D66-02CA-B9F7-8F30A301B230","name":"Built-in Retina Display","main":true,"frame":{"x":0,"y":0,"width":1512,"height":982},"visible":{"x":0,"y":33,"width":1512,"height":949},"scale":2,"workspace":1,"focused":true}"#
    static let window = #"{"id":4211,"pid":901,"app":"TextEdit","bundle":"com.apple.TextEdit","title":"Untitled","workspace":9,"display":null,"frame":{"x":0,"y":33,"width":756,"height":949},"focused":false,"agent":true,"minimized":false}"#
    static var workspaces: String {
        (1...9).map { n in
            #"{"number":\#(n),"name":null,"shown":\#(n == 1),"display":\#(n == 1 ? "\"37D8832A-2D66-02CA-B9F7-8F30A301B230\"" : "null"),"current":\#(n == 1),"agent":\#(n == 9),"windows":\#(n == 9 ? 1 : 0),"window_ids":\#(n == 9 ? "[4211]" : "[]")}"#
        }.joined(separator: ",")
    }
    static var state: String {
        #"{"version":1,"scope":"agent","access":"default","windows":[\#(window)],"current":1,"agent_workspace":9,"workspaces":[\#(workspaces)],"displays":[\#(display)],"focused":{"display":"37D8832A-2D66-02CA-B9F7-8F30A301B230","workspace":1,"window":null},"layout":{"workspaces":[{"number":9,"windows":[{"id":4211,"app":"TextEdit","title":"Untitled","frame":{"x":0,"y":33,"width":756,"height":949}}]}],"saved":["review"]},"theme":{"theme":"baneyspaces","palette":"auto","polycarp_theme":null}}"#
    }
}

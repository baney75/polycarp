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

    /// One `## ` section of the doc, without its heading.
    func section(_ title: String) -> String {
        guard let start = doc.range(of: "\n## \(title)\n") else { return "" }
        let rest = doc[start.upperBound...]
        return String(rest[..<(rest.range(of: "\n## ")?.lowerBound ?? rest.endIndex)])
    }

    /// Whether `text` says `phrase`, however either is wrapped: runs of white space count as one space (review r2
    /// first-F5), so rewrapping a paragraph never fails a check.
    func says(_ text: String, _ phrase: String) -> Bool {
        func flat(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        return flat(text).contains(flat(phrase))
    }

    /// A table row's cells, by its first cell's name, in one section.
    func row(_ name: String, in text: String) -> [String] {
        guard let line = text.split(separator: "\n").first(where: { $0.hasPrefix("| `\(name)` |") }) else { return [] }
        return line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    func testTheDocNamesEveryQueryCommandAndEventAndTheSchemaHasEach() throws {
        let schema = try AgentAPISchema.load()
        for q in Self.queries {
            XCTAssertTrue(doc.contains("| `\(q)` | `\(q)_result` |"), "the doc's query table lacks \(q)")
            XCTAssertNotNil(schema.defs["\(q)_result"], "no $defs/\(q)_result")
        }
        let commands = section("Commands")
        for (c, def) in Self.commands {
            // In the Commands table, with all four cells: the query table's `layout` row doesn't count (review F5).
            XCTAssertEqual(row(c, in: commands).count, 4, "the doc's command table lacks \(c)")
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
        guard blocks.count == 2 else { return XCTFail("the doc has \(blocks.count) json examples, not 2") }
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
        // A hello whose only defect is a missing state (review r2 second-F5): seq, access and events are all valid.
        let hello = #"{"scope":"agent","access":"default","events":["hello"]}"#
        XCTAssertEqual(schema.problems(json: hello, against: "hello_data"), ["$.state: missing"])
        XCTAssertFalse(schema.problems(json: #"{"version":1,"seq":1,"at":1,"type":"hello","data":\#(hello)}"#, against: "event").isEmpty,
                       "a hello without its state is not a hello")
        let whole = #"{"scope":"agent","access":"default","events":["hello"],"state":\#(Self.state)}"#
        XCTAssertEqual(schema.problems(json: #"{"version":1,"seq":1,"at":1,"type":"hello","data":\#(whole)}"#, against: "event"), [],
                       "the same hello with its state is one")
        XCTAssertFalse(schema.problems(json: #"{"version":1,"seq":1,"at":1,"type":"workspace_switched","data":{"display":null,"from":1,"to":0}}"#, against: "event").isEmpty)
        XCTAssertFalse(schema.problems(json: #"{"version":1,"action":"save","name":"has space"}"#, against: "layout_command_result").isEmpty)
        // ECMA-262's `$` is the very end, so a name with a line break after it is no name (review F7).
        XCTAssertFalse(schema.problems(json: #"{"version":1,"action":"save","name":"review\n"}"#, against: "layout_command_result").isEmpty)
        XCTAssertEqual(schema.problems(json: #"{"version":1,"action":"save","name":"review"}"#, against: "layout_command_result"), [])
        XCTAssertFalse(schema.problems(json: #"{"version":1,"scope":"everything","access":"full","displays":[]}"#, against: "displays_result").isEmpty)
    }

    // MARK: the rules review round 1 asked for (spec/agent-api.md)

    /// F1: one view control rule, and the command table says the same for every command. Round 2 first-F1 and
    /// second-F3: a shown workspace is a passing condition, so work on the agent workspace waits (`in_use`, `retry: safe`)
    /// whatever the setting, and only work off it is `permission_denied`.
    func testOneViewControlRuleAndTheTableAgrees() {
        let rule = section("View control")
        XCTAssertTrue(says(rule, "**One rule:** a command needs view control when it lands a window on, or changes a window in place on, a workspace other than the agent workspace."))
        // Round 2 first-F1: the rule once counted the workspace a window leaves, so a move onto the agent workspace
        // needed view control while the move row said it needed none. The rule now names the move row's exception.
        XCTAssertFalse(says(rule, "A command acts on the workspace a window lands on and the workspace of a window it changes"))
        XCTAssertTrue(says(rule, "`move` needs it unless it goes onto the agent workspace."))
        XCTAssertTrue(says(rule, "A `move` onto the agent workspace needs no view control from any workspace"))
        XCTAssertTrue(says(rule, "**Not while he looks:** a command that acts on the agent workspace never changes a workspace a display shows"))
        XCTAssertTrue(says(rule, "With view control or without, it answers `in_use`, `retry: safe`, and goes once no display shows them."))
        XCTAssertTrue(says(rule, "A shown workspace is a passing condition, so it is never `permission_denied`."))
        XCTAssertFalse(says(rule, "is never done, even with view control"), "the special case that two moves got around")
        let commands = section("Commands")
        let expected = [
            "switch": "always", "focus": "always",
            "move": "unless it goes onto the agent workspace (then `in_use` while the workspace it leaves or the agent workspace is shown)",
            "frame": "unless the window is on the agent workspace (then `in_use` while it is shown)",
            "layout": "`restore`, unless on the agent workspace (then `in_use` while it is shown)",
        ]
        for (c, column) in expected { XCTAssertEqual(row(c, in: commands).last, column, c) }
        let moveRow = row("move", in: commands).last ?? ""
        XCTAssertTrue(moveRow.hasPrefix("unless it goes onto the agent workspace") && says(rule, "`move` needs it " + "unless it goes onto the agent workspace"),
                      "the move row and the One rule name the same exception")
        XCTAssertTrue(row("theme-set", in: commands).last?.hasPrefix("never") == true)
        XCTAssertTrue(says(String(doc.prefix(1200)), "`theme-set` is the one stated exception"), "round 2 first-F3: the opening promise names it")
    }

    /// F2: the switch is never stored, so nothing an agent writes to disk turns view control on. A sealed stored value
    /// fails: another process can make the Keychain item first, with a key it knows.
    func testTheViewControlSwitchIsNeverStored() {
        let rule = section("View control")
        for phrase in ["The switch is never stored: it lives in the running app, is off at every launch",
                       "confirms it on Polycarp's own sheet with a real click or key",
                       "value leaves view control off: nothing on disk is read for it",
                       "A Keychain item planted with a matching seal, which an earlier draft of this rule trusted, is never read"] {
            XCTAssertTrue(says(rule, phrase), phrase)
        }
        XCTAssertTrue(says(rule, "On Windows, until the daemon has a confirmation that synthetic input can't answer, the switch stays off."),
                      "round 2 second-F1: no DPAPI seal, which any process of the user can open")
        XCTAssertFalse(says(doc, "DPAPI"))
        XCTAssertFalse(doc.contains("No command, tool or\n   setting an agent can reach turns it on"), "a claim the stored flag couldn't keep")
        XCTAssertFalse(rule.contains("MAC"), "a seal under a Keychain key another process can make first")
    }

    /// F3: no count or event says anything about a window out of scope.
    func testNothingCountsAWindowOutOfScope() throws {
        let scope = section("Scope")
        XCTAssertTrue(scope.contains("left out of every list, every count and every event"))
        // Round 2 second-F4: ids and pids rise globally, so the promise covers lists, counts and events and names that.
        XCTAssertFalse(says(scope, "no number that changes when it opens or closes"))
        XCTAssertTrue(says(scope, "that side channel is known and not closed"))
        XCTAssertTrue(scope.contains("focus moving between two windows outside scope sends no event"))
        let ws = try XCTUnwrap(try AgentAPISchema.load().defs["workspace"] as? [String: Any])
        let windows = try XCTUnwrap((ws["properties"] as? [String: Any])?["windows"] as? [String: Any])
        XCTAssertEqual(windows["description"] as? String, "The windows in scope on it: the length of window_ids.")
    }

    /// F4: Read Only refuses every command by name.
    func testReadOnlyRefusesEveryCommand() throws {
        let scope = section("Scope")
        let rule = try XCTUnwrap(scope.range(of: "**Read Only refuses every command**").map { String(scope[$0.lowerBound...]) })
        for c in Self.commands.keys where c != "layout" { XCTAssertTrue(rule.contains("`\(c)`"), c) }
        XCTAssertTrue(rule.contains("`layout save`") && rule.contains("`layout restore`"))
        XCTAssertTrue(rule.contains("with `permission_denied`, `retry: never`"))
    }

    /// F8 and F9: a layout holds only windows in scope, by identity, never by a window id that a restart reuses.
    func testLayoutsStayInScopeAndKeyWindowsByIdentity() throws {
        let commands = section("Commands")
        XCTAssertTrue(commands.contains("`layout save` records the ordinary windows in scope on one workspace"))
        XCTAssertTrue(says(commands, "Under scope `agent` only the agent workspace can be saved or restored"))
        XCTAssertTrue(says(commands, "It never moves a window to another workspace and never touches a window outside scope"))
        // Round 2 second-F2: one folder per workspace, names without case, no silent overwrite, list in scope.
        for phrase in ["`layouts/<workspace>/<name>.json`, so a save on one workspace never replaces a layout of another",
                       "Names are compared without case",
                       "answers `invalid_args`, `retry: never`, unless it passes `replace: true`",
                       "`layout list` and the `layout` query name only layouts of workspaces in the caller's scope"] {
            XCTAssertTrue(says(commands, phrase), phrase)
        }
        // Round 2 first-F4: creation order never picks a renamed document's window.
        XCTAssertTrue(says(doc, "Creation order decides only when no saved window of that bundle matches a live one by title and the saved and live counts of that bundle agree"))
        XCTAssertFalse(says(doc, "then by the same creation order."))
        XCTAssertNil(commands.range(of: #"by id\b"#, options: .regularExpression), "a saved window id can name another window after a restart")
        XCTAssertTrue(doc.contains("- **Window identity.** A window that must be known again once its id is gone"))
        let schema = try AgentAPISchema.load()
        let identity = try XCTUnwrap(schema.defs["window_identity"] as? [String: Any])
        XCTAssertEqual(identity["required"] as? [String], ["bundle", "title", "order"])
        XCTAssertNil((identity["properties"] as? [String: Any])?["id"])
        XCTAssertEqual(schema.problems(json: #"{"version":1,"action":"restore","name":"x","missing":[{"bundle":"com.apple.TextEdit","title":"Notes","order":0}]}"#, against: "layout_command_result"), [])
        XCTAssertFalse(schema.problems(json: #"{"version":1,"action":"restore","name":"x","missing":[{"app":"TextEdit","title":"Notes"}]}"#, against: "layout_command_result").isEmpty)
    }

    /// Round 2 (434 r2) second-S1: a layout name is unique per workspace only, so every list of saved layouts names the
    /// workspace too; a bare name would leave a client to guess which workspace a restore moves windows on.
    /// second-S3: `bundle` is never empty (a process with no bundle id is known by its executable's path).
    /// first-F2: one code for a bad argument, the one envelope.md names.
    func testSavedLayoutsNameTheirWorkspaceAndBadArgumentsHaveOneCode() throws {
        let schema = try AgentAPISchema.load()
        XCTAssertFalse(schema.problems(json: #"{"workspaces":[],"saved":["work","work"]}"#, against: "layout").isEmpty,
                       "a bare string array can't say which workspace each layout is on")
        XCTAssertFalse(schema.problems(json: #"{"version":1,"action":"list","saved":["work"]}"#, against: "layout_command_result").isEmpty)
        XCTAssertEqual(schema.problems(json: #"{"workspaces":[],"saved":[{"workspace":1,"name":"work"},{"workspace":3,"name":"work"}]}"#, against: "layout"), [])
        XCTAssertEqual(schema.problems(json: #"{"version":1,"action":"list","saved":[{"workspace":9,"name":"review"}]}"#, against: "layout_command_result"), [])
        XCTAssertFalse(schema.problems(json: #"{"workspaces":[],"saved":[{"name":"work"}]}"#, against: "layout").isEmpty)
        XCTAssertFalse(schema.problems(json: Self.window.replacingOccurrences(of: #""bundle":"com.apple.TextEdit""#, with: #""bundle":"""#), against: "window").isEmpty)
        XCTAssertTrue(says(doc, "a macOS process with no bundle id: the full path of its executable; `bundle` is never empty"))
        XCTAssertFalse(doc.contains("bad_arguments"), "envelope.md's code for a bad argument is invalid_args")
    }

    /// F10 and F11: what an Access change does to a listener, and one meaning for `seq` and `since`.
    func testListenersEndWhenAccessChangesAndSeqIsPerSubscriber() throws {
        let events = section("Events")
        XCTAssertTrue(events.contains("Every event is filtered by the scope in force when it is sent."))
        XCTAssertTrue(events.contains("When Donovan changes Access, the server ends every subscriber"))
        XCTAssertTrue(events.contains("**`seq` is per subscriber.**"))
        XCTAssertTrue(events.contains("a call without `since` starts the session's events again and answers `hello` with `next: 1`"))
        let schema = try AgentAPISchema.load()
        XCTAssertEqual(schema.problems(json: #"{"version":1,"events":[],"next":0}"#, against: "events_result"), [])
        XCTAssertFalse(schema.problems(json: #"{"version":1,"seq":0,"at":1,"type":"lagged","data":{"missed":2}}"#, against: "event").isEmpty, "seq starts at 1")
    }

    /// F6: the Checks section says what runs today; the probe is named as not written until it is.
    func testTheChecksSectionMatchesWhatExists() {
        let checks = section("Checks")
        let probe = Repo.root.appendingPathComponent("scripts/agent-api-probe.swift").path
        if !FileManager.default.fileExists(atPath: probe) {
            XCTAssertTrue(checks.contains("`scripts/agent-api-probe.swift` (not written yet)"))
        }
        XCTAssertFalse(checks.contains("real query results and the event\n  stream from the model"), "the contract test reads no model")
    }

    static let display = #"{"id":"37D8832A-2D66-02CA-B9F7-8F30A301B230","name":"Built-in Retina Display","main":true,"frame":{"x":0,"y":0,"width":1512,"height":982},"visible":{"x":0,"y":33,"width":1512,"height":949},"scale":2,"workspace":1,"focused":true}"#
    static let window = #"{"id":4211,"pid":901,"app":"TextEdit","bundle":"com.apple.TextEdit","title":"Untitled","workspace":9,"display":null,"frame":{"x":0,"y":33,"width":756,"height":949},"focused":false,"agent":true,"minimized":false}"#
    static var workspaces: String {
        (1...9).map { n in
            #"{"number":\#(n),"name":null,"shown":\#(n == 1),"display":\#(n == 1 ? "\"37D8832A-2D66-02CA-B9F7-8F30A301B230\"" : "null"),"current":\#(n == 1),"agent":\#(n == 9),"windows":\#(n == 9 ? 1 : 0),"window_ids":\#(n == 9 ? "[4211]" : "[]")}"#
        }.joined(separator: ",")
    }
    static var state: String {
        #"{"version":1,"scope":"agent","access":"default","windows":[\#(window)],"current":1,"agent_workspace":9,"workspaces":[\#(workspaces)],"displays":[\#(display)],"focused":{"display":"37D8832A-2D66-02CA-B9F7-8F30A301B230","workspace":1,"window":null},"layout":{"workspaces":[{"number":9,"windows":[{"id":4211,"app":"TextEdit","title":"Untitled","frame":{"x":0,"y":33,"width":756,"height":949}}]}],"saved":[{"workspace":9,"name":"review"}]},"theme":{"theme":"baneyspaces","palette":"auto","polycarp_theme":null}}"#
    }
}

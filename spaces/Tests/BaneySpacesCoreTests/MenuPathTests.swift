import XCTest
@testable import BaneySpacesCore

/// Item C: a menu-bar command by path. The tree is built by hand in the shape the engine's menubar surface reads
/// (AXMenuBar and AXMenu are role menu, AXMenuBarItem and AXMenuItem are menuitem); live opens are stopped, so no
/// recorded menu bar yet.
final class MenuPathTests: XCTestCase {
    static func item(_ name: String, _ e: Int, states: [String] = [], menu: [JSONValue]? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["role": "menuitem", "name": .string(name), "ref_id": .string("@sm:e\(e)")]
        if !states.isEmpty { o["states"] = .array(states.map(JSONValue.string)) }
        if let menu { o["children"] = .array([.object(["role": "menu", "children": .array(menu)])]) }
        return .object(o)
    }

    static let bar: JSONValue = .object(["role": "menu", "children": .array([
        item("Apple", 1, menu: [item("About This Mac", 2)]),
        item("File", 3, menu: [item("New", 4), .object(["role": "menuitem", "ref_id": "@sm:e5"]), item("Save As\u{2026}", 6), item("Revert To", 7, menu: [item("Last Saved", 8)])]),
        item("Format", 9, menu: [item("Font", 10, menu: [item("Bold", 11), item("Italic", 12, states: ["disabled"])])]),
    ])])

    func testAPathOfTitlesFindsTheCommandsRef() {
        XCTAssertEqual(MenuPath.parse(" Format>Font >  Bold "), ["Format", "Font", "Bold"])
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["Format", "Font", "Bold"]), .item(ref: "@sm:e11", path: ["Format", "Font", "Bold"]))
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["file", "save as..."]), .item(ref: "@sm:e6", path: ["File", "Save As\u{2026}"]), "any case, three dots for the ellipsis")
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["File", "Save As"]), .item(ref: "@sm:e6", path: ["File", "Save As\u{2026}"]))
    }

    func testAMissOrAStopShortSaysWhatIsThere() {
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["Edit", "Copy"]), .missing(level: 0, choices: ["Apple", "File", "Format"]))
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["File", "Close"]), .missing(level: 1, choices: ["New", "Save As\u{2026}", "Revert To"]), "a separator has no title")
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["Format", "Font"]), .submenu(path: ["Format", "Font"], choices: ["Bold", "Italic"]))
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["Format", "Font", "Italic"]), .disabled(path: ["Format", "Font", "Italic"]))
        XCTAssertEqual(MenuPath.find(Self.bar, path: []), .submenu(path: [], choices: ["Apple", "File", "Format"]))
    }

    /// The error never tells the agent to press something else: a read, or none.
    func testErrorsNameTheChoicesAndAReadOrNone() throws {
        let miss = try XCTUnwrap(MenuPath.error(.missing(level: 1, choices: ["New", "Save As\u{2026}"]), path: ["File", "Close"], window: 7))
        XCTAssertTrue(miss.message.contains("no \"Close\" in File; there: New, Save As\u{2026}"), miss.message)
        XCTAssertEqual(miss.nextCall, .null)
        let grey = try XCTUnwrap(MenuPath.error(.disabled(path: ["Format", "Font", "Italic"]), path: ["Format", "Font", "Italic"], window: 7))
        XCTAssertEqual(grey.nextCall, HandsError.call("snapshot", ["window": 7]))
        XCTAssertNil(MenuPath.error(.item(ref: "@sm:e11", path: []), path: [], window: 7))
    }

    func testTheMenuToolIsListedAndActs() throws {
        let menu = try XCTUnwrap(HandsTools.all.first { $0.verb == "menu" })
        XCTAssertTrue(menu.acts)
        XCTAssertTrue(menu.summary.contains(#"{"window":4211,"path":"Format > Font > Bold"}"#), "one example call")
        XCTAssertTrue(AgentAccessGate.changes.contains("menu"), "Read Only refuses it")
        XCTAssertTrue(menu.params.contains { $0.name == "wait" }, "it waits while Donovan uses the app, like every action")
    }

    /// A menu command goes to the app's key window: sent only when that can be nothing but the agent's window.
    func testTheCommandIsSentOnlyWhenTheKeyWindowIsTheAgentsOne() {
        func r(ws: Bool = true, owned: Bool = true, others: Int = 0, focused: UInt32? = 7, front: Bool = false) -> HandsErrorCode? {
            MenuPath.refusal(app: "TextEdit", window: 7, onAgentWorkspace: ws, agentOwned: owned, otherWindows: others, focusedWindow: focused, front: front)?.code
        }
        XCTAssertNil(r())
        XCTAssertEqual(r(owned: false), .needsLend, "Donovan's own process on the agent workspace")
        XCTAssertEqual(r(front: true), .inUse)
        XCTAssertEqual(r(others: 1), .notSupported, "another window could be the key one")
        XCTAssertEqual(r(focused: 8), .notSupported)
        XCTAssertEqual(r(focused: nil), .notSupported, "unknown focus is no proof")
        XCTAssertNil(r(ws: false, owned: false), "a lent app with this its one window, focused, not in front")
    }
}

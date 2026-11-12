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

    /// first-F1: only the agent's own copy, whatever the workspace (lent, or Donovan's own under Full Access).
    func testOnlyTheAgentsOwnCopyEverGetsAMenuCommand() {
        func r(owned: Bool = true, others: Int = 0, focused: UInt32? = 7, front: Bool = false) -> HandsError? {
            MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: owned, otherWindows: others, focusedWindow: focused, front: front)
        }
        XCTAssertNil(r())
        let lent = r(owned: false)
        XCTAssertEqual(lent?.code, .needsLend, "a lent window, or Donovan's own window under Full Access: his process either way")
        XCTAssertTrue(lent?.message.contains("menus work only in the agent's own copy") == true)
        XCTAssertEqual(lent?.nextCall, HandsError.call("open", ["app": "TextEdit"]))
        XCTAssertEqual(r(owned: false, front: true)?.code, .needsLend, "ownership first")
        XCTAssertEqual(r(front: true)?.code, .inUse)
        XCTAssertEqual(r(others: 1)?.code, .notSupported)
        XCTAssertEqual(r(focused: nil)?.code, .notSupported, "unknown focus is no proof")
    }

    /// first-F4: the focus refusal names no call that can't work.
    func testTheFocusRefusalSaysNoCallFocusesTheWindow() throws {
        let e = try XCTUnwrap(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, otherWindows: 0, focusedWindow: 8, front: false))
        XCTAssertFalse(e.suggestion.contains("`click` an element in this window first"))
        XCTAssertTrue(e.suggestion.contains("cannot focus a window"), e.suggestion)
        XCTAssertEqual(e.nextCall, .null)
    }

    /// first-F2: the Apple menu by its place in the bar, in any language and with no title at all.
    func testTheAppleMenuIsRefusedByPositionNotTitle() throws {
        XCTAssertEqual(MenuPath.find(Self.bar, path: ["Apple", "About This Mac"]), .appleMenu)
        guard case .object(var o) = Self.bar, var kids = o["children"]?.array, case .object(var apple) = kids[0] else { return XCTFail() }
        apple["name"] = "Pomme"
        kids[0] = .object(apple); o["children"] = .array(kids)
        XCTAssertEqual(MenuPath.find(.object(o), path: ["Pomme", "About This Mac"]), .appleMenu, "French")
        apple["name"] = nil
        kids[0] = .object(apple); o["children"] = .array(kids)
        XCTAssertEqual(MenuPath.find(.object(o), path: ["File", "New"]), .item(ref: "@sm:e4", path: ["File", "New"]), "an untitled Apple menu doesn't shift the bar")
        XCTAssertTrue(MenuPath.inAppMenu(.object(o), path: ["File"]), "the untitled Apple menu still counts: File is second, the app menu's place")
        XCTAssertFalse(MenuPath.inAppMenu(.object(o), path: ["Format"]))
        let e = try XCTUnwrap(MenuPath.error(.appleMenu, path: ["Apple"], window: 7))
        XCTAssertTrue(e.message.contains("whole Mac"), e.message)
    }

    /// first-F2: Quit, Hide Others and Services in the app menu, by identifier, then key equivalent, title last.
    func testQuitHideOthersAndServicesAreRefusedInTheAppMenu() {
        typealias I = MenuPath.AppMenuItem
        func refused(_ i: I) -> Bool { MenuPath.appMenuRefusal(i) != nil }
        XCTAssertTrue(refused(I(identifier: "terminate:", title: "Beenden")))
        XCTAssertTrue(refused(I(cmdChar: "Q", modifiers: 0, title: "TextEdit beenden")), "cmd+q in German")
        XCTAssertTrue(refused(I(cmdChar: "Q", modifiers: 2, title: "Quit and Keep Windows")), "opt+cmd+q")
        XCTAssertTrue(refused(I(cmdChar: "H", modifiers: 2, title: "Andere ausblenden")), "opt+cmd+h")
        XCTAssertTrue(refused(I(title: "Services")), "no key equivalent: the title, last")
        XCTAssertTrue(refused(I(title: "Quit TextEdit")))
        XCTAssertFalse(refused(I(cmdChar: "H", modifiers: 0, title: "Hide TextEdit")), "plain Hide hides only this app")
        XCTAssertFalse(refused(I(cmdChar: ",", modifiers: 0, title: "Settings\u{2026}")))
        XCTAssertFalse(refused(I(cmdChar: "S", modifiers: 0, title: "Quitter-ish but cmd+s")), "a key equivalent wins over the title")
        XCTAssertTrue(MenuPath.appMenuRefusal(I(cmdChar: "Q", modifiers: 0, title: "Quit TextEdit"))?.message.contains("no app is ever quit") == true)
    }

    /// first-F3: a panel after the press is found by what it is, cancelled, and refused; an alert sheet is not one.
    func testAnOpenOrSavePanelAfterThePressIsFoundAndRefused() {
        let doc = AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow", title: "notes.txt", children: [AXNodeInfo(role: "AXTextArea")])
        let save = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXTextField"), AXNodeInfo(role: "AXPopUpButton"), AXNodeInfo(role: "AXStaticText", value: "Where:"),
                                                           AXNodeInfo(role: "AXButton", title: "Cancel"), AXNodeInfo(role: "AXButton", title: "Save")])
        let open = AXNodeInfo(role: "AXWindow", subrole: "AXDialog", identifier: "open-panel", title: "Ouvrir")
        let alert = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXStaticText", value: "Do you want to keep this?"), AXNodeInfo(role: "AXButton", title: "OK")])
        XCTAssertEqual(MenuPath.panels([doc, save]), [1])
        XCTAssertEqual(MenuPath.panels([doc, open]), [1])
        XCTAssertEqual(MenuPath.panels([doc, alert]), [])
        let e = MenuPath.panelRefusal("TextEdit", cancelled: true)
        XCTAssertTrue(e.message.contains("it was cancelled") && e.suggestion.contains("handoff folder"), e.message)
        XCTAssertTrue(MenuPath.panelRefusal("TextEdit", cancelled: false).message.contains("still open"))
        let tree: JSONValue = .object(["role": "window", "children": .array([.object(["role": "sheet", "children": .array([
            .object(["role": "button", "name": "Annuler", "ref_id": "@sp:e3"]), .object(["role": "button", "name": "Enregistrer", "ref_id": "@sp:e4"])])])])])
        XCTAssertEqual(MenuPath.cancelRef(tree, title: "Annuler"), "@sp:e3", "the live AXCancelButton's title, any language")
        XCTAssertNil(MenuPath.cancelRef(tree, title: "Cancel"))
    }

    /// second-F7: found but no ref is said as such.
    func testAnItemWithNoRefIsNotCalledMissing() throws {
        guard case .object(var bold) = Self.item("Bold", 11) else { return XCTFail() }
        bold["ref_id"] = nil
        let bar: JSONValue = .object(["role": "menu", "children": .array([Self.item("Apple", 1), Self.item("Format", 2, menu: [.object(bold)])])])
        XCTAssertEqual(MenuPath.find(bar, path: ["Format", "Bold"]), .noRef(path: ["Format", "Bold"]))
        let e = try XCTUnwrap(MenuPath.error(.noRef(path: ["Format", "Bold"]), path: ["Format", "Bold"], window: 7))
        XCTAssertEqual(e.message, "Format > Bold is in the menu bar but has no ref in this read")
        XCTAssertEqual(e.nextCall, HandsError.call("snapshot", ["window": 7]))
    }

    /// second-F5: in front, a menu command waits like posted keys, then acts or answers in_use.
    func testAMenuCommandWaitsWhileDonovanHasTheCopyInFront() {
        XCTAssertNil(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, otherWindows: 0, focusedWindow: 7, front: false), "the early check leaves front to the wait")
        XCTAssertEqual(InUseRule.decide(verb: "menu", state: .front, onAgentWorkspace: true, isFocusedWindow: true, isMainWindow: true, delivery: .posted), .wait)
        let c = InUseTests.Clock()
        var looks = 0
        XCTAssertEqual(InUseWait.run(bound: 5, now: c.now, sleep: c.sleep) { looks += 1; return looks < 3 ? .busy(.front) : .ready }, .ready(waited: 0.5), "freed: it acts")
        guard case .timedOut = InUseWait.run(bound: 5, now: c.now, sleep: c.sleep, check: { .busy(.front) }) else { return XCTFail("still in front: in_use") }
    }

    /// second-F5, second-F6, first-F1, first-F3: the router's order, read from its source.
    func testTheRouterChecksWaitsReadsAsEvidenceAndCancelsPanels() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let menu = try XCTUnwrap(HandsSourceTests.block(after: "func menu(_ req: HandsRequest) -> HandsEnvelope", in: src))
        func at(_ s: String) throws -> String.Index { try XCTUnwrap(menu.range(of: s), s).lowerBound }
        let early = try at("menuRule(w, front: false)()"), wait = try at(#"awaitUse(w, verb: "menu", delivery: .posted, wait: req.int("wait")"#)
        let tx = try at("HandsEngine.shared.transaction(")
        XCTAssertTrue(early < wait && wait < tx, "ownership and windows refuse before anything is read or pressed; front is waited out")
        XCTAssertTrue(menu.contains("also: menuRule(w, front: true)"), "the full rule again at the press")
        XCTAssertTrue(menu.contains("evidence: true, surface: HandsEngine.surfaceMenubar"), "the menu bar read never takes the agent's snapshot slots")
        XCTAssertTrue(menu.contains("kind: .click, evidence: true"), "pressed from that read")
        XCTAssertFalse(menu.contains("read(w,"), "never through the registered read")
        XCTAssertTrue(try at("cancelPanels(w") > at("actInline("), "panels are looked for after the press, inside the transaction")
    }
}

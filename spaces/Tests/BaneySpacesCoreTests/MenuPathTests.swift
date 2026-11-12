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
        func r(owned: Bool = true, mine: Bool = true, others: Int = 0, focused: UInt32? = 7, front: Bool = false) -> HandsError? {
            MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: owned, sessionOwns: mine, otherWindows: others, focusedWindow: focused, front: front)
        }
        XCTAssertNil(r())
        let lent = r(owned: false)
        XCTAssertEqual(lent?.code, .needsLend, "a lent window, or Donovan's own window under Full Access: his process either way")
        XCTAssertTrue(lent?.message.contains("menus work only in the agent's own copy") == true)
        XCTAssertEqual(lent?.nextCall, .null, "r1 first-F3: next_call is a read or none, never an open")
        XCTAssertTrue(lent?.suggestion.contains("`open`") == true, "the advice stays in the text")
        let theirs = r(mine: false)
        XCTAssertEqual(theirs?.code, .notSupported, "r1 second-S2: another session's copy is not yours")
        XCTAssertTrue(theirs?.message.contains("not one your `open` made") == true)
        XCTAssertEqual(theirs?.nextCall, .null)
        XCTAssertEqual(r(owned: false, front: true)?.code, .needsLend, "ownership first")
        XCTAssertEqual(r(front: true)?.code, .inUse)
        XCTAssertEqual(r(others: 1)?.code, .notSupported)
        XCTAssertEqual(r(focused: nil)?.code, .notSupported, "unknown focus is no proof")
    }

    /// first-F4: the focus refusal names no call that can't work.
    func testTheFocusRefusalSaysNoCallFocusesTheWindow() throws {
        let e = try XCTUnwrap(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, sessionOwns: true, otherWindows: 0, focusedWindow: 8, front: false))
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
        let e = try XCTUnwrap(MenuPath.error(.appleMenu, path: ["Apple"], window: 7))
        XCTAssertTrue(e.message.contains("whole Mac"), e.message)
    }

    typealias I = MenuPath.MenuItem
    static let sep = I(title: "")
    /// A German bar: nothing below goes by an English title.
    static let deBar = ["Apple", "TextEdit", "Ablage", "Bearbeiten", "Format", "Darstellung", "Fenster", "Hilfe"].map { I(title: $0, submenu: true) }
    func steps(_ top: Int, _ menu: [I], _ at: Int, sub: [I]? = nil, _ subAt: Int = 0) -> [MenuPath.Step] {
        [.init(items: Self.deBar, at: top), .init(items: menu, at: at)] + (sub.map { [.init(items: $0, at: subAt)] } ?? [])
    }

    /// r1 second-S3 and the class: the app menu gives About and Settings only, by place and key, whatever it is called.
    func testTheAppMenuGivesOnlyAboutAndSettings() {
        let app = [I(title: "\u{DC}ber TextEdit"), Self.sep, I(cmdChar: ",", modifiers: 0, title: "Einstellungen \u{2026}"), Self.sep,
                   I(title: "Dienste", submenu: true), Self.sep, I(cmdChar: "H", modifiers: 0, title: "TextEdit ausblenden"),
                   I(cmdChar: "H", modifiers: 2, title: "Andere ausblenden"), I(title: "Alle einblenden"), Self.sep, I(cmdChar: "Q", modifiers: nil, title: "TextEdit beenden")]
        XCTAssertNil(MenuPath.policy(steps(1, app, 0)), "About")
        XCTAssertNil(MenuPath.policy(steps(1, app, 2)), "Settings")
        for at in [6, 7, 8, 10] { XCTAssertNotNil(MenuPath.policy(steps(1, app, at)), app[at].title) }
        XCTAssertNotNil(MenuPath.policy(steps(1, app, 4, sub: [I(title: "Etwas")])), "a service")
        XCTAssertTrue(MenuPath.policy(steps(1, app, 10))?.message.contains("TextEdit > TextEdit beenden is never used") == true, "cmd+q with its modifiers unread")
        XCTAssertNotNil(MenuPath.policy([.init(items: Self.deBar, at: 0)]), "the Apple menu")
    }

    /// r1 first-F2 as a class: window moves, full screen and the tab overview, by key equivalent and identifier.
    func testCommandsThatChangeWhatDonovanSeesAreRefused() {
        let window = [I(cmdChar: "M", modifiers: 0, title: "Im Dock ablegen"), I(title: "Zoomen"), Self.sep, I(title: "Alle nach vorne bringen"), I(title: "notes.txt")]
        for at in window.indices where !window[at].title.isEmpty {
            XCTAssertTrue(MenuPath.policy(steps(6, window, at))?.message.contains("changes what Donovan sees") == true, window[at].title)
        }
        let renamed = [I(title: "Mitte"), I(identifier: "arrangeInFront:", title: "Vorne")]
        XCTAssertNotNil(MenuPath.policy(steps(4, renamed, 0)), "a Window menu known by its Bring All to Front")
        let view = [I(cmdChar: "F", modifiers: 4, title: "Vollbildmodus aktivieren"), I(cmdChar: "\\", modifiers: 1, title: "Alle Tabs einblenden"),
                    I(identifier: "toggleFullScreen:", title: "Gro\u{DF}"), I(cmdChar: "+", modifiers: 0, title: "Gr\u{F6}\u{DF}er")]
        for at in 0...2 { XCTAssertNotNil(MenuPath.policy(steps(5, view, at)), view[at].title) }
        XCTAssertNil(MenuPath.policy(steps(5, view, 3)), "zoom in on the text")
        XCTAssertNil(MenuPath.policy(steps(4, [I(cmdChar: "B", modifiers: 0, title: "Fett")], 0)))
    }

    /// r1 first-F1: Open, Open Recent and its documents are refused before anything is listed or pressed.
    func testDocumentsAreNeverOpenedFromAMenu() {
        let file = [I(cmdChar: "N", modifiers: 0, title: "Neu"), I(cmdChar: "O", modifiers: 0, title: "\u{D6}ffnen \u{2026}"),
                    I(title: "Benutzte Dokumente", submenu: true), Self.sep, I(cmdChar: "W", modifiers: 0, title: "Schlie\u{DF}en")]
        let recent = [I(title: "geheim.txt"), I(title: "notes.txt"), Self.sep, I(title: "Eintr\u{E4}ge l\u{F6}schen")]
        XCTAssertNil(MenuPath.policy(steps(2, file, 0)))
        XCTAssertNil(MenuPath.policy(steps(2, file, 4)))
        XCTAssertNotNil(MenuPath.policy(steps(2, file, 1)), "Open")
        let stop = MenuPath.policy(steps(2, file, 2))
        XCTAssertTrue(stop?.message.contains("handoff folder") == true && stop?.message.contains("geheim") == false, "the submenu is refused, its documents unlisted")
        XCTAssertNotNil(MenuPath.policy(steps(2, file, 2, sub: recent, 1)), "a recent document")
        let byID = [I(identifier: "_NSRecentDocumentsMenu", title: "Zuletzt", submenu: true), I(title: "x")]
        XCTAssertNotNil(MenuPath.policy(steps(2, byID, 0)), "by identifier, with no Open above it")
        XCTAssertEqual(MenuPath.reached(.submenu(path: ["Ablage", "Benutzte Dokumente"], choices: ["geheim.txt"]), path: ["Ablage", "Benutzte Dokumente"]), ["Ablage", "Benutzte Dokumente"])
        XCTAssertEqual(MenuPath.reached(.missing(level: 2, choices: ["geheim.txt"]), path: ["Ablage", "Benutzte Dokumente", "x"]), ["Ablage", "Benutzte Dokumente"])
    }

    /// The clipboard is Donovan's: cut, copy and paste by key, by place in the Edit menu, and by identifier.
    func testClipboardCommandsAreRefusedByKeyAndPlace() {
        let edit = [I(cmdChar: "Z", modifiers: 0, title: "Widerrufen"), I(cmdChar: "Z", modifiers: 1, title: "Wiederholen"), Self.sep,
                    I(cmdChar: "X", modifiers: 0, title: "Ausschneiden"), I(cmdChar: "C", modifiers: 0, title: "Kopieren"), I(cmdChar: "V", modifiers: 0, title: "Einsetzen"),
                    I(cmdChar: "V", modifiers: 3, title: "Einsetzen und Stil anpassen"), I(title: "L\u{F6}schen"), I(cmdChar: "A", modifiers: 0, title: "Alles ausw\u{E4}hlen"),
                    Self.sep, I(title: "Suchen", submenu: true)]
        for at in 3...7 { XCTAssertTrue(MenuPath.policy(steps(3, edit, at))?.message.contains("Mac's clipboard") == true, edit[at].title) }
        XCTAssertTrue(MenuPath.policy(steps(3, edit, 4))?.suggestion.contains("agent clipboard") == true)
        XCTAssertNil(MenuPath.policy(steps(3, edit, 0)), "Undo")
        XCTAssertNil(MenuPath.policy(steps(3, edit, 8)), "Select All")
        XCTAssertNil(MenuPath.policy(steps(3, edit, 10, sub: [I(cmdChar: "F", modifiers: 0, title: "Suchen \u{2026}")])), "Find")
        var bare = edit
        for i in 3...6 { bare[i].cmdChar = nil; bare[i].modifiers = nil }
        XCTAssertNotNil(MenuPath.policy(steps(3, bare, 4)), "no key equivalent: its place after Undo and Redo")
        XCTAssertNotNil(MenuPath.policy(steps(4, [I(cmdChar: "C", modifiers: 2, title: "Stil kopieren")], 0)), "opt+cmd+c elsewhere")
        XCTAssertNotNil(MenuPath.policy(steps(4, [I(identifier: "pasteAsPlainText:", title: "Als Text")], 0)))
    }

    /// r1 first-F4: with no AXCancelButton, the button whose identifier says cancel.
    func testAPanelWithNoCancelButtonAttributeIsStillCancelled() {
        let panel = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXGroup", children: [
            AXNodeInfo(role: "AXButton", identifier: "SaveButton", title: "Sichern"), AXNodeInfo(role: "AXButton", identifier: "_NS:CancelButton", title: "Abbrechen")])])
        XCTAssertEqual(MenuPath.cancelTitle(panel, cancelButton: nil), "Abbrechen")
        XCTAssertEqual(MenuPath.cancelTitle(panel, cancelButton: "Annuler"), "Annuler", "the attribute first")
        XCTAssertNil(MenuPath.cancelTitle(AXNodeInfo(role: "AXSheet"), cancelButton: nil))
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
        XCTAssertNil(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, sessionOwns: true, otherWindows: 0, focusedWindow: 7, front: false), "the early check leaves front to the wait")
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
        let early = try at("menuRule(w, session: session, front: false)()"), wait = try at(#"awaitUse(w, verb: "menu", delivery: .posted, wait: req.int("wait")"#)
        let tx = try at("HandsEngine.shared.transaction(")
        XCTAssertTrue(early < wait && wait < tx, "ownership and windows refuse before anything is read or pressed; front is waited out")
        XCTAssertTrue(menu.contains("also: menuRule(w, session: session, front: true)"), "the full rule again at the press")
        XCTAssertTrue(menu.contains("evidence: true, surface: HandsEngine.surfaceMenubar"), "the menu bar read never takes the agent's snapshot slots")
        XCTAssertTrue(menu.contains("kind: .click, evidence: true"), "pressed from that read")
        XCTAssertFalse(menu.contains("read(w,"), "never through the registered read")
        XCTAssertTrue(try at("MenuPath.policy(steps)") < at("guard case .item(let ref"), "r1 first-F1: judged before a submenu's choices are listed")
        XCTAssertTrue(try at("MenuPath.policy(steps)") < at("actInline("), "and before the press")
        XCTAssertTrue(try at("cancelPanels(w, within: 0.3)") > at("if case .failed(let e) = reply"), "r1 second-S4: panels are looked for after the transaction, off the app's queue")
        XCTAssertTrue(menu.contains("cancelPanels(w, within: 3)"), "r1 first-F4: a slow panel is still cancelled")
        XCTAssertTrue(menu.contains("sessionOwns: mine") || src.contains("sessionOwns: mine"), "r1 second-S2")
    }
}

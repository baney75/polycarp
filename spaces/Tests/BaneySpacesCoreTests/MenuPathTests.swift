import ApplicationServices
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
        // The live check on 952839c: in an agent's copy, which is never in front, every window command read greyed and
        // the "may need a selection" hint sent a weak model round forever. In the background it is never retried.
        for path in [["Edit", "Select All"], ["File", "Duplicate"], ["Format", "Make Rich Text"]] {
            let bg = try XCTUnwrap(MenuPath.error(.disabled(path: path), path: path, window: 7, background: true, app: "TextEdit"))
            XCTAssertEqual(bg.retry, .never, path.joined())
            XCTAssertEqual(bg.nextCall, .null)
            XCTAssertTrue(bg.message.contains("TextEdit is in the background") && !bg.suggestion.contains("selection"), bg.message)
        }
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        XCTAssertTrue(src.contains("background: NSRunningApplication(processIdentifier: w.pid)?.isActive != true, app: w.app"))
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

    /// r1 first-F1 layer 1: what macOS adds and what reaches past the app, refused in a German menu by identifier and key.
    func testSystemItemsAreRefusedByIdentifierAndKeyInAnyLanguage() {
        let edit = [I(cmdChar: "Z", modifiers: 0, title: "Widerrufen"), Self.sep, Self.sep, I(title: "Autom. ausf\u{FC}llen", submenu: true),
                    I(identifier: "startDictation:", title: "Diktat starten \u{2026}"), I(identifier: "orderFrontCharacterPalette:", title: "Emoji & Symbole"),
                    I(cmdChar: " ", modifiers: 4, title: "Zeichen"), I(identifier: "showWritingTools:", title: "Schreibtools"),
                    I(identifier: "orderFrontSubstitutionsPanel:", title: "Ersetzungen einblenden"), I(identifier: "stopDictation:", title: "Diktat beenden"),
                    I(identifier: "_NSAutoFillMenu", title: "Ausf\u{FC}llen", submenu: true)]
        for at in 4...10 { XCTAssertTrue(MenuPath.policy(steps(3, edit, at))?.message.contains("outside the agent workspace") == true, edit[at].title) }
        let file = [I(cmdChar: "N", modifiers: 0, title: "Neu"), I(identifier: "print:", title: "Drucken \u{2026}"), I(cmdChar: "P", modifiers: 0, title: "Ausgeben"),
                    I(identifier: "runPageLayout:", title: "Papierformat \u{2026}"), I(cmdChar: "P", modifiers: 1, title: "Format"),
                    I(identifier: "NSSharingServicePickerMenuItem", title: "Teilen", submenu: true), I(identifier: "importFromDevice:", title: "Vom iPhone importieren", submenu: true)]
        XCTAssertNil(MenuPath.policy(steps(2, file, 0)), "New")
        for at in 1...6 { XCTAssertNotNil(MenuPath.policy(steps(2, file, at)), file[at].title) }
        let speech = [I(identifier: "startSpeaking:", title: "Sprechen starten"), I(identifier: "stopSpeaking:", title: "Sprechen stoppen")]
        for at in 0...1 { XCTAssertNotNil(MenuPath.policy(steps(3, [I(title: "Sprachausgabe", submenu: true)], 0, sub: speech, at)), "his speakers: \(speech[at].title)") }
        let help = [I(title: "Suche"), I(cmdChar: "?", modifiers: 0, title: "TextEdit-Hilfe")]
        for at in 0...1 { XCTAssertNotNil(MenuPath.policy(steps(7, help, at)), "the Help menu, by being last: \(help[at].title)") }
        XCTAssertNotNil(MenuPath.policy(steps(4, [I(cmdChar: "?", modifiers: 0, title: "Hilfe zu Format")], 0)), "help by key elsewhere")
        XCTAssertNil(MenuPath.policy(steps(4, [I(cmdChar: "B", modifiers: 0, title: "Fett"), I(title: "Ersetzungen", submenu: true)], 1)), "the Substitutions submenu itself")
    }

    /// r1 first-F2: a read that failed never counts as unset; an item with one is unknown and the path is refused.
    func testAnUnreadAttributeRefusesTheCommand() throws {
        typealias R = MenuPath.Read
        let ok = MenuPath.item(identifier: R<String>.absent, cmdChar: .value("C"), modifiers: .absent, title: .value("Kopieren"), submenu: false)
        XCTAssertEqual(ok, I(cmdChar: "C", title: "Kopieren"))
        XCTAssertNil(MenuPath.item(identifier: .failed, cmdChar: .absent, modifiers: .absent, title: .value("Kopieren"), submenu: false), "identifier timed out")
        XCTAssertNil(MenuPath.item(identifier: .absent, cmdChar: .failed, modifiers: .absent, title: .value("\u{D6}ffnen"), submenu: false), "key timed out")
        XCTAssertNil(MenuPath.item(identifier: .absent, cmdChar: .absent, modifiers: .failed, title: .value("Im Dock ablegen"), submenu: false))
        XCTAssertNil(MenuPath.item(identifier: .absent, cmdChar: .absent, modifiers: .absent, title: .failed, submenu: false))
        XCTAssertNil(MenuPath.item(identifier: .absent, cmdChar: .absent, modifiers: .absent, title: .value("Benutzte"), submenu: nil), "children timed out")
        let e = try XCTUnwrap(MenuPath.judge(nil, window: 7))
        XCTAssertEqual(e.code, .engineError)
        XCTAssertTrue(e.message.contains("can't tell whether the command is safe"), e.message)
        XCTAssertNil(MenuPath.judge(steps(4, [I(cmdChar: "B", modifiers: 0, title: "Fett")], 0), window: 7))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let steps = try XCTUnwrap(HandsSourceTests.block(after: "static func steps(pid: Int32, path: [String])", in: src))
        XCTAssertTrue(steps.contains("guard items.count == level.count"), "one unknown item fails the whole menu")
    }

    /// r1 first-F1 layer 2, 192 r1 first-F2 and second-F8: a new window off the agent workspace counts only when it is
    /// tied to the press, and only a tied one is ever closed.
    func testOnlyAWindowTiedToThePressIsCountedAndClosed() {
        typealias L = MenuPath.Listed
        let doc = CGRect(x: 100, y: 100, width: 800, height: 600)
        let before: Set<UInt32> = [1, 2]
        let palette = L(id: 7, pid: 77, owner: "CharacterPalette", visible: true, workspace: nil, bundle: "com.apple.CharacterPaletteIM", parent: 1)
        let own = L(id: 8, pid: 50, owner: "TextEdit", visible: true, workspace: nil, bounds: CGRect(x: 2000, y: 0, width: 400, height: 300))
        let sheet = L(id: 12, pid: 50, owner: "TextEdit", visible: true, workspace: nil, bounds: CGRect(x: 200, y: 122, width: 600, height: 180))
        let now = [L(id: 1, pid: 50, owner: "TextEdit", visible: true, workspace: 3, bounds: doc), L(id: 2, pid: 9, owner: "Finder", visible: true, workspace: 1),
                   palette, own, L(id: 9, pid: 50, owner: "TextEdit", visible: true, workspace: 3), L(id: 10, pid: 88, owner: "Tips", visible: false, workspace: nil, bundle: "com.apple.helpviewer"),
                   L(id: 11, pid: 99, owner: "Tipster", visible: true, workspace: nil, bundle: "com.example.tipster", parent: 1), sheet,
                   L(id: 13, pid: 66, owner: "helper", visible: true, workspace: 1, parent: 50)]
        func run(settled: Bool, input: Bool) -> [MenuPath.Escape] {
            MenuPath.escaped(before: before, now: now, pid: 50, agentWorkspace: 3, settled: settled, parent: doc, userInput: input)
        }
        XCTAssertEqual(run(settled: false, input: false), [.init(palette, tied: true), .init(now[8], tied: true)], "a helper by exact bundle, a child process of the app")
        XCTAssertEqual(run(settled: true, input: false).map(\.window.id), [7, 8, 13], "the app's own once settled; a name like Tipster never counts; the sheet on its window is no escape")
        XCTAssertEqual(run(settled: true, input: true).filter { !$0.tied }.map(\.window.id), [7], "Donovan typed or clicked: the helper's window may be his")
        XCTAssertEqual(MenuPath.escaped(before: before, now: [sheet], pid: 50, agentWorkspace: 3, settled: true, parent: nil, userInput: false).map(\.window.id), [12],
                       "with no frame for the window, an untracked one can't be shown on it")
        let e = MenuPath.escapeRefusal("Bearbeiten > Emoji & Symbole", found: [.init(palette, tied: true)], closed: true, window: 4)
        XCTAssertEqual(e.code, .outsideAgentWorkspace)
        XCTAssertEqual(e.retry, .never)
        XCTAssertTrue(e.message.contains("it was closed") && e.suggestion.contains("Don't use Bearbeiten > Emoji & Symbole again"), e.message)
        XCTAssertTrue(MenuPath.escapeRefusal("x", found: [.init(palette, tied: true)], closed: false, window: 4).message.contains("still open"))
        let mine = MenuPath.escapeRefusal("Hilfe > Tipps", found: [.init(palette, tied: false)], closed: true, window: 4)
        XCTAssertTrue(mine.message.contains("closed nothing") && !mine.suggestion.contains("Don't use"), mine.message)
        XCTAssertEqual(mine.nextCall, HandsError.call("snapshot", ["window": 4]))
    }

    /// r1 second-F6, second-F4: the watch runs a second past the press, so a late panel fails the call; none leaves it ok.
    /// 192 r1 first-F1: a look that hangs ends the wait, and the answer is unknown, never quiet.
    func testALatePanelFailsTheCall() {
        let start = Date()
        let late = MenuWatch<String>(every: 0.01)
        late.start { _ in Date().timeIntervalSince(start) > 0.5 ? "panel" : nil }
        guard case .seen(let looks) = late.finish() else { return XCTFail("0.5 s after the press: still told, never ok") }
        XCTAssertEqual(looks.first, "panel")
        let quiet = MenuWatch<String>(every: 0.01)
        var settledSeen = false
        let lock = NSLock()
        quiet.start { settled in lock.lock(); if settled { settledSeen = true }; lock.unlock(); return nil }
        XCTAssertEqual(quiet.finish(), .quiet)
        lock.lock(); XCTAssertTrue(settledSeen, "the last look judges the app's own windows"); lock.unlock()
        XCTAssertEqual(MenuWatch<String>().finish(), .quiet, "no press, no wait")
        let hung = MenuWatch<String>(every: 0.01, watch: 0.05, margin: 0.1)
        hung.start { _ in Thread.sleep(forTimeInterval: 2); return nil }
        let t = Date()
        XCTAssertEqual(hung.finish(), .unknown)
        XCTAssertLessThan(Date().timeIntervalSince(t), 1)
        XCTAssertTrue(MenuWatch<String>.unknownRefusal("Format > Bold", window: 4).message.contains("didn't answer in time"))
    }

    /// 192 r1 first-F3: AppKit's own Edit items, appended after Select All's group, are refused by place in any language.
    func testWhatAppKitAppendsToTheEditMenuIsRefusedInAnyLanguage() {
        func edit(_ t: [String]) -> [I] {
            [I(cmdChar: "Z", modifiers: 0, title: t[0]), Self.sep, I(cmdChar: "X", modifiers: 0, title: t[1]), I(cmdChar: "A", modifiers: 0, title: t[2]), Self.sep,
             I(title: t[3], submenu: true), I(title: t[4], submenu: true), Self.sep, I(title: t[5], submenu: true), I(title: t[6]), I(title: t[7]), I(identifier: "_NSAutoFillMenu", title: t[8], submenu: true)]
        }
        let menus = [
            ["Widerrufen", "Ausschneiden", "Alles ausw\u{E4}hlen", "Suchen", "Transformationen", "Autom. ausf\u{FC}llen", "Diktat starten", "Schreibtools", "Ausf\u{FC}llen"],
            ["\u{53D6}\u{308A}\u{6D88}\u{3059}", "\u{30AB}\u{30C3}\u{30C8}", "\u{3059}\u{3079}\u{3066}\u{3092}\u{9078}\u{629E}", "\u{691C}\u{7D22}", "\u{5909}\u{63DB}", "\u{81EA}\u{52D5}\u{5165}\u{529B}", "\u{97F3}\u{58F0}\u{5165}\u{529B}\u{3092}\u{958B}\u{59CB}", "\u{4F5C}\u{6587}\u{30C4}\u{30FC}\u{30EB}", "\u{5165}\u{529B}"],
            ["\u{062A}\u{0631}\u{0627}\u{062C}\u{0639}", "\u{0642}\u{0635}", "\u{062A}\u{062D}\u{062F}\u{064A}\u{062F} \u{0627}\u{0644}\u{0643}\u{0644}", "\u{0628}\u{062D}\u{062B}", "\u{062A}\u{062D}\u{0648}\u{064A}\u{0644}\u{0627}\u{062A}", "\u{062A}\u{0639}\u{0628}\u{0626}\u{0629} \u{062A}\u{0644}\u{0642}\u{0627}\u{0626}\u{064A}\u{0629}", "\u{0628}\u{062F}\u{0621} \u{0627}\u{0644}\u{0625}\u{0645}\u{0644}\u{0627}\u{0621}", "\u{0623}\u{062F}\u{0648}\u{0627}\u{062A} \u{0627}\u{0644}\u{0643}\u{062A}\u{0627}\u{0628}\u{0629}", "\u{062A}\u{0639}\u{0628}\u{0626}\u{0629}"],
        ]
        let find = [I(cmdChar: "F", modifiers: 0, title: "1"), I(cmdChar: "G", modifiers: 0, title: "2")], plain = [I(title: "1"), I(title: "2")]
        for t in menus {
            let m = edit(t)
            for at in [8, 9, 10] { XCTAssertTrue(MenuPath.policy(steps(3, m, at))?.message.contains("outside the agent workspace") == true, t[at - 3]) }
            XCTAssertNotNil(MenuPath.policy(steps(3, m, 11, sub: plain, 0)), "AutoFill's passwords and contacts: \(t[8])")
            XCTAssertNotNil(MenuPath.policy(steps(3, m, 8, sub: plain, 0)), "a submenu with no key inside")
            XCTAssertNil(MenuPath.policy(steps(3, m, 5, sub: find, 0)), "Find, whose items have keys: \(t[3])")
            XCTAssertNotNil(MenuPath.policy(steps(3, m, 6, sub: plain, 0)), "Transformations, with no key inside")
            XCTAssertNil(MenuPath.policy(steps(3, m, 3)), "Select All itself")
        }
    }

    /// 192 r1 second-F7: a Save sheet is cancelled on the sheet, not on the window whose read holds it.
    func testTheSheetIsCancelledBeforeTheWindowThatHoldsIt() {
        let save = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXTextField"), AXNodeInfo(role: "AXPopUpButton"), AXNodeInfo(role: "AXStaticText", value: "Where:"),
                                                           AXNodeInfo(role: "AXButton", title: "Cancel"), AXNodeInfo(role: "AXButton", title: "Save")])
        let doc = AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow", title: "notes.txt", children: [AXNodeInfo(role: "AXTextArea"), save])
        XCTAssertEqual(MenuPath.panel([doc, save]), 1)
        XCTAssertEqual(MenuPath.panel([AXNodeInfo(role: "AXWindow", subrole: "AXDialog", identifier: "open-panel")]), 0)
        XCTAssertNil(MenuPath.panel([AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow", children: [AXNodeInfo(role: "AXTextArea")])]))
        // first-F4: a panel gone before the cancel is not said to be cancelled.
        XCTAssertTrue(MenuPath.panelRefusal("TextEdit", cancelled: false, gone: true).message.contains("closed before Polycarp cancelled it"))
    }

    /// 192 r1 second-F10: an attribute the app doesn't implement is no value; a read that couldn't complete is unknown.
    func testAnAttributeTheAppDoesntImplementIsNoValue() {
        func kind(_ e: AXError) -> String { switch MenuPath.read(code: e.rawValue, value: "x" as String?) { case .value: "value"; case .absent: "absent"; case .failed: "failed" } }
        XCTAssertEqual(kind(.success), "value")
        for e in [AXError.noValue, .attributeUnsupported, .notImplemented, .illegalArgument] { XCTAssertEqual(kind(e), "absent", "\(e.rawValue)") }
        for e in [AXError.cannotComplete, .failure, .invalidUIElement, .apiDisabled] { XCTAssertEqual(kind(e), "failed", "\(e.rawValue)") }
        guard case .absent = MenuPath.read(code: 0, value: nil as String?) else { return XCTFail("success with no value") }
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
        XCTAssertTrue(try at("MenuPath.judge(") < at("guard case .item(let ref"), "r1 first-F1: judged before a submenu's choices are listed")
        XCTAssertTrue(try at("MenuPath.judge(") < at("actInline("), "and before the press")
        XCTAssertTrue(try at("watch.start(") < at("actInline("), "r2 second-F4: the watch starts with the press, so a modal panel is cancelled while it waits")
        XCTAssertTrue(try at("switch watch.finish()") < at("if case .failed(let e) = reply"), "r2 second-F4: the watch answers whatever the press did")
        XCTAssertFalse(menu.contains("cancelPanels(w, within: 3)"), "192 r1 second-F9: no silent cancel after the call answered")
        XCTAssertTrue(menu.contains("case .unknown: return failed("), "192 r1 first-F1: a watch that couldn't finish never answers ok")
        let rule = try XCTUnwrap(HandsSourceTests.block(after: "private func menuRule", in: src))
        XCTAssertTrue(rule.contains("sessionOwns: mine"), "r1 second-S2, r2 second-F7: in menuRule itself")
        let step = try XCTUnwrap(HandsSourceTests.block(after: "private func menuWatchStep", in: src))
        XCTAssertTrue(step.contains("MenuPath.escaped(") && step.contains("MenuPath.panel("), "layer 2 looks for both")
        let undo = try XCTUnwrap(HandsSourceTests.block(after: "private func undo(", in: src))
        XCTAssertTrue(undo.contains("cancelPanels(w, within: 0.3, old: oldPanels)") && undo.contains("var open = found.filter(\\.tied)")
                      && undo.contains("MenuPath.undoing(panel: seen.panel"), "192 r1 first-F2: only a tied window is closed; 246 r1 first-F1: after the panel")
        XCTAssertTrue(step.contains("onMain { ids.map {"), "first-F1: one trip to main per look")
        let ax = try XCTUnwrap(HandsSourceTests.block(after: "static func read<T: Sendable>(_ e: AXUIElement", in: src))
        XCTAssertTrue(ax.contains("AXUIElementSetMessagingTimeout(e, timeout)"), "first-F1: the timeout on the element read")
        XCTAssertFalse(src.contains("HandsAXTree.node("), "first-F1: panel reads use the short-timeout reader")
    }

    /// 197 r1 first-F2: the first sighting doesn't end the watch, so a panel after a helper's window is still seen and undone.
    func testTheWatchCollectsEveryLook() {
        let start = Date()
        let w = MenuWatch<String>(every: 0.01, watch: 0.4)
        w.start { _ in Date().timeIntervalSince(start) < 0.1 ? "tips" : Date().timeIntervalSince(start) > 0.3 ? "panel" : nil }
        guard case .seen(let looks) = w.finish() else { return XCTFail("seen") }
        XCTAssertTrue(looks.contains("tips") && looks.contains("panel"), "\(looks)")
        let tips = MenuPath.Listed(id: 5, pid: 9, owner: "Tips", visible: true, workspace: nil)
        let m = MenuPath.Seen.merged([.init(escapes: [.init(tips, tied: true)]), .init(panel: true, escapes: [.init(tips, tied: false)]), .init()])
        XCTAssertEqual(m, MenuPath.Seen(panel: true, escapes: [.init(tips, tied: false)]), "one window once, untied if any look untied it")
        XCTAssertEqual(MenuPath.Seen.merged([]), MenuPath.Seen())
    }

    /// 197 r1 first-F1: a helper opened by Donovan's input a moment before the press is his, not the press's.
    func testInputJustBeforeThePressUntiesAHelper() {
        XCTAssertTrue(MenuPath.userInput(idle: 0.4, sincePress: 0.2), "his click 0.2 s before the press")
        XCTAssertTrue(MenuPath.userInput(idle: 0.05, sincePress: 0.2))
        XCTAssertFalse(MenuPath.userInput(idle: 30, sincePress: 0.2))
        XCTAssertFalse(MenuPath.userInput(idle: MenuPath.watch + 0.3, sincePress: 0.2))
    }

    /// 197 r1 second-S1: a panel already up before the press is not blamed on the command, nor cancelled for it.
    func testAPanelUpBeforeThePressIsNotTheCommands() {
        let save = AXNodeInfo(role: "AXWindow", subrole: "AXDialog", identifier: "save-panel")
        let doc = AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow")
        XCTAssertNil(MenuPath.panel([doc, save], old: [false, true]))
        XCTAssertEqual(MenuPath.panel([doc, save], old: [false, false]), 1)
        XCTAssertEqual(MenuPath.panel([save, doc, save], old: [true, false, false]), 2, "a new one beside the old")
    }

    /// 197 r1 second-S2: an XPC service's bundle id comes from its executable's path; LaunchServices doesn't know it.
    func testAnXPCServicesBundleIsReadFromItsPath() throws {
        XCTAssertEqual(MenuPath.bundlePath(executable: "/System/Library/PrivateFrameworks/X.framework/Versions/A/XPCServices/WritingToolsViewService.xpc/Contents/MacOS/WritingToolsViewService"),
                       "/System/Library/PrivateFrameworks/X.framework/Versions/A/XPCServices/WritingToolsViewService.xpc")
        XCTAssertEqual(MenuPath.bundlePath(executable: "/Applications/Helium.app/Contents/Frameworks/H.framework/Helpers/Helper.app/Contents/MacOS/Helper"),
                       "/Applications/Helium.app/Contents/Frameworks/H.framework/Helpers/Helper.app", "the innermost")
        XCTAssertNil(MenuPath.bundlePath(executable: "/usr/libexec/launchd"))
        // A running XPC service of this Mac, read the way fillProcess reads one.
        var pids = [Int32](repeating: 0, count: 4096)
        let n = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size)))
        var buf = [CChar](repeating: 0, count: 4096)
        let xpc = pids.prefix(max(0, n)).first { p in p > 0 && proc_pidpath(p, &buf, UInt32(buf.count)) > 0 && String(cString: buf).contains(".xpc/Contents/MacOS/") }
        guard let pid = xpc else { throw XCTSkip("no XPC service running") }
        let id = try XCTUnwrap(MenuPath.processBundle(pid: pid), "pid \(pid)")
        XCTAssertFalse(id.isEmpty)
    }

    /// 197 r1 second-S3, first-F3: the Versions browser, Move To and Rename, and Use Selection for Find are refused by identifier or key.
    func testVersionsMoveToAndTheSharedFindTextAreRefused() {
        let file = [I(identifier: "browseDocumentVersions:", title: "Alle Versionen durchsuchen\u{2026}"), I(identifier: "moveDocument:", title: "Bewegen\u{2026}"),
                    I(identifier: "renameDocument:", title: "Umbenennen\u{2026}"), I(cmdChar: "S", title: "Sichern")]
        XCTAssertTrue(MenuPath.policy(steps(2, file, 0))?.message.contains("changes what Donovan sees") == true)
        XCTAssertTrue(MenuPath.policy(steps(2, file, 1))?.message.contains("handoff folder") == true)
        XCTAssertTrue(MenuPath.policy(steps(2, file, 2))?.message.contains("handoff folder") == true)
        XCTAssertNil(MenuPath.policy(steps(2, file, 3)))
        let edit = [I(cmdChar: "Z", title: "Widerrufen"), Self.sep, I(cmdChar: "A", title: "Alles ausw\u{E4}hlen"), Self.sep, I(title: "Suchen", submenu: true)]
        let find = [I(cmdChar: "F", title: "Suchen \u{2026}"), I(cmdChar: "E", title: "Auswahl f\u{FC}r Suche verwenden")]
        XCTAssertTrue(MenuPath.policy(steps(3, edit, 4, sub: find, 1))?.message.contains("find text") == true)
        XCTAssertNil(MenuPath.policy(steps(3, edit, 4, sub: find, 0)))
    }

    /// 197 r1 second-S4: a path that stops at a submenu past Select All is judged by the submenu's own items.
    func testListingASubmenuPastSelectAllIsJudgedByItsItems() {
        let edit = [I(cmdChar: "Z", title: "Widerrufen"), Self.sep, I(cmdChar: "A", title: "Alles ausw\u{E4}hlen"), Self.sep, I(title: "Suchen", submenu: true), I(title: "Diktat", submenu: true)]
        var find = steps(3, edit, 4)
        find[1].opens = [I(cmdChar: "F", title: "Suchen \u{2026}"), I(title: "Weiter")]
        XCTAssertNil(MenuPath.policy(find), "Find lists: its items have keys")
        var dictation = steps(3, edit, 5)
        dictation[1].opens = [I(title: "Starten")]
        XCTAssertNotNil(MenuPath.policy(dictation))
        XCTAssertNotNil(MenuPath.policy(steps(3, edit, 4)), "unread items: refused")
    }

    /// 205 r1 second-S1: an Open or Save panel that is a window of its own is the panel, never also an escape.
    func testAPanelWindowIsNoEscape() throws {
        typealias L = MenuPath.Listed
        let panel = L(id: 21, pid: 50, owner: "TextEdit", visible: true, workspace: nil), other = L(id: 22, pid: 50, owner: "TextEdit", visible: true, workspace: nil)
        let all = [L(id: 1, pid: 50, owner: "TextEdit", visible: true, workspace: 3), panel, other, L(id: 23, pid: 50, owner: "TextEdit", visible: false, workspace: nil)]
        XCTAssertEqual(MenuPath.fresh(all, before: [1], panels: [21]), [other])
        XCTAssertEqual(MenuPath.fresh(all, before: [1], panels: []).map(\.id), [21, 22])
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let step = try XCTUnwrap(HandsSourceTests.block(after: "private func menuWatchStep", in: src))
        XCTAssertTrue(step.contains("var new = MenuPath.fresh(all, before: before, panels: MenuPath.panelWindows(nodes, sheet: windows.map(\\.sheet), ids: windows.map(\\.id)))"))
    }

    /// 217 r1 first-F2, F3: a panel window is a panel, but a sheet and the document window holding it are not: that
    /// window is still an escape, and a panel window is no other window.
    func testOnlyAPanelWindowOfItsOwnIsLeftOut() throws {
        let save = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXTextField"), AXNodeInfo(role: "AXPopUpButton"), AXNodeInfo(role: "AXStaticText", value: "Where:"),
                                                           AXNodeInfo(role: "AXButton", title: "Cancel"), AXNodeInfo(role: "AXButton", title: "Save")])
        let doc = AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow", title: "Untitled", children: [AXNodeInfo(role: "AXTextArea"), save])
        let open = AXNodeInfo(role: "AXWindow", subrole: "AXDialog", identifier: "open-panel", title: "Ouvrir")
        XCTAssertEqual(MenuPath.panelWindows([doc, save, open], sheet: [false, true, false], ids: [40, 40, 41]), [41])
        XCTAssertEqual(MenuPath.otherWindows([(1, false), (41, false), (42, true)], unmapped: 0, window: 1, panels: [41]), 0)
        XCTAssertEqual(MenuPath.otherWindows([(1, false), (43, false)], unmapped: 1, window: 1, panels: [41]), 2)
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        XCTAssertTrue(try XCTUnwrap(HandsSourceTests.block(after: "private func menuRule(", in: src)).contains("panels: panels)"))
    }

    /// 205 r1 second-S2: a window that closed on its own before the undo is said to be gone, never "still open".
    func testAWindowThatClosedOnItsOwnIsReportedGone() throws {
        typealias L = MenuPath.Listed
        let tips = L(id: 31, pid: 88, owner: "Tips", visible: true, workspace: nil), viewer = L(id: 32, pid: 77, owner: "Character Viewer", visible: true, workspace: nil)
        let seen = MenuPath.Seen(escapes: [.init(tips, tied: true), .init(viewer, tied: true)])
        let (open, gone) = seen.split(listed: [1, 32])
        XCTAssertEqual(open.map(\.window.id), [32])
        XCTAssertEqual(gone.map(\.window.id), [31])
        // 246 r1 second-S1: a palette ordered out, parked or minimized is still listed, so it still exists and is closed.
        var hidden = viewer; hidden.visible = false
        let parked = seen.split([hidden, L(id: 1, pid: 50, owner: "TextEdit", visible: false, workspace: 3)])
        XCTAssertEqual(parked.open.map(\.window.id), [32], "listed but not visible is chosen for closing")
        XCTAssertEqual(parked.gone.map(\.window.id), [31], "only an unlisted window is gone")
        let e = MenuPath.escapeRefusal("Hilfe > Tipps", found: [], gone: gone, closed: true, window: 4)
        XCTAssertEqual(e.code, .outsideAgentWorkspace)
        XCTAssertTrue(e.message.contains("a window of Tips closed again on its own") && !e.message.contains("still open") && !e.message.contains("it was closed"), e.message)
        let both = MenuPath.escapeRefusal("x", found: open, gone: gone, closed: false, window: 4)
        XCTAssertTrue(both.message.contains("Character Viewer") && both.message.contains("still open") && both.message.contains("Tips closed again on its own"), both.message)
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let undo = try XCTUnwrap(HandsSourceTests.block(after: "private func undo(", in: src))
        let split = try XCTUnwrap(undo.range(of: "seen.split(MenuAX.listed())")), close = try XCTUnwrap(undo.range(of: "host.close("))
        XCTAssertLessThan(split.lowerBound, close.lowerBound, "listed again before anything is closed")
    }

    /// 246 r1 first-F3: a sheet cancelled a moment ago is still read while it goes away, and its window counts too. A
    /// false cancel is tried again after a pause, and the call is stuck only when the panel is still there.
    func testASheetCancelledAMomentAgoIsNoStuckPanel() {
        // Sheet and window counted: the sheet's cancel lands, the closing sheet's second cancel fails, then it is gone.
        var answers: [Bool?] = [true, false, nil], pauses = 0
        XCTAssertEqual(MenuPath.cancelEarlier(count: 2, pause: { pauses += 1 }) { answers.removeFirst() }, .cancelled)
        XCTAssertEqual(pauses, 1)
        answers = [false, false, true]
        XCTAssertEqual(MenuPath.cancelEarlier(count: 1) { answers.removeFirst() }, .cancelled, "a cancel that lands on a later try")
        answers = [false, false, false]
        XCTAssertEqual(MenuPath.cancelEarlier(count: 1) { answers.removeFirst() }, .stuck(afterCancelling: false))
    }

    /// 258 r1 second-S1: a cancel answered false, and the retry found the panel gone. Polycarp's Cancel was pressed and
    /// its read replaced the evidence store's, so it is `.cancelled` (the router reads the bar again), never `.none`,
    /// which would press the first read's ref in the panel's tree.
    func testAPanelGoneByTheRetryWasCancelled() throws {
        var answers: [Bool?] = [false, nil]
        XCTAssertEqual(MenuPath.cancelEarlier(count: 1) { answers.removeFirst() }, .cancelled)
        answers = [false, false, nil]
        XCTAssertEqual(MenuPath.cancelEarlier(count: 2) { answers.removeFirst() }, .cancelled)
        answers = [nil]
        XCTAssertEqual(MenuPath.cancelEarlier(count: 1) { answers.removeFirst() }, .none, "no panel: no cancel ran")
        // first-F2: the error is the last attempt's, never one an earlier attempt left behind.
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let menu = try XCTUnwrap(HandsSourceTests.block(after: "func menu(_ req: HandsRequest) -> HandsEnvelope", in: src))
        XCTAssertTrue(menu.contains("why = nil\n                            return cancelOnePanel(w, old: [], inline: c, failed: { why = $0 })"))
        XCTAssertTrue(menu.contains("case .cancelled: cancelledEarlier = true; item = pressable()"))
    }

    /// 246 r1 second-S2: when the cancel's own engine call failed a check (the window left scope, the call ran out of
    /// time), that is the answer, not a stuck panel; a Cancel that just didn't go through is still one.
    func testACheckThatFailedUnderTheCancelIsTheAnswer() throws {
        let scope = HandsError(.outsideAgentWorkspace, "left", suggestion: "s")
        XCTAssertEqual(MenuPath.earlierError("TextEdit", afterCancelling: false, engine: scope), scope)
        XCTAssertEqual(MenuPath.earlierError("TextEdit", afterCancelling: false, engine: HandsError(.timeout, "t", suggestion: "s")).code, .timeout)
        let pressed = MenuPath.earlierError("TextEdit", afterCancelling: true, engine: HandsError(.actionFailed, "no", suggestion: "s"))
        XCTAssertTrue(pressed.message.contains("couldn't be cancelled") && pressed.message.contains("one before it was cancelled"), pressed.message)
        XCTAssertTrue(MenuPath.earlierError("TextEdit", afterCancelling: false, engine: nil).message.contains("nothing was pressed"))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let menu = try XCTUnwrap(HandsSourceTests.block(after: "func menu(_ req: HandsRequest) -> HandsEnvelope", in: src))
        XCTAssertTrue(menu.contains("cancelOnePanel(w, old: [], inline: c, failed: { why = $0 })"))
        XCTAssertTrue(menu.contains("case .stuck(let after): return .failed(MenuPath.earlierError(w.app, afterCancelling: after, engine: why))"))
        // 246 r1 first-F4: the item is switched on, so no path answers ok with nothing pressed.
        XCTAssertTrue(menu.contains("switch item {\n                case .failure(let e): return .failed(e)\n                case .success(let f): found = f"))
        XCTAssertFalse(menu.contains("return .ok(.null) }"))
        let inline = try XCTUnwrap(HandsSourceTests.block(after: "private func cancelInline(", in: src))
        XCTAssertTrue(inline.contains("if case .failed(let e) = read { return e }") && inline.contains("check: scope, cancelled: cancelled) { return e }"))
    }

    /// 205 r1 first-F1, 217 r1 first-F1: a panel left from an earlier command is cancelled once the path is judged and
    /// found, just before the press, and said on every answer after it; one that won't cancel stops the call.
    func testAnEarlierPanelIsCancelledBeforeThePress() throws {
        var calls = 0
        XCTAssertEqual(MenuPath.cancelEarlier(count: 2) { calls += 1; return true }, .cancelled)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(MenuPath.cancelEarlier(count: 2) { nil }, .none)
        calls = 0
        XCTAssertEqual(MenuPath.cancelEarlier(count: 2) { calls += 1; return calls == 1 }, .stuck(afterCancelling: true))
        XCTAssertTrue(MenuPath.earlierStuck("TextEdit").message.contains("nothing was pressed"))
        XCTAssertTrue(MenuPath.earlierStuck("TextEdit", afterCancelling: true).message.contains("one before it was cancelled"))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let menu = try XCTUnwrap(HandsSourceTests.block(after: "func menu(_ req: HandsRequest) -> HandsEnvelope", in: src))
        let found = try XCTUnwrap(menu.range(of: "var item = pressable()")), cancel = try XCTUnwrap(menu.range(of: "MenuPath.cancelEarlier("))
        let old = try XCTUnwrap(menu.range(of: "oldPanels = MenuAX.panelElements(w.pid)")), tx = try XCTUnwrap(menu.range(of: "HandsEngine.shared.transaction("))
        XCTAssertTrue(tx.lowerBound < found.lowerBound && found.lowerBound < cancel.lowerBound && cancel.lowerBound < old.lowerBound)
        XCTAssertTrue(menu.contains("e.message += MenuPath.earlierNote") && menu.contains(#"if cancelledEarlier { o["cancelled_earlier_panel"] = true }"#))
        let panels = try XCTUnwrap(HandsSourceTests.block(after: "private func cancelPanels(", in: src))
        XCTAssertTrue(panels.contains("cancelOnePanel(w, old: oldPanels)"), "one cancel, shared")
    }

    /// 205 r1 first-F2: only an Edit-menu submenu is listed for `appended`, and an unread listing refuses only through it.
    func testOnlyAnEditSubmenuIsListedAndAnUnreadOneRefusesThroughAppended() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let read = try XCTUnwrap(HandsSourceTests.block(after: "static func steps(pid: Int32, path: [String])", in: src))
        XCTAssertTrue(read.contains("if MenuPath.listsOpens(out) {"))
        // 217 r1 first-F4: only the Edit menu's submenu is read.
        let editMenu = [I(cmdChar: "Z", title: "Widerrufen"), I(title: "Suchen", submenu: true)]
        XCTAssertTrue(MenuPath.listsOpens(steps(3, editMenu, 1)))
        XCTAssertFalse(MenuPath.listsOpens(steps(4, [I(title: "Schrift", submenu: true)], 0)))
        XCTAssertFalse(MenuPath.listsOpens(steps(3, editMenu, 0)))
        XCTAssertTrue(read.contains("if opens.count == level.count { out[1].opens = opens }"))
        XCTAssertFalse(read.contains("guard opens.count == level.count else { return nil }"), "an unread listing no longer fails the read")
        let edit = [I(cmdChar: "Z", title: "Widerrufen"), Self.sep, I(cmdChar: "A", title: "Alles ausw\u{E4}hlen"), Self.sep, I(title: "Suchen", submenu: true)]
        XCTAssertNotNil(MenuPath.policy(steps(3, edit, 4)), "Edit > Find unread: refused through appended")
        let format = [I(title: "Schrift", submenu: true)]
        XCTAssertNil(MenuPath.policy(steps(4, format, 0)), "Format > Font unread: listed as before")
    }

    /// 205 r1 first-F3: the refusal says what it closes, not that the shared find text is protected.
    func testTheFindRefusalSaysWhatItRefuses() {
        let edit = [I(cmdChar: "Z", title: "Widerrufen"), Self.sep, I(cmdChar: "A", title: "Alles ausw\u{E4}hlen"), Self.sep, I(title: "Suchen", submenu: true)]
        let find = [I(cmdChar: "F", title: "Suchen \u{2026}"), I(cmdChar: "E", title: "Auswahl f\u{FC}r Suche verwenden")]
        let m = MenuPath.policy(steps(3, edit, 4, sub: find, 1))?.message ?? ""
        XCTAssertTrue(m.contains("Use Selection for Find puts the selection on the find text"), m)
        XCTAssertFalse(m.contains("which is Donovan's"), m)
    }

    /// 246 r1 first-F2: a modal Open panel in its own window is the focused window; it is cancelled before the press, so
    /// the early checks don't refuse on it. Any other focused window still does.
    func testFocusOnTheAppsOwnPanelIsNoRefusal() {
        XCTAssertNil(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, sessionOwns: true, otherWindows: 0, focusedWindow: 9, panels: [9], front: false))
        XCTAssertNotNil(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, sessionOwns: true, otherWindows: 0, focusedWindow: 8, panels: [9], front: false))
        XCTAssertNotNil(MenuPath.refusal(app: "TextEdit", window: 7, agentOwned: true, sessionOwns: true, otherWindows: 0, focusedWindow: nil, panels: [9], front: false))
    }

    /// 246 r1 first-F1: a new window holding a Save sheet can't close while the sheet runs, so the panel is cancelled first,
    /// and the close is tried again while the sheet goes away.
    func testUndoCancelsThePanelBeforeClosingItsWindow() {
        var calls: [String] = [], closes = 0
        let r = MenuPath.undoing(panel: true, cancel: { calls.append("cancel"); return HandsError(.notSupported, "panel", suggestion: "") },
                                 close: { calls.append("close"); closes += 1; return closes == 3 }, pause: { calls.append("pause") })
        XCTAssertEqual(calls, ["cancel", "close", "pause", "close", "pause", "close"])
        XCTAssertTrue(r.closed)
        XCTAssertEqual(r.panel?.message, "panel")
        calls = []
        let none = MenuPath.undoing(panel: false, cancel: { calls.append("cancel"); return nil }, close: { calls.append("close"); return false }, pause: { calls.append("pause") })
        XCTAssertEqual(calls, ["close"], "no panel: no cancel and one close")
        XCTAssertFalse(none.closed)
        XCTAssertNil(none.panel)
        let stuck = MenuPath.undoing(panel: true, cancel: { nil }, close: { false }, tries: 3)
        XCTAssertFalse(stuck.closed, "still open after every try is said")
    }
}

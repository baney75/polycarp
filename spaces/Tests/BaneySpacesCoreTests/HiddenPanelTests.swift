import XCTest
import BaneySpacesCore

/// 11-15: `menu "Format > Font > Show Fonts"` in an agent's TextEdit answered plain ok. The Fonts panel, window 67321
/// (AXFloatingWindow), was the app's focused window but not in AXWindows, so `opened` didn't name it, `close` couldn't
/// find it, and every later menu call in that copy was refused. Pressing its close button gave the document focus back,
/// and the window server still listed it, ordered out.
final class HiddenPanelTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private func read(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }

    func testTheFocusedWindowAXWindowsLeftOutIsRead() {
        XCTAssertEqual(HiddenPanel.unlisted(listed: [67318], focused: 67321), 67321)
        XCTAssertNil(HiddenPanel.unlisted(listed: [67318, 67321], focused: 67321))
        XCTAssertNil(HiddenPanel.unlisted(listed: [67318], focused: nil))
    }

    func testARaisedPanelIsTheSessionsOnlyFromItsOwnWindow() {
        XCTAssertEqual(HiddenPanel.adopt(raised: [67321], target: 67318, sessionOwnsTarget: true), [67321])
        XCTAssertEqual(HiddenPanel.adopt(raised: [67321], target: 67318, sessionOwnsTarget: false), [], "raised from his window, it is his")
        XCTAssertEqual(HiddenPanel.adopt(raised: [67318], target: 67318, sessionOwnsTarget: true), [])
    }

    func testTheAnswerNamesThePanelAndHowToCloseIt() {
        XCTAssertEqual(HiddenPanel.ids(.object(["window": .int(67321), "kind": .string("floating")])), [67321])
        XCTAssertEqual(HiddenPanel.ids(.array([.object(["window": .int(1)]), .object(["window": .int(2)])])), [1, 2])
        XCTAssertEqual(HiddenPanel.ids(nil), [])
        XCTAssertEqual(HiddenPanel.note([67321], closable: true),
                       "the command raised window 67321; it is the app's focused window until it closes, so close it with `close --window 67321` when you are done")
        XCTAssertFalse(HiddenPanel.note([67321], closable: false).contains("close --window"))
    }

    func testAClosedPanelIsOneTheAppShowsNoMore() {
        XCTAssertTrue(HiddenPanel.closed(inWindows: false, focused: false))
        XCTAssertFalse(HiddenPanel.closed(inWindows: false, focused: true), "hidden, and still the focused window")
        XCTAssertFalse(HiddenPanel.closed(inWindows: true, focused: false))
    }

    /// Live on d5f6c5c: `menu` named panel 67369, then `close --window 67369` answered "window 67369 is gone", because the
    /// close's gate read only placed windows. A child is read there too; a placed window still wins.
    func testCloseSeesTheChildPanelInItsGate() throws {
        let panel = HandsWindow(id: 67369, pid: 5, app: "TextEdit", workspace: nil)
        let placed = HandsWindow(id: 67366, pid: 5, app: "TextEdit", workspace: 9)
        XCTAssertEqual(MutationGate.live(panel, placed: nil, child: panel), panel)
        XCTAssertNil(MutationGate.live(panel, placed: nil, child: nil), "a child the app no longer shows is gone")
        XCTAssertEqual(MutationGate.live(placed, placed: placed, child: nil), placed)
        XCTAssertNil(MutationGate.live(placed, placed: nil, child: panel), "a placed window that left is gone, never read as a child")
        let router = try read("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let body = try XCTUnwrap(router.range(of: "func mutateOnMain<T>")).lowerBound
        let gate = String(router[body...].prefix(2_000))
        XCTAssertTrue(gate.contains("m[w.id] = childWindow(w.id)"))
        XCTAssertTrue(gate.contains("let live = MutationGate.live(w, placed: placed, child: children[w.id])"))
        XCTAssertTrue(gate.contains("scope.allowed ? sheetProblem(l, agent: agent, session: session) ?? inspectProblem(l) : nil"), "a child is inspected in the pass too")
    }

    /// Issue #309, live on 0e4666d: after `menu "Format > Font > Show Colors"` the window server listed TextEdit window
    /// 67902 "Colors" at layer 3, never on screen; Accessibility had no element for it, even by remote token.
    func testAPanelOutOfSightWithNoElementIsNamed() {
        typealias W = HiddenPanel.ServerWindow
        let doc = W(id: 67899, layer: 0, onScreen: true, bounds: CGRect(x: 1511, y: 950, width: 656, height: 422), title: "notes.txt")
        let colors = W(id: 67902, layer: 3, onScreen: false, bounds: CGRect(x: 0, y: 528, width: 266, height: 454), title: "Colors")
        let before: Set<UInt32> = [67899, 67898]
        XCTAssertEqual(HiddenPanel.unreachable([doc, colors], before: before, reached: [67899]), [colors])
        XCTAssertEqual(HiddenPanel.unreachable([W(id: 67902, layer: 0, onScreen: false, bounds: .zero, title: "Colors")], before: before, reached: []), [],
                       "the first look, 0x0 at layer 0, is not a panel yet")
        XCTAssertEqual(HiddenPanel.unreachable([colors], before: before, reached: [67902]), [], "Fonts: read through its focused element")
        XCTAssertEqual(HiddenPanel.unreachable([colors], before: [67902], reached: []), [], "there before the press")
        XCTAssertEqual(HiddenPanel.unreachable([W(id: 7, layer: 3, onScreen: true, bounds: colors.bounds, title: "")], before: [], reached: []), [], "in sight")
        XCTAssertEqual(HiddenPanel.unreachable([W(id: 8, layer: 101, onScreen: false, bounds: colors.bounds, title: "")], before: [], reached: []), [], "a menu's window")
        XCTAssertEqual(HiddenPanel.opened(colors), .object(["window": .int(67902), "kind": .string("hidden_panel"), "title": .string("Colors"),
                                                           "shown": .bool(false), "waiting": .bool(false), "parent": .null]))
        XCTAssertEqual(HiddenPanel.ids(HiddenPanel.opened(colors)), [67902])
        XCTAssertTrue(HiddenPanel.why(colors, app: "TextEdit").hasPrefix("window 67902 (Colors) is a panel TextEdit shows only while it is the active app"))
        let refusal = HiddenPanel.closeRefusal(colors, app: "TextEdit")
        XCTAssertEqual(refusal.code, .notSupported)
        XCTAssertEqual(refusal.retry, .never)
    }

    /// `menu` reads the window server for them after the press, and `close` answers why instead of "no window".
    func testTheMenuNamesItAndCloseSaysWhy() throws {
        let menu = try read("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        let press = try XCTUnwrap(menu.range(of: "let before = MenuAX.ids()"))
        let look = try XCTUnwrap(menu.range(of: "let hidden = HiddenPanel.unreachable(MenuAX.serverWindows(pid: w.pid), before: before, reached: reached)"))
        XCTAssertLessThan(press.lowerBound, look.lowerBound)
        XCTAssertTrue(menu.contains("childLocked { for h in hidden { hiddenPanels[h.id] = (session, w.pid, w.app) } }"))
        let close = try read("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let body = try XCTUnwrap(close.range(of: "func close(_ req: HandsRequest) -> HandsEnvelope {")).upperBound
        let gate = String(close[body...].prefix(900))
        XCTAssertTrue(gate.contains("let h = childLocked({ hiddenPanels[id] }), h.session == session"), "only the session that raised it hears why")
        XCTAssertTrue(gate.contains("return .failure(HiddenPanel.closeRefusal(p, app: h.app))"))
    }

    /// The read, `menu` and `close` use the model; the app target can't be imported, so these read it.
    func testTheReadMenuAndCloseUseIt() throws {
        let ax = try read("Sources/BaneySpaces/Hands/ChildWindowsAX.swift")
        let unlisted = try XCTUnwrap(ax.range(of: "HiddenPanel.unlisted(listed: listed.map(\\.id) + Array(elements.keys), focused: id)"))
        let assemble = try XCTUnwrap(ax.range(of: "let out = ChildCollect.assemble(listed)"))
        XCTAssertLessThan(unlisted.lowerBound, assemble.lowerBound, "the hidden panel is a child before children are built")
        let menu = try read("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        XCTAssertTrue(menu.contains("sessionWindows.record(session: session, window: id, pid: w.pid)"))
        XCTAssertTrue(menu.contains("let notes = (shown.isEmpty ? [] : [HiddenPanel.note(shown, closable: !adopted.isEmpty)]) + hidden.map { HiddenPanel.why($0, app: w.app) }"))
        let close = try read("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let spaces = try read("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("let child = ChildWindowsAX.element(pid: owner.pid, id: id) else { return false }"), "host.close presses a child's own button")
        XCTAssertTrue(close.contains("w.workspace == nil ? !ChildWindowsAX.closed(pid: w.pid, id: w.id) : Self.serverLists(w.id)"))
    }
}

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

    /// The read, `menu` and `close` use the model; the app target can't be imported, so these read it.
    func testTheReadMenuAndCloseUseIt() throws {
        let ax = try read("Sources/BaneySpaces/Hands/ChildWindowsAX.swift")
        let unlisted = try XCTUnwrap(ax.range(of: "HiddenPanel.unlisted(listed: listed.map(\\.id) + Array(elements.keys), focused: id)"))
        let assemble = try XCTUnwrap(ax.range(of: "let out = ChildCollect.assemble(listed)"))
        XCTAssertLessThan(unlisted.lowerBound, assemble.lowerBound, "the hidden panel is a child before children are built")
        let menu = try read("Sources/BaneySpaces/Hands/HandsRouter+Menu.swift")
        XCTAssertTrue(menu.contains("sessionWindows.record(session: session, window: id, pid: w.pid)"))
        XCTAssertTrue(menu.contains("o[\"note\"] = .string(HiddenPanel.note(raised, closable: !adopted.isEmpty))"))
        let close = try read("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let spaces = try read("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("let child = ChildWindowsAX.element(pid: owner.pid, id: id) else { return false }"), "host.close presses a child's own button")
        XCTAssertTrue(close.contains("w.workspace == nil ? !ChildWindowsAX.closed(pid: w.pid, id: w.id) : Self.serverLists(w.id)"))
    }
}

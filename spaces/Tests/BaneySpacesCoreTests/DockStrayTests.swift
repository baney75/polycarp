import Foundation
import XCTest
@testable import BaneySpacesCore

/// Found while tracing a leftover tile on screen (2026-11-10): the stray check looked at the dock's
/// own panel only. The "+N" list or window strip has a panel of its own, and a panel rebuilt after
/// it wouldn't show kept its SwiftUI view. One owner now sweeps every dock-owned window.
final class DockStrayTests: XCTestCase {
    func testDownPastTheSlideOutNoDockWindowStaysOnScreenTheListIncluded() {
        let w: [(kind: DockStray.Kind, up: Bool)] = [(.dock, false), (.list, true)]
        XCTAssertEqual(DockStray.strays(shown: false, windows: w, hiddenAt: 100, now: 102), [1])
        XCTAssertEqual(DockStray.strays(shown: false, windows: [(.dock, true), (.list, true)], hiddenAt: 100, now: 102), [0, 1])
    }

    func testTheListFadesOutWithTheDockAndIsLeftAloneWhileUp() {
        XCTAssertEqual(DockStray.strays(shown: false, windows: [(.dock, true), (.list, true)], hiddenAt: 100, now: 100.1), [], "mid slide-out")
        XCTAssertEqual(DockStray.strays(shown: true, windows: [(.dock, true), (.list, true)], hiddenAt: 100, now: 102), [])
    }

    func testAPanelTheDockNoLongerHoldsIsNeverOnScreen() {
        XCTAssertEqual(DockStray.strays(shown: true, windows: [(.dock, true), (.orphan, true)], hiddenAt: nil, now: 5), [1])
        XCTAssertEqual(DockStray.strays(shown: false, windows: [(.orphan, true)], hiddenAt: 100, now: 100.1), [0])
        XCTAssertEqual(DockStray.strays(shown: false, windows: [(.orphan, false)], hiddenAt: 100, now: 102), [])
    }

    func testTheTraceNamesWhatWasLeft() {
        XCTAssertEqual(DockStray.traceLine(.list, hiddenAt: 100, now: 102.5),
                       "dock stray: the list panel was still on screen 2.5s after the dock went down; ordered out")
        XCTAssertTrue(DockStray.traceLine(.orphan, hiddenAt: nil, now: 1).hasPrefix("dock stray: a dock panel the dock no longer holds"))
    }

    // MARK: The app (source checks; `WorkspaceDock` is in the app target)

    func source() throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/WorkspaceDock.swift"), encoding: .utf8)
    }

    func testEveryTickSweepsEveryDockPanel() throws {
        let s = try source()
        XCTAssertTrue(s.contains("NSApp.windows.compactMap { $0 as? DockPanel }"), "one owner: every DockPanel the app has")
        XCTAssertTrue(s.contains("DockStray.strays(shown: isShown"))
        XCTAssertTrue(s.contains("guard isRunning else { return }\n        sweepStrays("), "checked on every tick, so after every hide")
    }

    func testARebuiltPanelLetsGoOfItsView() throws {
        XCTAssertTrue(try source().contains("p.orderOut(nil)\n            // Its SwiftUI view goes with it, so nothing keeps drawing into a panel the dock forgot.\n            p.contentView = nil\n            self.dockSwitch.forgetPanel()"))
    }

    func testARevealWithTheDockOffLeavesTheModelDown() throws {
        XCTAssertTrue(try source().contains("guard let p = dockSwitch.panelForReveal() else { model.shown = false; return }"))
    }

    func testGoingDownForgetsADropsSettlingIcon() throws {
        let s = try source()
        let reset = try XCTUnwrap(s.range(of: "    func reset() {"))
        let body = s[reset.upperBound...].prefix(400)
        XCTAssertTrue(body.contains("settling = nil"))
    }
}

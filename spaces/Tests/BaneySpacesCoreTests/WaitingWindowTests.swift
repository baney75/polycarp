import Foundation
import XCTest
@testable import BaneySpacesCore

/// An app's icon popped out of the hidden macOS Dock once a minute (Donovan, 2026-11-10): Word,
/// lent to an agent, had its document on the agent workspace and wanted an answer. Its macOS Dock
/// icon is quiet now (`SystemDockSettingsTests`); these pin what replaces it.
final class WaitingWindowTests: XCTestCase {
    // MARK: Which windows wait on you

    func testDialogsAlertsAndAnythingModalWaitOnYou() {
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXDialog", modal: true))
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXDialog", modal: nil))
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXSystemDialog", modal: false))
        // A standard window that blocks its app is a dialog in all but name.
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXStandardWindow", modal: true))
    }

    func testDocumentWindowsAndPalettesDoNot() {
        // Word's document (window 43258) was standard and not modal: an agent's claim was right to take it.
        XCTAssertFalse(WaitingWindow.asks(subrole: "AXStandardWindow", modal: false))
        XCTAssertFalse(WaitingWindow.asks(subrole: "AXFloatingWindow", modal: false))
        XCTAssertFalse(WaitingWindow.asks(subrole: nil, modal: nil))
    }

    func testAClaimNeverTakesAWindowThatWaitsOnYou() {
        XCTAssertFalse(WaitingWindow.claimTakes(subrole: "AXStandardWindow", modal: true))
        XCTAssertFalse(WaitingWindow.claimTakes(subrole: "AXDialog", modal: nil))
        XCTAssertTrue(WaitingWindow.claimTakes(subrole: "AXStandardWindow", modal: false))
    }

    // MARK: Where it belongs

    func testItStaysBesideItsAppWhenThatWorkspaceIsInSight() {
        XCTAssertEqual(WaitingWindow.place(asks: true, parents: [2, 9], shown: [2], recent: [2, 9]), .withParent(2))
    }

    func testOutOfSightItMarksTheAppsWorkspaceAndTakesYouNowhere() {
        // The 13:51 case: Word's only placed window on agent workspace 9, you on 2.
        XCTAssertEqual(WaitingWindow.place(asks: true, parents: [9], shown: [2], recent: [2, 9]), .needsAttention(9))
        // Several: the one you were on most recently.
        XCTAssertEqual(WaitingWindow.place(asks: true, parents: [4, 7], shown: [2], recent: [2, 7, 4]), .needsAttention(7))
        XCTAssertEqual(WaitingWindow.place(asks: true, parents: [4, 7], shown: [2], recent: [2]), .needsAttention(4))
    }

    func testOrdinaryWindowsAndAppsWithNothingPlacedAreLeftAlone() {
        XCTAssertEqual(WaitingWindow.place(asks: false, parents: [9], shown: [2], recent: [2]), .ordinary)
        XCTAssertEqual(WaitingWindow.place(asks: true, parents: [], shown: [2], recent: [2]), .ordinary)
    }

    // MARK: The dock's mark

    let word: Int32 = 35218

    func testWordsDialogMarksWorkspaceNine() {
        let seen = [WaitingWindow.Seen(id: 43312, pid: word, subrole: "AXDialog", modal: true)]
        let marks = DockAttention.marks(seen, names: [word: "Microsoft Word"], parents: [word: [9]], shown: [2], recent: [2, 9])
        XCTAssertEqual(marks, [DockAttention.Mark(pid: word, app: "Microsoft Word", workspace: 9, window: 43312)])
        XCTAssertEqual(DockAttention.label(app: "Microsoft Word", workspace: 9), "Microsoft Word needs you on workspace 9")
    }

    func testNoMarkOnceYouAreThereOrForAPaletteOrOneAppTwice() {
        let dialog = WaitingWindow.Seen(id: 43312, pid: word, subrole: "AXDialog", modal: true)
        XCTAssertEqual(DockAttention.marks([dialog], names: [:], parents: [word: [9]], shown: [9], recent: [9]), [])
        let palette = WaitingWindow.Seen(id: 50, pid: word, subrole: "AXFloatingWindow", modal: false)
        XCTAssertEqual(DockAttention.marks([palette], names: [:], parents: [word: [9]], shown: [2], recent: [2]), [])
        let second = WaitingWindow.Seen(id: 43400, pid: word, subrole: "AXDialog", modal: true)
        XCTAssertEqual(DockAttention.marks([second, dialog], names: [:], parents: [word: [9]], shown: [2], recent: [2]).map(\.window), [43312])
    }

    func testTraceSaysWhenAMarkSetsAndClears() {
        let m = DockAttention.Mark(pid: word, app: "Microsoft Word", workspace: 9, window: 43312)
        XCTAssertEqual(DockAttention.traceLines(from: [], to: [m]), ["dock attention set: Microsoft Word needs you on workspace 9 (window 43312)"])
        XCTAssertEqual(DockAttention.traceLines(from: [m], to: [m]), [])
        XCTAssertEqual(DockAttention.traceLines(from: [m], to: []), ["dock attention cleared: Microsoft Word on workspace 9 (window 43312)"])
    }

    // MARK: The app uses these (source check)

    func source(_ name: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/\(name)"), encoding: .utf8)
    }

    func testTheAppWiresTheRuleTheMarkAndTheQuietDock() throws {
        let spaces = try source("Spaces.swift"), dock = try source("WorkspaceDock.swift"), windows = try source("Windows.swift")
        XCTAssertTrue(windows.contains("WaitingWindow.asks("), "the scan reports windows that wait on you")
        XCTAssertTrue(spaces.contains("WaitingWindow.claimTakes("), "an agent's claim leaves a modal window with its app")
        XCTAssertTrue(spaces.contains("DockAttention.marks("), "the marks follow each scan and switch")
        XCTAssertTrue(spaces.contains("DockAttention.traceLines("), "trace.log says when a mark sets and clears")
        XCTAssertTrue(dock.contains("model.onFocusWaiting(waiting)"), "a marked tile's click goes to the waiting window")
        XCTAssertTrue(dock.contains("SystemDockSettings.record("), "the macOS Dock's settings come from the tested plan")
        XCTAssertFalse(dock.contains("for key in [\"autohide\", \"autohide-delay\"]"), "no hand-kept key list that leaves bouncing out")
    }
}

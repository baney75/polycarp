import Foundation
import XCTest
@testable import BaneySpacesCore

/// An app's icon popped out of the hidden macOS Dock once a minute (Donovan, 2026-11-10): Word,
/// lent to an agent, had its document on the agent workspace and wanted an answer. These pin
/// where a window that waits on you belongs.
final class WaitingWindowTests: XCTestCase {
    // MARK: Which windows wait on you

    func testDialogsAlertsAndAnythingModalWaitOnYou() {
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXDialog", modal: true))
        // Only with the modal flag unreadable does the subrole stand in.
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXDialog", modal: nil))
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXSystemDialog", modal: nil))
        // A standard window that blocks its app is a dialog in all but name.
        XCTAssertTrue(WaitingWindow.asks(subrole: "AXStandardWindow", modal: true))
    }

    func testADialogThatBlocksNothingDoesNot() {
        // An About box, a Settings window, a Find panel: AXDialog, not modal.
        XCTAssertFalse(WaitingWindow.asks(subrole: "AXDialog", modal: false))
        XCTAssertFalse(WaitingWindow.asks(subrole: "AXSystemDialog", modal: false))
        XCTAssertEqual(WaitingWindow.place(asks: WaitingWindow.asks(subrole: "AXDialog", modal: false), parents: [9], shown: [2], recent: [2, 9]),
                       .ordinary)
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

    func testAnAgentStartedProcessKeepsItsModalWithTheClaim() {
        XCTAssertTrue(WaitingWindow.claimKeeps(agentStartedProcess: true, subrole: "AXStandardWindow", modal: true))
        XCTAssertFalse(WaitingWindow.claimKeeps(agentStartedProcess: false, subrole: "AXStandardWindow", modal: true),
                       "a lent app's modal stays with the app's windows")
        XCTAssertTrue(WaitingWindow.claimKeeps(agentStartedProcess: false, subrole: "AXStandardWindow", modal: false))
    }

    func testALentAppsStandardModalOutOfSightStaysWithItsApp() {
        // Standard subrole, modal: placed on the agent workspace with the app.
        XCTAssertEqual(WaitingWindow.place(asks: WaitingWindow.asks(subrole: "AXStandardWindow", modal: true), parents: [9], shown: [2], recent: [2]),
                       .needsAttention(9))
    }

    // MARK: Where it belongs

    func testItStaysBesideItsAppWhenThatWorkspaceIsInSight() {
        XCTAssertEqual(WaitingWindow.place(asks: true, parents: [2, 9], shown: [2], recent: [2, 9]), .withParent(2))
    }

    func testOutOfSightItJoinsTheAppsWorkspaceAndTakesYouNowhere() {
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

    let word: Int32 = 35218

    // MARK: The app uses these (source check)

    func source(_ name: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/\(name)"), encoding: .utf8)
    }

    func testTheAppWiresTheRule() throws {
        let spaces = try source("Spaces.swift"), windows = try source("Windows.swift")
        XCTAssertTrue(windows.contains("WaitingWindow.asks("), "the scan reports windows that wait on you")
        XCTAssertTrue(spaces.contains("WaitingWindow.claimKeeps(agentStartedProcess: c.newProcess"), "an agent's claim leaves a lent app's modal with its app")
        XCTAssertTrue(windows.contains("if modal == true { asks.append("), "a standard window that is modal is reported too")
    }
}

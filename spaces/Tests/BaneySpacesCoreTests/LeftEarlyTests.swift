import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS8, case 30, and review of #881 round 2, first-F1: a closed window comes back only when a
/// scan begun after it left lists it in a full answer, so the others never fill and then give the space back.
final class LeftEarlyTests: XCTestCase {
    let left: [WindowID: LeftEarly.Left] = [7: .init(workspace: 2, serial: 10)]

    func testAScanBegunBeforeTheLeaveNeverPutsItBack() {
        XCTAssertEqual(LeftEarly.held(left, scan: 10, relisted: [7]), [7], "⌘W: the focus note's scan was under way")
        XCTAssertEqual(LeftEarly.held(left, scan: 9, relisted: [7]), [7])
    }

    func testALaterScanThatDoesntListItInFullKeepsItOut() {
        XCTAssertEqual(LeftEarly.held(left, scan: 11, relisted: []), [7], "a kept answer still lists it")
    }

    func testALaterScanThatListsItPutsItBack() {
        XCTAssertEqual(LeftEarly.held(left, scan: 11, relisted: [7]), [], "the note was wrong")
    }
}

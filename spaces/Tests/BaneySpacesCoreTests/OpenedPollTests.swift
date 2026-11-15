import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 second-S5, round 2 first-F1: `openedChildren` read the app's children (and the window list, on the main
/// thread) about every 50 ms for 200 ms after every action, even when nothing opened.
final class OpenedPollTests: XCTestCase {
    typealias M = OpenedPoll.Mark
    let doc: Set<M> = [M(id: 8, onScreen: true)]

    /// Which of a run of looks read the app.
    func reads(_ looks: [Set<M>]) -> [Int] {
        var first: Set<M>?
        var out: [Int] = []
        for (i, now) in looks.enumerated() {
            if OpenedPoll.reads(now: now, first: first) { out.append(i) }
            if first == nil { first = now }
        }
        return out
    }

    func testAnActionThatOpenedNothingReadsOnce() {
        XCTAssertEqual(reads(Array(repeating: doc, count: 4)), [0], "one read, not four")
    }

    func testOnceSomethingChangedEveryLookReads() {
        let sheet = doc.union([M(id: 51, onScreen: true)])
        XCTAssertEqual(reads([doc, sheet, sheet, sheet]), [0, 1, 2, 3], "AX can lag the window server")
        let ordered = [M(id: 8, onScreen: true), M(id: 60, onScreen: false)]
        XCTAssertEqual(reads([Set(ordered), [M(id: 8, onScreen: true), M(id: 60, onScreen: true)]]), [0, 1], "a panel ordered in")
        XCTAssertEqual(reads([doc, []]), [0, 1], "a window gone is a change too")
    }

    func testOpenedChildrenPollsTheServerFirst() throws {
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(ws.contains("let server = Set(MenuAX.serverWindows(pid: pid).map { OpenedPoll.Mark(id: $0.id, onScreen: $0.onScreen) })"))
        XCTAssertTrue(ws.contains("guard OpenedPoll.reads(now: server, first: first) else { Thread.sleep(forTimeInterval: 0.05); continue }\n            let all = listWindows().windows"),
                      "the main-thread window list and the child read come after the check")
    }
}

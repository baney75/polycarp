import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 sol-F3, round 2 sol-sol-F4 and second-S3: a sheet with no window number of its own (a save sheet on an
/// edited document) was missing from an action's `opened`, because only numbered children were compared, so `close`
/// answered `closed: false` with nothing to act on.
final class OpenedSheetTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 4_000_000)

    func testASheetTheActionRaisedIsOpened() {
        var a = ChildAttribution()
        a.acted(session: "A", pid: 300, at: t0, existing: [], sheetsOn: [])
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(0.1))
        XCTAssertEqual(a.openedSheets([7], pid: 300, session: "A"), [7], "the save sheet close raised")
        XCTAssertEqual(a.openedSheets([7], pid: 300, session: "B"), [], "not another session's")
    }

    func testASheetAlreadyUpOrNobodysIsNot() {
        var a = ChildAttribution()
        a.acted(session: "A", pid: 300, at: t0, existing: [], sheetsOn: [7])
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(0.1))
        XCTAssertEqual(a.openedSheets([7], pid: 300, session: "A"), [], "it was there before the action")
        var b = ChildAttribution()
        b.acted(session: "A", pid: 300, at: t0, existing: [], sheetsOn: [])
        b.acted(session: "B", pid: 300, at: t0.addingTimeInterval(0.05), existing: [], sheetsOn: [])
        b.observedSheets(on: [8], pid: 300, at: t0.addingTimeInterval(0.1))
        XCTAssertEqual(b.openedSheets([8], pid: 300, session: "A"), [], "two sessions acted: whose it is can't be told")
        XCTAssertEqual(ChildAttribution().openedSheets([7], pid: 300, session: "A"), [], "no action")
    }

    func testTheOpenedEntryNamesItsWindowAndStopsARun() {
        let o = ChildWindowList.openedSheet(on: 7)
        guard case .object(let m) = o else { return XCTFail() }
        XCTAssertEqual(m["window"], .int(7))
        XCTAssertEqual(m["kind"], .string("sheet"))
        XCTAssertEqual(m["waiting"], .bool(true))
        XCTAssertEqual(RunSteps.stop(after: .success(.object(["opened": o]))), .opened)
    }

    func testOpenedChildrenReportsTheSheets() throws {
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(ws.contains("let sheets = childLocked { attribution.openedSheets(r.sheetsOn, pid: pid, session: session) }"))
        XCTAssertTrue(ws.contains("if !new.isEmpty || !sheets.isEmpty {"))
        XCTAssertTrue(ws.contains("+ sheets.sorted().map(ChildWindowList.openedSheet(on:))"))
    }
}

import BaneySpacesCore
import Foundation
import XCTest

/// Review round 1 of #116, one class per blocking finding.

/// first-F1: every open that succeeds looks for its window; one with no session reports it owned by nobody, and only a real
/// overlap identifies none, saying so plainly.
final class OpenWithoutSessionTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 7_000_000)
    func win(_ id: UInt32, pid: Int32) -> HandsWindow { HandsWindow(id: id, pid: pid, app: "TextEdit", workspace: 9) }

    func testAnOpenWithNoSessionStillFindsItsWindowAndOwnsNone() {
        var s = SessionWindows()
        XCTAssertEqual(s.beginOpen(id: 1, session: "", app: "TextEdit", separate: true, pid: nil, known: [], at: t0), .noSession)
        s.launched(1, pid: 500)
        XCTAssertEqual(s.claim(1, windows: [win(30, pid: 500)], now: t0)?.id, 30, "agent open TextEdit notes.txt reports its window")
        XCTAssertNil(s.owner(of: 30), "owned by nobody")
    }

    func testANoSessionOpenStillCountsTowardAnOverlapAndNeverTakesALateWindow() {
        var s = SessionWindows()
        XCTAssertEqual(s.beginOpen(id: 1, session: "", app: "Word", separate: false, pid: 300, known: [1], at: t0), .noSession)
        s.endOpen(1)
        XCTAssertEqual(s.beginOpen(id: 2, session: "a", app: "Word", separate: false, pid: 300, known: [1], at: t0.addingTimeInterval(1)), .overlap)
        XCTAssertTrue(s.resolvePending(app: "Word", windows: [win(40, pid: 300)], now: t0.addingTimeInterval(2)).isEmpty)
    }

    func testTheNoteSaysPlainlyThatNoWindowWasIdentifiedAndWhy() {
        XCTAssertTrue(OpenNote.text(.overlap, app: "Word").hasPrefix("Polycarp identified no window"))
        XCTAssertTrue(OpenNote.text(.overlap, app: "Word").contains("still waiting for its window or overlapped one in the last 30 s"))
        XCTAssertFalse(OpenNote.text(.noSession, app: "Word").contains("overlap"), "no session is not blamed on an overlap")
        XCTAssertFalse(OpenNote.text(.owns, app: "Word").contains("overlap"))
    }

    func testTheRouterLooksForTheWindowUnlessTheOpenOverlapped() throws {
        let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: "Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("while start != .overlap, window == nil"))
        XCTAssertTrue(src.contains("OpenNote.text(start, app: display)"))
    }
}

/// sol-F1: on a split app, a usable window holding a sheet this session didn't raise is refused; unsure counts as not.
final class SheetOnSplitWindowTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 7_100_000)
    let w = HandsWindow(id: 7, pid: 300, app: "Word", workspace: 9)

    func testASheetFromBeforeTheActionIsNotThisSessions() {
        var a = ChildAttribution()
        a.observedSheets(on: [7], pid: 300, at: t0)
        a.acted(session: "a", pid: 300, at: t0.addingTimeInterval(1), existing: [], sheetsOn: [7])
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(2))
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "a"))
        XCTAssertNotNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [false], split: true))
    }

    func testASheetTheActionRaisedIsThatSessionsUntilItCloses() {
        var a = ChildAttribution()
        a.acted(session: "a", pid: 300, at: t0, existing: [], sheetsOn: [])
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(1))
        XCTAssertTrue(a.sheetAttributed(on: 7, pid: 300, session: "a"))
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "b"))
        XCTAssertNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [true], split: true))
        a.observedSheets(on: [], pid: 300, at: t0.addingTimeInterval(20))
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(21))
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "a"), "a sheet that reopened later is not attributed")
    }

    func testUnsureIsRefusedOnASplitAppAndAnUnsplitAppIsUnaffected() {
        XCTAssertFalse(ChildAttribution().sheetAttributed(on: 7, pid: 300, session: "a"), "never seen")
        XCTAssertNotNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [true, false], split: true))
        XCTAssertNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [false], split: false))
        XCTAssertNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [], split: true))
    }

    func testTheGateChecksSheetsOnPlacedWindows() throws {
        let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: "Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("sheetProblem(now, agent: agent, session: session) ?? inspectProblem(now)"))
    }
}

/// sol-F2, first-F5: a moved-in window whose owner can't be confirmed goes back to Donovan; only a process known gone is dropped.
final class MovedInOwnerTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 7_200_000)
    func entry(started: Double?) -> MovedInWindows.Entry { .init(window: 8, pid: 100, startedAt: started, origin: .lent, from: 2, to: 9) }

    func testAnUnreadableStartTimeIsUnconfirmedNotGone() {
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: nil, alive: true), .unconfirmed)
        XCTAssertEqual(MovedInWindows.owner(entry(started: nil), startTime: 1000, alive: true), .unconfirmed, "first-F5: none read at the move")
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: 1000.1, alive: true), .same)
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: 2000, alive: true), .gone)
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: nil, alive: false), .gone)
    }

    func testAtLaunchAnUnconfirmedEntryIsDeniedAndSentBack() {
        for started in [Double(1000), nil] {
            let l = MovedInWindows.launch([entry(started: started)], startTime: { _ in nil }, alive: { _ in true }, lends: LendBook(), now: now, mode: .full)
            XCTAssertEqual(l.sendBack.map(\.window), [8])
            XCTAssertTrue(l.drop.isEmpty)
            let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: 9)
            XCTAssertFalse(l.book.decide(w, base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .full).allowed)
        }
    }

    func testSettleSendsAnUnconfirmedWindowBack() throws {
        let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: "Sources/BaneySpaces/Hands/HandsMovedIn.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("if who == .gone { b.drop(window: e.window) } else { live.append(e) }"))
    }
}

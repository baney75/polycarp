import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 second-S1: one look that failed or was cut off (AXWindows timed out, over 64 windows, a placed window's
/// children unreadable) retired every child it didn't show, so the agent's own dialog came back as first seen past 10 s and
/// was refused as Donovan's. Round 1 first-F8 and round 2 first-F7: an attributed palette kept the watch reading every 0.5 s
/// for as long as it stayed open.
final class ChildLookTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 3_000_000)

    /// Session A acts on pid 300 at t0, its dialog 50 (and a numberless sheet on window 7) appear at +1 s and are seen every
    /// half second up to +11.5 s, past the 10 s window.
    func seenUntilPastTheWindow() -> ChildAttribution {
        var a = ChildAttribution()
        a.acted(session: "A", pid: 300, at: t0, existing: [], sheetsOn: [])
        for i in 0...21 {
            let at = t0.addingTimeInterval(1 + Double(i) * 0.5)
            a.observed([50], pid: 300, at: at)
            a.observedSheets(on: [7], pid: 300, at: at)
        }
        return a
    }

    func testALookThatMissedWindowsRetiresNothing() {
        var a = seenUntilPastTheWindow()
        a.observed([], pid: 300, at: t0.addingTimeInterval(12), complete: false)
        a.observedSheets(on: [], pid: 300, at: t0.addingTimeInterval(12), complete: false)
        a.observed([50], pid: 300, at: t0.addingTimeInterval(12.5))
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(12.5))
        XCTAssertTrue(a.attributed(50, pid: 300, session: "A"), "second-S1: the dialog is still the agent's")
        XCTAssertTrue(a.sheetAttributed(on: 7, pid: 300, session: "A"), "and so is the sheet")
    }

    func testAWholeLookStillRetiresWhatClosed() {
        var a = seenUntilPastTheWindow()
        a.observed([], pid: 300, at: t0.addingTimeInterval(12))
        a.observedSheets(on: [], pid: 300, at: t0.addingTimeInterval(12))
        a.observed([50], pid: 300, at: t0.addingTimeInterval(12.5))
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(12.5))
        XCTAssertFalse(a.attributed(50, pid: 300, session: "A"), "closed, then a new 50 past the window: nobody's")
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "A"))
    }

    func testALookIsWholeOnlyWhenItSawEveryWindow() {
        XCTAssertTrue(ChildLook.complete(listed: true, count: 3, placedReadable: true))
        XCTAssertTrue(ChildLook.complete(listed: true, count: ChildLook.maxWindows, placedReadable: true))
        XCTAssertFalse(ChildLook.complete(listed: true, count: ChildLook.maxWindows + 1, placedReadable: true), "cut at 64")
        XCTAssertFalse(ChildLook.complete(listed: false, count: 0, placedReadable: true), "AXWindows didn't answer")
        XCTAssertFalse(ChildLook.complete(listed: true, count: 3, placedReadable: false), "a placed window's children unreadable")
    }

    func testTheWatchSlowsAfterTheActionAndStopsAtItsLimit() {
        let a = seenUntilPastTheWindow()
        XCTAssertEqual(a.watchDelay(pid: 300, now: t0.addingTimeInterval(5)), ChildAttribution.watchFast)
        XCTAssertEqual(a.watchDelay(pid: 300, now: t0.addingTimeInterval(30)), ChildAttribution.watchSlow, "first-F8: slower while it's someone's")
        XCTAssertLessThan(ChildAttribution.watchSlow, ChildAttribution.forgetAfter, "slow looks still keep sightings continuous")
        XCTAssertEqual(a.watchDelay(pid: 300, now: t0.addingTimeInterval(ChildAttribution.watchFor)), ChildAttribution.watchSlow)
        XCTAssertNil(a.watchDelay(pid: 300, now: t0.addingTimeInterval(ChildAttribution.watchFor + 1)), "first-F7: not for hours")
        XCTAssertFalse(a.watching(pid: 300, now: t0.addingTimeInterval(ChildAttribution.watchFor + 1)))
        XCTAssertNil(ChildAttribution().watchDelay(pid: 300, now: t0), "no action, no watch")
        var b = a
        b.acted(session: "A", pid: 300, at: t0.addingTimeInterval(ChildAttribution.watchFor + 5), existing: [50], sheetsOn: [7])
        XCTAssertEqual(b.watchDelay(pid: 300, now: t0.addingTimeInterval(ChildAttribution.watchFor + 6)), ChildAttribution.watchFast, "a new action starts it again")
    }

    func testTheAppReadSaysWhenALookMissedWindowsAndTheBookIsTold() throws {
        let ax = try HandsSourceTests.code("Sources/BaneySpaces/Hands/ChildWindowsAX.swift")
        XCTAssertTrue(ax.contains("guard answer == .success || answer == .noValue else { return Reading(children: [], sheetsOn: [], complete: false) }"), "AXWindows failed")
        XCTAssertTrue(ax.contains("for el in list.prefix(ChildLook.maxWindows) {"))
        XCTAssertTrue(ax.contains("if !kids.readable { placedReadable = false }"))
        XCTAssertTrue(ax.contains("complete: ChildLook.complete(listed: true, count: list.count, placedReadable: placedReadable))"))
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(ws.contains("attribution.observed(Set(r.children.map(\\.id)), pid: pid, at: now, parents: firstParents, complete: r.complete)"))
        XCTAssertTrue(ws.contains("attribution.observedSheets(on: r.sheetsOn, pid: pid, at: now, complete: r.complete)"))
        XCTAssertTrue(ws.contains("if let d = self.attribution.watchDelay(pid: pid, now: Date()) { return d }"), "the watch keeps the book's pace")
        XCTAssertTrue(ws.contains("self.watch(pid: pid, after: next)"))
    }
}

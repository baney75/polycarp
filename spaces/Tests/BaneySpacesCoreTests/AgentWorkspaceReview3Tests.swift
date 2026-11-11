import BaneySpacesCore
import Foundation
import XCTest

/// Review round 3 of #106.

/// sol-sol-F2: a pending `open` is tied to its own launch.
final class OpenRequestTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 8_000_000)
    let word = "com.microsoft.Word"
    func win(_ id: UInt32, pid: Int32 = 300) -> HandsWindow { HandsWindow(id: id, pid: pid, app: "Word", bundle: "com.microsoft.Word", workspace: 9) }

    /// The running app: one pid for everyone.
    func testOverlappingOpensOfARunningAppGiveTheWindowToNeither() {
        var s = SessionWindows()
        XCTAssertTrue(s.beginOpen(id: 1, session: "a", app: word, separate: false, pid: 300, known: [1], at: t0))
        XCTAssertNil(s.claim(1, windows: [], now: t0), "A, wait 0: nothing yet")
        s.endOpen(1)
        XCTAssertFalse(s.beginOpen(id: 2, session: "b", app: word, separate: false, pid: 300, known: [1], at: t0.addingTimeInterval(1)), "B overlaps A")
        // B's window appears first.
        XCTAssertNil(s.claim(2, windows: [win(20)], now: t0.addingTimeInterval(2)), "B: window_identified false")
        s.endOpen(2)
        XCTAssertTrue(s.resolvePending(app: word, windows: [win(20), win(21)], now: t0.addingTimeInterval(3)).isEmpty, "A's claim was cleared")
        XCTAssertNil(s.owner(of: 20))
        XCTAssertNil(s.owner(of: 21))
        XCTAssertTrue(s.requests.isEmpty, "both cleared")
    }

    func testALonePendingOpenGetsItsLateWindow() {
        var s = SessionWindows()
        s.beginOpen(id: 1, session: "a", app: word, separate: false, pid: 300, known: [1], at: t0)
        s.endOpen(1)
        XCTAssertEqual(s.resolvePending(app: word, windows: [win(1), win(20)], now: t0.addingTimeInterval(4)).map(\.window.id), [20])
        XCTAssertEqual(s.owner(of: 20), "a")
        XCTAssertTrue(s.resolvePending(app: word, windows: [win(20)], now: t0.addingTimeInterval(40)).isEmpty)
        var late = SessionWindows()
        late.beginOpen(id: 1, session: "a", app: word, separate: false, pid: 300, known: [], at: t0)
        late.endOpen(1)
        XCTAssertTrue(late.resolvePending(app: word, windows: [win(20)], now: t0.addingTimeInterval(31)).isEmpty, "after 30 s it is nobody's")
    }

    func testSeparateLaunchesEachGetOnlyTheirOwnProcesssWindow() {
        var s = SessionWindows()
        XCTAssertTrue(s.beginOpen(id: 1, session: "a", app: "TextEdit", separate: true, pid: nil, known: [], at: t0))
        s.endOpen(1)
        XCTAssertTrue(s.beginOpen(id: 2, session: "b", app: "TextEdit", separate: true, pid: nil, known: [], at: t0), "separate launches never conflict")
        XCTAssertNil(s.claim(2, windows: [win(20, pid: 401)], now: t0), "B's pid is not known yet: nothing")
        s.launched(2, pid: 402)
        s.launched(1, pid: 401)
        XCTAssertEqual(s.claim(2, windows: [win(20, pid: 401), win(21, pid: 402)], now: t0)?.id, 21, "B's own process, though A's came first")
        XCTAssertEqual(s.resolvePending(app: "TextEdit", windows: [win(20, pid: 401), win(21, pid: 402)], now: t0).map(\.window.id), [20])
        XCTAssertEqual(s.owner(of: 20), "a")
        XCTAssertEqual(s.owner(of: 21), "b")
    }

    func testTenNoWindowOpensNeverOwnAnotherSessionsWindow() {
        var s = SessionWindows()
        // B's open replies before its window appears.
        s.beginOpen(id: 100, session: "b", app: word, separate: false, pid: 300, known: [1], at: t0)
        s.endOpen(100)
        for i in 1...10 {
            let id = i
            s.beginOpen(id: id, session: "a", app: word, separate: false, pid: 300, known: [1], at: t0.addingTimeInterval(Double(i)))
            XCTAssertNil(s.claim(id, windows: [win(20)], now: t0.addingTimeInterval(Double(i))))
            s.endOpen(id)
            s.resolvePending(app: word, windows: [win(20)], now: t0.addingTimeInterval(Double(i) + 0.5))
            XCTAssertNotEqual(s.owner(of: 20), "a", "open \(i)")
        }
        // The same with separate launches: A's requests never match B's process.
        var t = SessionWindows()
        t.beginOpen(id: 100, session: "b", app: "TextEdit", separate: true, pid: nil, known: [], at: t0)
        t.launched(100, pid: 500)
        t.endOpen(100)
        for i in 1...10 {
            t.beginOpen(id: i, session: "a", app: "TextEdit", separate: true, pid: nil, known: [], at: t0)
            XCTAssertNil(t.claim(i, windows: [win(30, pid: 500)], now: t0))
            t.endOpen(i)
        }
        XCTAssertNotEqual(t.owner(of: 30), "a")
        XCTAssertEqual(t.resolvePending(app: "TextEdit", windows: [win(30, pid: 500)], now: t0).map(\.session), ["b"], "B still gets its own")
        XCTAssertFalse(SessionWindows().requests.contains { $0.session.isEmpty })
        var none = SessionWindows()
        XCTAssertFalse(none.beginOpen(id: 1, session: "", app: word, separate: true, pid: nil, known: [], at: t0), "no session, no window")
    }
}

/// Low: the parent guess is the main window only when it is also the focused one and usable.
final class ParentHintTests: XCTestCase {
    func testTheGuessNeedsMainAndFocusedToAgreeAndBeUsable() {
        XCTAssertEqual(ChildCollect.hint(main: 7, focused: 7, usable: [7]), 7)
        XCTAssertNil(ChildCollect.hint(main: 8, focused: 8, usable: [7]), "agreeing, but his window")
        XCTAssertNil(ChildCollect.hint(main: 7, focused: 70, usable: [7]), "the dialog is focused: unknown")
        XCTAssertNil(ChildCollect.hint(main: 8, focused: 7, usable: [7, 8]), "they disagree")
        XCTAssertNil(ChildCollect.hint(main: nil, focused: nil, usable: [7]))
    }
}

/// Medium: nothing in the managing verbs changes a window outside `mutateOnMain`.
final class MutationGateSourceTests: XCTestCase {
    func testEveryMutationIsInsideTheGate() throws {
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        var gated: [Range<String.Index>] = []
        var from = ws.startIndex
        while let r = ws.range(of: "mutateOnMain(", range: from..<ws.endIndex) {
            let body = try XCTUnwrap(HandsSourceTests.block(after: "mutateOnMain(", in: String(ws[r.lowerBound...])))
            let start = try XCTUnwrap(ws.range(of: body, range: r.lowerBound..<ws.endIndex))
            gated.append(start)
            from = r.upperBound
        }
        XCTAssertEqual(gated.count, 3, "move, arrange, close")
        var found = 0
        for call in ["host.move(", "host.arrange(", "host.close("] {
            var at = ws.startIndex
            while let r = ws.range(of: call, range: at..<ws.endIndex) {
                found += 1
                XCTAssertTrue(gated.contains { $0.contains(r.lowerBound) }, "\(call) outside mutateOnMain")
                at = r.upperBound
            }
        }
        XCTAssertEqual(found, 4, "move, the move's frame, arrange, close")
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        for call in ["host.move(", "host.arrange(", "host.close("] { XCTAssertFalse(router.contains(call), call) }
    }
}

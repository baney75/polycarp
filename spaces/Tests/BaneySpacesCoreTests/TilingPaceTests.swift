import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS4 and R-TS5: a look never waits on a settle, and a frame on its way isn't asked twice.
final class TilingPaceTests: XCTestCase {
    private func engine(_ ids: [WindowID]) -> (TilingEngine, TilingShot) {
        var e = TilingEngine()
        var o = TilingOptions()
        o.everywhere = true
        e.apply(o)
        let windows = ids.map { TilingWindow(id: $0, pid: 7, bundle: "app", workspace: 1, frame: CGRect(x: 40, y: 60, width: 700, height: 500)) }
        return (e, TilingShot(windows: windows, shown: [1: .init(display: "D1", area: CGRect(x: 0, y: 25, width: 1728, height: 1050))], focused: nil))
    }

    func testCase16ASettleReportsOnlyTheWindowsItsWriteStillHolds() {
        var w = TilingWrites()
        let a = w.wrote([1, 2]), b = w.wrote([1])
        XCTAssertEqual(w.own([1, 2], a), [2])
        XCTAssertEqual(w.own([1], b), [1])
        w.done([1, 2], a)
        XCTAssertEqual(w.own([1], b), [1], "A's end leaves B's window to B")
        w.done([1], b)
        XCTAssertEqual(w.own([1], b), [])
    }

    func testCase17AFrameInFlightIsNotAskedAgain() throws {
        var (e, shot) = engine([1])
        let first = e.plan(shot)
        XCTAssertEqual(first.count, 1)
        e.flying([1])
        XCTAssertEqual(e.plan(shot), [], "the same target, still on its way")
        e.grounded([1])
        XCTAssertEqual(e.plan(shot).count, 1, "asked again once its settle ended")
    }

    func testCase18AnotherTargetIsAskedAtOnce() throws {
        var (e, shot) = engine([1])
        _ = e.plan(shot)
        e.flying([1])
        shot.windows.append(TilingWindow(id: 2, pid: 7, bundle: "app", workspace: 1, frame: CGRect(x: 40, y: 60, width: 700, height: 500)))
        let moves = e.plan(shot)
        XCTAssertTrue(moves.contains { $0.id == 1 }, "window 1's tile halved: a new target")
        XCTAssertTrue(moves.contains { $0.id == 2 })
    }

    func testCase19And20LandingOrATouchEndsTheFlight() throws {
        for end in ["landed", "touched"] {
            var (e, shot) = engine([1])
            _ = e.plan(shot)
            e.flying([1])
            if end == "landed" { _ = e.landed([1: shot.windows[0].frame]) } else { e.touched(1) }
            XCTAssertEqual(e.plan(shot).count, 1, end)
        }
    }

    /// Review of #863, first-F1: settle A, still watching window 1 after key 2 asked it for another target, must not
    /// grade A's frame against B's target (it learned a minimum 1728 wide from a half tile).
    func testAnOldSettleNeverGradesANewerTarget() throws {
        var (e, shot) = engine([1])
        let a = try XCTUnwrap(e.plan(shot).first)
        e.flying([1])
        shot.windows.append(TilingWindow(id: 2, pid: 7, bundle: "app", workspace: 1, frame: CGRect(x: 40, y: 60, width: 700, height: 500)))
        let b = try XCTUnwrap(e.plan(shot).first { $0.id == 1 })
        XCTAssertNotEqual(a.to, b.to)
        XCTAssertFalse(e.landed([1: a.to], targets: [1: a.to]), "A's frame, B's target: nothing learned")
        XCTAssertNil(e.minimums[1])
        XCTAssertTrue(e.asked[1]?.flying == false || e.asked[1]?.target == b.to)
    }

    /// The other half of first-F1: a write owns its windows from its start, so A's settle gives window 1 up as soon as B
    /// begins, before B returns.
    func testAWriteOwnsItsWindowsFromItsStart() {
        var w = TilingWrites()
        let a = w.wrote([1, 2])
        _ = w.wrote([1])
        XCTAssertEqual(w.own([1, 2], a), [2])
    }

    /// Review of #863, second-F6: a window late on its second try, skipped by a plan during its flight, must get the
    /// look that plan didn't give it when its settle finds it short.
    func testAWindowHeldBackInFlightIsLookedAtAgainIfItLandsShort() throws {
        var (e, shot) = engine([1])
        let m = try XCTUnwrap(e.plan(shot).first)
        e.grounded([1])
        _ = e.landed([1: shot.windows[0].frame])
        XCTAssertEqual(e.plan(shot).first?.to, m.to, "asked a second time")
        e.flying([1])
        XCTAssertEqual(e.plan(shot), [], "held back in flight")
        XCTAssertTrue(e.landed([1: shot.windows[0].frame], targets: [1: m.to]), "it never moved: a look is owed")
        XCTAssertEqual(e.plan(shot).first?.to, m.to, "and that look asks it a third time")
    }

    /// Review of #863, second-F5: a plan that held a window back wrote something in effect; its rounding count stands.
    func testAPlanThatHeldAWindowBackKeepsTheRoundingCount() throws {
        var (e, shot) = engine([1])
        _ = e.plan(shot)
        e.flying([1])
        e.roundings[1] = 2
        XCTAssertEqual(e.plan(shot), [])
        XCTAssertEqual(e.roundings[1], 2)
    }

    /// Review of #863 round 2, second-F2: a tab that takes the place of a window in flight is not in flight itself, since
    /// no settle watches its id; it gets its tile.
    func testATabThatTakesAFlyingWindowsPlaceIsAskedForItsTile() throws {
        var (e, shot) = engine([1])
        let m = try XCTUnwrap(e.plan(shot).first)
        e.flying([1])
        shot.windows = [TilingWindow(id: 2, pid: 7, bundle: "app", workspace: 1, frame: shot.windows[0].frame)]
        let moves = e.plan(shot)
        XCTAssertEqual(moves.first?.id, 2)
        XCTAssertEqual(moves.first?.to, m.to)
    }

    /// Review of #863 round 2: the settle grades before it grounds (grounding first erased that a plan held a window
    /// back, first-F1), and a write a switch cut off looks again shortly, not at once (second-F3).
    func testTheSettleGradesFirstAndACutWriteWaits() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Tiling.swift")
        let settle = try XCTUnwrap(code.range(of: "private func settle(")).lowerBound
        let after = try XCTUnwrap(code.range(of: "private func ready()", range: settle..<code.endIndex)).lowerBound
        let body = String(code[settle..<after])
        let graded = try XCTUnwrap(body.range(of: "self.engine.landed(now, targets: targets)"))
        let grounded = try XCTUnwrap(body.range(of: "self.engine.grounded(ids.subtracting(now.keys))"))
        XCTAssertLessThan(graded.lowerBound, grounded.lowerBound)
        let write = try XCTUnwrap(code.range(of: "private func write(")).lowerBound
        let wbody = String(code[write..<settle])
        XCTAssertFalse(wbody.contains("self.again = true"), "a cut write must not loop back at once")
        XCTAssertTrue(wbody.contains("else if cut { self.lookSoon(0.03) }"))
    }

    /// Cases 13 to 15, the wiring: tiling is busy only while it asks or writes. The ratchet: a settle that holds `busy`
    /// again (the 2026-11-26 lag, up to 600 ms behind each key) fails here.
    func testCases13To15ASettleNeverHoldsTheNextLook() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Tiling.swift")
        let settle = try XCTUnwrap(code.range(of: "private func settle(")).lowerBound
        let after = try XCTUnwrap(code.range(of: "private func ready()", range: settle..<code.endIndex)).lowerBound
        let body = String(code[settle..<after])
        XCTAssertFalse(body.contains("ready()"), "the settle must not end the busy time")
        XCTAssertFalse(body.contains("busy"), "the settle must not touch busy")
        let write = try XCTUnwrap(code.range(of: "private func write(")).lowerBound
        let wbody = String(code[write..<settle])
        let r = try XCTUnwrap(wbody.range(of: "self.ready()")), s = try XCTUnwrap(wbody.range(of: "self.settle("))
        XCTAssertLessThan(r.lowerBound, s.lowerBound, "the write's return ends the busy time, before the settle starts")
        XCTAssertTrue(wbody.contains("if again { self.look() }"), "a look asked meanwhile runs at the write's return")
    }
}

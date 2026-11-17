import BaneySpacesCore
import XCTest

/// 11-17: 257 scans in 8.8 days held the main thread 100 ms or more (median 253 ms), because a scan waited on main for
/// the slowest app. A scan now waits 5 ms at most; an app that answers later is merged on its own.
///
/// These fail with the wait-for-all scan: swap `group.wait(timeout: .now() + wait)` in `ScanFanOut.round` for
/// `group.wait()` and the first test's main thread waits for the hung app (2,000 ms against a 16 ms budget).
final class ScanFanOutTests: XCTestCase {
    /// A fake app's answer: its windows, or a timeout.
    struct Read: Equatable {
        let pid: Int32
        let windows: [WindowID]
        let ok: Bool
    }

    /// Apps 1 to 4 answer at once with two windows each; `hung` sleeps `hangs` seconds, then times out.
    final class Apps: @unchecked Sendable {
        let hung: Int32
        let hangs: TimeInterval
        private let lock = NSLock()
        private(set) var asked: [Int32: Int] = [:]
        init(hung: Int32 = 99, hangs: TimeInterval = 2) { self.hung = hung; self.hangs = hangs }
        func read(_ pid: Int32) -> Read {
            lock.lock(); asked[pid, default: 0] += 1; lock.unlock()
            if pid == hung { Thread.sleep(forTimeInterval: hangs); return Read(pid: pid, windows: [], ok: false) }
            return Read(pid: pid, windows: [WindowID(pid) * 10, WindowID(pid) * 10 + 1], ok: true)
        }
        func count(_ pid: Int32) -> Int { lock.lock(); defer { lock.unlock() }; return asked[pid] ?? 0 }
    }

    static let pids: [Int32] = [1, 2, 3, 4, 99]
    static let hungWindows: Set<WindowID> = [990, 991]

    /// A model that already knows each window on its workspace (`assign` moves only windows it knows).
    static func model(_ placed: [WindowID: Int]) -> Workspaces {
        var m = Workspaces()
        m.sync(seen: Array(placed.keys), alive: Set(placed.keys))
        for (id, n) in placed { m.assign(id, to: n, focus: false) }
        return m
    }

    /// The main thread's part of a scan: the round, then the model brought up to date from what came back.
    static func scan(_ fan: ScanFanOut<Read>, _ apps: Apps, model: inout Workspaces, alive: Set<WindowID>) -> (ScanFanOut<Read>.Round, TimeInterval) {
        let start = ProcessInfo.processInfo.systemUptime
        let round = fan.round(pids) { apps.read($0) }
        let seen = round.answered.values.filter(\.ok).flatMap(\.windows)
        _ = model.sync(seen: seen, alive: alive)
        return (round, ProcessInfo.processInfo.systemUptime - start)
    }

    func testAHungAppNeverHoldsTheMainThreadOrTheOtherApps() {
        let apps = Apps()
        let late = expectation(description: "the hung app's answer comes in late")
        late.assertForOverFulfill = false
        let fan = ScanFanOut<Read> { late.fulfill() }
        var model = Self.model([990: 3, 991: 3])
        let alive = Set([10, 11, 20, 21, 30, 31, 40, 41] as [WindowID]).union(Self.hungWindows)

        // Warm up the queue's threads so the first measured round isn't paying for thread creation.
        _ = ScanFanOut<Read>(onLate: {}).round([7]) { Read(pid: $0, windows: [], ok: true) }

        let (first, main) = Self.scan(fan, apps, model: &model, alive: alive)
        XCTAssertLessThan(main, ScanCheck.frame, "the main thread waited \(Int(main * 1000)) ms for the scan")
        XCTAssertEqual(first.pending, [99])
        XCTAssertEqual(Set(first.answered.keys), [1, 2, 3, 4])
        for id in [10, 11, 20, 21, 30, 31, 40, 41] as [WindowID] {
            XCTAssertNotNil(model.workspace(of: id), "window \(id) of an app that answered is placed")
        }
        XCTAssertEqual(model.workspace(of: 990), 3)

        // While its read is out, the hung app is pending for every scan and never asked twice at once.
        let (second, again) = Self.scan(fan, apps, model: &model, alive: alive)
        XCTAssertLessThan(again, ScanCheck.frame)
        XCTAssertEqual(second.pending, [99])
        XCTAssertEqual(apps.count(99), 1)
        XCTAssertTrue(fan.isReading(99))

        // Its answer comes in on its own and is merged by a scan that asks nobody.
        wait(for: [late], timeout: 4)
        XCTAssertTrue(fan.hasLate)
        let merge = fan.takeLate()
        XCTAssertEqual(merge.answered[99], Read(pid: 99, windows: [], ok: false))
        XCTAssertEqual(merge.asked, 0)
        XCTAssertFalse(fan.isReading(99))
        XCTAssertEqual(apps.count(1), 2, "a merge of late answers asks no app")
    }

    /// The closed-window rule and the tally, as `Spaces.refresh` runs them for one scan.
    static func judge<R>(_ round: ScanFanOut<R>.Round, apps: Set<Int32>, before: Set<Int32>, listed: Set<WindowID>,
                         ok: (R) -> Bool, model: inout Workspaces, alive: Set<WindowID>, seen: [WindowID]) -> (ScanTally, Set<WindowID>) {
        let tally = ScanTally.of(round, apps: apps, answeredBefore: before, ok: ok)
        let offscreen = Dictionary(uniqueKeysWithValues: hungWindows.map { ($0, Int32(99)) })
        let closed = ScanCheck.closed(known: Set(model.home.keys), listed: listed, vouching: tally.fresh,
                                      offscreen: offscreen, onNoOtherDesktop: { _ in true })
        _ = model.sync(seen: seen, alive: alive.subtracting(closed))
        return (tally, closed)
    }

    func testATimedOutAppKeepsItsWindowsLastWorkspace() {
        let apps = Apps(hangs: 0.3)
        let late = expectation(description: "the timeout comes back")
        late.assertForOverFulfill = false
        let fan = ScanFanOut<Read> { late.fulfill() }
        var model = Self.model([990: 3, 991: 3, 10: 1])
        let alive: Set<WindowID> = [10, 11, 20, 21, 30, 31, 40, 41, 990, 991]
        let everyone = Set(Self.pids)
        let before = everyone // every app answered in full last time

        // Still out: not closed, kept on workspace 3, and its windows are no one's to call unplaced.
        let round = fan.round(Self.pids) { apps.read($0) }
        var listed = Set(round.answered.values.flatMap(\.windows))
        var (tally, closed) = Self.judge(round, apps: everyone, before: before, listed: listed, ok: \.ok, model: &model,
                                         alive: alive, seen: Array(listed))
        XCTAssertEqual(tally.pending, [99])
        XCTAssertTrue(closed.isEmpty)
        XCTAssertEqual(model.workspace(of: 990), 3)
        XCTAssertEqual(model.workspace(of: 991), 3)
        let onScreen: [WindowID: Int32] = [990: 99, 991: 99]
        XCTAssertTrue(ScanCheck.unplaced(onScreen: onScreen, placed: [], notWindows: [], unsure: tally.unsure).isEmpty)

        // Back with a timeout: still nothing closed, still workspace 3.
        wait(for: [late], timeout: 3)
        let merge = fan.takeLate()
        listed = Set(merge.answered.values.flatMap(\.windows))
        (tally, closed) = Self.judge(merge, apps: everyone, before: before, listed: listed, ok: \.ok, model: &model,
                                     alive: alive, seen: [])
        XCTAssertEqual(tally.failed, [99])
        XCTAssertEqual(tally.standing, [1, 2, 3, 4])
        XCTAssertTrue(closed.isEmpty)
        XCTAssertEqual(model.workspace(of: 990), 3)
        XCTAssertEqual(model.workspace(of: 991), 3)
        XCTAssertEqual(model.workspace(of: 10), 1, "an app not asked by the merge keeps its windows too")

        // The same app answering in full without them is what closes them: the rule above isn't vacuous.
        let full = ScanFanOut<Read>.Round(answered: [99: Read(pid: 99, windows: [991], ok: true)])
        (tally, closed) = Self.judge(full, apps: everyone, before: before, listed: [991], ok: \.ok, model: &model,
                                     alive: alive, seen: [991])
        XCTAssertEqual(closed, [990])
        XCTAssertNil(model.workspace(of: 990))
        XCTAssertEqual(model.workspace(of: 991), 3)
    }

    func testALateAnswerWithANewWindowIsPlaced() {
        let fan = ScanFanOut<Read>(onLate: {})
        let gate = DispatchSemaphore(value: 0)
        let first = fan.round([5]) { pid -> Read in gate.wait(); return Read(pid: pid, windows: [50], ok: true) }
        XCTAssertEqual(first.pending, [5])
        gate.signal()
        let deadline = Date().addingTimeInterval(2)
        while !fan.hasLate, Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
        var model = Workspaces()
        let merge = fan.takeLate()
        _ = model.sync(seen: merge.answered.values.flatMap(\.windows), alive: [50])
        XCTAssertEqual(model.workspace(of: 50), model.current)
    }

    /// An app asked for the first time and not back yet is pending, never one that has no windows.
    func testAnAppNeverAnsweredIsPendingNotStanding() {
        let round = ScanFanOut<Read>.Round()
        let t = ScanTally.of(round, apps: [1, 2], answeredBefore: [1], ok: \.ok)
        XCTAssertEqual(t.standing, [1])
        XCTAssertEqual(t.pending, [2])
        XCTAssertEqual(t.unsure, [2])
    }

    /// A late answer for an app the scan no longer asks (it quit) is dropped, not merged.
    func testALateAnswerForAnAppThatQuitIsDropped() {
        let fan = ScanFanOut<Read>(onLate: {})
        let gate = DispatchSemaphore(value: 0)
        _ = fan.round([6]) { pid -> Read in gate.wait(); return Read(pid: pid, windows: [60], ok: true) }
        gate.signal()
        let deadline = Date().addingTimeInterval(2)
        while !fan.hasLate, Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
        let next = fan.round([1]) { Read(pid: $0, windows: [], ok: true) }
        XCTAssertNil(next.answered[6])
        XCTAssertNil(fan.takeLate().answered[6])
    }
}

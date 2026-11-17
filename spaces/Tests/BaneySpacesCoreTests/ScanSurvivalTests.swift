import BaneySpacesCore
import XCTest

/// Organizers study, item 6: Polycarp must survive apps that ignore Accessibility. One app answers every ask 2 s late,
/// one never answers. Over 20 switches each switch's scan stays under 150 ms on the main thread, the slow app's new
/// window is placed within 5 s of its answer, and no window ever lands on the wrong workspace. The scan runs as
/// `Spaces.refresh` runs it (`ScanFanOut`, `ScanTally`, `ScanCheck.closed`, `Workspaces.sync`), then `switchTo`.
/// Live: `swift scripts/slow-app-probe.swift <empty n>` does the same with two real apps.
final class ScanSurvivalTests: XCTestCase {
    struct Read {
        let pid: Int32
        let windows: [WindowID]
        let ok: Bool
    }

    static let fast: [Int32: [WindowID]] = [1: [10, 11], 2: [20, 21]]
    static let slow: Int32 = 7, hung: Int32 = 8
    /// Each app's deadline, as `AXScan.appTimeout` gives it: the hung app's ask comes back as a timeout then.
    static let deadline: TimeInterval = 3

    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var answered: TimeInterval?
        func note() { lock.lock(); if answered == nil { answered = ProcessInfo.processInfo.systemUptime }; lock.unlock() }
        var slowAnswered: TimeInterval? { lock.lock(); defer { lock.unlock() }; return answered }
    }

    func testTwentySwitchesWithASlowAndAHungAppStayQuickAndPutEveryWindowRight() throws {
        let clock = Clock()
        let fan = ScanFanOut<Read>(onLate: {})
        // The slow app opened window 71 since the last scan; 70 is known on workspace 2. The hung app's 80 is on 3.
        let read: (Int32) -> Read = { pid in
            switch pid {
            case Self.slow:
                Thread.sleep(forTimeInterval: 2)
                clock.note()
                return Read(pid: pid, windows: [70, 71], ok: true)
            case Self.hung:
                Thread.sleep(forTimeInterval: Self.deadline)
                return Read(pid: pid, windows: [], ok: false)
            default:
                return Read(pid: pid, windows: Self.fast[pid] ?? [], ok: true)
            }
        }
        var model = Workspaces()
        var expected: [WindowID: Int] = [10: 1, 11: 1, 20: 2, 21: 2, 70: 2, 80: 3]
        for (id, n) in expected { model.assign(id, to: n, focus: false) }
        let alive = Set(expected.keys).union([71])
        let offscreen: [WindowID: Int32] = [70: Self.slow, 80: Self.hung]
        let apps: Set<Int32> = [1, 2, Self.slow, Self.hung]
        var answeredBefore = apps
        var placedAt: TimeInterval?
        var mains: [TimeInterval] = []

        for i in 0..<20 {
            let start = ProcessInfo.processInfo.systemUptime
            let round = fan.round(Array(apps), read: read)
            let tally = ScanTally.of(round, apps: apps, answeredBefore: answeredBefore, ok: \.ok)
            let fresh = round.answered.values.filter(\.ok)
            let closed = ScanCheck.closed(known: Set(model.home.keys), listed: Set(fresh.flatMap(\.windows)),
                                          vouching: tally.fresh, offscreen: offscreen, onNoOtherDesktop: { _ in true })
            let added = model.sync(seen: fresh.flatMap(\.windows), alive: alive.subtracting(closed))
            let target = i % 2 == 0 ? 1 : 2
            let plan = model.switchTo(target)
            let main = ProcessInfo.processInfo.systemUptime - start
            mains.append(main)
            answeredBefore.subtract(tally.failed)
            answeredBefore.formUnion(tally.fresh)

            XCTAssertLessThan(main, 0.150, "switch \(i + 1): the main thread spent \(Int(main * 1000)) ms")
            XCTAssertTrue(closed.isEmpty, "switch \(i + 1) closed \(closed)")
            if added.contains(71) {
                expected[71] = model.workspace(of: 71)
                placedAt = ProcessInfo.processInfo.systemUptime
            }
            for (id, n) in expected {
                XCTAssertEqual(model.workspace(of: id), n, "switch \(i + 1): window \(id) moved workspace")
            }
            // What the switch shows is exactly the target's windows: none from another workspace comes into sight.
            XCTAssertEqual(Set(plan.show), Set(expected.filter { $0.value == target }.keys), "switch \(i + 1)")
            XCTAssertTrue(Set(plan.hide).isDisjoint(with: expected.filter { $0.value == target }.keys))
            Thread.sleep(forTimeInterval: 0.15)
        }

        let answered = try XCTUnwrap(clock.slowAnswered, "the slow app never answered")
        let placed = try XCTUnwrap(placedAt, "the slow app's new window was never placed")
        XCTAssertLessThan(placed - answered, 5, "placed \(placed - answered) s after the slow app answered")
        XCTAssertEqual(model.workspace(of: 80), 3, "the hung app's window keeps its workspace")
        print("ScanSurvivalTests: slowest switch scan \(Int((mains.max() ?? 0) * 1000)) ms, window 71 placed \(Int((placed - answered) * 1000)) ms after its app answered")
    }
}

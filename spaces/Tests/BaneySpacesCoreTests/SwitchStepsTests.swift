@testable import BaneySpacesCore
import Darwin
import Foundation
import XCTest

/// The second half of a switch (`SwitchSteps`): the raise, the wait for focus and parking, in 5ccaa277's order and the app's.
final class SwitchStepsTests: XCTestCase {
    private let queue = DispatchQueue(label: "switch-steps-test.main", qos: .userInteractive)
    private let raiseQueue = DispatchQueue(label: "switch-steps-test.raise", qos: .userInteractive)

    // MARK: Order

    func testParkingDoesNotWaitForASlowRaise() {
        let raised = expectation(description: "raised"), finished = expectation(description: "finished")
        var events: [String] = []
        queue.async { [self] in
            let steps = SwitchSteps(queue: queue, raiseQueue: raiseQueue, waitForFocus: false, landed: { false })
            steps.run(raise: { usleep(200_000); return true }, raised: { _ in events.append("raised"); raised.fulfill() },
                      focused: { events.append("focused") },
                      park: { done in events.append("park"); done() }, finished: { events.append("finished"); finished.fulfill() })
        }
        wait(for: [raised, finished], timeout: 2)
        XCTAssertEqual(events, ["park", "raised", "focused", "finished"], "parking starts before the raise returns")
    }

    func testFocusCountsAsMovedOnceItLandsWithoutTheRaise() {
        let focused = expectation(description: "focused")
        var raiseBack = false
        queue.async { [self] in
            let steps = SwitchSteps(queue: queue, raiseQueue: raiseQueue, waitForFocus: true, landed: { true })
            steps.run(raise: { usleep(300_000); return true }, raised: { _ in raiseBack = true },
                      focused: { XCTAssertFalse(raiseBack); focused.fulfill() }, park: { $0() }, finished: {})
        }
        wait(for: [focused], timeout: 1)
    }

    func testAHideOfTheAppInFrontWaitsForFocusAndEverythingElseDoesNot() {
        let finished = expectation(description: "finished")
        var events: [String] = []
        var front = false
        queue.async { [self] in
            let steps = SwitchSteps(queue: queue, raiseQueue: raiseQueue, waitForFocus: true, landed: { front })
            steps.run(raise: nil, raised: { _ in }, focused: { events.append("focused") }, park: { [self] done in
                events.append("moved")
                steps.afterFocus { events.append("hid the app in front") }
                queue.asyncAfter(deadline: .now() + 0.05) { front = true; done() }
            }, finished: { finished.fulfill() })
        }
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(events, ["moved", "focused", "hid the app in front"])
    }

    func testTheOldOrderRaisesWaitsAndOnlyThenParks() {
        let finished = expectation(description: "finished")
        var events: [String] = []
        queue.async { [self] in
            let steps = SwitchSteps(order: .raiseThenPark, queue: queue, raiseQueue: raiseQueue, waitForFocus: false, landed: { false })
            steps.run(raise: { events.append("raise"); return true }, raised: { _ in }, focused: { events.append("focused") },
                      park: { done in events.append("park"); done() }, finished: { finished.fulfill() })
        }
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(events, ["raise", "focused", "park"])
    }

    func testAFocusThatNeverLandsGivesUpAtTheLimit() {
        let finished = expectation(description: "finished")
        let start = Date()
        queue.async { [self] in
            let steps = SwitchSteps(queue: queue, raiseQueue: raiseQueue, waitForFocus: true, limit: 0.2, landed: { false })
            steps.run(raise: nil, raised: { _ in }, focused: {}, park: { $0() }, finished: { finished.fulfill() })
        }
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(Date().timeIntervalSince(start), 0.2, accuracy: 0.1)
    }

    /// The app runs the raise through `SwitchSteps` in the app's order, brings the window forward first, keeps the
    /// LaunchServices check for a hide that waits on focus, and holds back only the hide of the app that was in front.
    func testTheAppUsesTheNewOrder() throws {
        let code = try Repo.code("Sources/BaneySpaces/Spaces.swift")
        let apply = try XCTUnwrap(code.range(of: "private func apply(_ plan: SwitchPlan"))
        let body = String(code[apply.lowerBound...].prefix(20000))
        XCTAssertTrue(body.contains("SwitchSteps(waitForFocus: waitForFocus, landed: landed)"), "the app's order, not .raiseThenPark")
        XCTAssertFalse(body.contains("raised = target.focus()"), "no raise on the main thread")
        XCTAssertFalse(body.contains("waitUntil(timeout: 0.5, interval: 0.01, { Windows.focusedPid() == frontPid }"))
        let forward = try XCTUnwrap(body.range(of: "FrontProcess.bringForward(pid: target.pid, window: target.id)"))
        let run = try XCTUnwrap(body.range(of: "steps.run(raise:"))
        XCTAssertLessThan(forward.lowerBound, run.lowerBound)
        XCTAssertTrue(body.contains("waitForFocus ? { Windows.focusedPid() == frontPid }"), "a held hide waits for LaunchServices")
        XCTAssertTrue(body.contains("afterFocus: steps.afterFocus"))
        XCTAssertTrue(code.contains("if holdHides.contains(pid) { afterFocus(hide) } else { hide() }"))
        let front = try Repo.code("Sources/BaneySpaces/FrontProcess.swift")
        XCTAssertFalse(front.contains("@_silgen_name"), "looked up at run time, so a macOS without a call still launches")
    }

    // MARK: Under build load

    /// The switch's second half while every core runs a build the way buildgate does (hw.ncpu processes under
    /// `taskpolicy -b nice -n 15`), against `spacesTiming` in spec/speed.json. A model: the app being raised answers after
    /// 197 ms of its own CPU (the p90 raise in Donovan's timing.log), from a thread at default priority (T3 Code's main
    /// thread runs at 31); LaunchServices reports the new front app after 2 ms of CPU on a background-band thread, as
    /// its daemon runs unboosted (taskinfo: darwin BG, low-priority CPU); parking takes 20 ms of the main thread and one
    /// 20 ms settle. Times run from the `concealed` mark: PR 1's bringing home and moving are outside it.
    func testUnderBuildLoadTheSwitchKeepsItsBudget() throws {
        let budgets = try spacesTiming()
        let spin = try Spinners(count: ProcessInfo.processInfo.activeProcessorCount)
        defer { spin.stop() }
        let wasBackground = getpriority(PRIO_DARWIN_PROCESS, 0) != 0
        // Polycarp itself is no background process; buildgate makes this test one.
        setpriority(PRIO_DARWIN_PROCESS, 0, 0)
        defer { if wasBackground { setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG) } }
        Thread.sleep(forTimeInterval: 0.3)
        let old = bench(.raiseThenPark), new = bench(.together)
        let line = "switch-steps under \(spin.count) spinners (taskpolicy -b nice 15), ms from concealed, p50/p90/max: "
            + "5ccaa277 order done \(old.done) parked \(old.parked); this order done \(new.done) parked \(new.parked); "
            + "budget p90 switch \(budgets.switch) parked \(budgets.parked)"
        print(line)
        XCTAssertTrue(old.done.p90 > budgets.switch || old.parked.p90 > budgets.parked, "the bench can fail: \(line)")
        XCTAssertLessThanOrEqual(new.done.p90, budgets.switch, line)
        XCTAssertLessThanOrEqual(new.parked.p90, budgets.parked, line)
    }

    private struct Spread: CustomStringConvertible {
        let p50: Int, p90: Int, max: Int
        init(_ v: [Double]) {
            let s = v.sorted()
            p50 = Int(s[s.count / 2].rounded()); p90 = Int(s[min(s.count - 1, Int(Double(s.count) * 0.9))].rounded())
            max = Int(s.last!.rounded())
        }
        var description: String { "\(p50)/\(p90)/\(max)" }
    }

    private func bench(_ order: SwitchSteps.Order, switches: Int = 30) -> (done: Spread, parked: Spread) {
        let app = FakeApp()
        var done: [Double] = [], parked: [Double] = []
        for _ in 0..<switches {
            // A switch is over once it finished and the app answered its raise: switches are seconds apart in real use.
            let over = DispatchGroup()
            over.enter(); over.enter()
            app.reset()
            queue.async { [self] in
                let t0 = DispatchTime.now()
                let ms = { Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6 }
                // The app's order brings the window forward through the window server first, which tells LaunchServices
                // without the app; 5ccaa277's order lets the app do it once it has answered the raise.
                if order == .together { app.launchServices.report() }
                let steps = SwitchSteps(order: order, queue: queue, raiseQueue: raiseQueue, waitForFocus: true, landed: { app.launchServices.front })
                steps.run(raise: { app.raise(reportsFront: order == .raiseThenPark) }, raised: { _ in over.leave() }, focused: { done.append(ms()) },
                          park: { [self] finished in
                              burn(ms: 20)
                              queue.asyncAfter(deadline: .now() + 0.02) { parked.append(ms()); finished() }
                          }, finished: { over.leave() })
            }
            over.wait()
            Thread.sleep(forTimeInterval: 0.03)
        }
        app.stop()
        return (Spread(done), Spread(parked))
    }

    private func spacesTiming() throws -> (switch: Int, parked: Int) {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("spec/speed.json"))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let kinds = try XCTUnwrap((json["spacesTiming"] as? [String: Any])?["kinds"] as? [String: [String: Any]])
        return (try XCTUnwrap(kinds["switch"]?["p90"] as? Int), try XCTUnwrap(kinds["parked"]?["p90"] as? Int))
    }
}

/// Uses `ms` of this thread's own CPU, so it takes longer the less of a core it gets.
private func burn(ms: Double) {
    func now() -> Double {
        var t = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
        return Double(t.tv_sec) * 1e3 + Double(t.tv_nsec) / 1e6
    }
    let end = now() + ms
    while now() < end {}
}

/// An app busy when the raise comes: its main thread (default priority) answers after 197 ms of CPU.
private final class FakeApp {
    let launchServices = FakeLaunchServices()
    private let ask = DispatchSemaphore(value: 0), answer = DispatchSemaphore(value: 0)
    private var running = true
    private var reports = false

    init() {
        let main = Thread { [self] in
            while true {
                ask.wait()
                guard running else { return }
                burn(ms: 197)
                if reports { launchServices.report() }
                answer.signal()
            }
        }
        main.qualityOfService = .default
        main.start()
    }

    func reset() { launchServices.reset() }

    func raise(reportsFront: Bool) -> Bool {
        reports = reportsFront
        ask.signal()
        answer.wait()
        return true
    }

    func stop() { running = false; ask.signal(); launchServices.stop() }
}

/// LaunchServices' daemon unboosted: a background-band thread that takes 2 ms of CPU to report the new front app.
private final class FakeLaunchServices {
    private let lock = NSLock()
    private var isFront = false
    private let asked = DispatchSemaphore(value: 0)
    private var running = true

    var front: Bool { lock.lock(); defer { lock.unlock() }; return isFront }

    init() {
        Thread { [self] in
            setpriority(PRIO_DARWIN_THREAD, 0, PRIO_DARWIN_BG)
            while true {
                asked.wait()
                guard running else { return }
                burn(ms: 2)
                lock.lock(); isFront = true; lock.unlock()
            }
        }.start()
    }

    func report() { asked.signal() }
    func reset() { lock.lock(); isFront = false; lock.unlock() }
    func stop() { running = false; asked.signal() }
}

/// hw.ncpu CPU-bound processes the way buildgate runs a build: `taskpolicy -b nice -n 15`. Each quits once this test
/// process is gone, so a crash leaves none behind.
private final class Spinners {
    let count: Int
    private let process = Process()

    init(count: Int) throws {
        self.count = count
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/taskpolicy")
        let script = """
        my ($n, $boss) = @ARGV; my @kids;
        for (1..$n) { my $p = fork(); if (!$p) { my $i = 0; while (1) { exit if ++$i % 4000000 == 0 && getppid() == 1 } } push @kids, $p }
        $SIG{TERM} = sub { kill 'KILL', @kids; exit 0 };
        while (kill(0, $boss)) { select(undef, undef, undef, 0.2) }
        kill 'KILL', @kids;
        """
        process.arguments = ["-b", "/usr/bin/nice", "-n", "15", "/usr/bin/perl", "-e", script, String(count), String(getpid())]
        try process.run()
    }

    func stop() {
        process.terminate()
        process.waitUntilExit()
    }
}

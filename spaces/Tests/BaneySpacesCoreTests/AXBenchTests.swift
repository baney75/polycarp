import BaneySpacesCore
import XCTest

/// 2026-11-24: Word, launched at 22:14:17, missed one call at 22:14:18 ("asked again in 5.0s") and was still not asked at
/// 22:22:07, when a switch hid its window. A miss while an app was benched counted and started the wait again, silently,
/// and the bar's status read makes one every 15 s of any app it can't reach in 0.1 s.
final class AXBenchTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_795_576_458)
    private func at(_ s: TimeInterval) -> Date { start.addingTimeInterval(s) }

    func testAMissWhileBenchedIsTheSameHang() {
        var bench = AXBench()
        XCTAssertEqual(bench.missed(7, age: nil, now: at(0)), 5)
        for t in stride(from: 0.5, to: 5, by: 0.5) { XCTAssertEqual(bench.missed(7, age: nil, now: at(t)), 5 - t, accuracy: 0.001) }
        XCTAssertFalse(bench.isBenched(7, now: at(5)), "free when the first wait ends")
        XCTAssertEqual(bench.missed(7, age: nil, now: at(6)), 30, "the second miss in a row, not the tenth")
    }

    /// What the bar did: a miss every 15 s, for ever.
    func testReadsThatIgnoreTheBenchCantKeepAnAppOnIt() {
        var bench = AXBench()
        bench.missed(7, age: nil, now: at(0))
        var free = 0.0
        for t in stride(from: 1.0, through: 600, by: 1) {
            if !bench.isBenched(7, now: at(t)) { free += 1 }
            if t.truncatingRemainder(dividingBy: 15) == 2 { bench.missed(7, age: nil, now: at(t)) }
        }
        XCTAssertGreaterThan(free, 10, "a scan gets its turn between waits")
    }

    func testAMissInTheFirstMinuteWaitsFiveSecondsAndDoesntAddUp() {
        var bench = AXBench()
        for t in stride(from: 0.0, to: 60, by: 6) { XCTAssertEqual(bench.missed(7, age: t, now: at(t)), 5) }
        XCTAssertEqual(bench.missed(7, age: 61, now: at(61)), 5, "the first strike")
        XCTAssertEqual(bench.missed(7, age: 67, now: at(67)), 30)
    }

    func testAnAppThatKeepsHangingIsAskedLessAndLess() {
        var bench = AXBench()
        var t = 0.0
        for delay in [5.0, 30, 120, 600, 600] {
            XCTAssertEqual(bench.missed(7, age: 4000, now: at(t)), delay)
            XCTAssertTrue(bench.isBenched(7, now: at(t + delay - 0.1)))
            t += delay
            XCTAssertFalse(bench.isBenched(7, now: at(t)))
        }
        bench.answered(7)
        XCTAssertEqual(bench.missed(7, age: 4000, now: at(t)), 5, "an answer wipes the slate")
    }

    /// The bar's reads stay off the window bench: only a call that can't reach `checked` is used there.
    func testTheBarNeverBenchesAnAppForWindowTracking() throws {
        let bar = try Repo.code("Sources/BaneySpaces/TopBarMenus.swift")
        let reader = try XCTUnwrap(SourceText.block(after: "enum BarReader", in: bar))
        for call in [".checked(", ".bool(", "markUnresponsive", ").value(", "?.value(", "el.string(", "read.string(", "$0.string("] {
            XCTAssertFalse(reader.contains(call), "\(call) benches the app when it times out")
        }
        XCTAssertTrue(reader.contains("statusBench.missed("), "a status miss goes on the bar's own bench")
    }
}

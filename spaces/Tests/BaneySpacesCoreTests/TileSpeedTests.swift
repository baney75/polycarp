import XCTest
import BaneySpacesCore

/// The layout runs on the main thread in the same breath as a window opening or a key press.
final class TileSpeedTests: XCTestCase {
    /// The thread's own CPU time, so other work on the Mac doesn't count.
    private func p90(_ runs: Int, _ body: () -> Void) -> Double {
        var ms: [Double] = []
        for _ in 0..<runs {
            let t = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            body()
            ms.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t) / 1e6)
        }
        ms.sort()
        return ms[Int(Double(runs) * 0.9) - 1]
    }

    func testFramesForThirtyWindowsStayUnderHalfAMillisecond() {
        let area = CGRect(x: 0, y: 0, width: 3440, height: 1440)
        let minimums = Dictionary(uniqueKeysWithValues: (UInt32(1)...30).map { ($0, CGSize(width: 60 + Double($0), height: 40)) })
        for style in TileStyle.allCases {
            var l = TileLayout(style: style)
            l.sync(Array(1...30), focused: nil, area: area)
            let ms = p90(400) { _ = l.frames(in: area, gaps: TileGaps(inner: 8, outer: 8), minimums: minimums) }
            let plain = p90(400) { _ = l.frames(in: area, gaps: TileGaps(inner: 8, outer: 8)) }
            print(String(format: "tiles: frames for 30 windows, %@, p90 %.4f ms (no minimums %.4f ms)", style.rawValue, ms, plain))
            XCTAssertLessThan(max(ms, plain), 0.5, "\(style)")
        }
    }
}

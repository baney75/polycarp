import XCTest
@testable import BaneySpacesCore

/// T3: a `polycarp theme set` reaches the app within 200 ms, every time, with the watcher built as the app builds it.
/// The old watcher looked once a second, so a set landed 0 to 1 s later: these fail on it.
final class PolycarpThemeReloadTests: XCTestCase {
    private var config: URL!
    private var current: URL { config.appendingPathComponent("current") }
    private var file: String { current.appendingPathComponent("theme.json").path }

    override func setUpWithError() throws {
        config = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-reload-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: config) }

    /// What the command does: a temp file beside the target, renamed into place.
    private func set(_ text: String) throws {
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        let tmp = current.appendingPathComponent(".theme.json.tmp").path
        try text.write(toFile: tmp, atomically: false, encoding: .utf8)
        XCTAssertEqual(rename(tmp, file), 0)
    }

    private final class Arrivals: @unchecked Sendable {
        let lock = NSLock()
        let cond = NSCondition()
        var names: [String?] = []
        func add(_ t: PolycarpTheme?) { cond.lock(); names.append(t?.name); cond.broadcast(); cond.unlock() }
        /// Waits for delivery number `n` (1-based); the seconds it took, or nil if it never came within `limit`.
        func wait(for n: Int, limit: TimeInterval) -> TimeInterval? {
            let t0 = Date()
            cond.lock(); defer { cond.unlock() }
            while names.count < n {
                if !cond.wait(until: t0.addingTimeInterval(limit)) { return nil }
            }
            return Date().timeIntervalSince(t0)
        }
    }

    /// The watcher as `AppDelegate` makes it: every default, started the way launch starts it.
    private func appWatcher(_ seen: Arrivals) -> PolycarpThemeWatcher {
        let w = PolycarpThemeWatcher(path: file, deliver: seen.add)
        _ = w.start(firstLookWithin: 0.15)
        return w
    }

    func testTwentyThemeSetsEachLandWithinTwoHundredMilliseconds() throws {
        try set(PolycarpFixtures.blocks)
        let seen = Arrivals()
        let w = appWatcher(seen)
        defer { w.stop() }
        var took: [Double] = []
        for i in 0..<20 {
            let fixture = i % 2 == 0 ? PolycarpFixtures.still_water : PolycarpFixtures.blocks
            let t0 = Date()
            try set(fixture)
            guard seen.wait(for: i + 1, limit: 1.5) != nil else { return XCTFail("set \(i + 1) never arrived") }
            took.append(Date().timeIntervalSince(t0) * 1000)
            XCTAssertEqual(seen.names.last!, i % 2 == 0 ? "still-water" : "blocks")
        }
        let sorted = took.sorted()
        print(String(format: "theme reload: 20 sets, median %.1f ms, max %.1f ms", sorted[10], sorted[19]))
        XCTAssertLessThan(sorted[19], 200, "every set lands within 200 ms: \(took.map { Int($0) })")
    }

    func testTheFirstSetIntoAConfigFolderWithNoCurrentFolderLands() throws {
        let seen = Arrivals()
        let w = appWatcher(seen)
        defer { w.stop() }
        try set(PolycarpFixtures.still_water)
        XCTAssertNotNil(seen.wait(for: 1, limit: 0.5), "current/ and the file appeared: it lands")
        XCTAssertEqual(seen.names.last!, "still-water")
    }

    /// A first set makes `current/` and renames the file in at once, often before the watch on the config folder is
    /// live (GCD registers it after `resume()`). Watching only what existed at arm time missed 30 of 60 of these.
    func testTwentyFirstSetsRacingTheWatchAllLand() throws {
        var missed: [Int] = []
        for i in 0..<20 {
            let config = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-race-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: config) }
            let current = config.appendingPathComponent("current"), path = current.appendingPathComponent("theme.json").path
            let seen = Arrivals()
            let w = PolycarpThemeWatcher(path: path, deliver: seen.add)
            _ = w.start(firstLookWithin: 0.15)
            try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
            let tmp = current.appendingPathComponent(".theme.json.tmp").path
            try PolycarpFixtures.still_water.write(toFile: tmp, atomically: false, encoding: .utf8)
            XCTAssertEqual(rename(tmp, path), 0)
            if seen.wait(for: 1, limit: 0.5) == nil { missed.append(i) }
            w.stop()
        }
        XCTAssertEqual(missed, [], "every first set lands")
    }

    func testRemovingTheFileOrTheCurrentFolderLands() throws {
        try set(PolycarpFixtures.still_water)
        let seen = Arrivals()
        let w = appWatcher(seen)
        defer { w.stop() }
        try FileManager.default.removeItem(atPath: file)
        XCTAssertNotNil(seen.wait(for: 1, limit: 0.5))
        XCTAssertNil(seen.names.last!, "theme off removes the file: the person's own look is back")
        try set(PolycarpFixtures.blocks)
        XCTAssertNotNil(seen.wait(for: 2, limit: 0.5))
        try FileManager.default.removeItem(at: current)
        XCTAssertNotNil(seen.wait(for: 3, limit: 0.5), "the whole folder went")
        XCTAssertNil(seen.names.last!)
    }

    func testAnEditInPlaceLands() throws {
        try set(PolycarpFixtures.still_water)
        let seen = Arrivals()
        let w = appWatcher(seen)
        defer { w.stop() }
        try Data(PolycarpFixtures.blocks.utf8).write(to: URL(fileURLWithPath: file))
        XCTAssertNotNil(seen.wait(for: 1, limit: 0.5))
        XCTAssertEqual(seen.names.last!, "blocks")
    }

    func testAnEditInPlaceThatPausesHalfWrittenNeverDropsTheTheme() throws {
        try set(PolycarpFixtures.still_water)
        let seen = Arrivals()
        let w = appWatcher(seen)
        defer { w.stop() }
        let bytes = Data(PolycarpFixtures.blocks.utf8)
        let h = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
        try h.truncate(atOffset: 0)
        try h.write(contentsOf: bytes.prefix(bytes.count / 2))
        Thread.sleep(forTimeInterval: 0.02)   // an editor's write, caught between its two halves
        try h.write(contentsOf: bytes.suffix(from: bytes.count / 2))
        try h.close()
        XCTAssertNotNil(seen.wait(for: 1, limit: 1))
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(seen.names, ["blocks"], "half a file never took the theme away, even for a frame")
    }

    func testABadFileStillTurnsTheThemeOffOnceItHoldsStill() throws {
        try set(PolycarpFixtures.still_water)
        let seen = Arrivals()
        let w = appWatcher(seen)
        defer { w.stop() }
        try Data("{ not json".utf8).write(to: URL(fileURLWithPath: file))
        XCTAssertNotNil(seen.wait(for: 1, limit: 1), "a bad file lands, a moment later")
        XCTAssertEqual(seen.names, [nil])
    }

    func testAStoppedWatcherHearsNothing() throws {
        let seen = Arrivals()
        let w = appWatcher(seen)
        w.stop()
        try set(PolycarpFixtures.still_water)
        XCTAssertNil(seen.wait(for: 1, limit: 0.3))
    }

    func testTheWatchCoversTheFileItsFolderAndTheConfigFolderOrTheNearestFolderThere() throws {
        XCTAssertEqual(PathEvents.targets(file), [config.path], "only the config folder exists yet")
        try set(PolycarpFixtures.still_water)
        XCTAssertEqual(PathEvents.targets(file), [file, current.path, config.path])
        let deep = config.appendingPathComponent("a/b/current/theme.json").path
        XCTAssertEqual(PathEvents.targets(deep), [config.path], "nothing below exists: the nearest folder that does")
    }
}

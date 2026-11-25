import XCTest

/// What Donovan opens most has to report how long it took, or "fast" is a guess. A view that loses its clock fails here.
final class OpenClockTests: XCTestCase {
    func testTheLauncherAndOverviewEachTimeTheirOpening() throws {
        for (file, clock) in [
            ("Sources/BaneySpaces/Launcher.swift", "OpenClock(panel == nil ? \"launcher-first\" : \"launcher\")"),
            ("Sources/BaneySpaces/Viewer.swift", "OpenClock(panel == nil ? \"overview-first\" : \"overview\")"),
        ] {
            let code = try SourceText.code(file)
            XCTAssertTrue(code.contains(clock), "\(file) has no clock")
            XCTAssertTrue(code.contains("defer { clock.shown() }"), "\(file) never reports it")
        }
    }

    /// The switcher waits 120 ms on purpose, so its clock starts when its panel is asked to show, not at the key.
    func testTheSwitcherTimesItsPanelFromTheShow() throws {
        let s = try SourceText.code("Sources/BaneySpaces/WorkspaceSwitcher.swift")
        let show = try XCTUnwrap(SourceText.block(after: "private func show(retried", in: s))
        XCTAssertTrue(show.contains("OpenClock(panel == nil ? \"switcher-first\" : \"switcher\")\n        defer { clock?.shown() }"))
        XCTAssertEqual(s.components(separatedBy: "OpenClock(").count - 1, 1)
    }

    func testTheLogKeepsWhatTheSwitchBenchReads() throws {
        // scripts/bench.sh reads `done=` from timing.log. An `open` line must not look like one.
        let spaces = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("open \\(what)=\\(ms)"))
        XCTAssertFalse("open launcher=12".contains("done="))
    }
}

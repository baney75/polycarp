import XCTest

/// What Donovan opens most has to report how long it took, or "fast" is a guess. A view that loses its clock fails here.
final class OpenClockTests: XCTestCase {
    func testTheLauncherOverviewAndDockEachTimeTheirOpening() throws {
        for (file, clock) in [
            ("Sources/BaneySpaces/Launcher.swift", "OpenClock(panel == nil ? \"launcher-first\" : \"launcher\")"),
            ("Sources/BaneySpaces/Viewer.swift", "OpenClock(panel == nil ? \"overview-first\" : \"overview\")"),
            ("Sources/BaneySpaces/WorkspaceDock.swift", "OpenClock(\"dock\")"),
        ] {
            let code = try HandsSourceTests.code(file)
            XCTAssertTrue(code.contains(clock), "\(file) has no clock")
            XCTAssertTrue(code.contains("defer { clock.shown() }"), "\(file) never reports it")
        }
    }

    func testTheLogKeepsWhatTheSwitchBenchReads() throws {
        // scripts/bench.sh reads `done=` from timing.log. An `open` line must not look like one.
        let spaces = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("open \\(what)=\\(ms)"))
        XCTAssertFalse("open launcher=12".contains("done="))
    }
}

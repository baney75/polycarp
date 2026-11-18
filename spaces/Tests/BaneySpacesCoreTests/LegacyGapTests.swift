import XCTest
@testable import BaneySpacesCore

/// PR 20 sol-F5: BaneySpaces started between main.swift's launch check and LegacyWatcher's observer was seen by neither,
/// and ran beside Polycarp. The watcher now looks at what is running once its observer is up.
final class LegacyGapTests: XCTestCase {
    func testTheWatcherSweepsWhatIsRunningAfterItStartsListening() throws {
        let src = try String(contentsOf: SourceText.root.appendingPathComponent("Sources/BaneySpaces/LegacyWatcher.swift"), encoding: .utf8)
        let start = try XCTUnwrap(src.range(of: "func start() {"))
        let observe = try XCTUnwrap(src.range(of: "forName: NSWorkspace.didLaunchApplicationNotification", range: start.upperBound..<src.endIndex))
        let sweep = try XCTUnwrap(src.range(of: "for app in NSWorkspace.shared.runningApplications where !app.isTerminated { handle(app, takesOver: false) }",
                                            range: start.upperBound..<src.endIndex), "start() sweeps")
        XCTAssertLessThan(observe.lowerBound, sweep.lowerBound, "listening first, so a launch is caught by one or the other")

        // The sweep's rule: BaneySpaces is asked to quit; Silas is left to the voice.
        XCTAssertTrue(LegacyHandover.onLaunch(bundleID: Product.Legacy.bundleID, alreadyNotified: false, takesOver: false).quit)
        XCTAssertFalse(LegacyHandover.onLaunch(bundleID: Product.Silas.bundleID, alreadyNotified: false, takesOver: false).quit)
        XCTAssertFalse(LegacyHandover.onLaunch(bundleID: "com.apple.Terminal", alreadyNotified: false, takesOver: false).quit)
    }
}

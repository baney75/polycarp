import BaneySpacesCore
import XCTest

/// Silas turns regular when its window opens from the menu bar, with no launch or activation to say so. The cached app
/// list then left it out, every refresh skipped the scan, and its window had no workspace: it stayed in sight on every
/// workspace (2026-11-22).
final class ScanAppsTests: XCTestCase {
    func testAnAppNewlyDrawingAWindowOutsideTheListMakesTheListStale() {
        // Silas (pid 7) opened its window; the list read before that leaves it out.
        XCTAssertTrue(ScanApps.listStale(outsiders: [7], before: []))
        XCTAssertTrue(ScanApps.listStale(outsiders: [3, 7], before: [3]))
    }

    func testAnOutsiderSeenBeforeDoesNotReadTheListOnEveryRefresh() {
        // A menu bar app's own window, there all along: read once when it appeared, not again.
        XCTAssertFalse(ScanApps.listStale(outsiders: [3], before: [3]))
        XCTAssertFalse(ScanApps.listStale(outsiders: [], before: [3]))
        XCTAssertFalse(ScanApps.listStale(outsiders: [], before: []))
    }
}

/// Source checks for the wiring: they compile on any build, so they fail on one without it.
final class ScanAppsWiringTests: XCTestCase {
    private func refreshBody() throws -> String {
        let spaces = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        return try XCTUnwrap(SourceText.block(after: "private func refresh(full: Bool, asking: Set<pid_t>, then body:", in: spaces))
    }

    func testTheSnapshotNamesTheAppsOutsideTheList() throws {
        let windows = try SourceText.code("Sources/BaneySpaces/Windows.swift")
        let snapshot = try XCTUnwrap(SourceText.block(after: "static func snapshot(apps: Set<pid_t>)", in: windows))
        XCTAssertTrue(snapshot.contains("outsiders.insert"), "Windows.snapshot must collect the apps outside `apps` drawing a window on screen")
    }

    func testARefreshReadsTheAppListAgainBeforeItSkipsTheScan() throws {
        let body = try refreshBody()
        let check = try XCTUnwrap(body.range(of: "listStale("), "refresh must ask whether the cached app list is stale")
        let reread = try XCTUnwrap(body.range(of: "RunningApps.invalidate()"), "a stale list must be read again")
        let skip = try XCTUnwrap(body.range(of: "clock.scan = \"skip\""))
        XCTAssertLessThan(check.lowerBound, skip.lowerBound, "the list is checked before the refresh decides nothing changed")
        XCTAssertLessThan(reread.lowerBound, skip.lowerBound)
    }
}

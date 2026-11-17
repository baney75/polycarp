import XCTest

/// Files stream into the launcher (spec/launcher.md R-L14). Spotlight can't run in a unit test,
/// so this reads the app's source: each keystroke stops the search in flight before anything
/// else, Spotlight answers in batches (never one synchronous query a newer key waits behind),
/// and every batch goes through `LateRows.merge`, which `LateRowsTests` pins.
final class FileStreamWiringTests: XCTestCase {
    func source() throws -> String {
        try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpaces/Launcher.swift"), encoding: .utf8)
    }

    func testEachKeystrokeStopsTheSearchInFlightFirst() throws {
        let s = try source()
        let body = try XCTUnwrap(s.range(of: "private func searchFiles() {").map { String(s[$0.upperBound...].prefix(400)) })
        let stop = try XCTUnwrap(body.range(of: "FileFinder.stop()"), "searchFiles must stop the search in flight")
        let guardAt = try XCTUnwrap(body.range(of: "guard forFiles"))
        XCTAssertLessThan(stop.lowerBound, guardAt.lowerBound, "stop before deciding whether to search again")
    }

    func testSpotlightAnswersInBatchesThatMergeIntoTheList() throws {
        let s = try source()
        XCTAssertFalse(s.contains("kMDQuerySynchronous"), "a synchronous query can't be stopped by a newer key")
        XCTAssertTrue(s.contains("MDQuerySetDispatchQueue"))
        XCTAssertTrue(s.contains("kMDQueryProgressNotification"))
        XCTAssertTrue(s.contains("MDQueryStop(run.query)"))
        XCTAssertTrue(s.contains("LateRows.merge(shown: self.filesShown"))
        XCTAssertTrue(s.contains("PaintClock.shared.filesShown(since: typedAt)"))
    }
}

@testable import BaneySpacesCore
import XCTest

/// The browser moved to Tychicus. `BrowserSetup.swift` stays because Tychicus's tests read its bundle ids, and its helper
/// is Tychicus's own install, never a helper inside Polycarp.app.
final class BrowserBundleTests: XCTestCase {
    func testTheHelperIsTychicusOwnInstall() {
        XCTAssertEqual(BrowserBundle.helper(home: "/Users/a").path, "/Users/a/.local/share/tychicus/release/tychicus")
        XCTAssertFalse(BrowserBundle.helper().path.contains("Polycarp.app"))
        XCTAssertEqual(BrowserBundle.home.absoluteString, "https://github.com/baney75/tychicus")
    }

    func testTheBundleIDsTychicusReadsAreStillHere() throws {
        XCTAssertGreaterThanOrEqual(BrowserBundle.bundleIDs.count, 10)
        XCTAssertEqual(BrowserBundle.bundleID(for: "Helium"), "net.imput.helium")
        // Tychicus's test cuts the block from `public static let bundleIDs` to the first "]\n" and reads `"Name": "id",` pairs.
        let source = try String(contentsOf: Repo.root.appendingPathComponent("Sources/BaneySpacesCore/BrowserSetup.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("public static let bundleIDs: [String: String] = [\n        \"Helium\": \"net.imput.helium\","))
    }
}

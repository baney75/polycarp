@testable import BaneySpacesCore
import XCTest

/// The agent browser extension was removed. `BrowserSetup.swift` stays because a test outside this repo reads its bundle ids.
final class BrowserBundleTests: XCTestCase {
    func testTheBundleIDsAreStillHereInTheFormTheyAreRead() throws {
        XCTAssertGreaterThanOrEqual(BrowserBundle.bundleIDs.count, 10)
        XCTAssertEqual(BrowserBundle.bundleID(for: "Helium"), "net.imput.helium")
        // The outside test cuts the block from `public static let bundleIDs` to the first "]\n" and reads `"Name": "id",` pairs.
        let source = try String(contentsOf: Repo.root.appendingPathComponent("Sources/BaneySpacesCore/BrowserSetup.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("public static let bundleIDs: [String: String] = [\n        \"Helium\": \"net.imput.helium\","))
    }
}

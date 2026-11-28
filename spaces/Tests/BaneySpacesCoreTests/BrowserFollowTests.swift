import XCTest
@testable import BaneySpacesCore

/// R-F4: which apps follow at once, without the new-window wait.
final class BrowserFollowTests: XCTestCase {
    func testKnownBrowsersFollowAtOnce() {
        for id in ["net.imput.helium", "com.baney.polycarp.browser", "com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox"] {
            XCTAssertTrue(Catalog.isBrowser(id, defaultBrowser: nil), id)
        }
    }

    func testTheDefaultBrowserFollowsAtOnceEvenIfUnknown() {
        XCTAssertTrue(Catalog.isBrowser("org.example.newbrowser", defaultBrowser: "org.example.newbrowser"))
    }

    func testOtherAppsKeepTheWait() {
        for id in ["com.mitchellh.ghostty", "com.t3tools.t3code", "com.apple.finder", "org.example.newbrowser"] {
            XCTAssertFalse(Catalog.isBrowser(id, defaultBrowser: "net.imput.helium"), id)
        }
    }

    func testNoBundleIDKeepsTheWait() {
        XCTAssertFalse(Catalog.isBrowser(nil, defaultBrowser: "net.imput.helium"))
        XCTAssertFalse(Catalog.isBrowser("", defaultBrowser: ""))
    }
}

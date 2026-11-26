import XCTest
@testable import BaneySpacesCore

/// A new icon goes into a signed app without breaking its signature (spec/themes.md, "The icons"). The bundles here are
/// temp copies signed ad hoc with a fixed requirement, so no keychain is touched.
final class AppIconSwapTests: XCTestCase {
    private var folder: URL!
    private let adHoc = AppIconSwap.Signer(identity: "-", keychain: nil)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("icon-swap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    /// A small app, signed like Polycarp.app is: an identifier and a requirement that does not change when it is signed again.
    private func signedApp() throws -> URL {
        let fm = FileManager.default, app = folder.appendingPathComponent("Test.app")
        for d in ["Contents/MacOS", "Contents/Resources"] {
            try fm.createDirectory(at: app.appendingPathComponent(d), withIntermediateDirectories: true)
        }
        try fm.copyItem(atPath: "/usr/bin/true", toPath: app.appendingPathComponent("Contents/MacOS/Test").path)
        let info: NSDictionary = ["CFBundleExecutable": "Test", "CFBundleIdentifier": "com.baney.polycarp.icon-test",
                                  "CFBundleIconFile": "Test", "CFBundlePackageType": "APPL"]
        try info.write(to: app.appendingPathComponent("Contents/Info.plist"))
        try Data("old icon".utf8).write(to: app.appendingPathComponent("Contents/Resources/Test.icns"))
        let signed = AppIconSwap.run(["--force", "--sign", "-", "--identifier", "com.baney.polycarp.icon-test",
                                      "-r=designated => identifier \"com.baney.polycarp.icon-test\"", app.path])
        XCTAssertEqual(signed.status, 0, signed.text)
        XCTAssertTrue(AppIconSwap.whole(app))
        return app
    }

    func testTheIconGoesInAndTheSignatureStaysWholeWithTheSameRequirement() throws {
        let app = try signedApp()
        let requirement = try XCTUnwrap(AppIconSwap.requirement(app))
        let icns = try XCTUnwrap(ThemeIcon.icns(ThemeIcon.brand))
        XCTAssertEqual(AppIconSwap.replace(app: app, icns: icns, signer: adHoc), .changed)
        XCTAssertEqual(try Data(contentsOf: app.appendingPathComponent("Contents/Resources/Test.icns")), icns)
        let strict = AppIconSwap.run(["--verify", "--deep", "--strict", app.path])
        XCTAssertEqual(strict.status, 0, strict.text)
        XCTAssertEqual(AppIconSwap.requirement(app), requirement)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["Test.app"], "nothing left beside it")
        // The same icon again changes nothing.
        XCTAssertEqual(AppIconSwap.replace(app: app, icns: icns, signer: adHoc), .unchanged)
    }

    func testASigningThatFailsLeavesTheAppAsItWas() throws {
        let app = try signedApp()
        let before = AppIconSwap.cdhash(app)
        let outcome = AppIconSwap.replace(app: app, icns: Data("new".utf8), signer: .init(identity: "No Such Identity", keychain: nil))
        XCTAssertEqual(outcome, .refused("signing the copy failed"))
        XCTAssertEqual(try Data(contentsOf: app.appendingPathComponent("Contents/Resources/Test.icns")), Data("old icon".utf8))
        XCTAssertEqual(AppIconSwap.cdhash(app), before)
        XCTAssertTrue(AppIconSwap.whole(app))
    }

    func testAnAppWhoseSignatureIsBrokenIsLeftAlone() throws {
        let app = try signedApp()
        try Data("changed after signing".utf8).write(to: app.appendingPathComponent("Contents/Resources/Other.txt"))
        XCTAssertEqual(AppIconSwap.replace(app: app, icns: Data("new".utf8), signer: adHoc),
                       .refused("its signature is not whole now, so it is left alone"))
        XCTAssertEqual(try Data(contentsOf: app.appendingPathComponent("Contents/Resources/Test.icns")), Data("old icon".utf8))
    }

    func testAPlainAdHocSignatureIsLeftAloneBecauseItsRequirementWouldChange() throws {
        let app = try signedApp()
        // Signed again with no requirement of its own: the requirement is then the code's hash.
        XCTAssertEqual(AppIconSwap.run(["--force", "--sign", "-", "--identifier", "com.baney.polycarp.icon-test", app.path]).status, 0)
        XCTAssertEqual(AppIconSwap.replace(app: app, icns: Data("new".utf8), signer: adHoc),
                       .refused("its signature has no requirement of its own"))
        XCTAssertEqual(try Data(contentsOf: app.appendingPathComponent("Contents/Resources/Test.icns")), Data("old icon".utf8))
    }
}

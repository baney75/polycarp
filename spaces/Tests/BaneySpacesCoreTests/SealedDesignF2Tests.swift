import BaneySpacesCore
import CryptoKit
import XCTest

/// The round 2 F2 tests, run against the sealed design. The launch read is ViewControlSetting.init's own expression,
/// `stored != nil && ViewControl.isOn(stored, key: ViewControlKey.read())`, with the planted Keychain key in place of read().
final class SealedDesignF2Tests: XCTestCase {
    func testAPlantedKeyAndMatchingSealLeaveViewControlOffAtLaunch() throws {
        let suite = "polycarp-view-control-seal-\(UUID().uuidString)"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        let planted = SymmetricKey(size: .bits256)
        let sealed = Data("com.baney.polycarp agentViewControl on".utf8)
        let seal = Data(HMAC<SHA256>.authenticationCode(for: sealed, using: planted)).base64EncodedString()
        d.set(seal, forKey: ViewControl.defaultsKey)
        let stored = d.object(forKey: ViewControl.defaultsKey)
        let on = stored != nil && ViewControl.isOn(stored, key: planted.withUnsafeBytes { Data($0) })
        XCTAssertFalse(on, "a valid seal under a planted key reads off")
    }

    func testASyntheticEventCannotConfirmTheViewControlSheet() throws {
        let sheet = try Repo.code("Sources/BaneySpaces/LendConsent.swift")
        XCTAssertTrue(sheet.contains("static func askViewControl() -> Bool {\n        confirm("), "turning it on asks on the sheet")
    }
}

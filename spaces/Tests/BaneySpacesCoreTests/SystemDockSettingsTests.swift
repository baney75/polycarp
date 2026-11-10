import Foundation
import XCTest
@testable import BaneySpacesCore

/// Word's icon popped out of the hidden macOS Dock once a minute while Word asked for attention
/// (Donovan, 2026-11-10). With the Workspace Dock on, the macOS Dock doesn't bounce, and the
/// person's own setting comes back exactly when it goes off.
final class SystemDockSettingsTests: XCTestCase {
    func n(_ v: Double) -> NSNumber { v as NSNumber }

    func testTheHiddenDockDoesNotBounce() {
        XCTAssertEqual(SystemDockSettings.ours["no-bouncing"], true as NSNumber)
        XCTAssertEqual(SystemDockSettings.ours["autohide"], true as NSNumber)
        XCTAssertEqual(SystemDockSettings.ours["autohide-delay"], n(1000))
    }

    func testRoundTripPutsBackWhatWasThere() {
        let before: [String: NSNumber] = ["autohide": false as NSNumber, "autohide-delay": n(0.5), "no-bouncing": false as NSNumber]
        let rec = SystemDockSettings.record(existing: nil, current: before)
        let back = SystemDockSettings.restore(saved: rec, current: SystemDockSettings.ours)
        XCTAssertEqual(back["autohide"], .some(false as NSNumber))
        XCTAssertEqual(back["autohide-delay"], .some(n(0.5)))
        XCTAssertEqual(back["no-bouncing"], .some(false as NSNumber))
    }

    func testRoundTripRemovesWhatWasAbsent() {
        let rec = SystemDockSettings.record(existing: nil, current: [:])
        let back = SystemDockSettings.restore(saved: rec, current: SystemDockSettings.ours)
        XCTAssertEqual(Set(back.keys), ["autohide", "autohide-delay", "no-bouncing"])
        for (_, v) in back { XCTAssertNil(v ?? nil) }
    }

    func testARecordFromBeforeNoBouncingPicksUpItsValueBeforeTheFirstWrite() {
        // Saved by an older build, which hid the Dock but never touched bouncing.
        let old: [String: Any] = ["autohide": false as NSNumber]
        // The person had turned bouncing off themselves.
        let rec = SystemDockSettings.record(existing: old, current: ["autohide": true as NSNumber, "autohide-delay": n(1000), "no-bouncing": true as NSNumber])
        XCTAssertEqual(rec["no-bouncing"] as? NSNumber, true as NSNumber)
        // The older record's own values are kept, not overwritten by Polycarp's.
        XCTAssertEqual(rec["autohide"] as? NSNumber, false as NSNumber)
        XCTAssertNil(rec["autohide-delay"])
        let back = SystemDockSettings.restore(saved: rec, current: SystemDockSettings.ours)
        XCTAssertEqual(back["no-bouncing"], .some(true as NSNumber))
        XCTAssertEqual(back["autohide"], .some(false as NSNumber))
        XCTAssertEqual(back["autohide-delay"], .some(nil))
    }

    func testAnOldRecordRestoresOnlyTheKeysItCovers() {
        // Quit before an update could hide the Dock again: bouncing was never Polycarp's to put back.
        let old: [String: Any] = ["autohide-delay": n(0.2)]
        let back = SystemDockSettings.restore(saved: old, current: SystemDockSettings.ours)
        XCTAssertNil(back["no-bouncing"])
        XCTAssertEqual(back["autohide-delay"], .some(n(0.2)))
    }

    func testASettingChangedSinceStaysThePersons() {
        let rec = SystemDockSettings.record(existing: nil, current: ["no-bouncing": false as NSNumber])
        var now = SystemDockSettings.ours
        now["no-bouncing"] = false as NSNumber
        XCTAssertNil(SystemDockSettings.restore(saved: rec, current: now)["no-bouncing"])
    }

    func testOurOwnLeftoverValuesAreNotSavedAsThePersons() {
        let rec = SystemDockSettings.record(existing: nil, current: SystemDockSettings.ours)
        XCTAssertEqual(Set(rec.keys), [SystemDockSettings.keysKey])
    }

    /// The app writes every key in this list and the uninstaller puts each one back.
    func testTheUninstallerPutsBouncingBack() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let script = try String(contentsOf: root.appendingPathComponent("uninstall.sh"), encoding: .utf8)
        for key in SystemDockSettings.keys { XCTAssertTrue(script.contains("com.apple.dock \(key)"), key) }
    }
}

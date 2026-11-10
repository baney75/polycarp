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
        XCTAssertEqual(Set(rec.keys), [SystemDockSettings.keysKey, SystemDockSettings.oursKey], "only the bookkeeping, no values of the person's")
    }

    func testARecordFromThisBuildIsFullyRestoredFromTheRecordAlone() {
        let before: [String: NSNumber] = ["autohide": false as NSNumber, "no-bouncing": false as NSNumber]
        let rec = SystemDockSettings.record(existing: nil, current: before)
        // The record carries what restoring needs: every key, and the value Polycarp wrote to each.
        XCTAssertEqual(Set(SystemDockSettings.listed(rec)), Set(SystemDockSettings.keys))
        XCTAssertEqual(rec[SystemDockSettings.oursKey] as? [String: NSNumber], SystemDockSettings.ours)
        // Restored with the Dock as this build left it, read from the record's own `_ours`.
        let now = rec[SystemDockSettings.oursKey] as! [String: NSNumber]
        let back = SystemDockSettings.restore(saved: rec, current: now)
        XCTAssertEqual(Set(back.keys), ["autohide", "autohide-delay", "no-bouncing"])
        XCTAssertEqual(back["no-bouncing"], .some(false as NSNumber))
        XCTAssertEqual(back["autohide-delay"], .some(nil))
    }

    func testRestoreNeverConsultsTheKeysThisBuildWrites() {
        // A key no build has today, written by some later one: its record alone brings it back.
        let rec: [String: Any] = [SystemDockSettings.keysKey: ["later-key"], SystemDockSettings.oursKey: ["later-key": 7 as NSNumber],
                                  "later-key": 3 as NSNumber]
        XCTAssertEqual(SystemDockSettings.restore(saved: rec, current: ["later-key": 7 as NSNumber]), ["later-key": .some(3 as NSNumber)])
    }

    func testTheAppDropsTheRecordOnlyAfterEveryWriteReadsBack() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let s = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/WorkspaceDock.swift"), encoding: .utf8)
        XCTAssertTrue(s.contains("current: current(SystemDockSettings.listed(saved))"), "reads every key the record lists")
        XCTAssertTrue(s.contains("let landed = plan.allSatisfy { key, value in read(key) == value }\n        if landed {\n            UserDefaults.standard.removeObject(forKey: savedKey)"))
    }

    /// The app writes every key in this list and the uninstaller puts each one back.
    func testTheUninstallerPutsBouncingBack() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let script = try String(contentsOf: root.appendingPathComponent("uninstall.sh"), encoding: .utf8)
        for key in SystemDockSettings.keys { XCTAssertTrue(script.contains("com.apple.dock \(key)"), key) }
    }

    /// The record lists what Polycarp wrote under `_ours`. The uninstaller's fallback must read
    /// only what was there before: a key that was absent is deleted, not set to Polycarp's value.
    func testTheUninstallerReadsOnlyTheSavedValuesNotOurs() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let script = try String(contentsOf: root.appendingPathComponent("uninstall.sh"), encoding: .utf8)
        let begin = try XCTUnwrap(script.range(of: "# dock-record:begin")), end = try XCTUnwrap(script.range(of: "# dock-record:end"))
        let function = String(script[begin.upperBound..<end.lowerBound])
        XCTAssertTrue(script.contains("saved=$(pref systemDockSaved | top_level)"), "the Dock fallback reads through top_level")

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dock-record-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let plist = dir.appendingPathComponent("prefs.plist")
        func values(_ record: [String: Any]) throws -> [String: String] {
            try PropertyListSerialization.data(fromPropertyList: ["systemDockSaved": record], format: .xml, options: 0).write(to: plist)
            let sh = function + """

            saved=$(defaults read "$1" systemDockSaved | top_level)
            printf 'delay=%s\\n' "$(printf '%s\\n' "$saved" | sed -n 's/.*"autohide-delay" = "\\{0,1\\}\\([0-9.]*\\)"\\{0,1\\};.*/\\1/p')"
            printf 'hide=%s\\n' "$(printf '%s\\n' "$saved" | sed -n 's/.*[^-]autohide = "\\{0,1\\}\\([01]\\)"\\{0,1\\};.*/\\1/p')"
            printf 'bounce=%s\\n' "$(printf '%s\\n' "$saved" | sed -n 's/.*"no-bouncing" = "\\{0,1\\}\\([01]\\)"\\{0,1\\};.*/\\1/p')"
            """
            let p = Process(), out = Pipe()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-c", sh, "bash", plist.path]
            p.standardOutput = out
            try p.run(); p.waitUntilExit()
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return Dictionary(uniqueKeysWithValues: text.split(separator: "\n").compactMap { line -> (String, String)? in
                let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                return parts.count == 2 ? (String(parts[0]), String(parts[1])) : nil
            })
        }
        let ours: [String: Any] = ["autohide": true, "autohide-delay": 1000, "no-bouncing": true]
        // Nothing was set before: every key reads as absent, whatever `_ours` holds.
        XCTAssertEqual(try values(["_keys": SystemDockSettings.keys, "_ours": ours]), ["delay": "", "hide": "", "bounce": ""])
        // Values were set before: each reads once, as saved.
        XCTAssertEqual(try values(["autohide": false, "autohide-delay": 0.5, "no-bouncing": false, "_keys": SystemDockSettings.keys, "_ours": ours]),
                       ["delay": "0.5", "hide": "0", "bounce": "0"])
        // The uninstaller's own reads are the ones tested here.
        for pattern in [#"s/.*"autohide-delay" = "\{0,1\}\([0-9.]*\)"\{0,1\};.*/\1/p"#, #"s/.*[^-]autohide = "\{0,1\}\([01]\)"\{0,1\};.*/\1/p"#, #"s/.*"no-bouncing" = "\{0,1\}\([01]\)"\{0,1\};.*/\1/p"#] {
            XCTAssertTrue(script.contains(pattern), pattern)
        }
    }
}

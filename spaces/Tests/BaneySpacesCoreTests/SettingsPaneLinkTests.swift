import XCTest
@testable import BaneySpacesCore

/// Under Full Access an agent opens the System Settings pane it needs in one `open` instead of a sidebar walk (#350, item 3).
/// On main every pane link failed as "isn't a file or folder on this Mac".
final class SettingsPaneLinkTests: XCTestCase {
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("pane-link-\(UUID().uuidString)")
    private let settings = PermissionHelper.settingsBundleID
    private let panes = ["x-apple.systempreferences:com.apple.Displays-Settings.extension",
                         "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
                         "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                         "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension"]

    func testFullAccessOpensPaneLinksInSystemSettings() {
        for p in panes {
            switch AgentOpenGate.check(app: "System Settings", bundle: settings, targets: [p], handoff: root, mode: .full) {
            case .success(let f): XCTAssertEqual(f, [p], "the link is passed through unchanged")
            case .failure(let e): XCTFail("\(p): \(e.message)")
            }
        }
    }

    func testPaneLinksStayNarrow() {
        let p = panes[0]
        // Another app may not take one, and standard mode still refuses System Settings.
        if case .success = AgentOpenGate.check(app: "TextEdit", bundle: "com.apple.TextEdit", targets: [p], handoff: root, mode: .full) { XCTFail("TextEdit") }
        if case .success = AgentOpenGate.check(app: "System Settings", bundle: settings, targets: [p], handoff: root, mode: .standard) { XCTFail("standard") }
        // Only a plain pane id and one query: no paths, spaces, fragments or second scheme.
        for bad in ["x-apple.systempreferences:", "x-apple.systempreferences:/etc/hosts", "x-apple.systempreferences:com.apple.x?a?b",
                    "x-apple.systempreferences:com apple", "x-apple.systempreferences:com.apple.x#y", "x-apple.systempreferences://evil"] {
            XCTAssertFalse(SettingsPaneLink.isLink(bad), bad)
            if case .success = AgentOpenGate.check(app: "System Settings", bundle: settings, targets: [bad], handoff: root, mode: .full) { XCTFail(bad) }
        }
        XCTAssertTrue(panes.allSatisfy(SettingsPaneLink.isLink))
    }
}

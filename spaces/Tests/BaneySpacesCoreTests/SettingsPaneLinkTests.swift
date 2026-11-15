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

    /// System Settings has one window: a link sent to a running copy would move it, and it may be Donovan's.
    func testAPaneLinkNeverGoesToARunningCopy() throws {
        XCTAssertEqual(SettingsPaneLink.runningRefusal(targets: [panes[0]], alreadyRunning: true)?.code, .inUse)
        XCTAssertNil(SettingsPaneLink.runningRefusal(targets: [panes[0]], alreadyRunning: false))
        XCTAssertNil(SettingsPaneLink.runningRefusal(targets: ["/tmp/a.txt"], alreadyRunning: true), "files to a running app are unchanged")
        // Checked in the running-app branch, before anything is claimed or opened.
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let branch = try XCTUnwrap(src.range(of: "if !separate, let running = NSWorkspace.shared.runningApplications.first"))
        let tail = String(src[branch.upperBound...])
        let refusal = try XCTUnwrap(tail.range(of: "SettingsPaneLink.runningRefusal(targets: Array(args.dropFirst()), alreadyRunning: true)"))
        let grant = try XCTUnwrap(tail.range(of: "AgentAccess.shared.grant(pid)"))
        XCTAssertLessThan(refusal.lowerBound, grant.lowerBound)
    }
}

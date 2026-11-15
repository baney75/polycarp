import AppKit
import XCTest
@testable import BaneySpacesCore

/// The not-running launch of `agent open` (#361 review, first-F1): under Full Access a System Settings pane link reaches
/// the launch as the URL itself, started without activation, as a new copy, with nothing restored.
final class AgentLaunchTests: XCTestCase {
    private final class FakeLauncher: AgentAppLauncher {
        var launched: [AgentLaunchRequest] = []
        func launch(_ request: AgentLaunchRequest, done: @escaping (NSRunningApplication?) -> Void) {
            launched.append(request)
            done(nil)
        }
    }

    private let settings = URL(fileURLWithPath: "/System/Applications/System Settings.app")
    private let pane = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension"

    func testANotRunningSystemSettingsGetsThePaneLinkAsItsTarget() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("launch-\(UUID().uuidString)")
        guard case .success(let paths) = AgentOpenGate.check(app: "System Settings", bundle: PermissionHelper.settingsBundleID,
                                                             targets: [pane], handoff: root, mode: .full) else { return XCTFail("gate") }
        let fake = FakeLauncher()
        var answered = false
        fake.launch(AgentLaunchRequest(app: settings, paths: paths)) { _ in answered = true }
        let r = try XCTUnwrap(fake.launched.first)
        XCTAssertTrue(answered)
        XCTAssertEqual(r.targets, [URL(string: pane)!], "the link itself, not a file named after it")
        XCTAssertFalse(r.targets[0].isFileURL)
        XCTAssertEqual(r.app, settings)
        XCTAssertFalse(r.activates, "never brought forward over Donovan's work")
        XCTAssertTrue(r.newInstance)
        XCTAssertEqual(r.arguments, ["-ApplePersistenceIgnoreState", "YES"])
        let cfg = r.configuration
        XCTAssertFalse(cfg.activates)
        XCTAssertTrue(cfg.createsNewApplicationInstance)
        XCTAssertFalse(cfg.addsToRecentItems)
        XCTAssertEqual(cfg.arguments, ["-ApplePersistenceIgnoreState", "YES"])
        // Files stay files.
        XCTAssertEqual(AgentLaunch.targets(["/tmp/a.txt"]), [URL(fileURLWithPath: "/tmp/a.txt")])
    }

    /// The session's not-running branch launches only through the seam, with the request built from the gate's paths.
    func testTheSessionLaunchesThroughTheSeam() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(src.contains("case .success(let paths): files = AgentLaunch.targets(paths); launch = AgentLaunchRequest(app: url, paths: paths)"))
        XCTAssertTrue(src.contains("launcher.launch(launch) { app in started(app); finished(app) }"))
        XCTAssertFalse(src.contains("NSWorkspace.shared.openApplication(at: url"), "no second launch path around the seam")
        XCTAssertEqual(src.components(separatedBy: "withApplicationAt:").count - 1, 1, "only the running-app branch opens directly")
    }
}

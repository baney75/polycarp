@testable import BaneySpacesCore
import XCTest

/// Polycarp has no parts to choose. Workspaces always run: no chooser in Settings or the welcome window, and an old
/// `features.toml` (from when the browser and dictation were parts) is never read, so `workspaces = false` in it can't
/// leave the app doing nothing. The installer writes no such file and ignores one that's there.
final class FeaturesTests: XCTestCase {
    func testWorkspacesIsTheOnlyPartAndItIsAlwaysOn() {
        XCTAssertEqual(Feature.allCases, [.workspaces])
        XCTAssertTrue(FeatureSet.all.contains(.workspaces))
    }

    func testTheWelcomeWalkIsThePermissionsWithNoChooserFirst() throws {
        XCTAssertFalse(Welcome.canStart(granted: []))
        XCTAssertEqual(Welcome.next(granted: [], skipped: []), .accessibility)
        let window = try Repo.code("Sources/BaneySpaces/WelcomeWindow.swift")
        XCTAssertFalse(window.contains("WelcomePartsChooser"))
        XCTAssertFalse(window.contains("Both come with the app"))
        XCTAssertFalse(window.contains("Pick what you want"))
        XCTAssertTrue(window.contains("            walk\n"), "the window opens on the permission walk")
    }

    func testSettingsHasNoPartsGroup() throws {
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertFalse(setup.contains("PartsSection"))
        XCTAssertFalse(setup.contains("Parts of Polycarp"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: Repo.root.appendingPathComponent("Sources/BaneySpaces/Parts.swift").path))
    }

    /// The app starts the workspaces at launch whatever an old file says: nothing in it reads the file or gates on a part.
    func testTheAppNeverReadsTheOldFile() throws {
        let sources = Repo.root.appendingPathComponent("Sources")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        for case let url as URL in files where url.pathExtension == "swift" {
            let code = try Repo.code(String(url.path.dropFirst(Repo.root.path.count + 1)))
            for gone in ["PartsModel", "FeatureFile", "features.toml", "hasChosen"] {
                XCTAssertFalse(code.contains(gone), "\(url.lastPathComponent) still has \(gone)")
            }
        }
        let app = try Repo.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("        legacyWatcher.start()\n        startWorkspaces()\n"), "the workspaces start at launch, unconditionally")
    }

    // MARK: The installer

    private func installerText() throws -> String {
        try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh"), encoding: .utf8)
    }

    func testTheInstallerWritesNoPartsFile() throws {
        let t = try installerText()
        for gone in ["write_parts", "PARTS_FILE", "choose_parts"] { XCTAssertFalse(t.contains(gone), gone) }
    }

    /// The old app and Polycarp can't run together, and Polycarp always runs workspaces now, so an old
    /// `workspaces = false` no longer keeps BaneySpaces.
    func testAnOldFileNoLongerKeepsTheOldApp() throws {
        XCTAssertFalse(try installerText().contains("workspaces = false"))
    }

    /// Runs install.sh's functions in bash, the way the installer does. Nothing is installed.
    private func installer(_ script: String) throws -> (Int32, String) {
        let root = Repo.root.deletingLastPathComponent()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "POLYCARP_INSTALL_FUNCTIONS_ONLY=1 source \"\(root.path)/install.sh\"; \(script)"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.standardInput = FileHandle.nullDevice
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    /// An older scripted install that still sets POLYCARP_FEATURES carries on: workspaces, a typo or nothing say nothing.
    func testAnOldFeaturesListIsHarmless() throws {
        for list in ["workspaces", " workspaces , ", "workspaces,typo", ""] {
            let (code, output) = try installer("moved_notes '\(list)'")
            XCTAssertEqual(code, 0, list)
            XCTAssertEqual(output, "", list)
        }
    }
}

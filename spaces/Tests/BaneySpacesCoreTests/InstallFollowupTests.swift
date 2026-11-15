import BaneySpacesCore
import Foundation
import XCTest

/// Issue 30, PR 27's leftovers: BaneySpaces never goes once the welcome window is finished, the welcome line says the
/// settings came along only when they did, and what this Mac has in /Applications never changes a test's answer.
final class InstallFollowupTests: XCTestCase {
    private func temp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("if-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }

    /// A click on Start before a later try (5 s, then every 10 s for two minutes) used to leave the launch-time answer in
    /// place, so BaneySpaces went to the Trash after the window that tells about it had closed.
    func testAStartClickBeforeALaterTryKeepsBaneySpaces() throws {
        XCTAssertTrue(LegacyRetirement.welcomeFinished(atLaunch: false, now: true))
        XCTAssertTrue(LegacyRetirement.welcomeFinished(atLaunch: true, now: false))
        XCTAssertFalse(LegacyRetirement.welcomeFinished(atLaunch: false, now: false))
        let delegate = try Repo.text("Sources/BaneySpaces/AppDelegate.swift")
        let call = try XCTUnwrap(delegate.components(separatedBy: "\n").first { $0.contains("LegacyRetirementRunner.runIfDue(") })
        XCTAssertFalse(call.contains("welcomeFinished: welcomeFinishedAtLaunch"), "each try reads the window's state again: \(call)")
        XCTAssertTrue(delegate.contains("LegacyRetirement.welcomeFinished(atLaunch: welcomeFinishedAtLaunch, now: UserDefaults.standard.bool(forKey: Welcome.finishedKey))"))
    }

    func testTheWelcomeLineClaimsSettingsOnlyWhenTheyCame() throws {
        let support = temp()
        XCTAssertEqual(LegacyRetirement.welcomeNote(supportDir: support), "BaneySpaces moved to the Trash.")
        try Data().write(to: support.appendingPathComponent(Product.importedMarker))
        XCTAssertEqual(LegacyRetirement.welcomeNote(supportDir: support), "BaneySpaces moved to the Trash. Your settings came with you.")
    }

    func testTheSystemApplicationsFolderIsTheOneGiven() throws {
        let home = temp(), system = temp()
        let app = system.appendingPathComponent("BaneySpaces.app/Contents")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": Product.Legacy.bundleID], format: .xml, options: 0)
            .write(to: app.appendingPathComponent("Info.plist"))
        XCTAssertEqual(LegacyRetirement.copies(home: home, system: system).map(\.lastPathComponent), ["BaneySpaces.app"])
        XCTAssertEqual(LegacyApp.searchFolders(home: home).last?.path, "/Applications", "the app itself still looks in /Applications")
    }
}

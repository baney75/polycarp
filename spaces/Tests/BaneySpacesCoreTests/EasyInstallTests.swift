import XCTest
@testable import BaneySpacesCore

final class MoveToApplicationsTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/pat", isDirectory: true)
    private func app(_ p: String) -> URL { URL(fileURLWithPath: p, isDirectory: true) }
    private func loc(_ p: String) -> MoveToApplications.Location { MoveToApplications.classify(bundle: app(p), home: home) }

    func testEachPlaceIsToldApart() {
        XCTAssertEqual(loc("/Applications/Polycarp.app"), .installed)
        XCTAssertEqual(loc("/Users/pat/Applications/Polycarp.app"), .installed)
        XCTAssertEqual(loc("/Volumes/Polycarp/Polycarp.app"), .disk(volume: app("/Volumes/Polycarp")))
        XCTAssertEqual(loc("/Volumes/Polycarp 1/Polycarp.app"), .disk(volume: app("/Volumes/Polycarp 1")))
        XCTAssertEqual(loc("/Users/pat/Downloads/Polycarp.app"), .downloads)
        XCTAssertEqual(loc("/Users/pat/Downloads/Polycarp 2/Polycarp.app"), .downloads)
        XCTAssertEqual(loc("/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Polycarp.app"), .translocated)
        XCTAssertEqual(loc("/Users/pat/Projects/polycarp/spaces/build/Polycarp.app"), .elsewhere)
        XCTAssertEqual(loc("/Applications/Utilities/Polycarp.app"), .elsewhere, "only directly in Applications counts as installed")
    }

    func testAskOnlyFromTheDiskImageDownloadsOrATranslocatedPath() {
        let go = ["Polycarp"]
        func ask(_ p: String, _ args: [String] = go) -> Bool { MoveToApplications.shouldAsk(arguments: args, bundle: app(p), home: home) }
        XCTAssertTrue(ask("/Volumes/Polycarp/Polycarp.app"))
        XCTAssertTrue(ask("/Users/pat/Downloads/Polycarp.app"))
        XCTAssertTrue(ask("/private/var/folders/ab/T/AppTranslocation/X/d/Polycarp.app"))
        XCTAssertFalse(ask("/Applications/Polycarp.app"), "never when already installed")
        XCTAssertFalse(ask("/Users/pat/Applications/Polycarp.app"))
        XCTAssertFalse(ask("/Users/pat/Projects/x/build/Polycarp.app"), "a build folder isn't ours to move")
    }

    func testVersionOneShotsAndTheMovedCopyNeverAsk() {
        let dmg = app("/Volumes/Polycarp/Polycarp.app")
        func ask(_ args: [String]) -> Bool { MoveToApplications.shouldAsk(arguments: ["Polycarp"] + args, bundle: dmg, home: home) }
        XCTAssertTrue(ask([]))
        for flag in ["--version", "--help", "--restore-shortcuts", "--restore-dock", "--check-settings", "--unregister-login", "--render", "--bangs"] {
            XCTAssertFalse(ask([flag]), flag)
        }
        XCTAssertFalse(ask([MoveToApplications.movedFlag]), "the relaunched copy can't ask again, even if its path still looks odd")
    }

    func testTheDestinationIsApplicationsOrTheHomeOneWhenThatIsNotWritable() {
        XCTAssertEqual(MoveToApplications.destination(home: home, canWrite: { _ in true }).path, "/Applications/Polycarp.app")
        XCTAssertEqual(MoveToApplications.destination(home: home, canWrite: { $0.path != "/Applications" }).path, "/Users/pat/Applications/Polycarp.app")
    }

    func testThePlanReplacesAnExistingCopyAndEjectsOnlyTheDiskImage() {
        let fromDisk = MoveToApplications.plan(bundle: app("/Volumes/Polycarp/Polycarp.app"), home: home, canWrite: { _ in true }, exists: { _ in true })
        XCTAssertEqual(fromDisk.destination.path, "/Applications/Polycarp.app")
        XCTAssertTrue(fromDisk.replacesExisting)
        XCTAssertEqual(fromDisk.eject?.path, "/Volumes/Polycarp")
        let fromDownloads = MoveToApplications.plan(bundle: app("/Users/pat/Downloads/Polycarp.app"), home: home, canWrite: { _ in true }, exists: { _ in false })
        XCTAssertFalse(fromDownloads.replacesExisting)
        XCTAssertNil(fromDownloads.eject, "nothing to eject from Downloads")
        let moved = MoveToApplications.plan(bundle: app("/private/var/folders/a/AppTranslocation/X/d/Polycarp.app"), home: home, canWrite: { _ in true }, exists: { _ in false })
        XCTAssertNil(moved.eject)
    }

    func testTheEjectIsAShortSystemCommandWithTheVolumeAsAnArgument() {
        let c = MoveToApplications.ejectCommand(volume: app("/Volumes/Polycarp"))
        XCTAssertEqual(c.first, "/bin/sh")
        XCTAssertEqual(c.last, "/Volumes/Polycarp", "passed as an argument, never spliced into the script")
        XCTAssertTrue(c[2].contains("/usr/bin/hdiutil detach"))
    }

    func testTheDownloadMarkComesOffTheCopyAndEverythingInIt() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("q-\(UUID().uuidString)")
        let inner = dir.appendingPathComponent("Polycarp.app/Contents/MacOS")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let file = inner.appendingPathComponent("Polycarp")
        try Data("x".utf8).write(to: file)
        let top = dir.appendingPathComponent("Polycarp.app")
        for u in [top, file] { XCTAssertEqual(setxattr(u.path, "com.apple.quarantine", "0081;00000000;Safari;", 21, 0, 0), 0) }
        XCTAssertEqual(MoveToApplications.clearDownloadMark(at: top), 2)
        XCTAssertEqual(getxattr(file.path, "com.apple.quarantine", nil, 0, 0, 0), -1)
        XCTAssertEqual(getxattr(top.path, "com.apple.quarantine", nil, 0, 0, 0), -1)
        XCTAssertEqual(MoveToApplications.clearDownloadMark(at: top), 0, "nothing left to clear")
    }

    func testTheWordsForThisPathAreForPeople() {
        let strings = MoveToApplications.strings + [LegacyRetirement.welcomeNote, LegacyHandover.alertTitle, LegacyHandover.alertDetail,
                                                    LegacyHandover.continueButton, LegacyHandover.notNowButton, LegacyHandover.didNotQuit]
            + [LegacyHandover.alertDetail(running: ["BaneySpaces"]), LegacyHandover.alertTitle(running: ["BaneySpaces"])]
        for s in strings {
            for banned in ["terminal", "codesign", "quarantine", "bundle", "signature", "gatekeeper", "xattr", "sudo"] {
                XCTAssertFalse(s.lowercased().contains(banned), "\"\(s)\" says \(banned)")
            }
        }
        XCTAssertEqual(MoveToApplications.askTitle, "Move Polycarp to Applications?")
        XCTAssertEqual(MoveToApplications.moveButton, "Move and Open")
        XCTAssertEqual(MoveToApplications.quitButton, "Quit")
    }

    func testTheMoveRunsFirstAndEndsTheProcess() throws {
        let main = try Repo.text("Sources/BaneySpaces/main.swift")
        let move = try XCTUnwrap(main.range(of: "MoveToApplicationsRunner.runIfNeeded"))
        XCTAssertLessThan(move.lowerBound, try XCTUnwrap(main.range(of: "LegacyHandover.run")).lowerBound, "before the other alert")
        XCTAssertLessThan(move.lowerBound, try XCTUnwrap(main.range(of: "SingleInstance.claim")).lowerBound, "before any lock or file")
        let runner = try Repo.text("Sources/BaneySpaces/MoveToApplicationsRunner.swift")
        XCTAssertTrue(runner.contains("trashItem"), "an old copy goes to the Trash, not away")
        XCTAssertLessThan(try XCTUnwrap(runner.range(of: "terminate()")).lowerBound, try XCTUnwrap(runner.range(of: "copyItem")).lowerBound, "the old copy quits before it is replaced")
        XCTAssertTrue(runner.contains("--args\", MoveToApplications.movedFlag"))
    }
}

final class LegacyRetirementTests: XCTestCase {
    private func temp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("lr-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    private let old = URL(fileURLWithPath: "/Applications/BaneySpaces.app")

    func testBaneySpacesGoesOnlyWhenPolycarpHasItsSettingsAndItIsNotRunning() {
        XCTAssertTrue(LegacyRetirement.shouldRetire(legacyApp: old, running: false, settingsCopied: true, alreadyDone: false))
        XCTAssertFalse(LegacyRetirement.shouldRetire(legacyApp: nil, running: false, settingsCopied: true, alreadyDone: false), "not installed")
        XCTAssertFalse(LegacyRetirement.shouldRetire(legacyApp: old, running: true, settingsCopied: true, alreadyDone: false), "never while it runs")
        XCTAssertFalse(LegacyRetirement.shouldRetire(legacyApp: old, running: false, settingsCopied: false, alreadyDone: false), "settings are copied first")
        XCTAssertFalse(LegacyRetirement.shouldRetire(legacyApp: old, running: false, settingsCopied: true, alreadyDone: true), "once")
    }

    func testSettingsCountAsCopiedWhenTheImportFinishedOrThereWasNothing() throws {
        let support = temp(), legacy = temp()
        XCTAssertFalse(LegacyRetirement.settingsCopied(supportDir: support, legacySupportDir: legacy), "BaneySpaces has data and none came across yet")
        try Data("x".utf8).write(to: support.appendingPathComponent(Product.importedMarker))
        XCTAssertTrue(LegacyRetirement.settingsCopied(supportDir: support, legacySupportDir: legacy))
        XCTAssertTrue(LegacyRetirement.settingsCopied(supportDir: temp(), legacySupportDir: temp().appendingPathComponent("none")), "no data to copy")
        let pending = temp()
        try Data("layout.json\n".utf8).write(to: pending.appendingPathComponent(SettingsImport.pendingName))
        XCTAssertFalse(LegacyRetirement.settingsCopied(supportDir: pending, legacySupportDir: temp().appendingPathComponent("none")), "a half import isn't done")
    }

    func testRetiringStopsTheWatchdogMovesTheAppAndLeavesItsDataAlone() throws {
        let home = temp(), support = temp(), trash = temp()
        let app = home.appendingPathComponent("Applications/BaneySpaces.app")
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        let data = home.appendingPathComponent("Library/Application Support/BaneySpaces/layout.json")
        try FileManager.default.createDirectory(at: data.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: data)
        let plist = LegacyRetirement.watchdogPlist(home: home)
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("<plist/>".utf8).write(to: plist)
        var order: [String] = []
        let r = LegacyRetirement.retire(app: app, home: home, supportDir: support, unload: { order.append("unload") }, trash: { url in
            order.append("trash")
            let to = trash.appendingPathComponent(url.lastPathComponent)
            try FileManager.default.moveItem(at: url, to: to)
            return to
        })
        XCTAssertEqual(order, ["unload", "trash"], "the watchdog first, then the app")
        XCTAssertNil(r.failure)
        XCTAssertTrue(r.watchdogRemoved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: app.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: trash.appendingPathComponent("BaneySpaces.app").path), "recoverable")
        XCTAssertTrue(FileManager.default.fileExists(atPath: data.path), "its settings stay")
        XCTAssertTrue(LegacyRetirement.alreadyDone(supportDir: support))
    }

    func testAFailedMoveIsReportedAndTriedAgainNextLaunch() {
        let home = temp(), support = temp()
        struct Boom: Error, LocalizedError { var errorDescription: String? { "no permission" } }
        let r = LegacyRetirement.retire(app: old, home: home, supportDir: support, unload: {}, trash: { _ in throw Boom() })
        XCTAssertNil(r.trashed)
        XCTAssertTrue(r.failure?.contains("no permission") == true)
        XCTAssertFalse(LegacyRetirement.alreadyDone(supportDir: support), "no marker, so it is tried again")
    }

    func testTheRunnerNeverStartsTheOldAppAndTheWelcomeSaysOneLine() throws {
        let runner = try Repo.text("Sources/BaneySpaces/LegacyRetirementRunner.swift")
        XCTAssertFalse(runner.contains("openApplication"), "the old app is moved, never launched")
        XCTAssertTrue(runner.contains("trashItem"))
        XCTAssertEqual(LegacyRetirement.welcomeNote, "BaneySpaces moved to the Trash. Your settings came with you.")
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/WelcomeWindow.swift").contains("LegacyRetirement.welcomeNote"))
    }

    func testTheFirstLaunchSetsTheThemeLikeTheInstallerDid() throws {
        let sh = try Repo.text("scripts/install-app.sh")
        XCTAssertTrue(sh.contains("theme set polycarp"))
        XCTAssertTrue(sh.contains("config.toml"), "only when no look was chosen")
    }
}

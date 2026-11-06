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

    func testTheDestinationIsTheFolderThatHasACopyElseApplicationsElseTheHomeOne() {
        XCTAssertEqual(MoveToApplications.destination(home: home, canWrite: { _ in true }).path, "/Applications/Polycarp.app")
        XCTAssertEqual(MoveToApplications.destination(home: home, canWrite: { $0.path != "/Applications" }).path, "/Users/pat/Applications/Polycarp.app")
        let mine = [app("/Users/pat/Applications/Polycarp.app")]
        XCTAssertEqual(MoveToApplications.destination(home: home, canWrite: { _ in true }, installed: mine).path, "/Users/pat/Applications/Polycarp.app", "never one in each folder")
        XCTAssertEqual(MoveToApplications.installedCopies(home: home, exists: { $0.path.hasPrefix("/Users/pat") }).map(\.path), ["/Users/pat/Applications/Polycarp.app"], "both folders are looked at")
    }

    private func plan(_ path: String, original: String? = nil, installed: [String] = [], version: String? = nil, this: String = "0.3.0",
                      mounted: Set<String> = []) -> MoveToApplications.Plan {
        MoveToApplications.plan(bundle: app(path), original: original.map(app), home: home, canWrite: { _ in true },
                                installed: installed.map(app), installedVersion: { _ in version }, thisVersion: this, mountedImages: mounted)
    }

    func testOnlyAMountedDiskImageIsEjected_notADriveWithAFolderOnIt() {
        let image = plan("/Volumes/Polycarp/Polycarp.app", mounted: ["/Volumes/Polycarp"])
        XCTAssertEqual(image.eject?.path, "/Volumes/Polycarp")
        XCTAssertNil(plan("/Volumes/Backup/Apps/Polycarp.app", mounted: ["/Volumes/Polycarp"]).eject, "an external or network drive isn't an image hdiutil lists")
        XCTAssertNil(plan("/Volumes/Polycarp/Polycarp.app", mounted: []).eject)
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>images</key><array>
        <dict><key>system-entities</key><array><dict><key>dev-entry</key><string>/dev/disk4s1</string><key>mount-point</key><string>/Volumes/Polycarp</string></dict><dict><key>dev-entry</key><string>/dev/disk4</string></dict></array></dict>
        </array></dict></plist>
        """
        XCTAssertEqual(MoveToApplications.mountedImages(infoPlist: Data(xml.utf8)), ["/Volumes/Polycarp"])
        XCTAssertEqual(MoveToApplications.mountedImages(infoPlist: Data("nonsense".utf8)), [])
    }

    func testATranslocatedRunIsTracedBackToItsOriginal() {
        let t = app("/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Polycarp.app")
        // From the disk image: the original is on a mounted image, which is ejected.
        let fromImage = MoveToApplications.original(of: t, resolve: { _ in self.app("/Volumes/Polycarp/Polycarp.app") })
        XCTAssertEqual(fromImage.path, "/Volumes/Polycarp/Polycarp.app")
        let p1 = plan(t.path, original: fromImage.path, mounted: ["/Volumes/Polycarp"])
        XCTAssertEqual(p1.source.path, t.path, "what runs is what is copied")
        XCTAssertEqual(p1.eject?.path, "/Volumes/Polycarp")
        XCTAssertNil(p1.trashOriginal)
        // From Downloads: the original there goes to the Trash after the copy opens.
        let fromDownloads = MoveToApplications.original(of: t, resolve: { _ in self.app("/Users/pat/Downloads/Polycarp.app") })
        let p2 = plan(t.path, original: fromDownloads.path)
        XCTAssertEqual(p2.trashOriginal?.path, "/Users/pat/Downloads/Polycarp.app")
        XCTAssertNil(p2.eject)
        // The system can't say: nothing is ejected or trashed.
        let unknown = MoveToApplications.original(of: t, resolve: { _ in nil })
        XCTAssertEqual(unknown, t)
        let p3 = plan(t.path, original: unknown.path)
        XCTAssertNil(p3.eject); XCTAssertNil(p3.trashOriginal)
        // A plain path never asks the system.
        XCTAssertEqual(MoveToApplications.original(of: app("/Users/pat/Downloads/Polycarp.app"), resolve: { _ in XCTFail("asked"); return nil }).path, "/Users/pat/Downloads/Polycarp.app")
    }

    func testOnlyDownloadsOriginalsAreTidied() {
        XCTAssertEqual(plan("/Users/pat/Downloads/Polycarp.app").trashOriginal?.path, "/Users/pat/Downloads/Polycarp.app")
        XCTAssertNil(plan("/Users/pat/Desktop/Polycarp.app").trashOriginal)
        XCTAssertNil(plan("/Volumes/Polycarp/Polycarp.app", mounted: ["/Volumes/Polycarp"]).trashOriginal)
    }

    func testAnInstalledCopyThatIsTheSameOrNewerIsOnlyOpened_neverDowngraded() {
        let installed = ["/Applications/Polycarp.app"]
        XCTAssertTrue(plan("/Volumes/P/Polycarp.app", installed: installed, version: "0.4.0", this: "0.3.0").openInstalledOnly, "newer installed")
        XCTAssertTrue(plan("/Volumes/P/Polycarp.app", installed: installed, version: "0.3.0", this: "0.3.0").openInstalledOnly, "same")
        XCTAssertFalse(plan("/Volumes/P/Polycarp.app", installed: installed, version: "0.2.9", this: "0.3.0").openInstalledOnly, "older installed is replaced")
        XCTAssertFalse(plan("/Volumes/P/Polycarp.app", installed: [], version: nil).openInstalledOnly)
        XCTAssertTrue(MoveToApplications.isNewer("0.10.0", than: "0.9.0"), "by number, not by letters")
        XCTAssertFalse(MoveToApplications.isNewer("0.3", than: "0.3.0"))
        XCTAssertTrue(MoveToApplications.isNewer("1.0", than: "0.9.9"))
        XCTAssertTrue(plan("/Volumes/P/Polycarp.app", installed: installed, version: "0.4.0").existing.count == 1)
    }

    func testTheWaitGivesUpAtTheDeadlineAndChangesNothingItself() {
        var t = Date(timeIntervalSince1970: 0)
        var polls = 0
        XCTAssertFalse(MoveToApplications.wait(until: { false }, limit: 15, now: { t }, pause: { t = t.addingTimeInterval(1); polls += 1 }))
        XCTAssertEqual(polls, 15, "15 seconds, no longer")
        var n = 0
        XCTAssertTrue(MoveToApplications.wait(until: { n += 1; return n > 3 }, limit: 15, now: { t }, pause: {}))
        XCTAssertEqual(MoveToApplications.waitForQuit, 15)
    }

    func testTheEjectIsAShortSystemCommandWithTheVolumeAsAnArgumentAndNoForce() {
        let c = MoveToApplications.ejectCommand(volume: app("/Volumes/Polycarp"))
        XCTAssertEqual(c.first, "/bin/sh")
        XCTAssertEqual(c.last, "/Volumes/Polycarp", "passed as an argument, never spliced into the script")
        XCTAssertTrue(c[2].contains("/usr/bin/hdiutil detach"))
        XCTAssertFalse(c[2].contains("-force"), "a busy image stays mounted rather than being pulled")
    }

    func testTheMovedFlagIsAcceptedAsANormalStart() {
        let args = ["Polycarp", MoveToApplications.movedFlag]
        XCTAssertNil(EntryPoint.usageError(arguments: args), "the moved copy must not be refused")
        XCTAssertNil(EntryPoint.immediate(arguments: args, info: nil), "it isn't a print-and-exit flag")
        XCTAssertTrue(EntryPoint.needsExclusiveCopy(arguments: args), "it takes the lock like any start")
        XCTAssertTrue(EntryPoint.startFlags.contains("--after-move"))
        XCTAssertFalse(MoveToApplications.shouldAsk(arguments: args, bundle: app("/Volumes/P/Polycarp.app"), home: home))
    }

    func testFirstLaunchFromApplicationsRunsTheInstallStep() {
        let inApps = app("/Applications/Polycarp.app")
        XCTAssertTrue(FirstLaunch.shouldRunInstallStep(bundle: inApps, home: home, commandLinkTarget: nil), "no link yet: command links, theme")
        XCTAssertTrue(FirstLaunch.shouldRunInstallStep(bundle: inApps, home: home, commandLinkTarget: "/Old/Polycarp.app/Contents/Resources/bin/polycarp-spaces"))
        XCTAssertFalse(FirstLaunch.shouldRunInstallStep(bundle: inApps, home: home, commandLinkTarget: "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"), "already linked here")
        XCTAssertFalse(FirstLaunch.shouldRunInstallStep(bundle: app("/Volumes/P/Polycarp.app"), home: home, commandLinkTarget: nil))
        XCTAssertFalse(FirstLaunch.shouldRunInstallStep(bundle: app("/Users/pat/Downloads/Polycarp.app"), home: home, commandLinkTarget: nil))
        XCTAssertTrue(FirstLaunch.shouldRunInstallStep(bundle: app("/Users/pat/Applications/Polycarp.app"), home: home, commandLinkTarget: nil))
    }

    func testAnInstalledCopyThatIsAsNewIsTheOneOpened_theNewestOfThem() {
        func versionOf(_ u: URL) -> String? { ["/Applications/Polycarp.app": "0.2.0", "/Users/pat/Applications/Polycarp.app": "0.4.0"][u.path] }
        let p = MoveToApplications.plan(bundle: app("/Volumes/P/Polycarp.app"), home: home, canWrite: { _ in true },
                                        installed: [app("/Applications/Polycarp.app"), app("/Users/pat/Applications/Polycarp.app")],
                                        installedVersion: versionOf, thisVersion: "0.3.0", mountedImages: ["/Volumes/P"])
        XCTAssertTrue(p.openInstalledOnly)
        XCTAssertEqual(p.destination.path, "/Users/pat/Applications/Polycarp.app", "the 0.4.0 copy opens, not the 0.2.0 one beside it")
        XCTAssertEqual(p.eject?.path, "/Volumes/P", "and the image is let go")
        // Dragged to Applications already: it is installed, so it is never asked again.
        XCTAssertFalse(MoveToApplications.shouldAsk(arguments: ["Polycarp"], bundle: app("/Applications/Polycarp.app"), home: home))
    }

    func testTheDownloadMarkIsClearedOnTheInstalledCopyToo() throws {
        let runner = try Repo.text("Sources/BaneySpaces/MoveToApplicationsRunner.swift")
        let clear = try XCTUnwrap(runner.range(of: "if plan.openInstalledOnly { MoveToApplications.clearDownloadMark(at: plan.destination) }"))
        XCTAssertLessThan(clear.lowerBound, try XCTUnwrap(runner.range(of: "guard openAndWait(plan.destination)")).lowerBound, "before it is opened")
        let delegate = try Repo.text("Sources/BaneySpaces/AppDelegate.swift")
        let mark = try XCTUnwrap(delegate.range(of: "MoveToApplications.clearDownloadMark(at: Bundle.main.bundleURL)"))
        XCTAssertLessThan(mark.lowerBound, try XCTUnwrap(delegate.range(of: "\"--in-place\", bundle")).lowerBound, "a dragged copy is cleared before the install step runs its tools")
    }

    func testAnInterruptedInstallGetsItsOldCopyBack() throws {
        let fm = FileManager.default
        let folder = fm.temporaryDirectory.appendingPathComponent("rec-\(UUID().uuidString)")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: folder) }
        let aside = folder.appendingPathComponent(".Polycarp-old.app"), installed = folder.appendingPathComponent("Polycarp.app")
        try fm.createDirectory(at: aside.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        // Interrupted after the old copy was set aside: nothing at the destination, so the old one comes back.
        XCTAssertTrue(MoveToApplications.recoverInterruptedInstall(in: folder, fileManager: fm))
        XCTAssertTrue(fm.fileExists(atPath: installed.appendingPathComponent("Contents").path))
        XCTAssertFalse(fm.fileExists(atPath: aside.path))
        // Nothing to recover now; and a set-aside copy beside a real install is never deleted.
        XCTAssertFalse(MoveToApplications.recoverInterruptedInstall(in: folder, fileManager: fm))
        try fm.createDirectory(at: aside.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        XCTAssertFalse(MoveToApplications.recoverInterruptedInstall(in: folder, fileManager: fm))
        XCTAssertTrue(fm.fileExists(atPath: aside.path), "kept")
        let runner = try Repo.text("Sources/BaneySpaces/MoveToApplicationsRunner.swift")
        XCTAssertFalse(runner.contains("removeItem(at: aside)"), "the old copy is never deleted before the new one is in")
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/main.swift").contains("recoverInterruptedInstall"), "every launch")
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

    func testTheDownloadGuideInTheReadmeIsForPeople() throws {
        let readme = try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("README.md"), encoding: .utf8)
        let from = try XCTUnwrap(readme.range(of: "### Download and open"))
        let rest = readme[from.upperBound...]
        let section = String(rest[..<(rest.range(of: "\n## ")?.lowerBound ?? rest.endIndex)])
        // Link addresses aren't read by a person; only the words are.
        let words = section.replacingOccurrences(of: "\\]\\([^)]*\\)", with: "]", options: .regularExpression)
        XCTAssertTrue(words.contains("[Download Polycarp]"), words)
        XCTAssertTrue(section.contains("(https://github.com/baney75/polycarp/releases/download/preview/Polycarp.dmg)"), "the link is the file itself, so nobody chooses one")
        XCTAssertTrue(words.contains("look for a chip whose name starts with Apple"), "a way to check, in plain words")
        XCTAssertTrue(words.contains("open the file, and drag"), words)
        XCTAssertTrue(words.contains("drag\nPolycarp onto Applications") || words.contains("drag Polycarp onto Applications"), words)
        XCTAssertTrue(words.contains("This download is for newer Macs with Apple silicon."), "an Intel owner is told")
        for banned in ["dmg", "disk image", "bundle", "terminal", "codesign", "quarantine", "release", "gatekeeper", "xattr", "sudo"] {
            XCTAssertFalse(words.lowercased().contains(banned), "the guide says \(banned)")
        }
    }

    func testTheMoveRunsFirstAndEndsTheProcess() throws {
        let main = try Repo.text("Sources/BaneySpaces/main.swift")
        let move = try XCTUnwrap(main.range(of: "MoveToApplicationsRunner.runIfNeeded"))
        XCTAssertLessThan(move.lowerBound, try XCTUnwrap(main.range(of: "LegacyHandover.run")).lowerBound, "before the other alert")
        XCTAssertLessThan(move.lowerBound, try XCTUnwrap(main.range(of: "SingleInstance.claim")).lowerBound, "before any lock or file")
        let runner = try Repo.text("Sources/BaneySpaces/MoveToApplicationsRunner.swift")
        XCTAssertTrue(runner.contains("trashItem"), "an old copy goes to the Trash, not away")
        XCTAssertLessThan(try XCTUnwrap(runner.range(of: "terminate()")).lowerBound, try XCTUnwrap(runner.range(of: "try replace(plan")).lowerBound, "the old copy quits before it is replaced")
        XCTAssertLessThan(try XCTUnwrap(runner.range(of: "openAndWait(plan.destination)")).lowerBound, try XCTUnwrap(runner.range(of: "plan.eject {")).lowerBound, "no eject until it opened")
        XCTAssertTrue(runner.contains("SecTranslocateCreateOriginalPathForURL"))
        XCTAssertFalse(runner.contains("-force"))
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
    private let old = [URL(fileURLWithPath: "/Applications/BaneySpaces.app")]
    private func plant(_ app: URL, id: String) throws {
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try Data("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>\(id)</string></dict></plist>".utf8)
            .write(to: app.appendingPathComponent("Contents/Info.plist"))
    }

    func testBaneySpacesGoesOnlyForANewArrivalWithItsSettingsCopiedAndNotRunning() {
        func go(_ apps: [URL]? = nil, running: Bool = false, copied: Bool = true, done: Bool = false, finished: Bool = false, installed: Bool = true) -> Bool {
            LegacyRetirement.shouldRetire(legacyApps: apps ?? old, running: running, settingsCopied: copied, alreadyDone: done, welcomeFinished: finished, polycarpInstalled: installed)
        }
        XCTAssertTrue(go())
        XCTAssertFalse(go([]), "not installed")
        XCTAssertFalse(go(running: true), "never while it runs")
        XCTAssertFalse(go(copied: false), "settings are copied first")
        XCTAssertFalse(go(done: true), "once")
        XCTAssertFalse(go(finished: true), "an existing user's BaneySpaces never disappears silently")
        XCTAssertFalse(go(installed: false), "a Polycarp run from the Desktop, a build folder or the disk image removes nothing")
        // Only the import unfinished: wait and try again, never retire.
        XCTAssertTrue(LegacyRetirement.shouldWaitForImport(legacyApps: old, running: false, settingsCopied: false, alreadyDone: false, welcomeFinished: false, polycarpInstalled: true))
        XCTAssertFalse(LegacyRetirement.shouldWaitForImport(legacyApps: old, running: false, settingsCopied: false, alreadyDone: false, welcomeFinished: false, polycarpInstalled: false), "not installed: nothing to wait for")
        XCTAssertFalse(LegacyRetirement.shouldWaitForImport(legacyApps: old, running: false, settingsCopied: false, alreadyDone: false, welcomeFinished: true, polycarpInstalled: true))
        XCTAssertFalse(LegacyRetirement.shouldWaitForImport(legacyApps: old, running: false, settingsCopied: true, alreadyDone: false, welcomeFinished: false, polycarpInstalled: true))
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

    func testEveryCopyInBothFoldersIsFoundAndSilasNever() throws {
        let home = temp()
        try plant(home.appendingPathComponent("Applications/BaneySpaces.app"), id: Product.Legacy.bundleID)
        try plant(home.appendingPathComponent("Applications/Silas.app"), id: Product.Silas.bundleID)
        XCTAssertEqual(LegacyRetirement.copies(home: home).map(\.lastPathComponent), ["BaneySpaces.app"], "Silas stays")
        XCTAssertNil(LegacyApp.installed(in: [home.appendingPathComponent("Applications")].filter { $0.lastPathComponent == "nope" }))
        // A folder that holds only Silas yields nothing.
        let only = temp()
        try plant(only.appendingPathComponent("Applications/Silas.app"), id: Product.Silas.bundleID)
        XCTAssertEqual(LegacyRetirement.copies(home: only), [])
    }

    func testRetiringMovesEveryCopyFirstThenStopsTheWatchdogAndLeavesTheDataAlone() throws {
        let home = temp(), support = temp(), trash = temp()
        let a = home.appendingPathComponent("Applications/BaneySpaces.app"), b = home.appendingPathComponent("Other/BaneySpaces.app")
        for app in [a, b] { try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true) }
        let data = home.appendingPathComponent("Library/Application Support/BaneySpaces/layout.json")
        try FileManager.default.createDirectory(at: data.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: data)
        let plist = LegacyRetirement.watchdogPlist(home: home)
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("<plist/>".utf8).write(to: plist)
        var order: [String] = []
        var n = 0
        let r = LegacyRetirement.retire(apps: [a, b], home: home, supportDir: support, unload: { order.append("unload") }, trash: { url in
            order.append("trash"); n += 1
            let to = trash.appendingPathComponent("\(n)-" + url.lastPathComponent)
            try FileManager.default.moveItem(at: url, to: to)
            return to
        })
        XCTAssertEqual(order, ["trash", "trash", "unload"], "the apps first; the watchdog only after they moved")
        XCTAssertNil(r.failure)
        XCTAssertEqual(r.trashed.count, 2)
        XCTAssertTrue(r.watchdogRemoved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: plist.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: data.path), "its settings stay")
        XCTAssertTrue(LegacyRetirement.alreadyDone(supportDir: support))
    }

    func testAFailedMoveKeepsTheWatchdogAndTheMarkerOffSoItIsTriedAgain() throws {
        let home = temp(), support = temp()
        let plist = LegacyRetirement.watchdogPlist(home: home)
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("<plist/>".utf8).write(to: plist)
        struct Boom: Error, LocalizedError { var errorDescription: String? { "no permission" } }
        var unloaded = false
        let r = LegacyRetirement.retire(apps: old, home: home, supportDir: support, unload: { unloaded = true }, trash: { _ in throw Boom() })
        XCTAssertTrue(r.trashed.isEmpty)
        XCTAssertTrue(r.failure?.contains("no permission") == true)
        XCTAssertFalse(unloaded, "the app is still there, so it keeps its watchdog")
        XCTAssertTrue(FileManager.default.fileExists(atPath: plist.path))
        XCTAssertFalse(LegacyRetirement.alreadyDone(supportDir: support))
        // One copy moving and one failing: no marker either.
        var calls = 0
        let r2 = LegacyRetirement.retire(apps: old + [URL(fileURLWithPath: "/x/BaneySpaces.app")], home: home, supportDir: support, unload: {}, trash: { u in calls += 1; if calls == 2 { throw Boom() }; return u })
        XCTAssertEqual(r2.trashed.count, 1)
        XCTAssertFalse(LegacyRetirement.alreadyDone(supportDir: support), "marker only when none remain")
    }

    func testTheRunnerNeverStartsTheOldAppAndOnlyRunsForANewArrival() throws {
        let runner = try Repo.text("Sources/BaneySpaces/LegacyRetirementRunner.swift")
        XCTAssertFalse(runner.contains("openApplication"), "the old app is moved, never launched")
        XCTAssertTrue(runner.contains("trashItem"))
        XCTAssertTrue(runner.contains("welcomeFinished"))
        let delegate = try Repo.text("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate.contains("let welcomeFinishedAtLaunch = UserDefaults.standard.bool(forKey: Welcome.finishedKey)"), "read at launch")
        XCTAssertEqual(LegacyRetirement.welcomeNote, "BaneySpaces moved to the Trash. Your settings came with you.")
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/WelcomeWindow.swift").contains("LegacyRetirement.welcomeNote"))
    }

    func testTheFirstLaunchRunsTheInstallStepWithItsLinksAndTheTheme() throws {
        // The real script, in-place, in a temp HOME with a fake app: the command links and the theme call both happen.
        let home = temp(), appRoot = temp().appendingPathComponent("Polycarp.app")
        func script(_ body: String, _ rel: String) throws {
            let u = appRoot.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("#!/bin/sh\n\(body)\n".utf8).write(to: u)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: u.path)
        }
        try script("exit 0", "Contents/Resources/bin/polycarp-spaces")
        try script("echo \"$@\" > \"$HOME/theme-called\"", "Contents/Resources/bin/polycarp")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [Repo.root.appendingPathComponent("scripts/install-app.sh").path, "--in-place", appRoot.path]
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BANEYSPACES_DEST_DIR": temp().path, "BANEYSPACES_NO_LAUNCH": "1"]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try p.run(); p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".local/bin/polycarp-spaces").path), "command link")
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent("theme-called")).trimmingCharacters(in: .whitespacesAndNewlines), "theme set polycarp")
        let delegate = try Repo.text("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate.contains("FirstLaunch.shouldRunInstallStep"), "the app asks the tested rule")
        XCTAssertTrue(delegate.contains("\"--in-place\""))
    }
}

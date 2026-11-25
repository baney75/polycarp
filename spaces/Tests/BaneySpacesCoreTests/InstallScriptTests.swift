import XCTest

/// install.sh and package.sh as text: the release key is pinned in both, the download is checked
/// against it before anything installs, and the source build (which needs the command line tools)
/// only runs when there is no prebuilt app. The end-to-end run is in the pull request.
final class InstallScriptTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()

    private func read(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    private func index(of needle: String, in text: String, file: StaticString = #filePath, line: UInt = #line) throws -> String.Index {
        try XCTUnwrap(text.range(of: needle)?.lowerBound, "missing: \(needle)", file: file, line: line)
    }

    private func requirement() throws -> String {
        try read("scripts/release-requirement.txt").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func testRequirementIsThePinnedReleaseKey() throws {
        XCTAssertEqual(try requirement(),
                       #"identifier "com.baney.polycarp" and certificate leaf = H"d1cfbd7446f84f6c625b9db83c5bf96da33b157e""#)
    }

    func testInstallShInlinesTheSameRequirement() throws {
        XCTAssertTrue(try read("install.sh").contains("REQUIREMENT='\(try requirement())'"))
    }

    func testPackageShReadsTheRequirementAndRefusesOtherBuilds() throws {
        let package = try read("scripts/package.sh")
        XCTAssertTrue(package.contains("scripts/release-requirement.txt"))
        XCTAssertTrue(package.contains(#"codesign -v -R "=$REQ""#))
        XCTAssertLessThan(try index(of: "codesign -v -R", in: package), try index(of: "ditto -c -k --keepParent", in: package))
    }

    func testInstallShVerifiesBeforeRunningTheInstaller() throws {
        let install = try read("install.sh")
        let verify = try index(of: #"codesign -v -R "=$REQUIREMENT" "$APP""#, in: install)
        XCTAssertLessThan(try index(of: "codesign --verify --strict --deep", in: install), verify)
        XCTAssertLessThan(verify, try index(of: "Resources/install-app.sh", in: install))
        // A pinned commit is checked before anything installs, too.
        XCTAssertLessThan(try index(of: "PolycarpCommit", in: install), try index(of: "Resources/install-app.sh", in: install))
    }

    func testCommandLineToolsAreOnlyCheckedOnTheSourcePath() throws {
        let install = try read("install.sh")
        // The tools gate (the one that opens Apple's installer) sits after the prebuilt install.
        let prebuiltExit = try index(of: "Resources/install-app.sh", in: install)
        XCTAssertLessThan(prebuiltExit, try index(of: "xcode-select --install", in: install))
        XCTAssertLessThan(prebuiltExit, try index(of: "if ! have_tools; then", in: install))
        XCTAssertTrue(install.contains("BANEYSPACES_FROM_SOURCE"))
    }

    func testBundleShShipsAndCallsTheInstallStep() throws {
        let bundle = try read("scripts/bundle.sh")
        XCTAssertTrue(bundle.contains(#"cp scripts/install-app.sh "$APP/Contents/Resources/install-app.sh""#))
        XCTAssertTrue(bundle.contains(#"scripts/install-app.sh "$APP""#))
    }

    func testAnInstalledCopyWithAnotherSignerIsUpdatedFromSourceWhenToolsAreHere() throws {
        let install = try read("install.sh")
        let check = try index(of: #"codesign -v -R "=$REQUIREMENT" "$EXISTING""#, in: install)
        let source = try index(of: "FROM_SOURCE=1\n", in: install)
        XCTAssertLessThan(check, source)
        XCTAssertLessThan(source, try index(of: #"ZIP_URL="$BASE/download/$TAG/Polycarp.zip""#, in: install), "decided before any download")
        XCTAssertTrue(install.contains("macOS will ask for the Accessibility permission once more"))
    }

    func testTheDownloadUsesNoAPIAndTellsAMissingAppFromAFailure() throws {
        let install = try read("install.sh")
        XCTAssertFalse(install.contains("api.github.com"))
        XCTAssertTrue(install.contains("$BASE/download/$TAG/Polycarp.zip"))
        XCTAssertTrue(install.contains("%{http_code}"))
        XCTAssertTrue(install.contains("404) echo"))
        XCTAssertTrue(install.contains("BANEYSPACES_FROM_SOURCE=1"))
    }

    func testTheVersionAndChecksumAreChecked() throws {
        let install = try read("install.sh")
        XCTAssertTrue(install.contains(#"CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" 2>/dev/null)" != "${TAG#v}""#))
        XCTAssertTrue(install.contains("Polycarp.zip.sha256"))
        XCTAssertLessThan(try index(of: "shasum -a 256", in: install), try index(of: "Resources/install-app.sh", in: install))
    }

    func testInstallLocationFollowsTheRunningCopy() throws {
        let installApp = try read("scripts/install-app.sh")
        XCTAssertTrue(installApp.contains("BANEYSPACES_INSTALL_DIR"))
        XCTAssertLessThan(try index(of: #""$HOME/Applications" /Applications"#, in: installApp), try index(of: #"DEST="$DEST_DIR/$PRODUCT_NAME.app""#, in: installApp))
        let updater = try read("Sources/BaneySpaces/Updater.swift")
        // Only an Applications folder is passed on; anywhere else the installer finds the installed copy.
        XCTAssertTrue(updater.contains(#"parent == "/Applications" || parent == "\(NSHomeDirectory())/Applications""#))
        XCTAssertTrue(updater.contains(#"env["BANEYSPACES_INSTALL_DIR"] = parent"#))
    }

    func testTheAppRunsTheInPlaceStepsAtLaunch() throws {
        let delegate = try read("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate.contains(#""--in-place""#))
        XCTAssertTrue(delegate.contains("linkCommandIfNeeded()"))
        XCTAssertTrue(delegate.contains("DispatchQueue.global"))
    }

    /// --in-place copies nothing and quits nothing; it only links the command into ~/.local/bin.
    func testInPlaceLinksTheCommandAndCopiesNothing() throws {
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent("bs-inplace-\(UUID().uuidString)").resolvingSymlinksInPath()
        defer { try? fm.removeItem(at: home) }
        let app = home.appendingPathComponent("Apps/Polycarp.app")
        try fm.createDirectory(at: app.appendingPathComponent("Contents/Resources/bin"), withIntermediateDirectories: true)
        try "x".write(to: app.appendingPathComponent("Contents/Resources/bin/polycarp-spaces"), atomically: true, encoding: .utf8)
        let dest = home.appendingPathComponent("elsewhere")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [root.appendingPathComponent("scripts/install-app.sh").path, "--in-place", app.path]
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BANEYSPACES_DEST_DIR": dest.path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, out)
        // polycarp-spaces is the command; baneyspaces and ghostdeck stay as names for it.
        for name in ["polycarp-spaces", "baneyspaces", "ghostdeck"] {
            XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: home.appendingPathComponent(".local/bin/\(name)").path),
                           app.appendingPathComponent("Contents/Resources/bin/polycarp-spaces").path, name)
        }
        XCTAssertFalse(fm.fileExists(atPath: dest.path), "nothing was copied")
        let script = try read("scripts/install-app.sh")
        XCTAssertLessThan(try index(of: "if [ \"$IN_PLACE\" = 0 ]; then\n  rm -rf \"$DEST\"", in: script), try index(of: #"cp -R "$APP" "$DEST""#, in: script))
    }

    /// An ad-hoc or unsigned build never replaces an installed copy: that update would make macOS
    /// forget the Accessibility permission. The copy that was there stays as it was.
    func testAnAdHocBuildIsNotInstalledOverAnInstalledCopy() throws {
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent("bs-adhoc-\(UUID().uuidString)").resolvingSymlinksInPath()
        defer { try? fm.removeItem(at: home) }
        let app = home.appendingPathComponent("build/Polycarp.app")
        try fm.createDirectory(at: app.appendingPathComponent("Contents/Resources/bin"), withIntermediateDirectories: true)
        try "new".write(to: app.appendingPathComponent("Contents/Resources/bin/polycarp-spaces"), atomically: true, encoding: .utf8)
        let dest = home.appendingPathComponent("Applications")
        let marker = dest.appendingPathComponent("Polycarp.app/Contents/old")
        try fm.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "old".write(to: marker, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [root.appendingPathComponent("scripts/install-app.sh").path, app.path]
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BANEYSPACES_DEST_DIR": dest.path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        XCTAssertNotEqual(p.terminationStatus, 0, out)
        XCTAssertTrue(out.contains("signed ad-hoc"), out)
        XCTAssertTrue(fm.fileExists(atPath: marker.path), "the installed copy was left alone")
        let script = try read("scripts/install-app.sh")
        let guardAt = try index(of: "grep -q '^Authority='", in: script)
        XCTAssertLessThan(guardAt, try index(of: "to quit' >/dev/null", in: script))
        XCTAssertLessThan(guardAt, try index(of: "rm -rf \"$DEST\"", in: script))
    }

    /// One stream (docs/releases.md): with no tag named, the download and the source build are both the `nightly`
    /// release, the newest build of main. Nothing looks up a stable release any more.
    func testTheDownloadAndTheSourceBuildAreTheNightlyRelease() throws {
        let install = try read("install.sh")
        XCTAssertTrue(install.contains(#"TAG="${BANEYSPACES_REF:-nightly}""#))
        XCTAssertTrue(install.contains(#"REF="$TAG""#))
        XCTAssertFalse(install.contains("$BASE/latest"))
        XCTAssertFalse(install.contains("%{redirect_url}"))
    }

    func testABackgroundUpdateNeverOpensAppleInstallerAndTheSourceBuildUsesItsOwnInstallStep() throws {
        let install = try read("install.sh")
        let gate = try index(of: "if ! have_tools; then", in: install)
        let failFast = try index(of: "this update is built on your Mac and needs Apple's command line tools.", in: install)
        XCTAssertLessThan(gate, failFast)
        XCTAssertLessThan(failFast, try index(of: "xcode-select --install", in: install))
        XCTAssertTrue(install.contains(#"Resources/install-app.sh" "$SRC/build/Polycarp.app""#))
        XCTAssertTrue(install.contains(#"bundle.sh" --install"#), "older revisions only")
    }

    /// Every release ships a ready-made app, so no update waits for the command line tools: the updater reads only
    /// the feed, which names a ready-made app for this Mac or isn't offered.
    func testEveryUpdateInstallsReadyMade() throws {
        let updater = try read("Sources/BaneySpaces/Updater.swift")
        XCTAssertTrue(updater.contains("Updates.feedURL"))
        XCTAssertTrue(updater.contains("Updates.offer($0, build: Self.build)"))
        for gone in ["hasCommandLineTools", "api.github.com/repos/baney75/polycarp/releases?"] {
            XCTAssertFalse(updater.contains(gone), gone)
        }
        // `polycarp update` runs `polycarp-spaces update --help` to read the usage.
        let cli = try read("Sources/baneyspaces-cli/main.swift")
        XCTAssertTrue(cli.contains(#"let usage = "usage: \(me) update --check|--now""#))
        XCTAssertTrue(cli.contains(#"if rest == ["--help"] { out(usage); exit(0) }"#))
        // The menu's row stays "Checking for Updates…" (disabled) until GitHub's compare answers, so a second click
        // can't start a second check: `checking` clears only on a failure or the compare's answer.
        let failed = "self.checking = false\n                    self.checkProblem = problem"
        let compared = "self.confirm(offer, feed: feed) { release in\n                    self.checking = false\n"
        XCTAssertLessThan(try index(of: failed, in: updater), try index(of: compared, in: updater))
        XCTAssertLessThan(try index(of: compared, in: updater), try index(of: "self.available = release", in: updater))
        XCTAssertEqual(updater.components(separatedBy: "self.checking = false").count - 1, 2)
    }

    /// A browser update runs with nobody watching. A key it can't use just then is not made again: that would be a new
    /// app to macOS, and on the Mac that signs releases the key could not be made again at all.
    func testKeepLeavesAnUnusableSigningKeyAlone() throws {
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent("signing-keep-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: home) }
        let dir = home.appendingPathComponent("Library/Application Support/Polycarp/Signing"), bin = home.appendingPathComponent("bin")
        for d in [dir, bin] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
        // A `security` that always fails and writes down what it was asked, so no keychain is ever touched.
        let stub = bin.appendingPathComponent("security")
        try "#!/bin/bash\necho \"$@\" >> '\(home.path)/asked'\nexit 1\n".write(to: stub, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
        let key = dir.appendingPathComponent("polycarp-signing.keychain-db"), pass = dir.appendingPathComponent("keychain-password")
        try "the key".write(to: key, atomically: true, encoding: .utf8)
        try "made up".write(to: pass, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [root.appendingPathComponent("scripts/signing-identity.sh").path, "--keep"]
        p.environment = ["HOME": home.path, "PATH": "\(bin.path):/usr/bin:/bin"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 1)
        XCTAssertEqual(try String(contentsOf: key, encoding: .utf8), "the key")
        XCTAssertEqual(try String(contentsOf: pass, encoding: .utf8), "made up")
        XCTAssertFalse(try String(contentsOf: home.appendingPathComponent("asked"), encoding: .utf8).contains("delete-keychain"))
    }

    private func runSigningRestore(home: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [root.appendingPathComponent("scripts/signing-identity.sh").path]
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BANEYSPACES_SIGNING_RESTORE_ONLY": "1"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, out)
        return out
    }

    private func signingSandbox(kept: [String: String], existingDir: Bool = false, existingFile: String? = nil) throws -> URL {
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent("bs-sign-\(UUID().uuidString)").resolvingSymlinksInPath()
        try fm.createDirectory(at: home.appendingPathComponent("Library"), withIntermediateDirectories: true)
        for (folder, key) in kept {
            let dir = home.appendingPathComponent("Library/\(folder)")
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try key.write(to: dir.appendingPathComponent("polycarp-signing.keychain-db"), atomically: true, encoding: .utf8)
            try "pw".write(to: dir.appendingPathComponent(".hidden"), atomically: true, encoding: .utf8)
        }
        let target = home.appendingPathComponent("Library/Application Support/Polycarp/Signing")
        if existingDir { try fm.createDirectory(at: target, withIntermediateDirectories: true) }
        if let existingFile { try "x".write(to: target.appendingPathComponent(existingFile), atomically: true, encoding: .utf8) }
        return home
    }

    private func restored(_ home: URL, _ name: String) -> String? {
        try? String(contentsOf: home.appendingPathComponent("Library/Application Support/Polycarp/Signing/\(name)"), encoding: .utf8)
    }

    func testSigningRestoresTheKeptFolder() throws {
        let home = try signingSandbox(kept: ["Polycarp Release Signing": "key"])
        defer { try? FileManager.default.removeItem(at: home) }
        let out = try runSigningRestore(home: home)
        XCTAssertTrue(out.contains("restored the Polycarp release signing key"), out)
        XCTAssertEqual(restored(home, "polycarp-signing.keychain-db"), "key")
        XCTAssertEqual(restored(home, ".hidden"), "pw", "dotfiles come back too")
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Polycarp Release Signing").path))
    }

    /// BaneySpaces' own uninstaller kept the release key as "BaneySpaces Release Signing" with its own file name.
    func testSigningRestoresTheKeyBaneySpacesKept() throws {
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent("bs-sign-\(UUID().uuidString)").resolvingSymlinksInPath()
        defer { try? fm.removeItem(at: home) }
        for (folder, key) in ["BaneySpaces Release Signing 20261030-101010": "old", "BaneySpaces Release Signing 20261031-090000": "new"] {
            let dir = home.appendingPathComponent("Library/\(folder)")
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try key.write(to: dir.appendingPathComponent("baneyspaces-signing.keychain-db"), atomically: true, encoding: .utf8)
        }
        let out = try runSigningRestore(home: home)
        XCTAssertTrue(out.contains("restored the BaneySpaces release signing key"), out)
        let legacy = home.appendingPathComponent("Library/Application Support/BaneySpaces/Signing/baneyspaces-signing.keychain-db")
        XCTAssertEqual(try String(contentsOf: legacy, encoding: .utf8), "new", "the newest dated folder, back under the old names")
        XCTAssertFalse(fm.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Polycarp/Signing").path), "no second key is made")
    }

    func testSigningRestoresIntoAnExistingEmptyFolder() throws {
        let home = try signingSandbox(kept: ["Polycarp Release Signing": "key"], existingDir: true)
        defer { try? FileManager.default.removeItem(at: home) }
        _ = try runSigningRestore(home: home)
        XCTAssertEqual(restored(home, "polycarp-signing.keychain-db"), "key")
    }

    func testSigningMergesIntoAFolderThatHasOtherFiles() throws {
        let home = try signingSandbox(kept: ["Polycarp Release Signing": "key"], existingDir: true, existingFile: "stray")
        defer { try? FileManager.default.removeItem(at: home) }
        _ = try runSigningRestore(home: home)
        XCTAssertEqual(restored(home, "polycarp-signing.keychain-db"), "key")
        XCTAssertEqual(restored(home, ".hidden"), "pw")
        XCTAssertEqual(restored(home, "stray"), "x")
    }

    func testSigningRestoresTheNewestDatedFolderWhenThereIsNoPlainOne() throws {
        let home = try signingSandbox(kept: ["Polycarp Release Signing 20261030-101010": "old",
                                             "Polycarp Release Signing 20261031-090000": "new"])
        defer { try? FileManager.default.removeItem(at: home) }
        _ = try runSigningRestore(home: home)
        XCTAssertEqual(restored(home, "polycarp-signing.keychain-db"), "new")
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Polycarp Release Signing 20261030-101010").path), "the older one is left alone")
    }

    func testDiskImageToolIsPinnedByHashAndLivesOutsideBuild() throws {
        let package = try read("scripts/package.sh")
        XCTAssertTrue(package.contains("--require-hashes -r scripts/dmg-requirements.txt"))
        XCTAssertFalse(package.contains("build/.venv"))
        let pins = try read("scripts/dmg-requirements.txt")
        XCTAssertTrue(pins.contains("dmgbuild==") && pins.contains("--hash=sha256:"))
    }

    func testUninstallKeepsTheReleaseSigningKey() throws {
        let uninstall = try read("uninstall.sh")
        XCTAssertTrue(uninstall.contains("RELEASE_REQUIREMENT='\(try requirement())'"))
        XCTAssertLessThan(try index(of: "security find-certificate", in: uninstall), try index(of: "security delete-keychain", in: uninstall))
        XCTAssertTrue(uninstall.contains("Polycarp Release Signing"))
    }

    /// Over SSH osascript can't send the quit (no Automation permission) and failed silently, so an install from SSH stopped
    /// at "still running" (Parish1 lead, 2026-11-17). SIGTERM follows the quit, before the install gives up, and the app
    /// takes SIGTERM as a clean terminate.
    func testInstallFallsBackToSigtermWhenTheQuitIsNotHeard() throws {
        let script = try read("scripts/install-app.sh")
        let quit = try index(of: #"osascript -e "tell application id \"$BUNDLE_ID\" to quit""#, in: script)
        let term = try index(of: #"kill -TERM "$pid""#, in: script)
        XCTAssertLessThan(quit, term, "the gentle quit goes first")
        XCTAssertLessThan(term, try index(of: "is still running; quit it from the menu bar", in: script), "SIGTERM before giving up")
        XCTAssertTrue(script.contains(#"{ grep -v -- --restart-when-safe || true; }"#), "the restart helper is never sent SIGTERM")
        let delegate = try read("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate.contains("for sig in [SIGTERM, SIGINT, SIGHUP]"), "the app must take SIGTERM")
        XCTAssertTrue(delegate.contains("source.setEventHandler { NSApp.terminate(nil) }"), "as a clean terminate")
    }
}

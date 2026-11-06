@testable import BaneySpacesCore
import XCTest

/// Which parts of Polycarp run: the file both the app and `polycarp features` use, what each part owns, what it asks of
/// macOS, and the installer's checkboxes.
final class FeaturesTests: XCTestCase {
    private func temp() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testTheFileRoundTrips() {
        let set = FeatureSet([.voice, .browser])
        XCTAssertEqual(FeatureSet.parse(set.text), set)
        XCTAssertTrue(set.text.contains("workspaces = false"))
        XCTAssertTrue(set.text.contains("voice = true"))
    }

    func testOnlyAnExplicitFalseTurnsAPartOff() {
        XCTAssertEqual(FeatureSet.parse(""), .all)
        XCTAssertEqual(FeatureSet.parse("voice = maybe\nnonsense\n[x]\nbrowser"), .all)
        XCTAssertEqual(FeatureSet.parse("voice = false # not today\n"), FeatureSet([.workspaces, .browser]))
    }

    func testNoFileMeansNobodyHasChosen() throws {
        let path = try temp().appendingPathComponent("sub/features.toml").path
        XCTAssertNil(FeatureFile.load(path: path))
        XCTAssertTrue(FeatureFile.save(FeatureSet([.voice]), path: path))
        XCTAssertEqual(FeatureFile.load(path: path), FeatureSet([.voice]))
    }

    func testTheFileLivesBesideTheTheme() {
        XCTAssertEqual(FeatureFile.path(env: ["POLYCARP_CONFIG_DIR": "/tmp/pc"], home: "/Users/a"), "/tmp/pc/features.toml")
        XCTAssertEqual(FeatureFile.path(env: ["HOME": "/Users/a"], home: nil), "/Users/a/.config/polycarp/features.toml")
    }

    func testSettingsSectionsFollowTheirPart() {
        let voiceOnly = FeatureSet([.voice])
        for gone in ["Keys", "Dock", "Launcher", "Agents", "Automation", "Browser"] {
            XCTAssertFalse(voiceOnly.showsSettingsTab(gone), gone)
        }
        for kept in ["General", "Appearance", "Updates", "Silas"] { XCTAssertTrue(voiceOnly.showsSettingsTab(kept), kept) }
    }

    func testEveryPartHasAPlainNameAndLine() {
        XCTAssertEqual(Feature.allCases.map(\.title), ["Workspaces", "Silas", "Browser"])
        for f in Feature.allCases { XCTAssertTrue(f.summary.hasSuffix("."), f.title) }
    }

    // MARK: What each part asks of macOS

    func testAPartThatIsOffAsksForNothing() {
        XCTAssertEqual(Welcome.steps(for: .all).map(\.kind), [.accessibility, .screenRecording, .inputMonitoring, .microphone])
        XCTAssertEqual(Welcome.steps(for: FeatureSet([.voice])).map(\.kind), [.accessibility, .microphone])
        XCTAssertEqual(Welcome.steps(for: FeatureSet([.workspaces])).map(\.kind), [.accessibility, .screenRecording, .inputMonitoring])
        XCTAssertEqual(Welcome.steps(for: FeatureSet([.browser])).map(\.kind), [])
    }

    func testBrowserAloneStartsWithNoPermissions() {
        let browser = FeatureSet([.browser])
        XCTAssertTrue(Welcome.canStart(granted: [], features: browser))
        XCTAssertNil(Welcome.next(granted: [], skipped: [], features: browser))
        XCTAssertEqual(Welcome.defaultAction(granted: [], skipped: [], features: browser), .finish)
        XCTAssertFalse(Welcome.shouldShow(hasFinished: true, granted: [], forced: false, features: browser))
    }

    func testVoiceAloneStillNeedsAccessibilityAndSaysWhy() {
        let voice = FeatureSet([.voice])
        XCTAssertFalse(Welcome.canStart(granted: [], features: voice))
        XCTAssertTrue(Welcome.canStart(granted: [.accessibility], features: voice))
        let step = Welcome.steps(for: voice)[0]
        XCTAssertFalse(step.title.contains("windows"), "Silas alone doesn't arrange windows")
        XCTAssertTrue(step.why.contains("type"))
    }

    func testEveryoneElseSeesTheWalkAsBefore() {
        XCTAssertEqual(Welcome.steps(for: .all), Welcome.steps)
        XCTAssertFalse(Welcome.canStart(granted: []))
        XCTAssertEqual(Welcome.next(granted: [], skipped: []), .accessibility)
    }

    // MARK: Turning Browser off

    private func manifest(_ home: URL, browser: String, helper: String) throws -> URL {
        let url = home.appendingPathComponent("Library/Application Support/\(browser)/NativeMessagingHosts/\(BrowserPrevious.hostName).json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{\"path\":\"\(helper)\"}".utf8).write(to: url)
        return url
    }

    func testBrowserOffParksOnlyPolycarpsOwnManifests() throws {
        let home = try temp()
        let fm = FileManager.default
        let ours = try manifest(home, browser: "net.imput.helium", helper: "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser")
        let theirs = try manifest(home, browser: "Google/Chrome", helper: "/opt/homebrew/bin/tabkyra")

        XCTAssertEqual(BrowserHosts.setEnabled(false, home: home), 1)
        XCTAssertFalse(fm.fileExists(atPath: ours.path), "the browser can't find it now")
        XCTAssertTrue(fm.fileExists(atPath: ours.path + BrowserHosts.offSuffix))
        XCTAssertTrue(fm.fileExists(atPath: theirs.path), "a separate Tabkyra keeps working")

        XCTAssertEqual(BrowserHosts.setEnabled(true, home: home), 1)
        XCTAssertTrue(fm.fileExists(atPath: ours.path), "turning it on brings it straight back")
        XCTAssertFalse(fm.fileExists(atPath: ours.path + BrowserHosts.offSuffix))
    }

    func testTurningOnNeverOverwritesAManifestWrittenWhileItWasOff() throws {
        let home = try temp()
        let ours = try manifest(home, browser: "net.imput.helium", helper: "/Applications/Polycarp.app/x")
        BrowserHosts.setEnabled(false, home: home)
        try Data("{\"path\":\"/Applications/Polycarp.app/newer\"}".utf8).write(to: ours)
        XCTAssertEqual(BrowserHosts.setEnabled(true, home: home), 0)
        XCTAssertTrue(String(decoding: FileManager.default.contents(atPath: ours.path)!, as: UTF8.self).contains("newer"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: ours.path + BrowserHosts.offSuffix), "the older parked copy goes")
    }

    func testRemovingBrowserDeletesOnlyParkedManifests() throws {
        let home = try temp()
        let fm = FileManager.default
        let ours = try manifest(home, browser: "net.imput.helium", helper: "/Applications/Polycarp.app/x")
        BrowserHosts.setEnabled(false, home: home)
        let theirs = try manifest(home, browser: "Google/Chrome", helper: "/opt/homebrew/bin/tabkyra")
        XCTAssertEqual(BrowserHosts.removeParked(home: home), 1)
        XCTAssertFalse(fm.fileExists(atPath: ours.path + BrowserHosts.offSuffix))
        XCTAssertTrue(fm.fileExists(atPath: theirs.path))
    }

    func testOnlyBrowserStartedHostsAreStopped() {
        let helper = "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser"
        let ps = """
          101 \(helper) chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/ --parent-window=0
          102 \(helper) serve --port 8787
          106 \(helper) doctor --json
          103 /opt/homebrew/bin/tabkyra chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/
         1004 \(helper) chrome-extension://abcdefghijklmnopabcdefghijklmnop/
          105 /bin/zsh -c grep \(helper) chrome-extension://
        garbage line
        """
        XCTAssertEqual(BrowserHosts.hostPids(ps: ps, helper: helper), [101, 102, 1004], "remote access goes too; doctor doesn't")
    }

    // MARK: The installer's checkboxes

    /// Runs one of install.sh's functions in bash, the way the installer does.
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

    func testTheInstallerWritesTheChosenParts() throws {
        let dir = try temp()
        let (code, output) = try installer("write_parts '\(dir.path)' 'voice,browser'")
        XCTAssertEqual(code, 0, output)
        XCTAssertEqual(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path), FeatureSet([.voice, .browser]))
    }

    func testTheInstallerRefusesAnUnknownPartAndAnEmptyChoice() throws {
        let dir = try temp()
        XCTAssertNotEqual(try installer("write_parts '\(dir.path)' 'voice,typo'").0, 0)
        XCTAssertNotEqual(try installer("write_parts '\(dir.path)' ''").0, 0)
        XCTAssertNil(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path))
    }

    func testSpacesAroundThePartsAreFine() throws {
        let dir = try temp()
        XCTAssertEqual(try installer("write_parts '\(dir.path)' 'voice, browser'").0, 0)
        XCTAssertEqual(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path), FeatureSet([.voice, .browser]))
    }

    func testAReinstallKeepsTheChoice() throws {
        let dir = try temp()
        let file = dir.appendingPathComponent("features.toml")
        FeatureFile.save(FeatureSet([.voice]), path: file.path)
        XCTAssertEqual(try installer("write_parts '\(dir.path)' 'browser'").0, 0)
        XCTAssertEqual(FeatureFile.load(path: file.path), FeatureSet([.voice]))
    }

    func testTheOldAppIsRetiredOnlyForSomeoneTakingWorkspaces() throws {
        let installer = try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh"), encoding: .utf8)
        let keep = try XCTUnwrap(installer.range(of: "grep -q '^workspaces = false'"))
        let retire = try XCTUnwrap(installer.range(of: "if [ ${#OLD_APPS[@]} -gt 0 ]; then"))
        XCTAssertLessThan(keep.lowerBound, retire.lowerBound, "the list is emptied before anything acts on it")
        let choose = try XCTUnwrap(installer.range(of: "[ -n \"$REPLY\" ] || choose_parts"))
        let download = try XCTUnwrap(installer.range(of: "# 1. Get the app."))
        XCTAssertLessThan(choose.lowerBound, download.lowerBound, "the boxes come before the wait")
    }

    func testTheInstallerNeverPromptsWithoutATerminal() throws {
        let (code, output) = try installer("choose_parts; echo \"chose=[$REPLY]\"")
        XCTAssertEqual(code, 0, output)
        XCTAssertTrue(output.contains("chose=[]"), output)
    }
}

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
        let set = FeatureSet([])
        XCTAssertEqual(FeatureSet.parse(set.text), set)
        XCTAssertTrue(set.text.contains("workspaces = false"))
        XCTAssertEqual(set.text.split(separator: "\n").filter { !$0.hasPrefix("#") }.count, 1, "one line per part, no other")
    }

    func testOnlyAnExplicitFalseTurnsAPartOff() {
        XCTAssertEqual(FeatureSet.parse(""), .all)
        XCTAssertEqual(FeatureSet.parse("workspaces = maybe\nnonsense\n[x]\nworkspaces"), .all)
        XCTAssertEqual(FeatureSet.parse("workspaces = false # not today\n"), FeatureSet([]))
    }

    /// A file written while dictation or the browser was a part of Polycarp still has its line. It is ignored, either way.
    func testOldVoiceAndBrowserLinesAreIgnored() {
        XCTAssertEqual(FeatureSet.parse("workspaces = true\nvoice = false\nbrowser = false\n"), .all)
        XCTAssertEqual(FeatureSet.parse("workspaces = false\nvoice = true\nbrowser = true\n"), FeatureSet([]))
    }

    func testNoFileMeansNobodyHasChosen() throws {
        let path = try temp().appendingPathComponent("sub/features.toml").path
        XCTAssertNil(FeatureFile.load(path: path))
        XCTAssertTrue(FeatureFile.save(FeatureSet([]), path: path))
        XCTAssertEqual(FeatureFile.load(path: path), FeatureSet([]))
    }

    func testTheFileLivesBesideTheTheme() {
        XCTAssertEqual(FeatureFile.path(env: ["POLYCARP_CONFIG_DIR": "/tmp/pc"], home: "/Users/a"), "/tmp/pc/features.toml")
        XCTAssertEqual(FeatureFile.path(env: ["HOME": "/Users/a"], home: nil), "/Users/a/.config/polycarp/features.toml")
    }

    func testSettingsSectionsFollowTheirPart() {
        let none = FeatureSet([])
        for gone in ["Keys", "Dock", "Launcher", "Agents", "Automation"] {
            XCTAssertFalse(none.showsSettingsTab(gone), gone)
        }
        for kept in ["General", "Appearance", "Updates"] { XCTAssertTrue(none.showsSettingsTab(kept), kept) }
    }

    func testEveryPartHasAPlainNameAndLine() {
        XCTAssertEqual(Feature.allCases.map(\.title), ["Workspaces"])
        for f in Feature.allCases { XCTAssertTrue(f.summary.hasSuffix("."), f.title) }
    }

    // MARK: What each part asks of macOS

    func testAPartThatIsOffAsksForNothing() {
        XCTAssertEqual(Welcome.steps(for: .all).map(\.kind), [.accessibility])
        XCTAssertEqual(Welcome.steps(for: FeatureSet([.workspaces])).map(\.kind), [.accessibility])
        XCTAssertEqual(Welcome.steps(for: FeatureSet([])).map(\.kind), [])
    }

    func testEveryoneElseSeesTheWalkAsBefore() {
        XCTAssertEqual(Welcome.steps(for: .all), Welcome.steps)
        XCTAssertFalse(Welcome.canStart(granted: []))
        XCTAssertEqual(Welcome.next(granted: [], skipped: []), .accessibility)
    }

    // MARK: The installer's parts

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
        let (code, output) = try installer("write_parts '\(dir.path)' 'workspaces'")
        XCTAssertEqual(code, 0, output)
        XCTAssertEqual(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path), FeatureSet([.workspaces]))
    }

    func testTheInstallerRefusesAnUnknownPartAndAnEmptyChoice() throws {
        let dir = try temp()
        XCTAssertNotEqual(try installer("write_parts '\(dir.path)' 'workspaces,typo'").0, 0)
        XCTAssertNotEqual(try installer("write_parts '\(dir.path)' 'browser'").0, 0, "the browser is Tychicus's now")
        XCTAssertNotEqual(try installer("write_parts '\(dir.path)' ''").0, 0)
        XCTAssertNil(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path))
    }

    func testTheInstallerStillAcceptsVoiceButWritesNothingForIt() throws {
        let dir = try temp()
        let (code, output) = try installer("write_parts '\(dir.path)' 'voice,workspaces'")
        XCTAssertEqual(code, 0, output)
        XCTAssertEqual(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path), FeatureSet([.workspaces]))
        let alone = try temp()
        XCTAssertEqual(try installer("write_parts '\(alone.path)' 'voice'").0, 0)
        let written = try String(contentsOf: alone.appendingPathComponent("features.toml"), encoding: .utf8)
        XCTAssertTrue(written.contains("workspaces = false"), "voice alone still writes workspaces off, so the old app is kept: \(written)")
    }

    func testSpacesAroundThePartsAreFine() throws {
        let dir = try temp()
        XCTAssertEqual(try installer("write_parts '\(dir.path)' ' workspaces , '").0, 0)
        XCTAssertEqual(FeatureFile.load(path: dir.appendingPathComponent("features.toml").path), FeatureSet([.workspaces]))
    }

    func testAReinstallKeepsTheChoice() throws {
        let dir = try temp()
        let file = dir.appendingPathComponent("features.toml")
        FeatureFile.save(FeatureSet([]), path: file.path)
        XCTAssertEqual(try installer("write_parts '\(dir.path)' 'workspaces'").0, 0)
        XCTAssertEqual(FeatureFile.load(path: file.path), FeatureSet([]))
    }

    func testTheOldAppIsRetiredOnlyForSomeoneTakingWorkspaces() throws {
        let installer = try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh"), encoding: .utf8)
        let keep = try XCTUnwrap(installer.range(of: "grep -q '^workspaces = false'"))
        let retire = try XCTUnwrap(installer.range(of: "if [ ${#OLD_APPS[@]} -gt 0 ]; then"))
        XCTAssertLessThan(keep.lowerBound, retire.lowerBound, "the list is emptied before anything acts on it")
    }
}

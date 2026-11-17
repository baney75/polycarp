import XCTest
@testable import BaneySpacesCore

final class ScriptExtensionTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-ext-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    /// An extension folder with a manifest and an executable `run.sh`.
    @discardableResult
    private func make(_ id: String, manifest: String, script: String) throws -> URL {
        let dir = root.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try manifest.write(to: dir.appendingPathComponent("extension.toml"), atomically: true, encoding: .utf8)
        let s = dir.appendingPathComponent("run.sh")
        try ("#!/bin/sh\n" + script).write(to: s, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: s.path)
        return dir
    }

    private func ext(_ id: String, _ manifest: String, _ script: String) throws -> ScriptExtension {
        let dir = try make(id, manifest: manifest, script: script)
        return try ScriptExtension.parse(manifest, id: id, folder: dir)
    }

    func testManifestRules() throws {
        let dir = root!
        let ok = try ScriptExtension.parse("title = \"T\"\nkeyword = \"t\"\ncommand = [\"./run.sh\", \"-x\"]\noutput = \"list\"\ntimeout = 99\n",
                                           id: "t", folder: dir)
        XCTAssertEqual(ok.command, ["./run.sh", "-x"])
        XCTAssertEqual(ok.output, .list)
        XCTAssertEqual(ok.timeout, ScriptExtension.maxTimeout)
        XCTAssertEqual(try ScriptExtension.parse("title = \"T\"\nkeyword = \"t\"\ncommand = [\"x\"]", id: "t", folder: dir).timeout, 5)
        for bad in ["keyword = \"t\"\ncommand = [\"x\"]",                                   // no title
                    "title = \"T\"\ncommand = [\"x\"]",                                     // no keyword
                    "title = \"T\"\nkeyword = \"two words\"\ncommand = [\"x\"]",
                    "title = \"T\"\nkeyword = \"!yt\"\ncommand = [\"x\"]",
                    "title = \"T\"\nkeyword = \"t\"\ncommand = \"./run.sh; rm -rf ~\"",      // a string is not a command
                    "title = \"T\"\nkeyword = \"t\"\ncommand = []",
                    "title = \"T\"\nkeyword = \"t\"\ncommand = [\"x\", 3]",
                    "title = \"T\"\nkeyword = \"t\"\ncommand = [\"x\"]\noutput = \"html\"",
                    "title = \"T\"\nkeyword = \"t\"\ncommand = [\"x\"]\ntimeout = -1"] {
            XCTAssertThrowsError(try ScriptExtension.parse(bad, id: "t", folder: dir), bad)
        }
    }

    /// What's typed reaches the program as one argument, character for character: no shell reads it.
    func testTypedTextIsNeverInterpolated() throws {
        let marker = root.appendingPathComponent("pwned").path
        let e = try ext("echo", "title = \"Echo\"\nkeyword = \"echo\"\ncommand = [\"./run.sh\"]\n",
                        "printf '%s|%s' \"$#\" \"$1\"\n")
        let nasty = "a b; touch \(marker) $(touch \(marker)) `touch \(marker)` $HOME * \"q\" 'q' | cat"
        let run = ExtensionRunner.run(e, input: nasty)
        XCTAssertTrue(run.succeeded, run.stderr)
        XCTAssertEqual(run.stdout, "1|\(nasty)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker))
        XCTAssertEqual(ExtensionRunner.run(e, input: "").stdout, "0|")
    }

    func testItRunsInItsFolderWithAShortEnvironment() throws {
        let e = try ext("env", "title = \"Env\"\nkeyword = \"env\"\ncommand = [\"./run.sh\"]\n",
                        "pwd -P; echo \"$POLYCARP_INPUT\"; echo \"${SECRET_TOKEN:-unset}\"; cat; echo end\n")
        setenv("SECRET_TOKEN", "leak", 1)
        defer { unsetenv("SECRET_TOKEN") }
        let run = ExtensionRunner.run(e, input: "hi")
        let lines = run.stdout.split(separator: "\n").map(String.init)
        // realpath, not URL.resolvingSymlinksInPath: that one drops the /private that pwd -P keeps.
        let real = realpath(e.folder.path, nil).map { p in defer { free(p) }; return String(cString: p) }
        XCTAssertEqual(lines.first, real)
        XCTAssertEqual(Array(lines.dropFirst()), ["hi", "unset", "end"])
    }

    func testATimeoutStopsTheWholeGroup() throws {
        let marker = root.appendingPathComponent("survived").path
        let e = try ext("slow", "title = \"Slow\"\nkeyword = \"slow\"\ncommand = [\"./run.sh\"]\ntimeout = 1\n",
                        "(sleep 3; touch \(marker)) &\nsleep 20\n")
        let start = Date()
        let run = ExtensionRunner.run(e, input: "")
        XCTAssertTrue(run.timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
        XCTAssertEqual(ExtensionOutput.rows(run, of: e).first?.title, "Stopped after 1 s")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker), "a child outlived the timeout")
    }

    func testOutputIsCappedAndFailuresSayWhy() throws {
        let big = try ext("big", "title = \"Big\"\nkeyword = \"big\"\ncommand = [\"./run.sh\"]\n",
                          "yes a | head -c 300000\n")
        let r = ExtensionRunner.run(big, input: "")
        XCTAssertTrue(r.succeeded)
        XCTAssertTrue(r.truncated)
        XCTAssertEqual(r.stdout.utf8.count, ExtensionRunner.maxOutput)

        let fails = try ext("fails", "title = \"Fails\"\nkeyword = \"fails\"\ncommand = [\"./run.sh\"]\n",
                            "echo 'no network' >&2; exit 3\n")
        let rows = ExtensionOutput.rows(ExtensionRunner.run(fails, input: ""), of: fails)
        XCTAssertEqual(rows.map(\.title), ["Exit status 3"])
        XCTAssertEqual(rows.first?.subtitle, "no network")

        let missing = try ScriptExtension.parse("title = \"M\"\nkeyword = \"m\"\ncommand = [\"./nope.sh\"]", id: "m", folder: root)
        XCTAssertNotNil(ExtensionRunner.run(missing, input: "").failure)
        // A relative path can't climb out of its folder.
        let escape = try ScriptExtension.parse("title = \"E\"\nkeyword = \"e\"\ncommand = [\"../../../bin/sh\"]", id: "e", folder: root.appendingPathComponent("echo"))
        XCTAssertNil(escape.program())
    }

    func testTextAndListOutputBecomeRows() throws {
        let text = try ext("t", "title = \"T\"\nkeyword = \"t\"\ncommand = [\"./run.sh\"]\n", "printf 'line one\\nline two\\n'\n")
        let rows = ExtensionOutput.rows(ExtensionRunner.run(text, input: ""), of: text)
        XCTAssertEqual(rows.map(\.title), ["line one ⏎ line two"])
        XCTAssertEqual(rows.first?.action, .copy("line one\nline two"))

        let list = try ext("l", "title = \"L\"\nkeyword = \"l\"\ncommand = [\"./run.sh\"]\noutput = \"list\"\n",
                           "printf 'Alpha\\tfirst\\tA-VALUE\\nDocs\\tsite\\thttps://example.com/x\\nBare\\n'\n")
        let lrows = ExtensionOutput.rows(ExtensionRunner.run(list, input: ""), of: list)
        XCTAssertEqual(lrows.map(\.title), ["Alpha", "Docs", "Bare"])
        XCTAssertEqual(lrows.map(\.action), [.copy("A-VALUE"), .open(URL(string: "https://example.com/x")!), .copy("Bare")])
        XCTAssertEqual(lrows[0].subtitle, "first")
    }

    func testTheSpecIsThereForTheWindowsLauncher() {
        XCTAssertTrue(FileManager.default.fileExists(atPath: LauncherProviderSeamTests.source("spec/launcher-extensions.md")))
    }
}

import Foundation
import XCTest

/// Gap F3: after an install, every part reports the commit the app was built from, or the install says which one doesn't.
/// On 2026-11-17 the installed app, both commands and the browser helper were at 4fa0e4d while Helium's extension was at
/// 9640a7a, and nothing said so: `polycarp version --check` exited 1, but no build script ran it.
final class InstallSameCommitTests: XCTestCase {
    func testTheInstallChecksEveryPartAfterTheAppStarts() throws {
        let script = try Repo.code("scripts/install-app.sh")
        let launch = try XCTUnwrap(script.range(of: #"open "$DEST""#), "the install opens the app")
        let check = try XCTUnwrap(script.range(of: "version --check --wait"), "the install compares the parts")
        XCTAssertLessThan(launch.lowerBound, check.lowerBound, "after the app has started and copied the extension")
        XCTAssertTrue(script.contains(#"$DEST/Contents/Resources/bin/polycarp" version --check"#), "the polycarp this app carries")
        XCTAssertTrue(script.contains(#"elif [ "$same" != 0 ]; then"#) && script.contains("exit 1"), "a part that differs fails the install")
        XCTAssertTrue(script.contains(#"if [ "$same" = 75 ]; then"#), "a browser that didn't answer is a note, not a failure")
    }

    /// 2026-11-25: an update that changed the skill's text put every part in place, then failed on the old skill. The step of
    /// `polycarp update` that refreshes it comes after this script, so it never ran.
    func testAnInstalledSkillIsRefreshedBeforeTheCheckAndNoneIsAdded() throws {
        let script = try Repo.code("scripts/install-app.sh")
        let refresh = try XCTUnwrap(script.range(of: "skill install"), "the install refreshes the skill")
        let check = try XCTUnwrap(script.range(of: "version --check --wait"))
        XCTAssertLessThan(refresh.lowerBound, check.lowerBound)
        for (installed, asked) in [("polycarp-spaces", true), ("baneyspaces", true), (nil, false)] as [(String?, Bool)] {
            let fm = FileManager.default
            let home = fm.temporaryDirectory.appendingPathComponent("skill-\(UUID().uuidString)")
            defer { try? fm.removeItem(at: home) }
            let bin = home.appendingPathComponent("Polycarp.app/Contents/Resources/bin")
            try fm.createDirectory(at: bin, withIntermediateDirectories: true)
            for (name, body) in [("polycarp-spaces", "echo \"$@\" >> \"$HOME/asked\""), ("polycarp", "exit 0")] {
                let file = bin.appendingPathComponent(name)
                try Data("#!/bin/sh\n\(body)\n".utf8).write(to: file)
                try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            }
            if let installed {
                let dir = home.appendingPathComponent(".claude/skills/\(installed)")
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                try Data("old".utf8).write(to: dir.appendingPathComponent("SKILL.md"))
            }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [Repo.root.appendingPathComponent("scripts/install-app.sh").path, "--in-place", home.appendingPathComponent("Polycarp.app").path]
            p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BANEYSPACES_DEST_DIR": home.path, "BANEYSPACES_NO_LAUNCH": "1"]
            p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            try p.run(); p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0)
            let said = (try? String(contentsOf: home.appendingPathComponent("asked"), encoding: .utf8)) ?? ""
            XCTAssertEqual(said, asked ? "skill install\n" : "", installed ?? "no skill")
        }
    }
}

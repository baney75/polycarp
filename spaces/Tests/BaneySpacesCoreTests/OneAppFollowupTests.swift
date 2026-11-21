@testable import BaneySpacesCore
import Foundation
import XCTest

/// Follow-ups from PR 23's review (#24).
final class OneAppFollowupTests: XCTestCase {
    private func text(_ path: String) throws -> String {
        try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent(path), encoding: .utf8)
    }

    func testCIRunsTheSpacesTestsForTheRootInstaller() throws {
        let ci = try text(".github/workflows/ci.yml")
        let paths = ci.split(separator: "\n").filter { $0.contains("paths: [") }
        XCTAssertEqual(paths.count, 2, ci)
        for line in paths { XCTAssertTrue(line.contains("'install.sh'"), "\(line)") }
        let spaces = try XCTUnwrap(ci.split(separator: "\n").first { $0.trimmingCharacters(in: .whitespaces).hasPrefix("spaces: [") })
        XCTAssertTrue(spaces.contains("'install.sh'"), "\(spaces)")
    }

    func testTheRootInstallerPinsTheSameReleaseRequirement() throws {
        let req = try Repo.text("scripts/release-requirement.txt").trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertTrue(try text("install.sh").contains("local REQUIREMENT='\(req)'"), "install.sh and release-requirement.txt disagree")
    }
}

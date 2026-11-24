import Foundation
import XCTest
@testable import BaneySpacesCore

/// The throwaway macOS VM for agent work was removed from Polycarp (2026-11-21). Polycarp keeps one line saying so and
/// nothing else of it.
final class SandboxRemovedTests: XCTestCase {
    func testTheSandboxCommandPrintsOnlyThatItWasRemoved() throws {
        XCTAssertEqual(AgentWorkspace.sandboxRemoved, "The sandbox was removed from Polycarp.")
        let cli = try Repo.code("Sources/baneyspaces-cli/main.swift")
        let verb = try XCTUnwrap(cli.range(of: "case \"sandbox\":"))
        let next = try XCTUnwrap(cli[verb.upperBound...].range(of: "case "))
        let body = cli[verb.upperBound..<next.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(body, "fail(AgentWorkspace.sandboxRemoved, code: 2)", "one line on stderr, exit 2, nothing sent to the app")
        XCTAssertFalse(cli.contains("sandbox up"), "the usage no longer offers it")
    }

    func testTheAppNoLongerAnswersASandboxRequest() throws {
        let old = Data(#"{"op":"sandbox","text":"up"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(Wire.Request.self, from: old), "an old command's request is a bad request")
        for path in ["Sources/BaneySpaces/AppDelegate.swift", "Sources/BaneySpaces/Session/Server.swift",
                     "Sources/BaneySpaces/Session/SessionController.swift", "Sources/BaneySpaces/Setup.swift"] {
            XCTAssertFalse(try Repo.code(path).lowercased().contains("sandbox"), path)
        }
    }

    func testNoneOfTheSandboxIsLeftToBuildOrInstall() {
        let fm = FileManager.default
        for path in ["Sources/BaneySpacesCore/Sandbox", "Sources/BaneySpaces/Sandbox.swift", "Sources/baneyspaces-cli/Sandbox.swift",
                     "scripts/install-sandbox.sh", "scripts/sandbox-probe.swift", "sandbox", "docs/sandbox.md"] {
            XCTAssertFalse(fm.fileExists(atPath: Repo.root.appendingPathComponent(path).path), path)
        }
    }
}

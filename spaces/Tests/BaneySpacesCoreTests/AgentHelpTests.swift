@testable import BaneySpacesCore
import Foundation
import XCTest

/// `agent <verb> --help`: the verb's usage and exit 0, never --help read as search words (`agent move --help` said
/// "nothing matches") or as an app to lend (`agent lend --help` asked Donovan to lend "--help").
final class AgentHelpTests: XCTestCase {
    func testHelpIsAskedForOnEveryVerbButNotAsAValueOrAfterDashDash() {
        for rest in [["move", "--help"], ["move", "-h"], ["lend", "--help"], ["find", "--help"], ["status", "-h"], ["--help"], ["-h"],
                     ["move", "notes", "--help"], ["run", "--dir", "/tmp", "--help"], ["click", "--window", "4", "-h"], ["type", "-h"]] {
            XCTAssertTrue(AgentHelp.asked(rest), "\(rest)")
        }
        for rest in [["run", "--", "claude", "--help"], ["type", "--", "-h"], ["find", "--name", "-h"], ["lend", "Notes", "--for", "-h"], ["move", "notes"], [], ["status"]] {
            XCTAssertFalse(AgentHelp.asked(rest), "\(rest)")
        }
    }

    static let usage = """
    usage: polycarp-spaces <command>

      agent status|on [N]|off     the agent workspace
      agent run [--dir D] -- CMD  run a command
      agent \(HandsTools.verbLine)
                                  read and act on apps
      agent cursor on|theme <name>|status   each agent's cursor
      agent lend <app|pid> [--for 30m]   asks you, in a sheet
                                  (only a real click on Lend lends it)
      agent move <id | words>     send a window there
      doctor                      what's working
    """

    func testEachVerbGetsItsOwnUsage() {
        let move = AgentHelp.text(verb: "move", usage: Self.usage)
        XCTAssertTrue(move.hasPrefix("usage: polycarp-spaces agent move --window <window>"), move)
        XCTAssertTrue(move.contains("--window: Window id from `windows`."), move)
        XCTAssertTrue(move.contains("agent move <id | words>"), "the session move is named too: \(move)")
        XCTAssertFalse(move.contains("cursor"), move)

        let lend = AgentHelp.text(verb: "lend", usage: Self.usage)
        XCTAssertEqual(lend.components(separatedBy: "\n").count, 3, lend)
        XCTAssertTrue(lend.contains("(only a real click on Lend lends it)"), "continuation lines come along: \(lend)")

        XCTAssertTrue(AgentHelp.text(verb: "off", usage: Self.usage).contains("agent status|on [N]|off"))
        XCTAssertFalse(AgentHelp.text(verb: "status", usage: Self.usage).contains("cursor"), "cursor's `|status` is its own argument")
        XCTAssertTrue(AgentHelp.text(verb: "find", usage: Self.usage).hasPrefix("usage: polycarp-spaces agent find"))

        let all = AgentHelp.text(verb: nil, usage: Self.usage)
        XCTAssertTrue(all.contains("agent run") && all.contains("agent lend"), all)
        XCTAssertFalse(all.contains("doctor"), all)
        XCTAssertEqual(AgentHelp.text(verb: "nope", usage: Self.usage), all)
    }

    func testTheCLIAnswersHelpBeforeAnyAgentArm() throws {
        let main = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/baneyspaces-cli/main.swift"), encoding: .utf8)
        let help = try XCTUnwrap(main.range(of: "case \"agent\" where AgentHelp.asked(rest):"))
        let first = try XCTUnwrap(main.range(of: "case \"agent\" where HandsTools.userOnly"))
        XCTAssertLessThan(help.lowerBound, first.lowerBound, "help comes before lend, the hands verbs and the session op")
    }

    /// The built command itself. Help exits before any call to the app, so this never reaches a running Polycarp.
    func testAgentMoveHelpPrintsUsageAndExitsZero() throws {
        let bin = Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("baneyspaces-cli")
        guard FileManager.default.isExecutableFile(atPath: bin.path) else { throw XCTSkip("baneyspaces-cli isn't built next to the tests") }
        for args in [["agent", "move", "--help"], ["agent", "lend", "-h"]] {
            let p = Process()
            p.executableURL = bin
            p.arguments = args
            let pipe = Pipe()
            p.standardOutput = pipe
            try p.run()
            let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0, "\(args): \(out)")
            XCTAssertTrue(out.hasPrefix("usage:"), "\(args): \(out)")
            XCTAssertFalse(out.contains("nothing matches"), out)
            XCTAssertTrue(out.contains("agent \(args[1])"), out)
        }
    }
}

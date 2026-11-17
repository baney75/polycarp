import BaneySpacesCore
import XCTest

/// Who reaches what (spec/agent-api.md): the URL scheme answers any program and a web page, so its workspace commands
/// follow view control; the socket trusts every process running as Donovan, and Polycarp's scripts use it.
final class ViewPathTests: XCTestCase {
    /// Donovan on workspace 1, the agent workspace 9 out of sight.
    let view = ViewPath.View(current: 1, shown: [1], agentWorkspace: 9)

    func testASwitchURLWithViewControlOffIsRefused() {
        for access in AgentAccessMode.allCases {
            let e = ViewPath.urlRefusal("switch", 2, view: view, access: access, viewControl: false)
            XCTAssertEqual(e?.code, .permissionDenied, "switch/2 under \(access) with view control off")
            XCTAssertEqual(e?.retry, .never)
            XCTAssertEqual(e?.suggestion, ViewPath.scriptSuggestion)
        }
        XCTAssertEqual(ViewPath.urlRefusal("switch", 2, view: view, access: .standard, viewControl: true)?.code, .permissionDenied,
                       "view control on still needs Full Access")
        XCTAssertNil(ViewPath.urlRefusal("switch", 2, view: view, access: .full, viewControl: true))
    }

    func testRestoreAndMoveURLsFollowTheAgentAPIRule() {
        XCTAssertEqual(ViewPath.urlRefusal("restore", 0, view: view, access: .full, viewControl: false)?.code, .permissionDenied)
        XCTAssertNil(ViewPath.urlRefusal("restore", 0, view: view, access: .full, viewControl: true))
        XCTAssertEqual(ViewPath.urlRefusal("move", 3, view: view, access: .full, viewControl: false)?.code, .permissionDenied,
                       "the front window onto workspace 3 changes what he sees")
        // Onto the agent workspace the window still leaves the workspace in front: it waits, whatever the setting.
        for on in [false, true] {
            let e = ViewPath.urlRefusal("move", 9, view: view, access: .full, viewControl: on)
            XCTAssertEqual(e?.code, .inUse); XCTAssertEqual(e?.retry, .safe)
        }
        XCTAssertNil(ViewPath.urlRefusal("move", 3, view: view, access: .full, viewControl: true))
    }

    /// The socket path the scripts use is this Mac's only: no token lets another machine switch it.
    func testTheWorkspaceOpIsLocalOnly() {
        for verb in ["switch", "move", "restore"] {
            XCTAssertFalse(Remote.allows(Wire.Request(op: .workspace, target: "2", text: verb)), verb)
        }
    }

    func testURLsThatOnlyShowPolycarpsOwnWindowsAreNotGated() {
        for command in ["viewer", "launcher", "voice", "dock"] {
            XCTAssertNil(ViewPath.urlRefusal(command, 0, view: view, access: .readOnly, viewControl: false), command)
        }
    }

    /// The app's URL handler asks `ViewPath` before it acts, and no longer runs the three commands directly.
    func testTheURLHandlerAsksViewPathFirst() throws {
        let src = try Repo.text("Sources/BaneySpaces/AppDelegate.swift")
        let start = try XCTUnwrap(src.range(of: "@objc private func handleURL"))
        let handler = String(src[start.lowerBound...].prefix(2500))
        let gate = try XCTUnwrap(handler.range(of: "ViewPath.urlRefusal(host, n,"))
        let act = try XCTUnwrap(handler.range(of: "_ = workspaceAction(host, n)"))
        XCTAssertLessThan(gate.lowerBound, act.lowerBound)
        for direct in ["$0.switchTo(n)", "$0.moveFocused(to: n)", "case \"restore\": run"] {
            XCTAssertFalse(handler.contains(direct), "the URL handler still runs \(direct) without the gate")
        }
    }

    /// The probes and bench.sh switch through the socket, so they keep working after every install without the sheet.
    func testNoScriptOpensAWorkspaceURL() throws {
        let pattern = try NSRegularExpression(pattern: #"(polycarp|baneyspaces)://(switch|move|restore)"#)
        let root = Repo.root
        let skip = ["Sources/", "Tests/", ".build/", "platforms/linux/", "spec/"]
        var offenders: [String] = []
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        for case let url as URL in files {
            let path = String(url.path.dropFirst(root.path.count + 1))
            if skip.contains(where: path.hasPrefix) { files.skipDescendants(); continue }
            guard ["swift", "sh", "py", "mjs", "js", "ts", "lua", "applescript"].contains(url.pathExtension) || path == "Makefile",
                  let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            if pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil { offenders.append(path) }
        }
        XCTAssertEqual(offenders, [], "use `polycarp-spaces switch|move|restore`: the URLs need view control")
        XCTAssertTrue(try Repo.text("scripts/bench.sh").contains("\"$cli\" switch \"$current\""))
    }

    func testTheSpecSaysWhoReachesWhat() throws {
        let doc = try Repo.text("spec/agent-api.md")
        func flat(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        let opening = flat(String(doc.prefix(2200)))
        for phrase in ["That promise covers the agent API and the URL scheme.",
                       "The control socket (`polycarp-spaces focus`, `send`, `switch`, `move`, `restore`) trusts every process running as Donovan.",
                       "It is a convenience channel, not an agent boundary"] {
            XCTAssertTrue(opening.contains(phrase), phrase)
        }
    }
}

import XCTest
@testable import BaneySpacesCore

final class WindowCommandProviderTests: XCTestCase {
    let p = WindowCommandProvider()

    func testMoveTakesAWorkspaceNumber() {
        for q in ["move 3", "move to 3", "Move window to 3", "send to 3", "mv 3", "mv3"] {
            let rows = p.results(for: q)
            XCTAssertEqual(rows.map(\.action), [.moveWindow(3)], q)
            XCTAssertEqual(rows.first?.placement, .top, q)
        }
        XCTAssertEqual(p.results(for: "move").count, 9)
        XCTAssertEqual(p.results(for: "move 0"), [])
        XCTAssertEqual(p.results(for: "move 12"), [])
    }

    func testSwitchTakesAWorkspaceNumber() {
        XCTAssertEqual(p.results(for: "switch to 4").map(\.action), [.switchWorkspace(4)])
        XCTAssertEqual(p.results(for: "go to 2").map(\.action), [.switchWorkspace(2)])
        // "3" and "workspace 3" are the launcher's own Workspace rows already.
        XCTAssertEqual(p.results(for: "3"), [])
        XCTAssertEqual(p.results(for: "workspace 3"), [])
    }

    func testWindowActionsByName() {
        XCTAssertEqual(p.results(for: "fill").map(\.action), [.windowCommand("fill")])
        XCTAssertEqual(p.results(for: "fill").first?.placement, .top)
        XCTAssertEqual(p.results(for: "maximize").map(\.action), [.windowCommand("fill")])
        XCTAssertEqual(p.results(for: "f"), [])
        XCTAssertEqual(p.results(for: "safari"), [])
        XCTAssertEqual(p.results(for: "movie"), [])
    }

    func testTheLauncherHasThemAndRoutesEveryAction() throws {
        XCTAssertTrue(LauncherProviders.standard().contains { $0.name == "windows" })
        let src = try String(contentsOfFile: LauncherProviderSeamTests.source("Sources/BaneySpaces/Launcher.swift"), encoding: .utf8)
        for needle in ["case .moveWindow(let n)", "case .switchWorkspace(let n)", "case .windowCommand(let id)", "case .paste(let text)"] {
            XCTAssertTrue(src.contains(needle), needle)
        }
        let app = try String(contentsOfFile: LauncherProviderSeamTests.source("Sources/BaneySpaces/AppDelegate.swift"), encoding: .utf8)
        for c in WindowCommandProvider.commands {
            XCTAssertTrue(app.contains("case \"\(c.id)\""), "AppDelegate routes \(c.id)")
        }
    }
}

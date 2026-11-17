import BaneySpacesCore
import XCTest
@testable import BaneySpaces

/// `polycarp-spaces launcher query` lists what the panel lists. Both run on one model built over a fixture index (made-up
/// app paths, so no real app is looked at), and the panel's rows are its `items` after the query is typed.
final class LauncherQueryPanelTests: XCTestCase {
    private func model() -> LauncherModel {
        var a = LauncherActions()
        a.appsOn = { $0 == 3 ? ["Slack"] : [] }
        a.workspacesByApp = { ["/fixture/Slack.app": [3], "/fixture/Clock.app": [1]] }
        let names = ["Slack", "Google Chrome", "Visual Studio Code", "Clock", "Calculator", "Safari", "Lockdown Notes", "Font Book"]
        return LauncherModel(actions: a, apps: names.map { AppEntry(name: $0, path: "/fixture/\($0).app", folder: "Applications") })
    }

    func testTheQueryListsThePanelsTopFive() {
        let m = model()
        defer { m.query = "" } // cancels the Spotlight search typing schedules, before it can run
        for q in ["lck", "chorme", "vsc", "3"] {
            let asked = m.queryRows(q, limit: 5).map(\.id)
            m.query = q
            XCTAssertEqual(asked, Array(m.items.prefix(5).map(\.id)), q)
            XCTAssertGreaterThanOrEqual(asked.count, 4, q) // at least the three web rows and Install
        }
        XCTAssertEqual(m.queryRows("vsc", limit: 1).map(\.id), ["app:/fixture/Visual Studio Code.app"])
        XCTAssertEqual(m.queryRows("3", limit: 1).map(\.id), ["ws:3"])
    }

    /// Asking records no pick and leaves the panel's rows as they were.
    func testAskingChangesNothingThePanelShows() {
        let m = model()
        defer { m.query = "" }
        m.query = "cal"
        let before = m.items.map(\.id)
        let recents = UserDefaults.standard.stringArray(forKey: "launcherRecents")
        _ = m.queryRows("vsc", limit: 5)
        XCTAssertEqual(m.items.map(\.id), before)
        XCTAssertEqual(m.query, "cal")
        XCTAssertEqual(UserDefaults.standard.stringArray(forKey: "launcherRecents"), recents)
    }

    /// The only line it writes is the timing line, and what was typed isn't in it.
    func testTheTimingLineCarriesNoQuery() {
        var lines: [String] = []
        let typed = "vsc private words"
        let rows = LauncherQueryAnswer.rows(typed, limit: 3, model: model(), log: { lines.append($0) })
        XCTAssertEqual(lines.count, 1)
        XCTAssertTrue(lines[0].contains(" launcher query="), lines[0])
        XCTAssertTrue(lines[0].hasSuffix(" rows=\(rows.count)"), lines[0])
        for word in typed.split(separator: " ") { XCTAssertFalse(lines[0].contains(word), lines[0]) }
        XCTAssertFalse(rows.isEmpty)
    }
}

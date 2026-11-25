import BaneySpacesCore
import XCTest

/// Donovan, 2026-10-14: the menu bar menu was "way too cluttered". These hold the trimmed shape.
final class MenuLayoutTests: XCTestCase {
    func testListsOnlyWorkspacesInUseThenOneEmpty() {
        let rows = MenuLayout.rows(current: 1, apps: [1: ["Helium", "Ghostty"], 2: ["Grok Bot"]])
        XCTAssertEqual(rows.map(\.workspace), [1, 2, 3])
        XCTAssertEqual(rows.map(\.title), ["1  Helium, Ghostty", "2  Grok Bot", "3  Empty"], "the number alone, no \"Workspace\"")
        XCTAssertEqual(rows.map(\.isCurrent), [true, false, false])
    }

    func testCurrentWorkspaceShowsEvenWhenEmpty() {
        let rows = MenuLayout.rows(current: 5, apps: [1: ["Helium"]])
        XCTAssertEqual(rows.map(\.workspace), [1, 5, 2])
        XCTAssertEqual(rows[1].title, "5  Empty")
        XCTAssertTrue(rows[1].isCurrent)
        // The empty row is another workspace than the one you're on.
        XCTAssertEqual(rows[2].title, "2  Empty")
    }

    func testLongAppListShortensAndKeepsTheFullListForTheTooltip() {
        let names = ["Helium", "Ghostty", "Obsidian", "T3 Code (Nightly)", "iPhone Mirroring"]
        let row = MenuLayout.rows(current: 1, apps: [1: names])[0]
        XCTAssertEqual(row.title, "1  Helium, Ghostty, Obsidian +2")
        XCTAssertEqual(row.fullList, names.joined(separator: ", "))
        XCTAssertNil(MenuLayout.rows(current: 1, apps: [1: ["A", "B", "C"]])[0].fullList)
    }

    func testEveryWorkspaceInUseLeavesNoEmptyRow() {
        var apps: [Int: [String]] = [:]
        for n in 1...9 { apps[n] = ["App \(n)"] }
        let rows = MenuLayout.rows(current: 4, apps: apps)
        XCTAssertEqual(rows.count, 9)
        XCTAssertFalse(rows.contains { $0.title.hasSuffix("Empty") })
    }

    /// 2026-11-22: the menu never asks what you are doing. It opens on the workspaces, with no head and no rows that
    /// ask for a focus or a review of the day. Two workspaces in use and one empty make eight rows.
    func testTheMenuOpensOnTheWorkspaces() {
        let rows = MenuLayout.rows(current: 1, apps: [1: ["Ghostty"]])
        let e = MenuLayout.entries(rows: rows, finished: 0, update: .check)
        XCTAssertEqual(e, rows.map(MenuEntry.workspace) + [.separator, .showAll, .find, .separator, .update(.check), .settings, .quit])
        let two = MenuLayout.rows(current: 1, apps: [1: ["Helium"], 2: ["T3 Code (Nightly)"]])
        XCTAssertEqual(MenuLayout.entries(rows: two, finished: 0, update: .check).filter { $0 != .separator }.count, 8,
                       "three workspace rows and five fixed rows")
    }

    /// The app target can't be imported by tests, so these read its source (code only, comments stripped).
    private func code(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    func testMenuBarMenuDropsTheHintRowAndMovesTheSwitchesToSettings() throws {
        let text = try code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertFalse(text.contains("\"Add ⇧ to send the front window there\""), "the ⇧ hint row is gone; setup teaches it")
        XCTAssertTrue(text.contains("MenuLayout.rows("), "the workspace rows come from MenuLayout")
        for gone in ["optionsItem()", "channelItem()", "updateItem()", "parkedAppsItem()", "\"About BaneySpaces\"", "session.menuItems()", "toolTip = updater"] {
            XCTAssertFalse(text.contains(gone), "\(gone) moved into Settings (Donovan, 2026-10-31)")
        }
        // The Workspace Dock and its switch went on 2026-11-23.
        XCTAssertFalse(text.contains("Turn Off Workspace Dock"))
        XCTAssertFalse(text.contains("toggleDockFromMenu"))
        XCTAssertFalse(text.contains("\"Name This Hour…\""), "the head names the hour")
    }

    /// Donovan, 2026-10-31: the menu keeps the workspace rows, Show All Workspaces, Find or Install
    /// an App, Settings and Quit. Finished agents get a row only while there is something to act on
    /// (review of #100: a tooltip and a Settings tab are not a notice); the update row is always there.
    func testMenuIsFiveKindsOfRowsAndTheUpdateRowWhenNothingIsPending() {
        let rows = MenuLayout.rows(current: 1, apps: [1: ["Ghostty"]])
        let e = MenuLayout.entries(rows: rows, finished: 0, update: .check)
        XCTAssertEqual(e, rows.map(MenuEntry.workspace) + [.separator, .showAll, .find, .separator, .update(.check), .settings, .quit])
    }

    func testFinishedAgentsAddARowOnlyWhileTheyAreThereAndTheUpdateRowSitsAboveSettings() {
        let rows = MenuLayout.rows(current: 1, apps: [:])
        let notice = UpdateNotice(name: "BaneySpaces 0.3.1", installing: false)
        let tail: ([MenuEntry]) -> [MenuEntry] = { Array($0.dropFirst(rows.count)) }
        XCTAssertEqual(tail(MenuLayout.entries(rows: rows, finished: 2, update: .check)),
                       [.separator, .showAll, .find, .separator, .finished(count: 2), .update(.check), .settings, .quit])
        XCTAssertEqual(tail(MenuLayout.entries(rows: rows, finished: 0, update: .notice(notice))),
                       [.separator, .showAll, .find, .separator, .update(.notice(notice)), .settings, .quit])
        XCTAssertEqual(tail(MenuLayout.entries(rows: rows, finished: 1, update: .checking)),
                       [.separator, .showAll, .find, .separator, .finished(count: 1), .update(.checking), .settings, .quit])
    }

    /// The update row's four states: check by hand, a check running, a release on offer, one installing.
    func testTheUpdateRowSaysWhatTheUpdaterKnows() throws {
        let offer = UpdateNotice(name: "BaneySpaces 0.3.1", installing: false)
        let installing = UpdateNotice(name: "BaneySpaces 0.3.1", installing: true)
        XCTAssertEqual(MenuUpdate(notice: nil, checking: false), .check)
        XCTAssertEqual(MenuUpdate(notice: nil, checking: true), .checking)
        XCTAssertEqual(MenuUpdate(notice: offer, checking: true), .notice(offer), "a release on offer wins over a check")
        XCTAssertEqual(MenuUpdate.check.title, "Check for Updates…")
        XCTAssertEqual(MenuUpdate.checking.title, "Checking for Updates…")
        XCTAssertEqual(MenuUpdate.notice(offer).title, "Update to BaneySpaces 0.3.1…")
        XCTAssertEqual(MenuUpdate.notice(installing).title, "Updating to BaneySpaces 0.3.1…")
        XCTAssertEqual([MenuUpdate.check, .checking, .notice(offer), .notice(installing)].map(\.enabled), [true, false, true, false])
        XCTAssertEqual([MenuUpdate.check, .checking, .notice(offer), .notice(installing)].map(\.offersRelease), [false, false, true, false])
        let text = try code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(text.contains("update: MenuUpdate(notice: updateNotice(), checking: updater.checking)"))
        XCTAssertTrue(text.contains("update.offersRelease ? #selector(offerUpdate) : #selector(checkForUpdatesFromMenu)"))
        XCTAssertTrue(text.contains("@objc private func checkForUpdatesFromMenu() { checkForUpdates() }"))
        XCTAssertTrue(try code("Sources/BaneySpaces/Updater.swift").contains("private(set) var checking = false"))
    }

    func testUpdateWordingIsCapitalizedWhereASentenceStarts() {
        let notice = UpdateNotice(name: "Polycarp 0.4.0 (2026-11-25)", installing: false)
        XCTAssertEqual(notice.menuTitle, "Update to Polycarp 0.4.0 (2026-11-25)…")
        XCTAssertEqual(notice.sentence, "Polycarp 0.4.0 (2026-11-25) is available.")
        XCTAssertEqual(UpdateNotice(name: "Polycarp 0.4.0 (2026-11-25)", installing: true).menuTitle, "Updating to Polycarp 0.4.0 (2026-11-25)…")
        XCTAssertEqual(MenuLayout.finishedTitle(1), "1 Agent Finished While You Were Away")
        XCTAssertEqual(MenuLayout.finishedTitle(3), "3 Agents Finished While You Were Away")
    }

    /// The status item's count of finished agents and the way to reach them travel together, so
    /// the number never counts something the menu won't show.
    func testTheCountBesideTheIconComesWithARowForThoseAgents() throws {
        let text = try code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(text.contains("session.unseenCount"))
        XCTAssertTrue(text.contains("finished: session.started ? session.unseenCount : 0"), "the menu row counts the same agents as the badge")
        XCTAssertTrue(text.contains("session.finishedMenuItem(title:"))
        XCTAssertFalse(text.contains("toolTip = updater"), "a tooltip is no notice of an update")
    }

    /// Every item the menu builds: a literal title in `item(`, `NSMenuItem(title:` or `addItem(withTitle:`,
    /// and one `NSMenuItem(` call in the helper that every other item goes through. A row added any
    /// other way fails here, and a new title has to be added to this list on purpose.
    func testNoMenuItemIsBuiltOutsideTheKnownOnes() throws {
        let text = try code("Sources/BaneySpaces/AppDelegate.swift")
        let titlePatterns = [#"item\("([^"]+)""#, #"NSMenuItem\(title: "([^"]+)""#, #"addItem\(withTitle: "([^"]+)""#]
        var titles = Set<String>()
        for pattern in titlePatterns {
            let re = try NSRegularExpression(pattern: pattern)
            for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                titles.insert(String(text[Range(m.range(at: 1), in: text)!]))
            }
        }
        // `item(` also matches "menuItem(for:" and "updateItem(": only quoted titles are captured.
        // The update row takes its title from Core.
        XCTAssertEqual(titles, ["Show All Workspaces", "Find or Install an App…", "Settings…", "Quit Polycarp",
                                "Waiting for AeroSpace to quit", "Polycarp needs permission to arrange windows", "Allow Polycarp…"])
        XCTAssertEqual(text.components(separatedBy: "NSMenuItem(").count - 1, 1, "only the item(_:_:key:) helper builds one")
        XCTAssertEqual(text.components(separatedBy: ".addItem(withTitle:").count - 1, 2, "the not-started notices")
        XCTAssertFalse(text.contains("Dictation"), "no dictation item: Polycarp has no dictation")
        XCTAssertEqual(text.components(separatedBy: "NSMenu()").count - 1, 1, "the status item's own menu, and no submenu of its own")
        // The one other place a menu row is built, the finished-agents submenu, is the session engine's.
        let session = try code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertEqual(session.components(separatedBy: "NSMenuItem(").count - 1, 2, "the finished row and one item for each agent")
    }

    /// Review of #100: Settings' lists were read only on a tab change, a clicked row stayed, the
    /// command line tools were asked once, and Automation worked before BaneySpaces had started.
    func testSettingsListsRefreshAndAutomationWaitsForAccessibility() throws {
        let setup = try code("Sources/BaneySpaces/Setup.swift")
        let app = try code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(setup.contains("if tab == .automation { reloadParked() }\n        }"), "the parked list reads when the tab appears")
        // ...and not on every reload: the bodies of reload() and reloadOptional() never read it.
        for name in ["func reload() {", "private func reloadOptional() {"] {
            let from = try XCTUnwrap(setup.range(of: name))
            let rest = setup[from.upperBound...]
            let body = rest[..<(rest.range(of: "\n    func ")?.lowerBound ?? rest.range(of: "\n    private func ")!.lowerBound)]
            XCTAssertFalse(body.contains("reloadParked()"), "\(name) runs every few ticks")
        }
        XCTAssertTrue(setup.contains("NSWindow.didBecomeKeyNotification, object: window"), "the lists read again when the window takes the keyboard")
        XCTAssertTrue(setup.contains("onFocusFinished?(id)\n        finished = finishedRows()"), "a clicked row leaves the list at once")
        XCTAssertTrue(setup.contains("model.focusFinished(row.id)"))
        XCTAssertEqual(setup.components(separatedBy: ".disabled(model.automationReason != nil)").count - 1, 2, "the app list and Bring Every Window Back wait for BaneySpaces to start")
        for name in ["private func bringBack() {", "private func toggleParked(_ id: String) {"] {
            let start = try XCTUnwrap(app.range(of: name))
            XCTAssertTrue(app[start.upperBound...].prefix(60).contains("guard started else { return }"), "\(name) acts only once started")
        }
    }

    func testEveryActionTheMenuHadIsInSettings() throws {
        let setup = try code("Sources/BaneySpaces/Setup.swift")
        let wired = try code("Sources/BaneySpaces/AppDelegate.swift")
        // Each used to be a menu item; each is now a control in Settings, wired in the app delegate.
        for control in ["⌘Space opens the Polycarp launcher instead of Spotlight",
                        "Keep usable by automation", "Bring Every Window Back", "Uninstall Polycarp…",
                        "Check for updates daily", "Check for Updates Now…",
                        "Button(notice.menuTitle)", "About Polycarp…", "Finished while you were away"] {
            XCTAssertTrue(setup.contains(control), "Settings lacks \"\(control)\"")
        }
        for wire in ["onBringBack", "onAbout", "onToggleParked", "onCheckForUpdates", "onOfferUpdate",
                     "onSetCheckDaily", "onFocusFinished", "onUninstall"] {
            XCTAssertTrue(wired.contains("c.model.\(wire) ="), "\(wire) isn't wired")
        }
    }

    func testTheBadgeAndTheMenuCountOnlyAgentsTheListCanShow() throws {
        let session = try code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("var unseenCount: Int { finishedRows().count }"), "one count for the badge and the menu row")
        XCTAssertTrue(session.contains("engine.attention.unseen.compactMap { engine.item($0) }"), "an unseen agent with no row isn't listed")
    }

    func testTheKeyObserverIsKeptAndRemoved() throws {
        let setup = try code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("observers.append((NotificationCenter.default, NotificationCenter.default.addObserver(\n            forName: NSWindow.didBecomeKeyNotification"))
        XCTAssertTrue(setup.contains("deinit {"))
        XCTAssertTrue(setup.contains("for o in observers { o.center.removeObserver(o.token) }"))
        XCTAssertTrue(setup.contains("if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }"))
    }

    func testTheParkedListReadsOnEventsNotEveryTick() throws {
        let setup = try code("Sources/BaneySpaces/Setup.swift")
        let start = try XCTUnwrap(setup.range(of: "private func reloadOptional()"))
        let end = try XCTUnwrap(setup.range(of: "func reloadParked()"))
        XCTAssertFalse(setup[start.lowerBound..<end.lowerBound].contains("reloadParked()"), "reloadOptional runs every few ticks")
        XCTAssertTrue(setup.contains("NSWorkspace.didLaunchApplicationNotification"))
        XCTAssertTrue(setup.contains("NSWorkspace.didTerminateApplicationNotification"))
        XCTAssertTrue(setup.contains("self.model.tab == .automation"), "only while that tab is up")
    }

    func testSettingsReadsTheListWhenStartedFlipsAndWhileTheTabIsUp() throws {
        let setup = try code("Sources/BaneySpaces/Setup.swift")
        // F4: nothing is live until the gate has read the state.
        XCTAssertTrue(setup.contains("@Published var started = false {"))
        XCTAssertTrue(setup.contains("var isStarted: () -> Bool = { false } {\n        didSet { started = isStarted() }"))
        // F2: the list read empty while waiting; it reads the moment BaneySpaces is up.
        XCTAssertTrue(setup.contains("guard started, !oldValue, tab == .automation, windowVisible() else { return }\n            reloadParked()"))
        // F6: a late first window shows without any notification.
        XCTAssertTrue(setup.contains("let due = reads.tick(ticks, pane: tab.rawValue, visible: windowVisible())\n        if due.slower { reloadOptional() }\n        if due.windows { reloadParked() }"))
        let reads = SettingsWindowReads(ask: { 0 }, land: { _ in })
        XCTAssertTrue(reads.tick(12, pane: "Automation", visible: true).windows)
        XCTAssertFalse(reads.tick(12, pane: "Automation", visible: false).windows, "a closed window isn't scanned for")
        XCTAssertFalse(reads.tick(11, pane: "Automation", visible: true).windows)
        XCTAssertTrue(setup.contains("guard started, !oldValue, tab == .automation, windowVisible() else { return }"))
        XCTAssertTrue(setup.contains("self?.windowVisible() == true { self?.reloadParked() }"))
        XCTAssertTrue(setup.contains("model.windowVisible = { [weak window] in window?.isVisible == true }"))
        let app = try code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("if started { spaces.refresh() }"), "the list is the window list as it is now")
    }
}

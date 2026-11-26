import XCTest
import BaneySpacesCore

/// What the Settings window reads, and when: opening it read everything three times on the main thread, and an open
/// window redrew four times a second for values that hadn't changed. The app target can't be imported, so these read it.
final class SettingsReadsTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func read(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }

    /// The text from `start` up to `end`, both required.
    private func body(_ text: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(text.range(of: start), "no \(start)")
        let b = try XCTUnwrap(text[a.upperBound...].range(of: end), "no \(end) after \(start)")
        return String(text[a.lowerBound..<b.lowerBound])
    }

    func testReadsAFewMillisecondsApartAreOne() {
        XCTAssertTrue(SettingsReads.due(last: nil, now: 10))
        XCTAssertFalse(SettingsReads.due(last: 10, now: 10 + SettingsReads.again - 0.01))
        XCTAssertTrue(SettingsReads.due(last: 10, now: 10 + SettingsReads.again))
    }

    func testOnlyOpeningOnTheAutomationPaneReadsEveryWindow() {
        XCTAssertTrue(SettingsReads.readsWindows(pane: "Automation", opening: true))
        XCTAssertFalse(SettingsReads.readsWindows(pane: "Automation", opening: false), "coming forward scanned every app")
        for pane in ["General", "Keys", "Default apps", "Agents", "Appearance", "Launcher", "Permissions", "Updates"] {
            XCTAssertFalse(SettingsReads.readsWindows(pane: pane, opening: true), pane)
        }
        let reads = SettingsWindowReads(ask: { 0 }, land: { _ in })
        XCTAssertEqual(reads.shown(pane: "Automation", opening: false, now: 100), false)
        XCTAssertEqual(reads.shown(pane: "Automation", opening: true, now: 100.01), true)
    }

    /// The window opens, takes the keyboard, comes forward, ticks for 10 s and the switch is flipped: the login item
    /// is asked for off the main thread every time, and the ticks never ask.
    func testTheMainThreadNeverAsksForTheLoginItem() {
        let lock = NSLock()
        var asks = 0, mainAsks = 0
        let landed = expectation(description: "flip landed")
        let reads = SettingsWindowReads(ask: { () -> Int in
            lock.lock(); defer { lock.unlock() }
            asks += 1
            if Thread.isMainThread { mainAsks += 1 }
            return asks
        }, land: { if $0 == 3 { landed.fulfill() } })
        XCTAssertEqual(reads.shown(pane: "Automation", opening: true, now: 0), true)
        XCTAssertNil(reads.shown(pane: "Automation", opening: false, now: 0.01), "the keyboard a moment later is the same read")
        XCTAssertEqual(reads.shown(pane: "Automation", opening: false, now: 5), false)
        var windows = 0
        for n in 1...40 { if reads.tick(n, pane: "Automation", visible: true).windows { windows += 1 } }
        XCTAssertEqual(windows, 3)
        reads.refreshLogin()
        wait(for: [landed], timeout: 5)
        lock.lock(); defer { lock.unlock() }
        XCTAssertEqual(asks, 3)
        XCTAssertEqual(mainAsks, 0)
    }

    /// Two reads in flight (the window came forward, then the switch was flipped): the older one finishing last
    /// must not put the old value back.
    func testOnlyTheNewestLoginReadLands() {
        let hold = DispatchSemaphore(value: 0), lock = NSLock()
        var calls = 0, landed: [String] = []
        let newest = expectation(description: "newest landed")
        let reads = SettingsWindowReads(ask: { () -> String in
            lock.lock(); calls += 1; let first = calls == 1; lock.unlock()
            if first { _ = hold.wait(timeout: .now() + 2); return "off" }
            return "on"
        }, land: { landed.append($0); if $0 == "on" { newest.fulfill() } })
        reads.refreshLogin()
        reads.refreshLogin()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { hold.signal() }
        wait(for: [newest], timeout: 5)
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        XCTAssertEqual(landed, ["on"], "the older read landed after the newer one")
    }

    func testASlowReadIsTraced() {
        XCTAssertNil(SettingsReads.slowLine(seconds: 0.049, pane: "General", windows: false))
        XCTAssertEqual(SettingsReads.slowLine(seconds: 0.12, pane: "General", windows: false), "slow settings read: 120 ms on main, General pane")
        XCTAssertEqual(SettingsReads.slowLine(seconds: 0.3, pane: "Automation", windows: true),
                       "slow settings read: 300 ms on main, Automation pane, every window read")
    }

    func testOpeningTheWindowReadsOnce() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let show = try body(setup, from: "    func show() {", to: "\n    }\n")
        XCTAssertTrue(show.contains("model.readShown(opening: true)"))
        XCTAssertFalse(show.contains("model.reload()"), "show reads through readShown")
        XCTAssertFalse(show.contains("model.reloadParked()"), "show refreshed every window on any pane")
        let key = try body(setup, from: "NSWindow.didBecomeKeyNotification", to: "}))")
        XCTAssertTrue(key.contains("self?.model.readShown()"))
        XCTAssertFalse(key.contains("reload"), "the window taking the keyboard read everything again")
        let active = try body(setup, from: "NSApplication.didBecomeActiveNotification", to: "\n        }\n")
        XCTAssertTrue(active.contains("self?.model.readShown()"))
        XCTAssertFalse(active.contains("model.reload()"), "the app coming forward read everything again")
    }

    func testTheOpenWindowsReadsSetOnlyWhatChanged() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let reads = try body(setup, from: "func tick() {", to: "    func toggleParked(")
        let bare = try NSRegularExpression(pattern: #"(?m)^\s+(?:if [^{]*\{\s*)?(\w+) = (?!self\[)"#)
        let names = bare.matches(in: reads, range: NSRange(reads.startIndex..., in: reads)).compactMap {
            Range($0.range(at: 1), in: reads).map { String(reads[$0]) }
        }
        XCTAssertEqual(names, [], "a published value set without put(_:_:) redraws the pane even when it didn't change")
        XCTAssertTrue(reads.contains("if self[keyPath: key] != value { self[keyPath: key] = value }"))
    }

    /// The seam is the only way to the login item: a wrapper around the system call, or around `askLogin`, is one more.
    func testTheLoginItemIsAskedForOnlyThroughTheSeam() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let code = setup.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        XCTAssertEqual(code.filter { $0.contains("SMAppService.mainApp.status") }.map { $0.trimmingCharacters(in: .whitespaces) },
                       ["private static func askLogin() -> SMAppService.Status { SMAppService.mainApp.status }"])
        // The first model, `finish` (once, when setup ends), and the seam.
        XCTAssertEqual(code.filter { $0.contains("askLogin") }.count, 4)
        XCTAssertTrue(setup.contains("private static let firstLoginStatus = askLogin()"))
        XCTAssertTrue(setup.contains("SettingsWindowReads(ask: SetupModel.askLogin)"))
        XCTAssertTrue(setup.contains("SetupModel.askLogin() == .notRegistered"))
    }

    func testTheThemeShelfRedrawsOnlyWhenItsThemesChanged() throws {
        let model = try read("Sources/BaneySpaces/Appearance/ThemeEditorModel.swift")
        let reload = try body(model, from: "    func reload() {", to: "    /// Customize:")
        XCTAssertTrue(reload.contains("if let self, tiles != self.tiles { self.tiles = tiles }"))
    }
}

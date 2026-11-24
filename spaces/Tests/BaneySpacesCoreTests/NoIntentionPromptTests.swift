import XCTest
@testable import BaneySpacesCore

/// Donovan, 2026-11-22: "remove the weird popups where it asks what I'm working on, that is not to be a part of this."
/// Workspace purposes, the day's single focus, the morning card, the evening review, the wake alarm that opened it,
/// the focus timer, the menu's "now" head and the menu bar ask were removed. These fail if any of them comes back:
/// at launch, in the status menu, the bar, the dock, the new tab page, surfaces.json or the socket.
final class NoIntentionPromptTests: XCTestCase {
    /// Names of the removed pieces, split so a search of the repo for them finds only their removal.
    private let gone = ["Purpose" + "Keeper", "Rhythm" + "Sheet", "Wake" + "Alarm", "Menu" + "Head", "Purpose" + "Store",
                        "Purpose" + "API", "Day" + "Ledger", "Exa" + "men", "exa" + "men", "One" + "Thing", "one" + "Thing",
                        "MenuN" + "ow", "MenuT" + "imer", "menuBar" + "Ask", "hideSystem" + "MenuBar", "purpose" + "Handler",
                        "What is this " + "hour for", "What is this " + "day for", "Name This " + "Hour", "morning " + "question"]

    private func swiftFiles(under folder: String) throws -> [(path: String, code: String)] {
        let root = Repo.root.appendingPathComponent(folder)
        let walk = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var out: [(String, String)] = []
        for case let url as URL in walk where url.pathExtension == "swift" {
            let rel = String(url.path.dropFirst(Repo.root.path.count + 1))
            out.append((rel, try Repo.code(rel)))
        }
        return out
    }

    func testNoSourceFileHoldsAPromptForWhatYouAreDoing() throws {
        let files = try swiftFiles(under: "Sources")
        XCTAssertGreaterThan(files.count, 50, "the walk found the sources")
        for file in files {
            for name in gone { XCTAssertFalse(file.code.contains(name), "\(file.path) has \(name)") }
        }
        let purposeFolder = Repo.root.appendingPathComponent("Sources/BaneySpacesCore/Purpose").path
        XCTAssertFalse(FileManager.default.fileExists(atPath: purposeFolder), "the purpose core is gone")
    }

    /// Launch starts no card, alarm or ask: the app delegate's launch never names one.
    func testLaunchSchedulesNoAsk() throws {
        let app = try Repo.code("Sources/BaneySpaces/AppDelegate.swift")
        for name in gone { XCTAssertFalse(app.contains(name), "AppDelegate has \(name)") }
        XCTAssertFalse(app.contains("accessoryView"), "no alert carries a field that asks for text")
        XCTAssertFalse(app.contains("NSTextField("), "no field to type an answer into")
    }

    /// The status menu opens on the workspaces: no head that asks, no rows for a focus, a timer or an evening review.
    func testTheMenuOpensOnTheWorkspaces() {
        let rows = MenuLayout.rows(current: 2, apps: [2: ["Pages"]])
        let entries = MenuLayout.entries(rows: rows, finished: 0, update: .check)
        XCTAssertEqual(entries.first, .workspace(rows[0]))
        XCTAssertEqual(entries.filter { if case .workspace = $0 { false } else { true } },
                       [.separator, .showAll, .find, .separator, .update(.check), .settings, .quit])
    }

    /// surfaces.json has no alarm and nothing the bar could ask with; the socket has no purpose request.
    func testNoSettingOrRequestCarriesThem() {
        XCTAssertFalse(SurfaceField.all.contains { $0.path.hasPrefix("alarm") || $0.path.hasPrefix("rhythm") })
        XCTAssertNil(Surfaces.BarModule(id: "purpose"))
        XCTAssertNil(Surfaces.BarModule(id: "one-" + "thing"))
        XCTAssertNil(Wire.Request.Op(rawValue: "purpose"))
        XCTAssertFalse(Surfaces.defaults.newtab.question.hasSuffix("?"), "the new tab's field asks nothing")
    }

    /// The command line has no purpose, focus, day or timer command.
    func testTheCommandLineHasNoneOfThem() throws {
        let cli = try Repo.code("Sources/baneyspaces-cli/main.swift")
        for command in ["case \"purpose\"", "case \"timer\"", "\"one\", \"day\""] {
            XCTAssertFalse(cli.contains(command), "polycarp-spaces still has \(command)")
        }
    }
}

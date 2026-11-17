import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// `polycarp-spaces layout save|restore`: the plan that puts windows back, with a fake pair of displays.
final class NamedLayoutsTests: XCTestCase {
    let laptop = DisplayArea(key: "laptop", frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                             visible: CGRect(x: 0, y: 33, width: 1512, height: 949))
    let studio = DisplayArea(key: "studio", frame: CGRect(x: 1512, y: -300, width: 2560, height: 1440),
                             visible: CGRect(x: 1512, y: -267, width: 2560, height: 1407))

    private func rec(_ bundle: String, _ title: String, order: Int, workspace: Int, frame: CGRect) -> WindowRecord {
        WindowRecord(bundle: bundle, title: title, order: order, workspace: workspace, frame: frame,
                     displays: [laptop, studio], window: WindowID(100 + order), pid: 9, at: 0)
    }

    private var twoDisplays: NamedLayout {
        NamedLayout(savedAt: 0, current: 2, displays: ["laptop": 2, "studio": 4], windows: [
            rec("com.apple.TextEdit", "notes.txt", order: 0, workspace: 2, frame: CGRect(x: 40, y: 60, width: 700, height: 500)),
            rec("com.apple.TextEdit", "plan.txt", order: 1, workspace: 4, frame: CGRect(x: 2000, y: 0, width: 1200, height: 800)),
            rec("com.mitchellh.ghostty", "~", order: 0, workspace: 4, frame: CGRect(x: 1600, y: 600, width: 900, height: 500)),
        ])
    }

    /// Every window the layout knows goes back to its workspace and its exact frame on its display.
    func testRestoringPutsEachWindowBackOnItsWorkspaceAndFrameOnBothDisplays() {
        let live = [LiveWindow(id: 7, bundle: "com.apple.TextEdit", title: "plan.txt", order: 0),
                    LiveWindow(id: 8, bundle: "com.apple.TextEdit", title: "notes.txt", order: 1),
                    LiveWindow(id: 9, bundle: "com.mitchellh.ghostty", title: "~", order: 0)]
        let (placements, missing) = twoDisplays.plan(live, displays: [laptop, studio])
        let by = Dictionary(uniqueKeysWithValues: placements.map { ($0.window, $0) })
        XCTAssertEqual(missing, 0)
        XCTAssertEqual(by[8]?.workspace, 2)
        XCTAssertEqual(by[8]?.frame, CGRect(x: 40, y: 60, width: 700, height: 500), "by title, though it is now second")
        XCTAssertEqual(by[7]?.workspace, 4)
        XCTAssertEqual(by[7]?.frame, CGRect(x: 2000, y: 0, width: 1200, height: 800))
        XCTAssertEqual(by[9]?.frame, CGRect(x: 1600, y: 600, width: 900, height: 500))
    }

    func testAWindowThatIsGoneCountsAsMissingAndOthersAreLeftAlone() {
        let live = [LiveWindow(id: 8, bundle: "com.apple.TextEdit", title: "notes.txt", order: 0),
                    LiveWindow(id: 50, bundle: "com.apple.Preview", title: "a.pdf", order: 0)]
        let (placements, missing) = twoDisplays.plan(live, displays: [laptop, studio])
        XCTAssertEqual(placements.map(\.window), [8], "Preview isn't in the layout, so it stays where it is")
        XCTAssertEqual(missing, 2, "plan.txt and the Ghostty window are not open")
    }

    /// Saved on two displays, restored on the laptop alone: the studio's windows land inside the laptop.
    func testWindowsOfADisplayThatIsNotHereLandInsideOneThatIs() {
        let live = [LiveWindow(id: 7, bundle: "com.apple.TextEdit", title: "plan.txt", order: 1),
                    LiveWindow(id: 9, bundle: "com.mitchellh.ghostty", title: "~", order: 0)]
        let (placements, _) = twoDisplays.plan(live, displays: [laptop])
        for p in placements {
            XCTAssertTrue(laptop.visible.contains(try XCTUnwrap(p.frame)), "window \(p.window) at \(String(describing: p.frame))")
        }
    }

    func testNames() {
        for ok in ["work", "Two Displays", "desk_2", "a.b-c"] { XCTAssertTrue(NamedLayouts.isValid(ok), ok) }
        for bad in ["", ".hidden", " lead", "a/b", "x;rm", String(repeating: "a", count: 65), "new\nline"] {
            XCTAssertFalse(NamedLayouts.isValid(bad), bad)
        }
    }

    func testLayoutsRoundTripThroughTheirFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("named-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        var all = NamedLayouts()
        all.layouts["desk"] = twoDisplays
        var one = twoDisplays
        one.only = 9
        all.layouts["agent"] = one
        all.save(to: url)
        XCTAssertEqual(NamedLayouts.load(from: url), all)
        XCTAssertEqual(NamedLayouts.load(from: url.appendingPathExtension("missing")), NamedLayouts())
    }

    /// An agent session (`BANEYSPACES_SESSION`) may list, save and delete its own layouts, never restore one, and never
    /// delete or replace one it didn't save. A request with no session is Donovan's and may do all of it.
    func testAnAgentSessionNeverRestoresAndTouchesOnlyItsOwnLayouts() {
        var mine = twoDisplays
        mine.savedBy = "agent-7"
        let donovans = twoDisplays
        XCTAssertEqual(LayoutAccess.session(in: ["--workspace", "3", "--session", "agent-7"]), "agent-7")
        XCTAssertNil(LayoutAccess.session(in: ["--workspace", "3"]))
        XCTAssertNil(LayoutAccess.session(in: ["--session", ""]))
        for verb in ["list", "save", "restore", "delete"] {
            XCTAssertNil(LayoutAccess.refusal(verb: verb, session: nil, existing: donovans), "Donovan may \(verb)")
        }
        for existing in [mine, donovans, nil] as [NamedLayout?] {
            XCTAssertEqual(LayoutAccess.refusal(verb: "restore", session: "agent-7", existing: existing),
                           "Agents may change what you see is off: layout restore is Donovan's")
        }
        XCTAssertNil(LayoutAccess.refusal(verb: "list", session: "agent-7", existing: nil))
        XCTAssertNil(LayoutAccess.refusal(verb: "save", session: "agent-7", existing: nil), "a new name")
        XCTAssertNil(LayoutAccess.refusal(verb: "save", session: "agent-7", existing: mine), "its own, replaced")
        XCTAssertNil(LayoutAccess.refusal(verb: "delete", session: "agent-7", existing: mine))
        XCTAssertNotNil(LayoutAccess.refusal(verb: "save", session: "agent-7", existing: donovans))
        XCTAssertNotNil(LayoutAccess.refusal(verb: "delete", session: "agent-7", existing: donovans))
        XCTAssertNotNil(LayoutAccess.refusal(verb: "delete", session: "agent-8", existing: mine), "another session's")
    }

    /// second-F5 for layouts: after a save, `named-layouts.json` holds no window title, only keyed hashes, and is 0600.
    func testTheLayoutsFileHoldsNoTitleTextAndOnlyYouCanReadIt() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("layouts-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let key = TitleHash.key(at: folder.appendingPathComponent("title.key"))
        let secret = "Private Browsing - Statement for Account 4471"
        let r = WindowRecord(bundle: "com.example.browser", title: secret, order: 0, workspace: 2,
                             frame: CGRect(x: 40, y: 60, width: 700, height: 500), displays: [laptop], window: 1, pid: 1, at: 1, key: key)
        let url = folder.appendingPathComponent("named-layouts.json")
        NamedLayouts(layouts: ["desk": NamedLayout(savedAt: 1, current: 2, displays: ["laptop": 2], windows: [r])]).save(to: url)
        let text = try String(contentsOf: url, encoding: .utf8).lowercased()
        for word in ["private", "browsing", "statement", "account", "4471"] { XCTAssertFalse(text.contains(word), word) }
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        let back = try XCTUnwrap(NamedLayouts.load(from: url).layouts["desk"])
        let live = [LiveWindow(id: 5, bundle: "com.example.browser", title: secret, order: 3, key: key)]
        XCTAssertEqual(back.plan(live, displays: [laptop]).placements.map(\.rule), [.title], "still restored by its title")
    }

    /// Planning is a small part of the 300 ms a restore may take: 200 windows over two displays under 30 ms.
    func testPlanningTwoHundredWindowsIsFast() {
        var records: [WindowRecord] = [], live: [LiveWindow] = []
        for i in 0..<200 {
            let x = CGFloat(i % 2 == 0 ? 50 : 1600), title = "doc \(i)"
            records.append(rec("app\(i % 10)", title, order: i / 10, workspace: i % 9 + 1, frame: CGRect(x: x, y: 100, width: 600, height: 400)))
            live.append(LiveWindow(id: WindowID(1000 + i), bundle: "app\(i % 10)", title: title, order: 19 - i / 10))
        }
        let layout = NamedLayout(savedAt: 0, current: 1, displays: [:], windows: records)
        let start = ProcessInfo.processInfo.systemUptime
        let (placements, missing) = layout.plan(live, displays: [laptop, studio])
        let ms = (ProcessInfo.processInfo.systemUptime - start) * 1000
        XCTAssertEqual(placements.count, 200)
        XCTAssertEqual(missing, 0)
        XCTAssertLessThan(ms, 30, "planning took \(ms) ms")
    }
}

@testable import BaneySpacesCore
import XCTest

/// `[[rules]]` in `spaces.toml` (W2): a rule places an app's new window, first match wins, and a window it placed that
/// you then moved is never taken again.
final class AppRulesTests: XCTestCase {
    func load(_ s: String) throws -> (rules: [AppRule], problems: [KeymapProblem]) { AppRules.load(try MiniTOML.parse(s), reserved: [9]) }

    func testARulePlacesANewWindow() throws {
        let (rules, problems) = try load("""
        [[rules]]
        app = "Mail"
        workspace = 3
        layout = "right-half"
        [[rules]]
        app = "com.mitchellh.ghostty"
        title = "^scratch"
        layout = "center-third"
        [[rules]]
        app = "Ghostty"
        float = true
        """)
        XCTAssertEqual(problems, [])
        var book = RuleBook(rules: rules)
        XCTAssertEqual(book.decide(NewWindow(id: 1, name: "mail", bundle: "com.apple.mail", title: "", workspace: 1)),
                       .init(workspace: 3, layout: .rightHalf, rule: 2), "by name, any case")
        XCTAssertEqual(book.decide(NewWindow(id: 2, name: "Ghostty", bundle: "com.mitchellh.ghostty", title: "scratch 1", workspace: 1)),
                       .init(workspace: nil, layout: .centerThird, rule: 6), "by bundle id and title")
        XCTAssertNil(book.decide(NewWindow(id: 3, name: "Ghostty", bundle: "com.mitchellh.ghostty", title: "zsh", workspace: 1)),
                     "the floating rule matches and does nothing")
        XCTAssertNil(book.decide(NewWindow(id: 4, name: "Safari", bundle: "com.apple.Safari", title: "x", workspace: 1)))
        XCTAssertEqual(book.decide(NewWindow(id: 5, name: "Mail", bundle: nil, title: "", workspace: 3)),
                       .init(workspace: nil, layout: .rightHalf, rule: 2), "already on its workspace: only the layout")
    }

    func testAMovedWindowIsLeftAlone() throws {
        var model = Workspaces()
        var book = RuleBook(rules: try load("[[rules]]\napp = \"Mail\"\nworkspace = 3\n").rules)
        func look() {
            for id in model.sync(seen: [7], alive: [7]) {
                let w = NewWindow(id: id, name: "Mail", bundle: nil, title: "Inbox", workspace: model.workspace(of: id)!)
                if let n = book.decide(w)?.workspace { model.assign(id, to: n, focus: false) }
            }
        }
        look()
        XCTAssertEqual(model.workspace(of: 7), 3, "the rule placed it")
        model.assign(7, to: 5, focus: false) // you move it
        look()
        XCTAssertEqual(model.workspace(of: 7), 5)
        XCTAssertNil(book.decide(NewWindow(id: 7, name: "Mail", bundle: nil, title: "Inbox", workspace: 5)),
                     "even shown again as new (a scan that missed it), a window the rules decided once stays yours")
        book.keep(only: [])
        XCTAssertEqual(book.decide(NewWindow(id: 7, name: "Mail", bundle: nil, title: "", workspace: 1))?.workspace, 3,
                       "a closed window's number used again is a new window")
    }

    func testABrokenRuleGivesNoRulesAndSaysWhere() throws {
        let cases: [(String, String)] = [
            ("[[rules]]\nworkspace = 2\n", "rules[1].app"),
            ("[[rules]]\napp = \"Mail\"\nworkspace = 12\n", "line 3: rules[1].workspace: 12 is not a workspace from 1 to 9"),
            ("[[rules]]\napp = \"Mail\"\nworkspace = 9\n", "agent workspace"),
            ("[[rules]]\napp = \"Mail\"\nlayout = \"left\"\n", "\"left\" is not a layout"),
            ("[[rules]]\napp = \"Mail\"\nlayout = \"left-half\"\nfloat = true\n", "takes no layout"),
            ("[[rules]]\napp = \"Mail\"\ntitle = \"(\"\n", "not a regular expression"),
            ("[[rules]]\napp = \"Mail\"\nworksapce = 2\n", "worksapce: unknown key"),
            ("[[rules]]\napp = \"Mail\"\n", "does nothing"),
            ("rules = \"Mail\"\n", "write [[rules]]"),
        ]
        for (text, want) in cases {
            let (rules, problems) = try load(text)
            XCTAssertEqual(rules, [], text)
            XCTAssertTrue(problems.map(\.description).joined(separator: " | ").contains(want), "\(text): \(problems)")
        }
    }

    /// A bad rule is a bad file: the keys and rules in force stay, and the recovery chord turns the rules off.
    func testABrokenRuleKeepsTheLastGoodFileAndRecoveryClearsTheRules() {
        var s = KeymapState(settingsMod: [.cmd])
        let good = "[keys.bindings]\n\"ctrl+alt+1\" = \"switch 3\"\n[[rules]]\napp = \"Mail\"\nworkspace = 3\n"
        XCTAssertEqual(s.fileChanged(good, reserved: [9]), "Keys and 1 app rule reloaded from spaces.toml")
        XCTAssertEqual(s.rules.map(\.app), ["Mail"])
        let notice = s.fileChanged(good.replacingOccurrences(of: "workspace = 3", with: "workspace = 9"), reserved: [9])
        XCTAssertTrue(notice?.contains("line 5: rules[1].workspace") ?? false, notice ?? "nil")
        XCTAssertEqual(s.rules.map(\.app), ["Mail"], "the last good rules stay")
        XCTAssertEqual(s.keymap.action(for: Chord([.ctrl, .alt], "1")), .switchTo(3), "and the last good keys")
        XCTAssertTrue(s.recover().hasPrefix("Default keys restored and app rules off."))
        XCTAssertEqual(s.rules, [])
    }
}

import BaneySpacesCore
import Foundation
import XCTest

/// `Keymap.all` is the one list of Polycarp's shortcuts. These fail when the code takes a key with no row, a row
/// outlives its key, the CLI stops printing the table, or docs/keys.md says something else.
final class KeymapTests: XCTestCase {
    // MARK: Every key the code takes has a row

    /// Each `register(keyCode:modifiers:)` (Hotkeys) and `add(keyCode:modifiers:)` (ScopedHotkeys) call under
    /// Sources/BaneySpaces, as "<key code> <modifiers>" written in the source, and the row it is.
    static let registered: [String: String] = [
        "kVK_Space cmdKey": "launcher.cmdSpace",
        "kVK_ANSI_K controlKey | cmdKey": "launcher.open",
        "kVK_ANSI_U controlKey | cmdKey": "agents.finished",
        // The loop over Hotkeys.digitKeyCodes.
        "code mods": "workspace.switch",
        "code mods | shiftKey": "window.move",
        "kVK_ANSI_Grave controlKey": "terminal.quick",
        "kVK_ANSI_U cmdShift": "agents.finished.terminal",
    ]

    /// Each command the launcher's search field handles in `control(_:textView:doCommandBy:)`, and its row.
    static let launcherCommands: [String: String] = [
        "moveDown": "launcher.down",
        "moveUp": "launcher.up",
        "insertNewline": "launcher.run",
        "insertTab": "launcher.tab",
        "cancelOperation": "launcher.escape",
        "deleteBackward": "launcher.back",
    ]

    /// Each `e.key` the new tab page acts on, and its row.
    static let newTabKeys: [String: String] = [
        "Enter": "newtab.go", "ArrowDown": "newtab.down", "n": "newtab.down.ctrl", "ArrowUp": "newtab.up", "p": "newtab.up.ctrl",
        "Tab": "newtab.tab", "Escape": "newtab.clear",
    ]

    /// Each key the overview's key monitor (Viewer.swift) reads, by key code, and its row. Its 1 to 9 is read as
    /// characters and has its own check.
    static let overviewKeyCodes: [String: String] = [
        "53": "overview.close", "36": "overview.go",
        "123": "overview.move", "124": "overview.move", "125": "overview.move", "126": "overview.move",
    ]

    /// Each key equivalent the status menu's items carry (`item(_:_:key:)` in AppDelegate.swift), and its row.
    static let menuKeys: [String: String] = [#"\(row.workspace)"#: "menu.workspace", ",": "menu.settings", "q": "menu.quit"]

    /// What the player does for each key it acts on (`PlayerKeys.command`), as "<modifiers>+<key>", and its row.
    static let playerKeys: [String: String] = [
        "space": "player.play", "left": "player.seek", "right": "player.seek",
        "shift+left": "player.longSeek", "shift+right": "player.longSeek",
        "up": "player.volume", "down": "player.volume",
        "cmd+left": "player.step", "cmd+right": "player.step",
        "f": "player.fill", "cmd+i": "player.info", "escape": "player.close", "cmd+w": "player.closeCmd",
    ]

    /// Rows that come from no call the scans read: the ⌘Tab, switcher and Mission Control keys go through the event tap
    /// in MissionControlKeys.swift (`testTheEventTapStillTakesTheKeysItsRowsSay`), ⌘Return is a flag read inside the
    /// Return branch, and the overview's 1 to 9 is read as characters.
    static let unscanned: Set<String> = [
        "launcher.reveal", "workspace.overview", "workspace.overview.controlUp", "switcher.next", "switcher.back",
        "switcher.arrows", "switcher.cancel", "overview.pick",
    ]

    /// kVK_ constants in Launcher.swift and the row each is, or nil when it is not a shortcut: ⌘Q is posted to quit an
    /// app, never read.
    static let launcherKeyCodes: [String: String?] = ["kVK_ANSI_Q": nil]

    /// Files that call RegisterEventHotKey themselves; anything else registering a key would skip the scan.
    static let hotkeyFiles: Set<String> = ["Hotkeys.swift", "ScopedHotkeys.swift"]

    static func appSources() throws -> [(name: String, code: String)] {
        let dir = SourceText.root.appendingPathComponent("Sources/BaneySpaces")
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        return try files.map { url in
            (url.lastPathComponent, try SourceText.code(String(url.path.dropFirst(SourceText.root.path.count + 1))))
        }.sorted { $0.name < $1.name }
    }

    static func matches(_ pattern: String, in text: String) -> [[String]] {
        let re = try! NSRegularExpression(pattern: pattern)
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { m in
            (1..<m.numberOfRanges).map { i in Range(m.range(at: i), in: text).map { String(text[$0]) } ?? "" }
        }
    }

    /// Every registration in the app's code, as `registered` writes them.
    static func registrations() throws -> [String] {
        try appSources().flatMap { file in
            matches(#"(?:register|add)\(keyCode:\s*(kVK_\w+|code),\s*modifiers:\s*([^)]+?)\)"#, in: file.code)
                .map { "\($0[0]) \($0[1].split(whereSeparator: \.isWhitespace).joined(separator: " "))" }
        }
    }

    func testEveryRegisteredShortcutHasARow() throws {
        let found = try Self.registrations()
        XCTAssertGreaterThanOrEqual(found.count, 7, "the scan found too few registrations: \(found)")
        for sig in found {
            guard let id = Self.registered[sig] else {
                XCTFail("a shortcut is registered with no Keymap row: \(sig). Add a row to Keymap.all and map it in KeymapTests.registered")
                continue
            }
            XCTAssertNotNil(Keymap.binding(id), "\(sig) maps to \(id), which Keymap.all lacks")
        }
        for (sig, id) in Self.registered where !found.contains(sig) {
            XCTFail("Keymap row \(id) stands for \(sig), which the code no longer registers")
        }
    }

    func testOnlyTheTwoHotkeyFilesRegisterKeysThemselves() throws {
        for file in try Self.appSources() where file.code.contains("RegisterEventHotKey(") {
            XCTAssertTrue(Self.hotkeyFiles.contains(file.name), "\(file.name) registers a key outside Hotkeys and ScopedHotkeys")
        }
    }

    func testEveryKeyTheLauncherHandlesHasARow() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        let handler = try XCTUnwrap(SourceText.block(after: "doCommandBy sel: Selector", in: code))
        let commands = Self.matches(#"#selector\(NSResponder\.(\w+)\(_:\)\)"#, in: handler).map { $0[0] }
        XCTAssertFalse(commands.isEmpty, "the launcher's key handler moved; point this test at it")
        for c in commands {
            guard let id = Self.launcherCommands[c] else {
                XCTFail("the launcher handles \(c) with no Keymap row. Add a row and map it in KeymapTests.launcherCommands")
                continue
            }
            XCTAssertNotNil(Keymap.binding(id), "\(c) maps to \(id), which Keymap.all lacks")
        }
        for (c, id) in Self.launcherCommands where !commands.contains(c) {
            XCTFail("Keymap row \(id) stands for the launcher's \(c), which it no longer handles")
        }
        // ⌘Return: the Return branch reads ⌘.
        XCTAssertTrue(handler.contains("runSelected(reveal: NSEvent.modifierFlags.contains(.command))"), "⌘Return changed; fix launcher.reveal")
        for k in Self.matches(#"(kVK_\w+)"#, in: code).map({ $0[0] }) {
            guard let row = Self.launcherKeyCodes[k] else {
                XCTFail("Launcher.swift reads \(k): give it a Keymap row and map it in KeymapTests.launcherKeyCodes, or map it to nil")
                continue
            }
            if let id = row { XCTAssertNotNil(Keymap.binding(id), "\(k) maps to \(id), which Keymap.all lacks") }
        }
    }

    func testEveryKeyTheNewTabPageHandlesHasARow() throws {
        let dir = SourceText.root.appendingPathComponent("extension/newtab")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).filter { $0.pathExtension == "js" }
        var keys: [String] = []
        for f in files {
            let js = try String(contentsOf: f, encoding: .utf8)
            keys += Self.matches(#"\.key\s*[!=]==?\s*"([^"]+)""#, in: js).map { $0[0] }
        }
        XCTAssertFalse(keys.isEmpty, "the new tab page's Enter handler moved; point this test at it")
        for k in keys {
            guard let id = Self.newTabKeys[k] else { XCTFail("the new tab page handles \(k) with no Keymap row"); continue }
            XCTAssertNotNil(Keymap.binding(id))
        }
    }

    func testEveryKeyTheOverviewHandlesHasARow() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Viewer.swift")
        let monitor = try XCTUnwrap(SourceText.block(after: "keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown)", in: code),
                                    "the overview's key monitor moved; point this test at it")
        let codes = Self.matches(#"keyCode == (\d+)"#, in: monitor).map { $0[0] }
            + Self.matches(#"(\d+): \.(?:left|right|up|down)"#, in: monitor).map { $0[0] }
        XCTAssertEqual(Set(codes).count, 6, "the overview's keys changed: \(codes)")
        for c in codes {
            guard let id = Self.overviewKeyCodes[c] else { XCTFail("the overview reads key code \(c) with no Keymap row"); continue }
            XCTAssertNotNil(Keymap.binding(id))
        }
        for c in Self.overviewKeyCodes.keys where !codes.contains(c) { XCTFail("the overview no longer reads key code \(c)") }
        XCTAssertTrue(monitor.contains("let n = Int(c), Workspaces.range.contains(n)"), "the overview's 1 to 9 changed; fix overview.pick")
        XCTAssertEqual(monitor.components(separatedBy: "return nil").count - 1, 4, "the overview takes a key this test doesn't know")
    }

    func testEveryKeyTheStatusMenuShowsHasARow() throws {
        let code = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let keys = Self.matches(#"item\([^\n]*?key: "((?:[^"\\]|\\.)*)"\)"#, in: code).map { $0[0] }
        XCTAssertFalse(keys.isEmpty, "the status menu's items moved; point this test at them")
        for k in keys {
            guard let id = Self.menuKeys[k] else { XCTFail("a status menu item shows key \(k) with no Keymap row"); continue }
            XCTAssertNotNil(Keymap.binding(id))
        }
        for k in Self.menuKeys.keys where !keys.contains(k) { XCTFail("the status menu no longer shows key \(k)") }
        // The workspace rows carry the modifier, as menu.workspace's "mod" says.
        XCTAssertTrue(code.contains("it.keyEquivalentModifierMask = Modifier.current.menuFlags"))
    }

    /// The menu's "Find or Install an App" shows the launcher key that works: ⌘Space only when it is registered.
    func testTheMenuShowsTheLauncherKeyThatIsRegistered() throws {
        let code = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        // The menu reads what the registration returned, so a Spotlight change after launch never shows a dead key.
        XCTAssertTrue(code.contains("cmdSpaceHeld = hotkeys.register(keyCode: kVK_Space"), "the ⌘Space registration records whether it took")
        XCTAssertTrue(code.contains("hotkeys.removeAll()\n        cmdSpaceHeld = false"), "re-registering starts from not held")
        let find = try XCTUnwrap(Self.matches(#"if (.+?) \{ find\.keyEquivalent = " "; find\.keyEquivalentModifierMask = \[\.command\] \}(.*)"#, in: code).first)
        XCTAssertEqual(find[0], "cmdSpaceHeld", "the menu shows ⌘Space only when Polycarp holds it")
        XCTAssertTrue(find[1].contains(#"else { find.keyEquivalent = "k"; find.keyEquivalentModifierMask = [.control, .command] }"#),
                      "without ⌘Space the menu shows ⌃⌘K")
    }

    func testEveryKeyThePlayerActsOnHasARow() {
        let keys: [(String, PlayerKey)] = [("space", .space), ("left", .left), ("right", .right), ("up", .up), ("down", .down), ("escape", .escape)]
            + "abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./ ".map { (String($0), PlayerKey.character($0)) }
        let mods: [(String, PlayerModifiers)] = [("cmd", .command), ("shift", .shift), ("opt", .option), ("ctrl", .control)]
        var found: Set<String> = []
        for kind in MediaKind.allCases {
            for (name, key) in keys {
                for bits in 0..<16 {
                    let held = mods.enumerated().filter { bits & (1 << $0.offset) != 0 }.map(\.element)
                    let set = held.reduce(into: PlayerModifiers()) { $0.insert($1.1) }
                    guard let c = PlayerKeys.command(key, set, kind: kind) else { continue }
                    // ⇧ that changes nothing isn't a shortcut of its own.
                    if set.contains(.shift), PlayerKeys.command(key, set.subtracting(.shift), kind: kind) == c { continue }
                    let sig = (held.map(\.0) + [name]).joined(separator: "+")
                    found.insert(sig)
                    guard let id = Self.playerKeys[sig] else { XCTFail("the player acts on \(sig) with no Keymap row"); continue }
                    XCTAssertNotNil(Keymap.binding(id))
                }
            }
        }
        for sig in Self.playerKeys.keys where !found.contains(sig) { XCTFail("the player no longer acts on \(sig)") }
    }

    func testThePlayerTurnsEveryKeyIntoAPlayerKey() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Player.swift")
        XCTAssertTrue(code.contains("guard let c = PlayerKeys.command(key, mods, kind: kind) else { return false }"),
                      "the player decides its keys somewhere other than PlayerKeys; point testEveryKeyThePlayerActsOnHasARow at it")
    }

    func testTheEventTapStillTakesTheKeysItsRowsSay() throws {
        let tap = try SourceText.code("Sources/BaneySpaces/MissionControlKeys.swift")
        // While the switcher is up: Esc closes it and the arrows step; every other key is swallowed.
        XCTAssertEqual(Self.matches(#"if inGesture, code == (\w+)"#, in: tap).map { $0[0] }, ["escapeKey"], "the switcher's keys changed; fix switcher.cancel")
        XCTAssertTrue(tap.contains("if inGesture, let forward = SwitcherSelection.arrow(keyCode: code)"), "the switcher's arrows changed; fix switcher.arrows")
        let order = try SourceText.code("Sources/BaneySpacesCore/WorkspaceSwitcherOrder.swift")
        XCTAssertTrue(order.contains("case rightArrow, downArrow: return true") && order.contains("case leftArrow, upArrow: return false"),
                      "the switcher's arrows changed; fix switcher.arrows")
        XCTAssertTrue(tap.contains("let back = event.flags.contains(.maskShift)"), "⌘⇧Tab changed; fix switcher.back")
        XCTAssertTrue(tap.contains("mods == .maskCommand"), "⌘Tab changed; fix switcher.next")
        let core = try SourceText.code("Sources/BaneySpacesCore/MissionControlTakeover.swift")
        XCTAssertTrue(core.contains("code == upArrow && control && !command && !option && !shift"), "⌃↑ changed; fix workspace.overview.controlUp")
    }

    func testEveryRowIsAKeyTheCodeTakesOrIsListedAsUnscanned() {
        let mapped = Set(Self.registered.values).union(Self.launcherCommands.values).union(Self.newTabKeys.values)
            .union(Self.overviewKeyCodes.values).union(Self.menuKeys.values).union(Self.playerKeys.values)
        for b in Keymap.all {
            XCTAssertTrue(mapped.contains(b.id) || Self.unscanned.contains(b.id), "\(b.id) stands for no key the scan finds; map it or list it in unscanned")
        }
        for id in Self.unscanned { XCTAssertNotNil(Keymap.binding(id), "unscanned lists \(id), which Keymap.all lacks") }
    }

    // MARK: The table

    func testIdsAreUniqueAndEveryRowIsFilledIn() {
        XCTAssertEqual(Set(Keymap.all.map(\.id)).count, Keymap.all.count)
        for b in Keymap.all {
            XCTAssertFalse(b.keys.isEmpty, b.id)
            XCTAssertFalse(b.title.isEmpty, b.id)
            XCTAssertNotEqual(b.note, "", b.id)
            for text in [b.title, b.note ?? ""] + b.keys {
                XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "\(b.id): no em or en dashes")
            }
        }
    }

    func testDisplayWritesMacSymbolsWithTheModifierGiven() {
        XCTAssertEqual(Keymap.binding("launcher.open")?.display(modifierSymbol: "⌥"), "⌃⌘K")
        XCTAssertEqual(Keymap.binding("workspace.switch")?.display(modifierSymbol: "⌘"), "⌘1...9")
        XCTAssertEqual(Keymap.binding("window.move")?.display(modifierSymbol: "⌃⌥"), "⌃⌥⇧1...9")
        XCTAssertEqual(KeyBinding(id: "x", keys: ["opt", "shift", "Return"], title: "x", group: .bar, scope: .global).display(modifierSymbol: "⌘"), "⌥⇧Return")
    }

    // MARK: The modifier, read the way the app reads it

    func testTheModifierSymbolsMatchTheAppsModifier() throws {
        let keys = try SourceText.code("Sources/BaneySpaces/Keys.swift")
        let symbol = try XCTUnwrap(SourceText.block(after: "var symbol: String", in: keys))
        for (raw, sym) in [("command", "⌘"), ("control", "⌃"), ("option", "⌥"), ("controlOption", "⌃⌥")] {
            XCTAssertTrue(symbol.contains("case .\(raw): \"\(sym)\""), "the app's Modifier.\(raw) is no longer \(sym)")
            XCTAssertEqual(Keymap.modifierSymbol(setting: raw), sym)
        }
        XCTAssertEqual(Keymap.modifierSymbol(setting: nil), "⌘")
        XCTAssertEqual(Keymap.modifierSymbol(setting: "nonsense"), "⌘")
        // The app reads "modifier" from its own defaults; the command reads the same key in the app's domain.
        XCTAssertTrue(keys.contains("UserDefaults.standard.string(forKey: \"modifier\")"))
        let cli = try SourceText.code("Sources/baneyspaces-cli/Keys.swift")
        XCTAssertTrue(cli.contains("CFPreferencesCopyAppValue(\"modifier\" as CFString, Product.bundleID as CFString)"))
        let plist = try String(contentsOf: SourceText.root.appendingPathComponent("Resources/Info.plist"), encoding: .utf8)
        XCTAssertTrue(plist.contains("<key>CFBundleIdentifier</key><string>\(Product.bundleID)</string>"))
    }

    // MARK: polycarp-spaces keys

    func testTheCommandIsWiredAndPrintsTheTable() throws {
        let main = try SourceText.code("Sources/baneyspaces-cli/main.swift")
        XCTAssertTrue(main.contains("case \"keys\":\n    KeysCommand.run(rest, remote: remoteHost != nil)"))
        XCTAssertTrue(main.contains("  keys [--json]"), "the usage lists keys")
        let cli = try SourceText.code("Sources/baneyspaces-cli/Keys.swift")
        XCTAssertTrue(cli.contains("case []: print(Keymap.cheatSheet(modifierSymbol: symbol))"))
        XCTAssertTrue(cli.contains("case [\"--json\"]: print(Keymap.json(modifierSymbol: symbol))"))
        XCTAssertTrue(cli.contains("case [\"--markdown\"]: print(Keymap.markdown())"))
    }

    func testTheCheatSheetGroupsEveryRowWithTheModifier() {
        let text = Keymap.cheatSheet(modifierSymbol: "⌃")
        let lines = text.components(separatedBy: "\n")
        XCTAssertTrue(lines[0].contains("Your modifier is ⌃"))
        // Groups in order, each heading once, empty groups left out.
        let headings = lines.filter { KeyBinding.Group.allCases.map(\.title).contains($0) }
        XCTAssertEqual(headings, Keymap.grouped.map(\.group.title))
        for b in Keymap.all {
            let row = "  " + b.display(modifierSymbol: "⌃")
            XCTAssertTrue(lines.contains { $0.hasPrefix(row) && $0.contains(b.title) && $0.contains(b.scope.title) && $0.hasSuffix(b.note ?? b.scope.title) }, b.id)
        }
        XCTAssertTrue(lines.contains { $0.hasPrefix("  ⌃1...9 ") && $0.contains("Go to workspace 1 to 9") })
        // Each row sits under its own group's heading.
        var current = ""
        for line in lines {
            if headings.contains(line) { current = line; continue }
            guard line.hasPrefix("  ") else { continue }
            let b = Keymap.all.first { line.hasPrefix("  " + $0.display(modifierSymbol: "⌃") + " ") && line.contains($0.title) }
            XCTAssertEqual(b?.group.title, current, line)
        }
    }

    func testTheJSONIsAnArrayOfEveryRow() throws {
        let data = Data(Keymap.json(modifierSymbol: "⌥").utf8)
        let rows = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(rows.count, Keymap.all.count)
        for (row, b) in zip(rows, Keymap.all) {
            XCTAssertEqual(Set(row.keys), ["id", "keys", "display", "title", "group", "scope", "note"])
            if let note = b.note { XCTAssertEqual(row["note"] as? String, note) } else { XCTAssertTrue(row["note"] is NSNull, b.id) }
            XCTAssertEqual(row["id"] as? String, b.id)
            XCTAssertEqual(row["keys"] as? [String], b.keys)
            XCTAssertEqual(row["display"] as? String, b.display(modifierSymbol: "⌥"))
            XCTAssertEqual(row["title"] as? String, b.title)
            XCTAssertEqual(row["group"] as? String, b.group.rawValue)
            XCTAssertEqual(row["scope"] as? String, b.scope.rawValue)
        }
        let move = try XCTUnwrap(rows.first { $0["id"] as? String == "window.move" })
        XCTAssertEqual(move["display"] as? String, "⌥⇧1...9")
        XCTAssertEqual(move["keys"] as? [String], ["mod", "shift", "1...9"])
    }

    // MARK: docs/keys.md

    static let docsBegin = "<!-- keys:begin -->\n"
    static let docsEnd = "\n<!-- keys:end -->"

    func testDocsKeysMatchesTheKeymap() throws {
        let doc = try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("docs/keys.md"), encoding: .utf8)
        let begin = try XCTUnwrap(doc.range(of: Self.docsBegin), "docs/keys.md lost its keys:begin marker")
        let end = try XCTUnwrap(doc.range(of: Self.docsEnd, range: begin.upperBound..<doc.endIndex), "docs/keys.md lost its keys:end marker")
        XCTAssertEqual(String(doc[begin.upperBound..<end.lowerBound]), Keymap.markdown(),
                       "docs/keys.md disagrees with Keymap.all: put `swift run baneyspaces-cli keys --markdown` between its markers")
        XCTAssertFalse(doc.contains("\u{2014}") || doc.contains("\u{2013}"), "no em or en dashes")
    }

    func testTheGuideAndTheReadmeLinkTheKeys() throws {
        let top = Repo.root.deletingLastPathComponent()
        let guide = try String(contentsOf: top.appendingPathComponent("docs/guide.md"), encoding: .utf8)
        let readme = try String(contentsOf: top.appendingPathComponent("README.md"), encoding: .utf8)
        XCTAssertTrue(guide.contains("(keys.md)") || guide.contains("docs/keys.md"), "docs/guide.md links docs/keys.md")
        XCTAssertTrue(readme.contains("(docs/keys.md)"), "README.md links docs/keys.md")
    }
}

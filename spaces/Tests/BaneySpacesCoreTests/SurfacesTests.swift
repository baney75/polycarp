import XCTest
@testable import BaneySpacesCore

/// surfaces.json: defaults, checks with exact paths, unknown keys kept, edits that write whole files, and the watcher
/// that brings a change to the app within 150 ms and keeps the last good config through a broken file.
final class SurfacesTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent("surfaces.json").path }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-surfaces-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func tree(_ json: String) -> SurfaceValue {
        guard case .success(let v) = SurfaceValue.parse(Data(json.utf8)) else { XCTFail("not JSON: \(json)"); return .null }
        return v
    }

    private func errors(_ json: String) -> [SurfacesIssue] {
        if case .failure(let e) = Surfaces.check(tree(json)) { return e.issues }
        return []
    }

    // MARK: Defaults

    func testEveryDefaultIsCompiledInAndAnEmptyFileIsTheDefaults() throws {
        let d = Surfaces.defaults
        XCTAssertEqual(d.bar.enabled, false)
        XCTAssertEqual(d.bar.height, 26)
        XCTAssertEqual(d.bar.style, .solid)
        XCTAssertEqual(d.bar.left, [.mark, .workspaces, .appMenus, .purpose])
        XCTAssertEqual(d.bar.center, [.clock])
        XCTAssertEqual(d.bar.right, [.oneThing, .status])
        XCTAssertEqual(d.bar.clockFormat, .dayTwelveHour)
        XCTAssertTrue(d.bar.hourNames)
        XCTAssertFalse(d.bar.hideSystemMenuBar)
        XCTAssertEqual(d.desktop.scene, .field)
        XCTAssertTrue(d.desktop.followDaylight)
        XCTAssertTrue(d.desktop.verse)
        XCTAssertEqual(d.desktop.versePosition, .bottomRight)
        XCTAssertEqual(d.desktop.verseRotation, .daily)
        XCTAssertEqual(d.dock.tileLabel, .purpose)
        XCTAssertTrue(d.dock.restTile)
        XCTAssertEqual(d.menu.rows, Surfaces.MenuRow.allCases)
        XCTAssertEqual(d.menu.hidden, [])
        XCTAssertEqual(d.newtab.question, "What is this hour for?")
        XCTAssertFalse(d.newtab.chips, "one field: the bar already shows the purposes")
        XCTAssertTrue(d.newtab.verse)
        XCTAssertEqual(d.newtab.searchURL(for: "purity of heart")?.absoluteString, "https://duckduckgo.com/?q=purity%20of%20heart")
        XCTAssertFalse(d.idle.enabled, "the idle screen waits until you turn it on")
        XCTAssertEqual(d.idle.style, .martyrNight)
        XCTAssertTrue(d.idle.effects && d.idle.showMachineName && d.idle.showVerse && d.idle.showKierkegaard)
        XCTAssertEqual(d.idle.startAfterMinutes, 10)
        XCTAssertEqual(d.alarm, .init(wake: false, wakeAt: "06:30", days: .every, keepAwake: true, timerMinutes: 25),
                       "the wake alarm waits until you turn it on")
        XCTAssertEqual(d.text.translation, .bsb)
        XCTAssertEqual(d.text.verseSource, .builtIn)

        guard case .success(let empty) = Surfaces.check(tree("{}")) else { return XCTFail("{} is a valid file") }
        XCTAssertEqual(empty.surfaces, d)
        XCTAssertEqual(empty.warnings, [])
        guard case .success(let full) = Surfaces.check(SurfaceField.defaultTree) else { return XCTFail("the defaults pass their own checks") }
        XCTAssertEqual(full.surfaces, d)
        XCTAssertEqual(full.warnings, [], "the default tree has no key the checker doesn't know")
        XCTAssertEqual(SurfacesFile.load(path: file), .missing)
    }

    func testEveryFieldsDefaultPassesItsOwnKindAndEveryPathIsUnique() {
        for f in SurfaceField.all {
            XCTAssertNil(SurfaceCheck.problem(f.defaultValue, kind: f.kind), f.path)
            XCTAssertFalse(f.help.isEmpty, f.path)
        }
        XCTAssertEqual(Set(SurfaceField.all.map(\.path)).count, SurfaceField.all.count)
        // No rhythm section: the morning question and examen are the purpose work's (feat/purpose), not mirrored here.
        XCTAssertFalse(SurfaceField.all.contains { $0.path.hasPrefix("rhythm") })
    }

    func testTheSupportFolderHoldsTheFileUnlessTheTestHookPointsElsewhere() {
        let home = URL(fileURLWithPath: "/Users/someone")
        XCTAssertEqual(SurfacesFile.path(env: [:], home: home), "/Users/someone/Library/Application Support/Polycarp/surfaces.json")
        XCTAssertEqual(SurfacesFile.path(env: ["POLYCARP_SURFACES_FILE": "/x/s.json"], home: home), "/x/s.json")
        XCTAssertEqual(SurfacesFile.path(env: ["POLYCARP_SURFACES_FILE": "relative.json"], home: home),
                       "/Users/someone/Library/Application Support/Polycarp/surfaces.json", "a relative override is ignored")
    }

    // MARK: Round trip

    func testASetIsReadBackAndTheFileHoldsOnlyWhatWasSet() throws {
        let sets: [(String, String)] = [
            ("bar.enabled", "true"), ("bar.height", "34"), ("bar.style", "\"glass\""),
            ("bar.modules", #"{"left":["mark","custom:weather"],"center":["hour","verse"],"right":["clock"]}"#),
            ("bar.clockFormat", "\"24h\""), ("bar.hourNames", "false"), ("bar.hideSystemMenuBar", "true"),
            ("desktop.scene", "\"image:dawn-field.heic\""), ("desktop.followDaylight", "false"), ("desktop.verse", "false"),
            ("desktop.versePosition", "\"top-center\""), ("desktop.verseRotation", "\"fixed:1 Corinthians 13:4-7\""),
            ("dock.tileLabel", "\"number\""), ("dock.restTile", "false"),
            ("menu.order", #"["quit","settings"]"#), ("menu.hidden", #"["update","agents"]"#),
            ("newtab.question", "\"Will one thing.\""), ("newtab.chips", "true"), ("newtab.verse", "false"),
            ("newtab.searchURL", "\"https://search.brave.com/search?q={query}&source=web\""),
            ("idle.enabled", "true"), ("idle.style", "\"verse\""), ("idle.effects", "false"), ("idle.showMachineName", "false"), ("idle.showVerse", "false"),
            ("idle.showKierkegaard", "false"), ("idle.startAfterMinutes", "5"),
            ("alarm.wake", "true"), ("alarm.wakeAt", "\"05:45\""), ("alarm.days", "\"weekdays\""), ("alarm.keepAwake", "false"),
            ("alarm.timerMinutes", "50"),
            ("text.translation", "\"BSB\""), ("text.verseSource", "\"file:psalms.json\""),
        ]
        for (p, v) in sets {
            guard case .success = SurfacesOps.set(p, tree(v), file: file) else { return XCTFail("set \(p) \(v) was refused: \(SurfacesOps.set(p, tree(v), file: file))") }
        }
        guard case .document(let d) = SurfacesFile.load(path: file) else { return XCTFail("the file reads back") }
        let s = d.surfaces
        XCTAssertEqual(s.bar, .init(enabled: true, height: 34, style: .glass, left: [.mark, .custom("weather")], center: [.hour, .verse],
                                    right: [.clock], clockFormat: .twentyFourHour, hourNames: false, hideSystemMenuBar: true))
        XCTAssertEqual(s.desktop, .init(scene: .image("dawn-field.heic"), followDaylight: false, verse: false, versePosition: .topCenter,
                                        verseRotation: .fixed("1 Corinthians 13:4-7")))
        XCTAssertEqual(s.dock, .init(tileLabel: .number, restTile: false))
        XCTAssertEqual(s.menu.rows, [.quit, .settings, .workspaces, .showAll, .find, .dock], "left-out rows follow; hidden ones go")
        XCTAssertEqual(s.newtab, .init(question: "Will one thing.", chips: true, verse: false, searchURL: "https://search.brave.com/search?q={query}&source=web"))
        XCTAssertEqual(s.idle, .init(enabled: true, style: .verse, effects: false, showMachineName: false, showVerse: false, showKierkegaard: false, startAfterMinutes: 5))
        XCTAssertEqual(s.alarm, .init(wake: true, wakeAt: "05:45", days: .weekdays, keepAwake: false, timerMinutes: 50))
        XCTAssertEqual(s.text, .init(translation: .bsb, verseSource: .file("psalms.json")))
        // Reading the tree's text again gives the same tree: nothing is lost or reordered into something else.
        XCTAssertEqual(tree(d.tree.json()), d.tree)
        XCTAssertEqual(d.tree.at(["version"]), .number(1), "a set stamps the format")
        // get answers the value in force and whether the file sets it.
        XCTAssertEqual(try SurfacesOps.get("idle.startAfterMinutes", file: file).get().object?["value"], .number(5))
        XCTAssertEqual(try SurfacesOps.get("idle.startAfterMinutes", file: file).get().object?["set"], .bool(true))
    }

    func testGetMergesTheFileOverTheDefaults() throws {
        XCTAssertEqual(try SurfacesOps.get("bar.height", file: file).get().object?["value"], .number(26), "no file: the default")
        XCTAssertEqual(try SurfacesOps.get("bar.height", file: file).get().object?["set"], .bool(false))
        _ = SurfacesOps.set("bar.height", .number(36), file: file)
        let bar = try SurfacesOps.get("bar", file: file).get().object?["value"]
        XCTAssertEqual(bar?.at(["height"]), .number(36))
        XCTAssertEqual(bar?.at(["style"]), .string("solid"), "fields the file leaves out are the defaults")
        let all = try SurfacesOps.get(nil, file: file).get().object?["value"]
        XCTAssertEqual(all?.at(["idle", "style"]), .string("martyr-night"))
    }

    func testResetTakesOnePathBackOrTheWholeFile() throws {
        _ = SurfacesOps.set("bar.height", .number(36), file: file)
        _ = SurfacesOps.set("dock.restTile", .bool(false), file: file)
        let r = try SurfacesOps.reset("bar.height", file: file).get()
        XCTAssertEqual(r.object?["value"], .number(26))
        guard case .document(let d) = SurfacesFile.load(path: file) else { return XCTFail() }
        XCTAssertNil(d.tree.at(["bar"]), "an emptied group leaves the file")
        XCTAssertEqual(d.tree.at(["dock", "restTile"]), .bool(false))
        _ = try SurfacesOps.reset(nil, file: file).get()
        guard case .document(let all) = SurfacesFile.load(path: file) else { return XCTFail() }
        XCTAssertEqual(all.tree, .object(["version": .number(1)]))
        XCTAssertEqual(all.surfaces, .defaults)
    }

    // MARK: Every error, with its path

    func testEveryValueErrorNamesItsPathAndWhatItTakes() {
        let cases: [(json: String, path: String, says: String)] = [
            (#"[]"#, "$", "must be a JSON object, not a list"),
            (#"{"version":"1"}"#, "version", "must be a whole number from 1 to 1000, not a string"),
            (#"{"version":0}"#, "version", "must be from 1 to 1000, not 0"),
            (#"{"bar":true}"#, "bar", "must be an object, not a boolean"),
            (#"{"bar":{"modules":[]}}"#, "bar.modules", "must be an object, not a list"),
            (#"{"bar":{"enabled":"yes"}}"#, "bar.enabled", "must be true or false, not a string"),
            (#"{"bar":{"height":21}}"#, "bar.height", "must be from 22 to 40, not 21"),
            (#"{"bar":{"height":41}}"#, "bar.height", "must be from 22 to 40, not 41"),
            (#"{"bar":{"height":28.5}}"#, "bar.height", "must be a whole number from 22 to 40, not 28.5"),
            (#"{"bar":{"height":null}}"#, "bar.height", "must be a whole number from 22 to 40, not null"),
            (#"{"bar":{"style":"frosted"}}"#, "bar.style", #"must be one of "solid", "glass", "hairline", not "frosted""#),
            (#"{"bar":{"style":1}}"#, "bar.style", "must be one of"),
            (#"{"bar":{"clockFormat":"24"}}"#, "bar.clockFormat", #"not "24""#),
            (#"{"bar":{"clockFormat":"day"}}"#, "bar.clockFormat", #"must be one of "12h", "24h", "day-12h", "day-24h", not "day""#),
            (#"{"bar":{"modules":{"left":"mark"}}}"#, "bar.modules.left", "must be a list of ids, not a string"),
            (#"{"bar":{"modules":{"left":["mark",3]}}}"#, "bar.modules.left[1]", "must be an id (a string), not a number"),
            (#"{"bar":{"modules":{"left":["mark","wifi"]}}}"#, "bar.modules.left[1]", #""wifi" is not a known id"#),
            (#"{"bar":{"modules":{"left":["custom:Bad Name"]}}}"#, "bar.modules.left[0]", "custom:<name>"),
            (#"{"bar":{"modules":{"left":["mark","mark"]}}}"#, "bar.modules.left[1]", #""mark" is listed twice"#),
            (#"{"bar":{"modules":{"left":["mark"],"center":["mark"]}}}"#, "bar.modules.center[0]", #""mark" is already in bar.modules.left; a module goes in one place"#),
            (#"{"desktop":{"scene":"forest"}}"#, "desktop.scene", #"must be one of "field", "olive", "water", "parchment", "solid" or image:<...>"#),
            (#"{"desktop":{"scene":"image:../etc/x.png"}}"#, "desktop.scene", #""../etc/x.png" is not a valid image value"#),
            (#"{"desktop":{"scene":"image:Dawn.PNG"}}"#, "desktop.scene", "is not a valid image value"),
            (#"{"desktop":{"versePosition":"middle"}}"#, "desktop.versePosition", #"not "middle""#),
            (#"{"desktop":{"verseRotation":"weekly"}}"#, "desktop.verseRotation", "fixed:<...>"),
            (#"{"desktop":{"verseRotation":"fixed:3:16"}}"#, "desktop.verseRotation", #""3:16" is not a valid fixed value"#),
            (#"{"dock":{"tileLabel":"name"}}"#, "dock.tileLabel", #"not "name""#),
            (#"{"idle":{"startAfterMinutes":0}}"#, "idle.startAfterMinutes", "not 0"),
            (#"{"menu":{"order":["workspaces","help"]}}"#, "menu.order[1]", #""help" is not a known id"#),
            (#"{"menu":{"order":["custom:x"]}}"#, "menu.order[0]", "is not a known id"),
            (#"{"menu":{"hidden":["find","find"]}}"#, "menu.hidden[1]", "listed twice"),
            (#"{"menu":{"hidden":["find","settings"]}}"#, "menu.hidden[1]", #""settings" can't be hidden"#),
            (#"{"newtab":{"question":"   "}}"#, "newtab.question", "must not be blank"),
            (#"{"newtab":{"question":"\#(String(repeating: "a", count: 161))"}}"#, "newtab.question", "at most 160 characters, not 161"),
            (#"{"newtab":{"question":"two\nlines"}}"#, "newtab.question", "must be one line"),
            (#"{"newtab":{"searchURL":"http://x.com/?q={query}"}}"#, "newtab.searchURL", "must start with https://"),
            (#"{"newtab":{"searchURL":"https://x.com/"}}"#, "newtab.searchURL", "{query} exactly once"),
            (#"{"newtab":{"searchURL":"https://x.com/?q={query}&r={query}"}}"#, "newtab.searchURL", "{query} exactly once"),
            (#"{"newtab":{"searchURL":"https://x .com/?q={query}"}}"#, "newtab.searchURL", "is not a valid URL"),
            (#"{"newtab":{"searchURL":"https:///?q={query}"}}"#, "newtab.searchURL", "is not a valid URL"),
            (#"{"idle":{"style":"martyr"}}"#, "idle.style", #"not "martyr""#),
            (#"{"idle":{"startAfterMinutes":241}}"#, "idle.startAfterMinutes", "must be from 1 to 240, not 241"),
            (#"{"idle":{"effects":1}}"#, "idle.effects", "must be true or false, not a number"),
            (#"{"alarm":{"wakeAt":"25:00"}}"#, "alarm.wakeAt", #"must be a time "HH:MM" from 00:00 to 23:59 (as "06:30"), not "25:00""#),
            (#"{"alarm":{"wakeAt":"6:3"}}"#, "alarm.wakeAt", #"not "6:3""#),
            (#"{"alarm":{"wakeAt":"06:60"}}"#, "alarm.wakeAt", #"not "06:60""#),
            (#"{"alarm":{"wakeAt":630}}"#, "alarm.wakeAt", "must be a time \"HH:MM\" (24 hour, as \"06:30\"), not a number"),
            (#"{"alarm":{"timerMinutes":0}}"#, "alarm.timerMinutes", "must be from 1 to 240, not 0"),
            (#"{"alarm":{"timerMinutes":241}}"#, "alarm.timerMinutes", "must be from 1 to 240, not 241"),
            (#"{"alarm":{"days":"sundays"}}"#, "alarm.days", #"must be one of "every", "weekdays", "not-sunday", not "sundays""#),
            (#"{"alarm":{"wake":"on"}}"#, "alarm.wake", "must be true or false, not a string"),
            (#"{"text":{"translation":"KJV"}}"#, "text.translation", #"must be one of "BSB", not "KJV""#),
            (#"{"text":{"verseSource":"file:psalms.txt"}}"#, "text.verseSource", "is not a valid file value"),
        ]
        for c in cases {
            let got = errors(c.json)
            XCTAssertEqual(got.count, 1, "\(c.json): \(got)")
            XCTAssertEqual(got.first?.path, c.path, c.json)
            XCTAssertTrue(got.first?.message.contains(c.says) == true, "\(c.json): \(got.first?.message ?? "no error")")
        }
    }

    func testEveryErrorInAFileIsListedInPathOrder() {
        let got = errors(#"{"idle":{"style":"x"},"bar":{"height":99,"style":"x"},"dock":{"restTile":"no"}}"#)
        XCTAssertEqual(got.map(\.path), ["bar.height", "bar.style", "dock.restTile", "idle.style"])
    }

    func testNotJSONIsAnErrorAtTheRoot() {
        guard case .invalid(let e, tree: nil) = SurfacesFile.parse(Data("{\"bar\": ".utf8)) else { return XCTFail() }
        XCTAssertEqual(e.issues.first?.path, "$")
        XCTAssertTrue(e.issues.first?.message.hasPrefix("not valid JSON") == true)
    }

    func testAFileOverTheLimitIsRefused() throws {
        let big = "{\"x\":\"" + String(repeating: "a", count: SurfacesFile.maxBytes) + "\"}"
        try big.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(SurfacesFile.load(path: file), .rejected("over \(SurfacesFile.maxBytes) bytes"))
    }

    // MARK: Forward compatibility

    func testUnknownKeysAreKeptThroughEveryWriteAndOnlyWarnedAbout() throws {
        let newer = #"{"version":3,"bar":{"height":30,"blur":12},"journal":{"prompt":"x"},"desktop":{"scene":"olive"}}"#
        try newer.write(toFile: file, atomically: true, encoding: .utf8)
        guard case .document(let d) = SurfacesFile.load(path: file) else { return XCTFail("a newer file reads") }
        XCTAssertEqual(d.surfaces.bar.height, 30)
        XCTAssertEqual(d.surfaces.desktop.scene, .olive)
        XCTAssertEqual(d.warnings.map(\.path), ["bar.blur", "journal", "version"])

        let set = try SurfacesOps.set("dock.restTile", .bool(false), file: file).get()
        XCTAssertEqual(set.object?["warnings"]?.array?.count, 3, "set says what it kept and didn't know")
        _ = try SurfacesOps.reset("desktop.scene", file: file).get()
        guard case .document(let after) = SurfacesFile.load(path: file) else { return XCTFail() }
        XCTAssertEqual(after.tree.at(["bar", "blur"]), .number(12))
        XCTAssertEqual(after.tree.at(["journal", "prompt"]), .string("x"))
        XCTAssertEqual(after.tree.at(["version"]), .number(3), "an older build never lowers the format")
        XCTAssertNil(after.tree.at(["desktop"]))
        // get and reset reach a key this build doesn't know; set doesn't, so a typo can't land.
        XCTAssertEqual(try SurfacesOps.get("journal.prompt", file: file).get().object?["value"], .string("x"))
        _ = try SurfacesOps.reset("journal", file: file).get()
        guard case .document(let gone) = SurfacesFile.load(path: file) else { return XCTFail() }
        XCTAssertNil(gone.tree.at(["journal"]))
    }

    // MARK: Edits

    func testASetThatFailsWritesNothingAndSaysWhy() throws {
        _ = SurfacesOps.set("bar.height", .number(30), file: file)
        let before = try Data(contentsOf: URL(fileURLWithPath: file))
        guard case .failure(let f) = SurfacesOps.set("bar.height", .number(99), file: file) else { return XCTFail() }
        XCTAssertEqual(f.code, "invalid_value")
        XCTAssertEqual(f.message, "bar.height: must be from 22 to 40, not 99")
        XCTAssertEqual(f.issues, [SurfacesIssue("bar.height", "must be from 22 to 40, not 99")])
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), before)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(names, ["surfaces.json"], "no temp file is left behind")
    }

    func testAnUnknownPathIsRefusedWithTheNearestOne() {
        guard case .failure(let f) = SurfacesOps.set("bar.heigth", .number(30), file: file) else { return XCTFail() }
        XCTAssertEqual(f.code, "unknown_path")
        XCTAssertEqual(f.suggestion, "did you mean bar.height?")
        XCTAssertEqual(f.issues.first?.path, "bar.heigth")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
        guard case .failure(let g) = SurfacesOps.get("idle.styles.x", file: file) else { return XCTFail() }
        XCTAssertEqual(g.code, "unknown_path")
        guard case .failure(let bad) = SurfacesOps.set("bar..height", .number(30), file: file) else { return XCTFail() }
        XCTAssertEqual(bad.code, "invalid_args")
        XCTAssertEqual(bad.exit, 2)
    }

    func testAGroupTakesAnObjectAndIsCheckedWhole() {
        guard case .failure(let f) = SurfacesOps.set("bar", .number(1), file: file) else { return XCTFail() }
        XCTAssertEqual(f.code, "invalid_value")
        guard case .failure(let g) = SurfacesOps.set("bar", tree(#"{"height":12}"#), file: file) else { return XCTFail() }
        XCTAssertEqual(g.issues.first?.path, "bar.height")
        XCTAssertNoThrow(try SurfacesOps.set("bar", tree(#"{"height":24,"style":"hairline"}"#), file: file).get())
    }

    func testASetOnAFileWithOtherErrorsNamesThemAndWritesNothing() throws {
        try #"{"version":1,"idle":{"startAfterMinutes":0}}"#.write(toFile: file, atomically: true, encoding: .utf8)
        guard case .failure(let f) = SurfacesOps.set("bar.height", .number(30), file: file) else { return XCTFail() }
        XCTAssertEqual(f.code, "invalid_value")
        XCTAssertTrue(f.message.contains("the file has other errors"), f.message)
        XCTAssertEqual(f.issues.map(\.path), ["idle.startAfterMinutes"])
        // Fixing the error is a set of its own path.
        XCTAssertNoThrow(try SurfacesOps.set("idle.startAfterMinutes", .number(15), file: file).get())
    }

    func testTheEnvelopeIsTheOneTheThemeCommandUses() {
        let f = SurfacesFailure("invalid_value", "bar.height: bad", suggestion: "run schema", issues: [SurfacesIssue("bar.height", "bad")])
        XCTAssertEqual(f.envelope, .object([
            "ok": .bool(false),
            "error": .object(["code": .string("invalid_value"), "message": .string("bar.height: bad"), "suggestion": .string("run schema"),
                              "retry": .string("never"),
                              "data": .object(["errors": .array([.object(["path": .string("bar.height"), "message": .string("bad")])])])]),
        ]))
        XCTAssertEqual(SurfacesOps.ok(.number(1)), .object(["ok": .bool(true), "data": .number(1)]))
        XCTAssertEqual(SurfacesFailure.usage("x").envelope.at(["error", "suggestion"]), .string("Run `polycarp-spaces surfaces help` for the usage."),
                       "a suggestion is always there, as in the theme envelope")
    }

    // MARK: A broken file

    func testABrokenFileCantBeEditedByAccidentAndResetStartsOver() throws {
        try "{ not json".write(toFile: file, atomically: true, encoding: .utf8)
        for r in [SurfacesOps.set("bar.height", .number(30), file: file), SurfacesOps.reset("bar.height", file: file), SurfacesOps.get(nil, file: file)] {
            guard case .failure(let f) = r else { return XCTFail("a file that isn't JSON is never edited") }
            XCTAssertEqual(f.code, "invalid_file")
        }
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), "{ not json")
        guard case .failure(let v) = SurfacesOps.validate(file) else { return XCTFail() }
        XCTAssertEqual(v.code, "invalid_surfaces")
        XCTAssertEqual(v.issues.first?.path, "$")
        XCTAssertNoThrow(try SurfacesOps.reset(nil, file: file).get())
        XCTAssertEqual(SurfacesFile.load(path: file), .document(.init(tree: .object(["version": .number(1)]), surfaces: .defaults, warnings: [])))
    }

    func testTheWatcherKeepsTheLastGoodConfigThroughABrokenFileAndSaysWhyOnce() throws {
        let queue = DispatchQueue(label: "surfaces-test")
        let seen = Seen()
        let lines = Seen.Lines()
        let w = SurfacesWatcher(path: file, queue: queue, log: lines.add, schedule: { _, _, _, _ in {} }, watch: { _, _, _ in {} },
                                deliver: seen.add)
        _ = SurfacesOps.set("bar.height", .number(32), file: file)
        w.start()
        queue.sync {}
        XCTAssertEqual(seen.all.last?.bar.height, 32)
        for broken in ["{ half", #"{"bar":{"height":"tall"}}"#, "{ half again"] {
            try broken.write(toFile: file, atomically: false, encoding: .utf8)
            w.tickNow()
            XCTAssertEqual(seen.all.count, 1, "a broken file never takes effect")
        }
        XCTAssertTrue(lines.all.contains { $0.contains("ignored") && $0.contains("$: not valid JSON") && $0.contains("keeping the last good config") }, "\(lines.all)")
        XCTAssertTrue(lines.all.contains { $0.contains("bar.height: must be a whole number") }, "\(lines.all)")
        let logged = lines.all.count
        w.tickNow()
        XCTAssertEqual(lines.all.count, logged, "the same problem is logged once")
        _ = try SurfacesOps.reset(nil, file: file).get()
        w.tickNow()
        XCTAssertEqual(seen.all.count, 2)
        XCTAssertEqual(seen.all.last, .defaults, "a fixed file lands")
        try FileManager.default.removeItem(atPath: file)
        w.tickNow()
        XCTAssertEqual(seen.all.count, 2, "removing a file that was all defaults changes nothing")
        w.stop()
    }

    func testAnInvalidFileAtLaunchMeansTheDefaults() throws {
        try #"{"bar":{"height":5}}"#.write(toFile: file, atomically: true, encoding: .utf8)
        let lines = Seen.Lines()
        let w = SurfacesWatcher(path: file, log: lines.add, schedule: { _, _, _, _ in {} }, watch: { _, _, _ in {} }, deliver: { _ in })
        XCTAssertEqual(w.start(firstLookWithin: 1), .defaults)
        XCTAssertEqual(lines.all.count, 1)
        w.stop()
    }

    // MARK: Live reload

    /// The watcher as the app builds it (`SurfacesStore.start`): each `surfaces set` reaches the notification on the main
    /// queue within 150 ms, and the watcher never reads on the main thread.
    func testTwentySetsEachReachTheNotificationWithinOneHundredFiftyMilliseconds() throws {
        let center = NotificationCenter()
        let store = SurfacesStore(center: center)
        store.start(path: file, firstLookWithin: 0.15)
        defer { store.stop() }
        XCTAssertEqual(store.current, .defaults)
        var took: [Double] = []
        for i in 0..<20 {
            let height = 22 + i % 19
            let arrived = expectation(description: "set \(i + 1)")
            var onMain = false
            let token = center.addObserver(forName: SurfacesStore.didChange, object: nil, queue: nil) { note in
                guard (note.userInfo?[SurfacesStore.key] as? Surfaces)?.bar.height == height else { return }
                onMain = Thread.isMainThread
                arrived.fulfill()
            }
            let t0 = Date()
            XCTAssertNoThrow(try SurfacesOps.set("bar.height", .number(Double(height)), file: file).get())
            wait(for: [arrived], timeout: 1.5)
            took.append(Date().timeIntervalSince(t0) * 1000)
            center.removeObserver(token)
            XCTAssertTrue(onMain, "the notification comes on the main queue")
            XCTAssertEqual(store.current.bar.height, height, "current already holds it when the notification comes")
        }
        let sorted = took.sorted()
        print(String(format: "surfaces reload: 20 sets, median %.1f ms, max %.1f ms", sorted[10], sorted[19]))
        XCTAssertLessThan(sorted[19], 150, "every set lands within 150 ms: \(took.map { Int($0) })")
    }

    func testTheWatcherDeliversOffTheMainThread() throws {
        let arrived = expectation(description: "delivered")
        let w = SurfacesWatcher(path: file) { _ in
            XCTAssertFalse(Thread.isMainThread)
            arrived.fulfill()
        }
        w.start()
        wait(for: [arrived], timeout: 1)
        w.stop()
    }

    // MARK: Schema and docs

    func testTheSchemaHasEveryFieldWithItsDefaultAndRules() {
        let s = Surfaces.schema
        XCTAssertEqual(s.at(["$schema"]), .string("https://json-schema.org/draft/2020-12/schema"))
        XCTAssertEqual(s.at(["additionalProperties"]), .bool(true), "a newer file must still pass")
        for f in SurfaceField.all {
            let at = f.keys.flatMap { ["properties", $0] }
            XCTAssertEqual(s.at(at + ["default"]), f.defaultValue, f.path)
            XCTAssertNotNil(s.at(at + ["description"])?.string, f.path)
        }
        for g in SurfaceField.groups {
            XCTAssertEqual(s.at(g.path.split(separator: ".").flatMap { ["properties", String($0)] } + ["type"]), .string("object"), g.path)
        }
        XCTAssertEqual(s.at(["properties", "bar", "properties", "height", "minimum"]), .number(22))
        XCTAssertEqual(s.at(["properties", "bar", "properties", "height", "maximum"]), .number(40))
        XCTAssertEqual(s.at(["properties", "bar", "properties", "style", "enum"]), .array([.string("solid"), .string("glass"), .string("hairline")]))
        XCTAssertEqual(s.at(["properties", "alarm", "properties", "wakeAt", "pattern"]), .string("^([01][0-9]|2[0-3]):[0-5][0-9]$"))
        XCTAssertEqual(s.at(["properties", "alarm", "properties", "timerMinutes", "maximum"]), .number(240))
        // The text is JSON a schema tool can read.
        XCTAssertEqual(tree(s.json()), s)
    }

    /// docs/surfaces.md lists every field with its default, so an agent reading it never meets a field the docs lack.
    func testTheDocsListEveryFieldAndItsDefault() throws {
        let doc = try String(contentsOf: SourceText.root.appendingPathComponent("docs/surfaces.md"), encoding: .utf8)
        for f in SurfaceField.all where f.path != "version" {
            XCTAssertTrue(doc.contains("| `\(f.path)` |"), "docs/surfaces.md has no row for \(f.path)")
            XCTAssertTrue(doc.contains("`\(f.defaultValue.json(pretty: false))`"), "docs/surfaces.md lacks \(f.path)'s default \(f.defaultValue.json(pretty: false))")
        }
        XCTAssertFalse(doc.contains("\u{2014}") || doc.contains("\u{2013}"), "no em or en dashes")
    }

    /// `alarm.wakeAt` takes every minute of the day as "HH:MM" and nothing else; a set of a bare word reads as text.
    func testTheWakeTimeIsHoursAndMinutesOnTheTwentyFourHourClock() throws {
        for good in ["00:00", "06:30", "12:05", "23:59"] { XCTAssertNil(SurfaceCheck.problem(.string(good), kind: .time), good) }
        for bad in ["24:00", "25:00", "6:3", "6:30", "06:3", "0630", "06:30 ", "", "ab:cd"] {
            XCTAssertNotNil(SurfaceCheck.problem(.string(bad), kind: .time), bad)
        }
        XCTAssertEqual(Surfaces.defaults.alarm.time?.hour, 6)
        XCTAssertEqual(Surfaces.defaults.alarm.time?.minute, 30)
        XCTAssertNoThrow(try SurfacesOps.set("alarm", tree(#"{"wake":true,"wakeAt":"07:15","days":"not-sunday"}"#), file: file).get())
        guard case .document(let d) = SurfacesFile.load(path: file) else { return XCTFail("the file reads back") }
        XCTAssertEqual(d.surfaces.alarm, .init(wake: true, wakeAt: "07:15", days: .notSunday, keepAwake: true, timerMinutes: 25))
        guard case .failure(let f) = SurfacesOps.set("alarm.wakeAt", .string("7:15"), file: file) else { return XCTFail("7:15 is refused") }
        XCTAssertEqual(f.issues.first?.path, "alarm.wakeAt")
    }

    /// Review of #587: a file that set one place under the old defaults (`center: ["hour"]`, the docs' own example)
    /// must still read. A place the file sets takes its modules from the places left at their default.
    func testAPlaceTheFileSetsTakesItsModulesFromTheDefaults() throws {
        func bar(_ json: String) throws -> Surfaces.Bar {
            guard case .success(let c) = Surfaces.check(tree(json)) else { XCTFail("\(json) must read"); return Surfaces.defaults.bar }
            return c.surfaces.bar
        }
        let a = try bar(#"{"bar":{"modules":{"center":["hour"]}}}"#)
        XCTAssertEqual(a.center, [.hour])
        XCTAssertEqual(a.right, [.oneThing, .status, .clock], "a middle set without the clock keeps it at the right (review of #602)")
        let c = try bar(#"{"bar":{"modules":{"center":["one-thing","clock"]}}}"#)
        XCTAssertEqual(c.right, [.status], "a middle that holds the clock keeps it there")
        let d = try bar(#"{"bar":{"modules":{"center":["hour"],"right":["status"]}}}"#)
        XCTAssertEqual(d.right, [.status], "a right the file sets is left as written")
        let b = try bar(#"{"bar":{"modules":{"right":["mark","clock"]}}}"#)
        XCTAssertEqual(b.left, [.workspaces, .appMenus, .purpose])
        XCTAssertEqual(b.right, [.mark, .clock])
        XCTAssertEqual(b.center, [], "clock left the default middle")
        // A saved list from before the Omarchy defaults is the user's: it keeps its hour and its places.
        let old = try bar(#"{"bar":{"modules":{"left":["mark","workspaces","app-menus","purpose"],"center":["one-thing"],"right":["status","hour","clock"]}}}"#)
        XCTAssertEqual(old.center, [.oneThing])
        XCTAssertEqual(old.right, [.status, .hour, .clock])
    }

    /// The day forms of the clock are taken and read back; the 12h and 24h forms still read as they did.
    func testEveryClockFormatReadsBack() throws {
        for f in Surfaces.ClockFormat.allCases {
            XCTAssertNoThrow(try SurfacesOps.set("bar.clockFormat", .string(f.rawValue), file: file).get(), f.rawValue)
            guard case .document(let d) = SurfacesFile.load(path: file) else { return XCTFail("the file reads back") }
            XCTAssertEqual(d.surfaces.bar.clockFormat, f)
        }
        XCTAssertEqual(Surfaces.schema.at(["properties", "bar", "properties", "clockFormat", "enum"]),
                       .array(["12h", "24h", "day-12h", "day-24h"].map(SurfaceValue.string)))
    }
}

private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [Surfaces] = []
    func add(_ s: Surfaces) { lock.lock(); list.append(s); lock.unlock() }
    var all: [Surfaces] { lock.lock(); defer { lock.unlock() }; return list }

    final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [String] = []
        func add(_ s: String) { lock.lock(); list.append(s); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return list }
    }
}

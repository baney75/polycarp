import XCTest
@testable import BaneySpacesCore

/// The theme editor's pure parts: fields from the schema, the draft with undo, contrast warnings, the palette from a picture,
/// and the commands. The last tests run the real `polycarp` and skip where it isn't built.
final class ThemeEditorTests: XCTestCase {
    // MARK: Fixtures

    /// The CLI's schema shape, cut down: one field of each kind, and the sections in `x-paths`.
    static func schema(extraShape: String = "") -> Data {
        let colors = ["accent", "background", "border", "done", "foreground", "muted", "on_accent", "selection", "strong", "sunken",
                      "surface", "urgent", "working"]
            .map { #""\#($0)": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$", "description": "The \#($0) color."}"# }
            .joined(separator: ",")
        let text = #"""
        {"ok": true, "data": {"schema": {
          "properties": {
            "name": {"type": "string"},
            "light": {"$ref": "#/$defs/colors", "description": "Light mode."},
            "dark": {"$ref": "#/$defs/colors", "description": "Dark mode."},
            "shape": {"$ref": "#/$defs/shape", "description": "Corners."},
            "type": {"$ref": "#/$defs/type", "description": "Fonts."},
            "motion": {"$ref": "#/$defs/motion", "description": "Motion."}
          },
          "x-paths": {"sections": ["light", "dark", "shape", "type", "motion"]},
          "$defs": {
            "colors": {"properties": {\#(colors)}},
            "shape": {"properties": {
              \#(extraShape)
              "radius": {"type": "integer", "minimum": 0, "maximum": 64, "description": "Corner radius."},
              "radius_small": {"type": "integer", "minimum": 0, "maximum": 64, "description": "Small corners."},
              "radius_large": {"type": "integer", "minimum": 0, "maximum": 64, "description": "Large corners."},
              "border_width": {"type": "integer", "minimum": 0, "maximum": 8, "description": "Borders."},
              "blur": {"type": "integer", "minimum": 0, "maximum": 80, "description": "Blur."},
              "shadow": {"type": "number", "minimum": 0, "maximum": 1, "description": "Shadow."},
              "density": {"type": "string", "enum": ["compact", "regular", "spacious"], "description": "Spacing."},
              "indicator": {"type": "string", "enum": ["dot", "bar", "number-block"], "description": "Status mark."}
            }},
            "type": {"properties": {
              "ui": {"type": "string", "pattern": "^.+$", "description": "UI font."},
              "display": {"type": "string", "pattern": "^.+$", "description": "Titles."},
              "mono": {"type": "string", "pattern": "^.+$", "description": "Code."},
              "size": {"type": "integer", "minimum": 10, "maximum": 24, "description": "Size."},
              "weight": {"type": "integer", "minimum": 300, "maximum": 800, "description": "Weight."},
              "line_height": {"type": "number", "minimum": 1.0, "maximum": 2.0, "description": "Line height."}
            }},
            "motion": {"properties": {
              "easing": {"type": "string", "pattern": "^ease$", "description": "Easing."},
              "fast": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "Fast."},
              "normal": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "Normal."},
              "slow": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "Slow."},
              "scale_from": {"type": "number", "minimum": 0.5, "maximum": 1, "description": "Scale."},
              "reduced": {"type": "boolean", "description": "Still."}
            }}
          }
        }}}
        """#
        return Data(text.utf8)
    }

    /// still-water's own values by section, from the checked-in theme.json fixture.
    static func values() throws -> [String: [String: Any]] {
        let root = try JSONSerialization.jsonObject(with: Data(PolycarpFixtures.still_water.utf8)) as! [String: Any]
        return ((root["surfaces"] as! [String: Any])["spaces"] as! [String: [String: Any]])
    }

    static func sections() throws -> [ThemeFieldSection] { try ThemeEditorSchema.parse(schema()).get() }
    static func draft() throws -> ThemeDraft {
        try ThemeDraft.load(name: "still-water", title: "Still Water", sections: sections(), values: values()).get()
    }

    // MARK: Fields from the schema

    func testEachSchemaTypeGetsItsControlInTheSchemasSectionOrder() throws {
        let s = try Self.sections()
        XCTAssertEqual(s.map(\.name), ["light", "dark", "shape", "type", "motion"])
        XCTAssertEqual(s.map(\.title), ["Light colors", "Dark colors", "Shape", "Type", "Motion"])
        let all = Dictionary(uniqueKeysWithValues: s.flatMap(\.fields).map { ($0.path, $0) })
        XCTAssertEqual(all["light.accent"]?.kind, .color)
        XCTAssertEqual(all["shape.radius"]?.kind, .integer(min: 0, max: 64))
        XCTAssertEqual(all["shape.shadow"]?.kind, .number(min: 0, max: 1))
        XCTAssertEqual(all["shape.indicator"]?.kind, .choice(["dot", "bar", "number-block"]))
        XCTAssertEqual(all["motion.reduced"]?.kind, .toggle)
        XCTAssertEqual(all["type.ui"]?.kind, .text)
        XCTAssertEqual(all["type.line_height"]?.kind, .number(min: 1, max: 2))
        XCTAssertEqual(all["shape.radius_small"]?.label, "Radius small")
        XCTAssertEqual(all["shape.radius"]?.help, "Corner radius.")
        // Page, then text, then lines, then status: not the schema's alphabetical order.
        XCTAssertEqual(s[0].fields.map(\.key), ["background", "surface", "sunken", "foreground", "strong", "muted", "border", "selection",
                                                 "accent", "on_accent", "urgent", "working", "done"])
        XCTAssertEqual(s[2].fields.prefix(3).map(\.key), ["radius_small", "radius", "radius_large"])
    }

    func testAFieldTheCLIAddsLaterShowsUpWithNoChangeHere() throws {
        let extra = #""corner_style": {"type": "string", "enum": ["round", "cut"], "description": "New."}, "glow": {"type": "number", "minimum": 0, "maximum": 2},"#
        let shape = try ThemeEditorSchema.parse(Self.schema(extraShape: extra)).get()[2]
        // After the known ones, by name.
        XCTAssertEqual(shape.fields.suffix(2).map(\.key), ["corner_style", "glow"])
        XCTAssertEqual(shape.fields.last?.kind, .number(min: 0, max: 2))
        XCTAssertEqual(shape.fields.suffix(2).first?.kind, .choice(["round", "cut"]))
    }

    func testABrokenSchemaIsOneSentenceNotACrash() {
        XCTAssertThrowsError(try ThemeEditorSchema.parse(Data("[1]".utf8)).get())
        XCTAssertThrowsError(try ThemeEditorSchema.parse(Data(#"{"properties": {}, "$defs": {}}"#.utf8)).get())
    }

    // MARK: The draft

    func testADragIsOneUndoStepAndRedoBringsItBack() throws {
        var d = try Self.draft()
        let start = d["light.accent"]
        XCTAssertFalse(d.canUndo)
        // A drag in the color well: many values, a few hundredths of a second apart.
        for (i, hex) in ["#336666", "#346767", "#356868", "#366969"].enumerated() {
            d.set("light.accent", .text(hex), at: 100 + Double(i) * 0.05)
        }
        XCTAssertEqual(d["light.accent"], .text("#366969"))
        // A later edit, after the gesture ended, is its own step.
        d.set("light.accent", .text("#112233"), at: 105)
        d.set("shape.radius", .number(4), at: 105.1)
        d.undo()
        XCTAssertEqual(d["shape.radius"], .number(10))
        d.undo()
        XCTAssertEqual(d["light.accent"], .text("#366969"))
        d.undo()
        XCTAssertEqual(d["light.accent"], start)
        XCTAssertFalse(d.canUndo)
        d.redo(); d.redo()
        XCTAssertEqual(d["light.accent"], .text("#112233"))
        XCTAssertTrue(d.canRedo)
        // A new edit drops what redo had.
        d.set("motion.reduced", .flag(true), at: 200)
        XCTAssertFalse(d.canRedo)
    }

    func testRevertGoesBackToTheSavedThemeAndUndoReturnsTheEdits() throws {
        var d = try Self.draft()
        d.set("light.accent", .text("#112233"), at: 1)
        d.set("shape.radius", .number(3), at: 5)
        XCTAssertTrue(d.isEdited)
        d.revert()
        XCTAssertFalse(d.isEdited)
        XCTAssertEqual(d.changes().count, 0)
        d.undo()
        XCTAssertEqual(d.changes().map(\.path), ["light.accent", "shape.radius"])
    }

    func testChangesAreOnlyWhatDiffersInEditorOrderAndSavedMakesThemTheBaseline() throws {
        var d = try Self.draft()
        d.set("shape.radius", .number(3), at: 1)
        d.set("light.background", .text("#ffffff"), at: 5)
        // Set and set back is no change.
        d.set("motion.fast", .number(1), at: 9)
        d.set("motion.fast", d.original["motion.fast"]!, at: 20)
        XCTAssertEqual(d.changes().map(\.path), ["light.background", "shape.radius"])
        XCTAssertEqual(ThemeEditorCommands.save("mine", d.changes()),
                       ["theme", "change", "light.background", "#ffffff", "shape.radius", "3", "--theme", "mine", "--json"])
        d.saved()
        XCTAssertFalse(d.isEdited)
        XCTAssertFalse(d.canUndo)
        XCTAssertEqual(d.original["shape.radius"], .number(3))
    }

    func testAnUnknownPathOrTheSameValueIsNotAStep() throws {
        var d = try Self.draft()
        d.set("light.nope", .text("#000000"), at: 1)
        d.set("shape.radius", d["shape.radius"]!, at: 2)
        d.set(["nope.x": .number(1)])
        XCTAssertFalse(d.canUndo)
    }

    func testThePreviewIsWhatTheAppWouldReadAndKeepsDrawingThroughAFaintPair() throws {
        var d = try Self.draft()
        XCTAssertEqual(d.preview?.light.roles["accent"], RGB(hex: "#3f6b6a"))
        XCTAssertEqual(d.preview?.radius, 10)
        d.set("light.muted", .text("#eeeeee"), at: 1)
        d.set("shape.indicator", .text("bar"), at: 3)
        let t = try XCTUnwrap(d.preview, "a faint pair still previews")
        XCTAssertEqual(t.light.roles["muted"], RGB(hex: "#eeeeee"))
        XCTAssertEqual(t.indicator, .bar)
        // The app itself still refuses that file.
        XCTAssertThrowsError(try PolycarpTheme.parse(d.themeJSON()).get())
    }

    func testValuesAreWrittenTheWayTheCommandTakesThem() {
        XCTAssertEqual(ThemeValue.number(12).argument, "12")
        XCTAssertEqual(ThemeValue.number(0.98).argument, "0.98")
        XCTAssertEqual(ThemeValue.flag(false).argument, "false")
        XCTAssertEqual(ThemeValue.text("-apple-system, sans-serif").argument, "-apple-system, sans-serif")
        XCTAssertEqual(ThemeValue.color(RGB(r: 1, g: 0.5, b: 0)), .text("#ff8000"))
    }

    // MARK: Contrast

    func testABuiltInHasNoWarningsAndAFaintMutedNamesEachPairItFails() throws {
        var d = try Self.draft()
        XCTAssertEqual(ThemeEditorContrast.warnings(d), [])
        d.set("light.muted", .text("#c8d0d0"), at: 1)
        let w = ThemeEditorContrast.warnings(d)
        XCTAssertEqual(Set(w.map(\.fill)), ["background", "surface", "sunken"])
        XCTAssertTrue(w.allSatisfy { $0.mode == "light" && $0.text == "muted" && $0.needed == 4.5 && $0.ratio < 4.5 })
        XCTAssertEqual(w.first?.paths, ["light.muted", "light.sunken"], "worst first: sunken is the darkest page")
        XCTAssertTrue(w[0].message.hasPrefix("Light: muted on sunken is 1."), w[0].message)
        XCTAssertTrue(w[0].message.hasSuffix("AA needs 4.5:1 for text."), w[0].message)
    }

    func testMarksOnSunkenNeedThreeAndTheLineIsTheCLIs() {
        let sunken = RGB(hex: "#e3ebeb")!
        // Just under and just over 3:1 for a mark; both are under 4.5 against the page.
        func colors(_ accent: RGB) -> [String: RGB] { ["accent": accent, "sunken": sunken] }
        let under = ThemeEditorContrast.warnings(colors(RGB(hex: "#8a8f8f")!), mode: "light")
        XCTAssertEqual(under.map(\.needed), [3])
        XCTAssertTrue(under[0].message.hasSuffix("AA needs 3:1 for marks."), under[0].message)
        XCTAssertEqual(ThemeEditorContrast.warnings(colors(RGB(hex: "#7d8282")!), mode: "light"), [])
    }

    // MARK: A palette from a picture

    private func picture(_ parts: [(RGB, Int)]) -> [RGB] { parts.flatMap { Array(repeating: $0.0, count: $0.1) } }

    func testAPictureProposesItsColorFittedSoEveryPairStillReads() throws {
        let d = try Self.draft()
        // Mostly sky and sand, with a strong orange: the orange is the accent.
        let orange = RGB(hex: "#f08a24")!
        let px = picture([(RGB(hex: "#dde6ea")!, 600), (RGB(hex: "#c9b79a")!, 300), (orange, 100)])
        let p = try XCTUnwrap(ThemeEditorPalette.propose(px, light: d.colors("light"), dark: d.colors("dark")))
        XCTAssertEqual(p.found.hsb.h, orange.hsb.h, accuracy: 0.02)
        XCTAssertEqual(Set(p.changes.keys), ["light.accent", "light.on_accent", "light.selection", "light.border",
                                             "dark.accent", "dark.on_accent", "dark.selection", "dark.border"])
        // Still orange, in both modes.
        for m in ["light", "dark"] { XCTAssertEqual(p.changes["\(m).accent"]!.color!.hsb.h, orange.hsb.h, accuracy: 0.04) }
        // Accepted, the theme passes every pair the CLI checks.
        var taken = d
        taken.set(p.changes)
        XCTAssertEqual(ThemeEditorContrast.warnings(taken.colors("light"), mode: "light"), [])
        XCTAssertEqual(ThemeEditorContrast.warnings(taken.colors("dark"), mode: "dark"), [])
        XCTAssertEqual(p.swatches.first.map { ThemeEditorPalette.distance($0, RGB(hex: "#dde6ea")!) < 0.05 }, true, "most of the picture first")
        // One step: one undo takes the whole palette back.
        taken.undo()
        XCTAssertEqual(taken.values, d.values)
    }

    func testAVividColorBeatsALargerDullOne() throws {
        let d = try Self.draft()
        // Sand is faintly colored (saturation 0.28) and three times the orange's area; the orange is what people see.
        let orange = RGB(hex: "#e2782c")!
        let px = picture([(RGB(hex: "#d9e2e8")!, 600), (RGB(hex: "#c7b28f")!, 300), (orange, 100)])
        let p = try XCTUnwrap(ThemeEditorPalette.propose(px, light: d.colors("light"), dark: d.colors("dark")))
        XCTAssertEqual(p.found.hsb.h, orange.hsb.h, accuracy: 0.02)
        XCTAssertGreaterThan(p.changes["light.accent"]!.color!.hsb.s, 0.5, "still orange, not a brown gray")
    }

    func testAGrayPictureProposesNothing() throws {
        let d = try Self.draft()
        let px = picture([(RGB(hex: "#202020")!, 500), (RGB(hex: "#9a9a9a")!, 500), (RGB(hex: "#f0f0f0")!, 500)])
        XCTAssertNil(ThemeEditorPalette.propose(px, light: d.colors("light"), dark: d.colors("dark")))
        XCTAssertNil(ThemeEditorPalette.propose([], light: d.colors("light"), dark: d.colors("dark")))
    }

    func testAFaintPastelIsDeepenedForLightAndAShadowLiftedForDark() throws {
        let d = try Self.draft()
        let p = try XCTUnwrap(ThemeEditorPalette.propose(picture([(RGB(hex: "#9fd8ff")!, 50)]), light: d.colors("light"), dark: d.colors("dark")))
        XCTAssertLessThan(p.changes["light.accent"]!.color!.luminance, RGB(hex: "#9fd8ff")!.luminance)
        let q = try XCTUnwrap(ThemeEditorPalette.propose(picture([(RGB(hex: "#1a3a8a")!, 50)]), light: d.colors("light"), dark: d.colors("dark")))
        XCTAssertGreaterThan(q.changes["dark.accent"]!.color!.luminance, RGB(hex: "#1a3a8a")!.luminance)
    }

    // MARK: Import and names

    func testADroppedThemeNeverReplacesABuiltInAndAsksBeforeReplacingYours() {
        let themes = [ThemeCommandReply.Listed(name: "calm", title: "Calm", builtIn: true, current: false),
                      ThemeCommandReply.Listed(name: "mine", title: "Mine", builtIn: false, current: true)]
        guard case .refuse(let why) = ThemeImport.decide(name: "calm", themes: themes) else { return XCTFail("a built-in is refused") }
        XCTAssertTrue(why.contains("built-in"))
        guard case .ask = ThemeImport.decide(name: "mine", themes: themes) else { return XCTFail("yours is asked about") }
        XCTAssertEqual(ThemeImport.decide(name: "new", themes: themes), .save)
        XCTAssertEqual(ThemeImport.kind("/x/My Theme.TOML"), .theme)
        XCTAssertEqual(ThemeImport.kind("/x/beach.jpeg"), .picture)
        XCTAssertEqual(ThemeImport.kind("/x/notes.txt"), .other)
    }

    func testACopyGetsAFreeName() {
        XCTAssertEqual(ThemeEditorCommands.copyName("calm", taken: ["calm"]), "calm-custom")
        XCTAssertEqual(ThemeEditorCommands.copyName("calm", taken: ["calm-custom", "calm-custom-2"]), "calm-custom-3")
    }

    func testTheCommandsOwnWordsComeBackAsTheyAre() {
        let refused = #"{"ok": false, "error": {"code": "contrast", "message": "the theme is not valid", "data": {"errors": [{"message": "light.muted on light.background is 1.04, needs 4.5", "path": "light.muted"}]}}}"#
        let r = ThemeCommandReply(stdout: Data(refused.utf8), status: 1)
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.code, "contrast")
        XCTAssertEqual(r.message, "the theme is not valid\nlight.muted on light.background is 1.04, needs 4.5")
        let crash = ThemeCommandReply(stdout: Data(), stderr: Data("polycarp: boom\n".utf8), status: 2)
        XCTAssertEqual(crash.message, "polycarp: boom")
        let list = ThemeCommandReply(stdout: Data(#"{"ok": true, "data": {"themes": [{"name": "calm", "title": "Calm", "source": "built-in", "current": true}]}}"#.utf8), status: 0)
        XCTAssertEqual(list.themes, [.init(name: "calm", title: "Calm", builtIn: true, current: true)])
    }

    // MARK: The real command

    private var dir: URL!
    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("theme-editor-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func binary() throws -> String {
        if let b = ProcessInfo.processInfo.environment["POLYCARP_BIN"], !b.isEmpty { return b }
        let cli = Repo.root.deletingLastPathComponent().appendingPathComponent("cli/target")
        for p in ["debug", "release"] {
            let c = cli.appendingPathComponent(p).appendingPathComponent("polycarp").path
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        throw XCTSkip("the polycarp binary is not built: set POLYCARP_BIN or run `cargo build --manifest-path cli/Cargo.toml`.")
    }

    private func run(_ args: [String], input: Data? = nil) throws -> ThemeCommandReply {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: try binary())
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["POLYCARP_CONFIG_DIR"] = dir.path
        env["XDG_CONFIG_HOME"] = nil
        p.environment = env
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = inp
        try p.run()
        if let input { inp.fileHandleForWriting.write(input) }
        try inp.fileHandleForWriting.close()
        let o = out.fileHandleForReading.readDataToEndOfFile(), e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return ThemeCommandReply(stdout: o, stderr: e, status: p.terminationStatus)
    }

    private func runData(_ args: [String]) throws -> Data {
        let r = try run(args)
        XCTAssertTrue(r.ok, "\(args): \(r.message)")
        return try JSONSerialization.data(withJSONObject: ["ok": true, "data": r.data])
    }

    private func load(_ name: String, _ sections: [ThemeFieldSection]) throws -> ThemeDraft {
        var values: [String: [String: Any]] = [:]
        for s in sections {
            let r = try run(ThemeEditorCommands.section(s.name, of: name))
            XCTAssertTrue(r.ok, r.message)
            values[s.name] = ThemeDraft.section(r)
        }
        return try ThemeDraft.load(name: name, title: name, sections: sections, values: values).get()
    }

    func testTheRealSchemaGivesEveryFieldAControlAndEveryBuiltInLoads() throws {
        let sections = try ThemeEditorSchema.parse(runData(ThemeEditorCommands.schema)).get()
        XCTAssertEqual(sections.map(\.name), ["light", "dark", "shape", "type", "motion"])
        XCTAssertEqual(sections[0].fields.count, 13)
        for f in sections.flatMap(\.fields) { XCTAssertFalse(f.help.isEmpty, "\(f.path) has help") }
        for t in try run(ThemeEditorCommands.list).themes where t.builtIn {
            let d = try load(t.name, sections)
            XCTAssertNotNil(d.preview, t.name)
            XCTAssertEqual(ThemeEditorContrast.warnings(d), [], "\(t.name) passes the CLI, so the editor shows no warning")
        }
    }

    func testCustomizeThenSaveGoesThroughTheCommandAndOneUndoTakesItBack() throws {
        let sections = try ThemeEditorSchema.parse(runData(ThemeEditorCommands.schema)).get()
        let name = ThemeEditorCommands.copyName("calm", taken: Set(try run(ThemeEditorCommands.list).themes.map(\.name)))
        XCTAssertTrue(try run(ThemeEditorCommands.create(name, extends: "calm")).ok)
        var d = try load(name, sections)
        // calm has reduced on: the editor shows its own durations, not the zeros products read.
        XCTAssertEqual(d["motion.reduced"], .flag(true))
        XCTAssertEqual(d["motion.fast"], .number(120))
        d.set("light.accent", .text("#2a5a8a"), at: 1)
        d.set("shape.radius", .number(3), at: 5)
        d.set("type.ui", .text("-apple-system, sans-serif"), at: 9)
        d.set("motion.reduced", .flag(false), at: 13)
        let saved = try run(ThemeEditorCommands.save(name, d.changes()))
        XCTAssertTrue(saved.ok, saved.message)
        let back = try load(name, sections)
        XCTAssertEqual(back.values, d.values, "what the file holds now is the draft")
        XCTAssertTrue(try run(["theme", "undo", "--json"]).ok)
        let undone = try load(name, sections)
        XCTAssertEqual(undone.values, d.original)

        // A faint pair: the editor warns, and the CLI refuses with its own words and changes nothing.
        d.set("light.muted", .text("#eeeeee"), at: 100)
        XCTAssertFalse(ThemeEditorContrast.warnings(d).isEmpty)
        let refused = try run(ThemeEditorCommands.save(name, d.changes()))
        XCTAssertFalse(refused.ok)
        XCTAssertTrue(refused.message.contains("light.muted on light.background"), refused.message)
    }

    func testADroppedFileIsCheckedThenImportedUnderItsOwnName() throws {
        let good = Data("name = \"drop\"\ntitle = \"Drop\"\nextends = \"calm\"\n\n[light]\naccent = \"#225588\"\n".utf8)
        let checked = try run(ThemeEditorCommands.validateInput, input: good)
        XCTAssertTrue(checked.ok, checked.message)
        let name = try XCTUnwrap(checked.data["name"] as? String)
        XCTAssertEqual(ThemeImport.decide(name: name, themes: try run(ThemeEditorCommands.list).themes), .save)
        let file = dir.appendingPathComponent("Downloaded theme (1).toml")
        try good.write(to: file)
        XCTAssertTrue(try run(ThemeEditorCommands.importFile(file.path)).ok)
        guard case .ask = ThemeImport.decide(name: name, themes: try run(ThemeEditorCommands.list).themes) else { return XCTFail("now it asks") }
        let bad = try run(ThemeEditorCommands.validateInput, input: Data("name = \"x\"\n[light]\naccent = 3\n".utf8))
        XCTAssertFalse(bad.ok)
        XCTAssertFalse(bad.message.isEmpty)
        let toml = try run(ThemeEditorCommands.exportTOML("drop"))
        XCTAssertEqual(toml.data["toml"] as? String, String(decoding: good, as: UTF8.self))
    }
}

import XCTest
@testable import BaneySpacesCore

/// Polycarp themes (`polycarp theme set ...`) as BaneySpaces reads them: strict checking, the mapping
/// to a `ThemeSpec` and a `Palette`, bad files, following the file, and precedence over Settings.
final class PolycarpThemeTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-theme-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        ThemeCenter.use(.baneyspaces)
    }

    private var file: String { dir.appendingPathComponent("theme.json").path }

    private func json(_ text: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
    }

    private func data(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }

    /// A fixture with one change made to its `surfaces.spaces`.
    private func edited(_ fixture: String = PolycarpFixtures.still_water, _ change: (inout [String: Any]) -> Void) -> Data {
        var root = json(fixture)
        var surfaces = root["surfaces"] as! [String: Any]
        var spaces = surfaces["spaces"] as! [String: Any]
        change(&spaces)
        surfaces["spaces"] = spaces
        root["surfaces"] = surfaces
        return data(root)
    }

    private func parse(_ d: Data) -> Result<PolycarpTheme, PolycarpThemeError> { PolycarpTheme.parse(d) }

    private func good(_ fixture: String = PolycarpFixtures.still_water) throws -> PolycarpTheme {
        try parse(Data(fixture.utf8)).get()
    }

    private func failure(_ d: Data, file: StaticString = #filePath, line: UInt = #line) -> String {
        switch parse(d) {
        case .success: XCTFail("expected a refusal", file: file, line: line); return ""
        case .failure(let e): return e.description
        }
    }

    // MARK: The checked-in files

    func testStillWaterParsesAndMapsToSpecAndPalette() throws {
        let t = try good()
        XCTAssertEqual(t.name, "still-water")
        XCTAssertEqual(t.title, "Still Water")
        XCTAssertEqual(t.mode, .auto)
        let s = t.spec
        XCTAssertEqual(s.label, "Still Water")
        XCTAssertEqual(s.radius, .init(bar: 16, tile: 10, row: 6, list: 10))
        XCTAssertEqual(s.border.width, 1)
        XCTAssertEqual(s.border.role, "border")
        XCTAssertEqual(s.border.focusedRole, "accent")
        XCTAssertEqual(s.border.focusedWidth, 1.5)
        XCTAssertNil(s.fill.material, "blur 0 is an opaque fill")
        XCTAssertEqual(s.fill.opacity, 1)
        XCTAssertFalse(s.fill.adjustable)
        XCTAssertEqual(s.shadow, .init(radius: 24, y: 10, opacity: 0.12))
        XCTAssertEqual(s.font, .init(family: "system-sans", size: 12, weight: "regular"))
        XCTAssertEqual(s.space, .init(gap: 8, padding: 10, tile: 64))
        XCTAssertEqual(s.indicator, .dot)
        XCTAssertEqual(s.motion, .init(inMs: 200, outMs: 120, listInMs: 200, listOutMs: 120, rowMs: 120, scaleFrom: 0.98, lift: 1.04))
        // The palette is the spaces section's, by mode.
        XCTAssertEqual(t.palette(systemDark: true).color("background"), RGB(hex: "#1f2a2d"))
        XCTAssertEqual(t.palette(systemDark: false).color("background"), RGB(hex: "#f1f5f5"))
        XCTAssertTrue(t.palette(systemDark: true).isDark)
        XCTAssertFalse(t.palette(systemDark: false).isDark)
        XCTAssertEqual(t.accent(systemDark: true), RGB(hex: "#a5cfcb"))
        for role in Palette.roles { XCTAssertNotNil(t.palette(systemDark: true).color(role), role) }
    }

    func testBlocksDarkIsSquareMonospaceAndNumbered() throws {
        let t = try good(PolycarpFixtures.blocks)
        XCTAssertEqual(t.mode, .dark)
        XCTAssertTrue(t.palette(systemDark: false).isDark, "dark is dark whatever the system says")
        XCTAssertTrue(t.isDark(systemDark: false))
        let s = t.spec
        XCTAssertEqual(s.radius, .init(bar: 0, tile: 0, row: 0, list: 0))
        XCTAssertEqual(s.border.width, 2)
        XCTAssertEqual(s.indicator, .numberBlock)
        XCTAssertEqual(s.font.family, "monospace")
        XCTAssertNil(s.shadow)
        XCTAssertEqual(s.motion.scaleFrom, 1)
        XCTAssertEqual(s.motion.lift, 1)
        XCTAssertFalse(s.motion.slides)
    }

    func testModeDecidesWhichPaletteDraws() throws {
        let t = try good()
        XCTAssertEqual(t.look(systemDark: true).palette, t.palette(systemDark: true))
        XCTAssertEqual(t.look(systemDark: false).palette, t.palette(systemDark: false))
        for mode in ["light", "dark"] {
            var r = json(PolycarpFixtures.still_water)
            r["mode"] = mode
            let m = try parse(data(r)).get()
            XCTAssertEqual(m.palette(systemDark: true).isDark, mode == "dark")
            XCTAssertEqual(m.palette(systemDark: false).isDark, mode == "dark")
        }
    }

    func testTheLookDrawsPolycarpColorsThroughTheExistingRoles() throws {
        let look = try good().look(systemDark: true)
        XCTAssertEqual(look.theme, PolycarpTheme.carrier)
        XCTAssertEqual(look.polycarp, "still-water")
        XCTAssertFalse(look.isAuto)
        XCTAssertFalse(look.isShipped)
        XCTAssertEqual(look.color("foreground"), RGB(hex: "#e8f0f0"))
        XCTAssertEqual(look.color("light"), RGB(r: 1, g: 1, b: 1))
        // Every text pair the look draws reads, as ThemeConformanceTests holds the built-in looks to.
        for p in look.textPairs(accent: look.color("accent")) {
            XCTAssertGreaterThanOrEqual(p.text.contrast(with: p.fill), 4.5, p.name)
        }
    }

    func testShapeBlurFillAndDensity() throws {
        func theme(_ change: (inout [String: Any]) -> Void) throws -> PolycarpTheme { try parse(edited(PolycarpFixtures.still_water, change)).get() }
        let blurry = try theme { var sh = $0["shape"] as! [String: Any]; sh["blur"] = 12; sh["shadow"] = 0.3; sh["density"] = "compact"; $0["shape"] = sh }
        XCTAssertEqual(blurry.spec.fill.material, "ultra-thin")
        XCTAssertEqual(blurry.spec.fill.opacity, 0.92)
        XCTAssertEqual(blurry.spec.shadow?.opacity, 0.3)
        XCTAssertEqual(blurry.spec.space, .init(gap: 6, padding: 8, tile: 56))
        let roomy = try theme { var sh = $0["shape"] as! [String: Any]; sh["density"] = "spacious"; sh["border_width"] = 0; $0["shape"] = sh }
        XCTAssertEqual(roomy.spec.space, .init(gap: 10, padding: 12, tile: 72))
        XCTAssertEqual(roomy.spec.border.width, 0)
        XCTAssertEqual(roomy.spec.border.focusedWidth, 0)
    }

    func testReducedMotionHasNoDurationAndNoScale() throws {
        let t = try parse(edited { var m = $0["motion"] as! [String: Any]; m["reduced"] = true; $0["motion"] = m }).get()
        let m = t.spec.motion
        XCTAssertEqual([m.inMs, m.outMs, m.listInMs, m.listOutMs, m.rowMs], [0, 0, 0, 0, 0])
        XCTAssertEqual(m.scaleFrom, 1)
        XCTAssertEqual(m.lift, 1)
    }

    func testTypeMapsToSizeWeightAndFamily() throws {
        func theme(_ ui: String, size: Double = 16, weight: Double = 400) throws -> PolycarpTheme {
            try parse(edited { var t = $0["type"] as! [String: Any]; t["ui"] = ui; t["size"] = size; t["weight"] = weight; $0["type"] = t }).get()
        }
        XCTAssertEqual(try theme("system-ui, sans-serif").spec.font.family, "system-sans")
        XCTAssertEqual(try theme("ui-monospace, Menlo").spec.font.family, "monospace")
        let own = try theme("\"Iowan Old Style\", Georgia, serif", size: 20, weight: 600)
        XCTAssertEqual(own.spec.font, .init(family: PolycarpTheme.fontKey, size: 15, weight: "medium"))
        XCTAssertEqual(own.look(systemDark: true).families(for: PolycarpTheme.fontKey), ["Iowan Old Style", "Georgia", FontFace.systemSerif])
        XCTAssertEqual(own.look(systemDark: true).families(for: "monospace"), ThemeCatalog.shared.fontFamilies("monospace"))
        XCTAssertNil(try theme("system-ui").fontFamilies)
    }

    func testASerifStackResolvesToANativeSerifFont() throws {
        func resolved(_ ui: String) throws -> String {
            let t = try parse(edited { var t = $0["type"] as! [String: Any]; t["ui"] = ui; $0["type"] = t }).get()
            XCTAssertEqual(t.spec.font.family, PolycarpTheme.fontKey, ui)
            let font = try XCTUnwrap(FontFace.resolve(families: t.look(systemDark: false).families(for: PolycarpTheme.fontKey), weight: .regular, size: 13), ui)
            return CTFontCopyFamilyName(font) as String
        }
        // The resolved font, not the key: New York is the system's serif; sans resolves to something else.
        for ui in ["serif", "ui-serif", "ui-serif, serif", "No Such Font 123, serif"] {
            XCTAssertEqual(try resolved(ui), FontFace.systemSerif, ui)
        }
        XCTAssertNotEqual(FontFace.systemSerif, CTFontCopyFamilyName(try XCTUnwrap(CTFontCreateUIFontForLanguage(.system, 13, nil))) as String)
        XCTAssertEqual(try resolved("ui-serif, Georgia, serif"), "Georgia")
        // Only a serif first generic name asks for it: a sans stack that merely ends in serif's cousin does not.
        let sans = try parse(edited { var t = $0["type"] as! [String: Any]; t["ui"] = "Nope Nope, sans-serif, serif"; $0["type"] = t }).get()
        XCTAssertEqual(sans.fontFamilies, ["Nope Nope"])
        XCTAssertEqual(try parse(edited { var t = $0["type"] as! [String: Any]; t["ui"] = "system-ui, serif"; $0["type"] = t }).get().spec.font.family, "system-sans")
    }

    // MARK: Strict checking

    func testColorsMustBeSixDigitHex() {
        for bad in ["#FFF", "ffffff", "#gggggg", "#1234567", "#12345", "", "rgb(0,0,0)", " #ffffff"] {
            let d = edited { var l = $0["dark"] as! [String: Any]; l["accent"] = bad; $0["dark"] = l }
            XCTAssertEqual(failure(d), "dark.accent is not #rrggbb", bad)
        }
        let d = edited { var l = $0["dark"] as! [String: Any]; l["accent"] = 12; $0["dark"] = l }
        XCTAssertEqual(failure(d), "dark.accent is missing")
        XCTAssertNoThrow(try parse(edited { var l = $0["dark"] as! [String: Any]; l["accent"] = "#A5CFCB"; $0["dark"] = l }).get(), "capitals are fine")
    }

    func testNumbersMustBeInRangeAndReallyNumbers() {
        func edit(_ section: String, _ key: String, _ v: Any) -> Data {
            edited { var s = $0[section] as! [String: Any]; s[key] = v; $0[section] = s }
        }
        XCTAssertTrue(failure(edit("shape", "radius", 65)).contains("radius is 65.0"))
        XCTAssertTrue(failure(edit("shape", "radius", -1)).contains("radius"))
        XCTAssertTrue(failure(edit("shape", "border_width", 9)).contains("border_width"))
        XCTAssertTrue(failure(edit("shape", "blur", 81)).contains("blur"))
        XCTAssertTrue(failure(edit("shape", "shadow", 1.5)).contains("shadow"))
        XCTAssertTrue(failure(edit("type", "size", 9)).contains("size"))
        XCTAssertTrue(failure(edit("type", "weight", 900)).contains("weight"))
        XCTAssertTrue(failure(edit("motion", "fast", 1001)).contains("fast"))
        XCTAssertTrue(failure(edit("motion", "scale_from", 0.4)).contains("scale_from"))
        XCTAssertTrue(failure(edit("shape", "radius", "10")).contains("not a number"), "a string is not a number")
        XCTAssertTrue(failure(edit("shape", "radius", true)).contains("not a number"), "true is not a number")
        XCTAssertTrue(failure(edit("shape", "radius", NSNull())).contains("not a number"))
    }

    func testEnumsAndFlagsMustBeKnown() {
        func edit(_ section: String, _ key: String, _ v: Any) -> Data {
            edited { var s = $0[section] as! [String: Any]; s[key] = v; $0[section] = s }
        }
        XCTAssertTrue(failure(edit("shape", "density", "tight")).contains("density"))
        XCTAssertTrue(failure(edit("shape", "indicator", "star")).contains("indicator"))
        XCTAssertTrue(failure(edit("motion", "reduced", 1)).contains("reduced"), "1 is not a boolean")
        XCTAssertTrue(failure(edit("motion", "reduced", "true")).contains("reduced"))
        XCTAssertTrue(failure(edit("motion", "easing", "bounce")).contains("easing"))
        XCTAssertTrue(failure(edit("motion", "easing", "cubic-bezier(2, 0, 0, 1)")).contains("easing"))
        XCTAssertTrue(failure(edit("motion", "easing", "cubic-bezier(0, 0, 0)")).contains("easing"))
        var root = json(PolycarpFixtures.still_water)
        root["mode"] = "sepia"
        XCTAssertTrue(failure(data(root)).contains("mode"))
        root["mode"] = nil
        XCTAssertTrue(failure(data(root)).contains("mode"))
    }

    func testMissingSectionsAreRefused() {
        XCTAssertTrue(failure(edited { $0["shape"] = nil }).contains("shape is missing"))
        XCTAssertTrue(failure(edited { $0["type"] = nil }).contains("type is missing"))
        XCTAssertTrue(failure(edited { $0["motion"] = nil }).contains("motion is missing"))
        XCTAssertTrue(failure(edited { $0["light"] = nil }).contains("light is missing"))
        XCTAssertTrue(failure(edited { $0["dark"] = "none" }).contains("dark is missing"))
        var root = json(PolycarpFixtures.still_water)
        root["surfaces"] = ["voice": [:]]
        XCTAssertTrue(failure(data(root)).contains("surfaces.spaces is missing"))
        root["surfaces"] = nil
        XCTAssertTrue(failure(data(root)).contains("surfaces.spaces is missing"))
    }

    func testFontStacksCannotCarryCSS() {
        for bad in ["url(x)", "a; b", "{x}", "\"unclosed", "a, , b", "'a\\b'", "\"a<b\"", "\"a/*b\"", "", "   ", String(repeating: "a", count: 301)] {
            let d = edited { var t = $0["type"] as! [String: Any]; t["display"] = bad; $0["type"] = t }
            XCTAssertTrue(failure(d).contains("display is not a font stack"), bad)
        }
        XCTAssertEqual(PolycarpTheme.parseStack("Newsreader, \"Iowan Old Style\", Georgia, serif"), ["Newsreader", "Iowan Old Style", "Georgia", "serif"])
    }

    func testUnreadableContrastIsRefusedInBothModes() {
        for mode in ["light", "dark"] {
            for (key, other) in [("foreground", "background"), ("muted", "surface"), ("foreground", "selection"), ("on_accent", "accent")] {
                let d = edited { var m = $0[mode] as! [String: Any]; m[key] = m[other]; $0[mode] = m }
                let why = failure(d)
                // The first unreadable pair is the one named, which may be an earlier pair that shares the color.
                XCTAssertTrue(why.hasPrefix("\(mode).") && why.hasSuffix("needs 4.5"), "\(mode) \(key) on \(other): \(why)")
            }
        }
    }

    func testEveryPairTheCommandChecksIsCheckedHere() {
        // The CLI also holds strong and muted on sunken, the status colors on background and surface at 4.5,
        // and on sunken at 3.
        for (mode, role, other) in [("dark", "strong", "sunken"), ("light", "muted", "sunken"), ("dark", "done", "surface"),
                                    ("light", "urgent", "background"), ("dark", "working", "background"), ("light", "accent", "surface")] {
            let d = edited { var m = $0[mode] as! [String: Any]; m[role] = m[other]; $0[mode] = m }
            let why = failure(d)
            XCTAssertTrue(why.hasPrefix("\(mode)."), "\(mode) \(role) on \(other): \(why)")
        }
    }

    func testAFileThatPassesTheCommandsPairsButFailsADrawnPairIsRefused() {
        // Black text on red fills and a green sunken: every pair the command checks holds (4.5 and up on each fill
        // alone), but the tooltip draws on sunken at 78% over the background, a dark olive that is 4.1:1.
        let d = edited { var m = $0["dark"] as! [String: Any]
            for r in ["foreground", "strong", "muted", "urgent", "working", "done", "accent"] { m[r] = "#000000" }
            for r in ["background", "surface", "selection"] { m[r] = "#ff0000" }
            m["sunken"] = "#00a000"; m["on_accent"] = "#ffffff"
            $0["dark"] = m }
        let why = failure(d)
        XCTAssertTrue(why.hasPrefix("dark: tooltip text is"), why)
    }

    func testSchemaMustBeTheOneKnown() throws {
        func with(_ schema: Any?) -> Data {
            var root = json(PolycarpFixtures.still_water)
            if let schema { root["schema"] = schema } else { root.removeValue(forKey: "schema") }
            return data(root)
        }
        XCTAssertNoThrow(try parse(with(1)).get())
        let newer = failure(with(2))
        XCTAssertTrue(newer.contains("schema 2") && newer.contains("update BaneySpaces"), newer)
        XCTAssertTrue(failure(with(nil)).contains("schema is missing"))
        XCTAssertTrue(failure(with("1")).contains("schema is missing or not a whole number"))
        XCTAssertTrue(failure(with(1.5)).contains("not a whole number"))
        XCTAssertTrue(failure(with(true)).contains("not a whole number"))
        XCTAssertTrue(failure(with(0)).contains("schema 0"))
    }

    func testNotAnObjectIsRefused() {
        for text in ["", "null", "[]", "42", "\"theme\"", "{", "{\"mode\":\"auto\"}", "\u{0}\u{1}"] {
            XCTAssertFalse(isSuccess(parse(Data(text.utf8))), text)
        }
        XCTAssertFalse(isSuccess(parse(Data([0xff, 0xfe, 0xfd]))))
    }

    private func isSuccess(_ r: Result<PolycarpTheme, PolycarpThemeError>) -> Bool { if case .success = r { true } else { false } }

    func testNamesAreCappedAndCleaned() throws {
        var root = json(PolycarpFixtures.still_water)
        root["title"] = String(repeating: "x", count: 49)
        XCTAssertEqual(try parse(data(root)).get().title, "still-water", "a title over 48 bytes falls back to the name")
        root["title"] = "Bad\u{7}Title"
        XCTAssertEqual(try parse(data(root)).get().title, "still-water")
        root["name"] = nil
        root["title"] = nil
        XCTAssertEqual(try parse(data(root)).get().title, "Polycarp")
    }

    // MARK: Files

    func testALoadedFileIsTheFixture() throws {
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(PolycarpThemeFile.load(path: file).theme, try good())
    }

    func testMissingIsQuietAndEverythingElseIsRejected() throws {
        XCTAssertEqual(PolycarpThemeFile.load(path: file), .missing)
        XCTAssertEqual(PolycarpThemeFile.load(path: dir.appendingPathComponent("no/such/dir/theme.json").path), .missing)
        // A directory at the path.
        try FileManager.default.createDirectory(atPath: file, withIntermediateDirectories: false)
        XCTAssertEqual(PolycarpThemeFile.load(path: file), .rejected("not a regular file"))
        try FileManager.default.removeItem(atPath: file)
        // Corrupt.
        try Data("{\"mode\": \"auto\", ".utf8).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(PolycarpThemeFile.load(path: file), .rejected("not a JSON object"))
        // Binary junk.
        try Data((0..<2048).map { UInt8(truncatingIfNeeded: $0 &* 31) }).write(to: URL(fileURLWithPath: file))
        if case .rejected = PolycarpThemeFile.load(path: file) {} else { XCTFail("junk was accepted") }
        // Unreadable permissions.
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file) }
        if getuid() != 0 {
            if case .rejected(let why) = PolycarpThemeFile.load(path: file) { XCTAssertTrue(why.hasPrefix("unreadable")) } else { XCTFail("read a 000 file") }
        }
    }

    func testAnOversizedFileIsRefusedBeforeItIsRead() throws {
        // Valid JSON padded past the limit: refused on size, whatever is in it.
        var root = json(PolycarpFixtures.still_water)
        root["padding"] = String(repeating: "a", count: PolycarpTheme.maxBytes)
        try data(root).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(PolycarpThemeFile.load(path: file), .rejected("over \(PolycarpTheme.maxBytes) bytes"))
        XCTAssertEqual(failure(data(root)), "over \(PolycarpTheme.maxBytes) bytes")
        // Exactly at the limit still parses (padding trimmed to fit).
        let base = data(json(PolycarpFixtures.still_water)).count
        root["padding"] = String(repeating: "a", count: PolycarpTheme.maxBytes - base - 15)
        let atLimit = data(root)
        XCTAssertLessThanOrEqual(atLimit.count, PolycarpTheme.maxBytes)
        XCTAssertTrue(isSuccess(parse(atLimit)))
    }

    func testANamedPipeDoesNotHangTheRead() throws {
        XCTAssertEqual(mkfifo(file, 0o600), 0)
        XCTAssertEqual(PolycarpThemeFile.load(path: file), .rejected("not a regular file"))
    }

    func testASymlinkToAThemeIsFollowed() throws {
        let real = dir.appendingPathComponent("real.json").path
        try PolycarpFixtures.blocks.write(toFile: real, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: file, withDestinationPath: real)
        XCTAssertEqual(PolycarpThemeFile.load(path: file).theme?.name, "blocks")
    }

    // MARK: Where the file is

    func testConfigDirFollowsThePolycarpCommand() {
        func dir(_ env: [String: String], home: String? = "/Users/x", windows: Bool = false) -> String? {
            PolycarpThemeFile.configDir(env: { env[$0] }, home: home, windows: windows)
        }
        XCTAssertEqual(dir(["POLYCARP_CONFIG_DIR": "/c", "XDG_CONFIG_HOME": "/x"]), "/c")
        XCTAssertNil(dir(["POLYCARP_CONFIG_DIR": "relative", "XDG_CONFIG_HOME": "/x"]), "a relative override is refused, not skipped")
        XCTAssertEqual(dir(["XDG_CONFIG_HOME": "/x"]), "/x/polycarp")
        XCTAssertEqual(dir(["XDG_CONFIG_HOME": "x"]), "/Users/x/.config/polycarp", "a relative XDG is ignored")
        XCTAssertEqual(dir(["POLYCARP_CONFIG_DIR": "", "XDG_CONFIG_HOME": ""]), "/Users/x/.config/polycarp", "empty counts as unset")
        XCTAssertNil(dir([:], home: nil))
        XCTAssertEqual(dir(["APPDATA": "C:\\A", "XDG_CONFIG_HOME": "/x"], windows: true), "C:\\A\\Polycarp")
        XCTAssertEqual(PolycarpThemeFile.path(env: ["POLYCARP_CONFIG_DIR": "/c"]), "/c/current/theme.json")
    }

    // MARK: Following the file

    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [PolycarpTheme?] = []
        private var logs: [String] = []
        func add(_ t: PolycarpTheme?) { lock.lock(); items.append(t); lock.unlock() }
        func addLog(_ l: String) { lock.lock(); logs.append(l); lock.unlock() }
        var themes: [PolycarpTheme?] { lock.lock(); defer { lock.unlock() }; return items }
        var lines: [String] { lock.lock(); defer { lock.unlock() }; return logs }
    }

    private final class Fails: @unchecked Sendable {
        var left = 0
        func next() -> Bool { if left > 0 { left -= 1; return true }; return false }
    }

    private func watcher(_ seen: Seen) -> PolycarpThemeWatcher {
        PolycarpThemeWatcher(path: file, log: seen.addLog, deliver: seen.add)
    }

    func testTheWatcherFollowsTheFileFromMissingToThemeToChangedToRemoved() throws {
        let seen = Seen()
        let w = watcher(seen)
        w.tickNow()
        XCTAssertEqual(seen.themes.count, 1, "the first look reports what is there: nothing")
        XCTAssertNil(seen.themes.last!)
        w.tickNow()
        XCTAssertEqual(seen.themes.count, 1, "an unchanged stat reports nothing")

        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "still-water")
        w.tickNow()
        XCTAssertEqual(seen.themes.count, 2)

        try PolycarpFixtures.blocks.write(toFile: file, atomically: true, encoding: .utf8)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "blocks")

        try FileManager.default.removeItem(atPath: file)
        w.tickNow()
        XCTAssertNil(seen.themes.last!, "a file removed while running reports nil")
        XCTAssertEqual(seen.themes.count, 4)
        XCTAssertTrue(seen.lines.contains { $0.contains("still-water") })
        XCTAssertTrue(seen.lines.contains { $0.contains("file removed") })
    }

    func testABadFileReportsNilOnceAndLogsItOnce() throws {
        let seen = Seen()
        let w = watcher(seen)
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        w.tickNow()
        try Data("{ nope".utf8).write(to: URL(fileURLWithPath: file))
        w.tickNow()
        XCTAssertNil(seen.themes.last!, "a theme that went bad is not in force")
        w.tickNow(); w.tickNow()
        XCTAssertEqual(seen.lines.filter { $0.contains("ignored") }.count, 1)
    }

    func testADirectoryAtThePathIsIgnoredAndTheWatcherSurvives() throws {
        let seen = Seen()
        let w = watcher(seen)
        try FileManager.default.createDirectory(atPath: file, withIntermediateDirectories: false)
        w.tickNow()
        XCTAssertNil(seen.themes.last!)
        XCTAssertTrue(seen.lines.last!.contains("not a regular file"))
        try FileManager.default.removeItem(atPath: file)
        try PolycarpFixtures.blocks.write(toFile: file, atomically: true, encoding: .utf8)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "blocks")
    }

    func testRestoringReadPermissionWithoutRewritingTheFileReadsItAgain() throws {
        let seen = Seen()
        let w = watcher(seen)
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(chmod(file, 0o000), 0)
        defer { _ = chmod(file, 0o644) }
        w.tickNow()
        XCTAssertNil(seen.themes.last!, "unreadable: no theme")
        let before = seen.themes.count
        w.tickNow()
        XCTAssertEqual(seen.themes.count, before, "still unreadable and unchanged: nothing new")
        XCTAssertEqual(chmod(file, 0o644), 0)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "still-water", "same mtime, size and inode, but the mode changed")
        // And the other way: a theme in force stops when its file becomes unreadable.
        XCTAssertEqual(chmod(file, 0o000), 0)
        w.tickNow()
        XCTAssertNil(seen.themes.last!)
    }

    func testAnUnreadableFolderOrASymlinkLoopIsIgnoredOnceAndRecovers() throws {
        let sub = dir.appendingPathComponent("current").path
        try FileManager.default.createDirectory(atPath: sub, withIntermediateDirectories: false)
        let inner = sub + "/theme.json"
        let seen = Seen()
        let w = PolycarpThemeWatcher(path: inner, log: seen.addLog, deliver: seen.add)
        try PolycarpFixtures.still_water.write(toFile: inner, atomically: true, encoding: .utf8)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "still-water")
        XCTAssertEqual(chmod(sub, 0o000), 0)
        defer { _ = chmod(sub, 0o755) }
        for _ in 0..<4 { w.tickNow() }
        XCTAssertNil(seen.themes.last!, "a folder that can't be searched is no theme")
        XCTAssertEqual(seen.lines.filter { $0.contains("ignored") }.count, 1, "one line, not one a second: \(seen.lines)")
        XCTAssertFalse(seen.lines.contains { $0.contains("file removed") }, "it was not removed")
        XCTAssertEqual(chmod(sub, 0o755), 0)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "still-water", "searchable again")

        try FileManager.default.removeItem(atPath: inner)
        try FileManager.default.createSymbolicLink(atPath: inner, withDestinationPath: inner)
        let before = seen.lines.filter { $0.contains("ignored") }.count
        for _ in 0..<3 { w.tickNow() }
        XCTAssertNil(seen.themes.last!)
        XCTAssertEqual(seen.lines.filter { $0.contains("ignored") }.count, before + 1)
    }

    func testAReadThatFailsForNowKeepsTheThemeAndIsRetriedWithoutAChange() throws {
        let failing: PolycarpThemeFile.ReadCall = { _, _, _ in errno = EIO; return -1 }
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(PolycarpThemeFile.load(path: file, read: failing), .failed("unreadable: Input/output error"))
        XCTAssertEqual(PolycarpThemeFile.load(path: file).theme?.name, "still-water")

        let seen = Seen()
        let fail = Fails()
        let w = PolycarpThemeWatcher(path: file, log: seen.addLog, load: { p in
            fail.next() ? PolycarpThemeFile.load(path: p, read: failing) : PolycarpThemeFile.load(path: p)
        }, deliver: seen.add)
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "still-water")
        // Rewritten, and the next read fails once (EMFILE, EIO, ...): the theme in force stays, nothing is delivered.
        try PolycarpFixtures.blocks.write(toFile: file, atomically: true, encoding: .utf8)
        fail.left = 2
        let count = seen.themes.count
        w.tickNow(); w.tickNow()
        XCTAssertEqual(seen.themes.count, count, "a failed read is not 'no theme'")
        XCTAssertEqual(seen.lines.filter { $0.contains("could not read") }.count, 1, "one line, not one per tick")
        // The file did not change in between, and the next tick reads it.
        w.tickNow()
        XCTAssertEqual(seen.themes.last??.name, "blocks")
    }

    func testAThemeFileThatIsThereIsReadBeforeStartReturns() throws {
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        let seen = Seen()
        let w = watcher(seen)
        defer { w.stop() }
        XCTAssertEqual(w.start(firstLookWithin: 5), .theme(try good()))
        w.tickNow()
        XCTAssertTrue(seen.themes.isEmpty, "the caller applies the first look; it is not delivered twice")
        // No file, and a file that is refused: settled too, with nothing to apply.
        let none = Seen()
        let w2 = PolycarpThemeWatcher(path: dir.appendingPathComponent("nope.json").path, deliver: none.add)
        defer { w2.stop() }
        XCTAssertEqual(w2.start(firstLookWithin: 5), .none)
    }

    func testASlowDiskCostsOnlyTheWaitAndTheThemeArrivesLater() throws {
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        let seen = Seen()
        let arrived = expectation(description: "delivered")
        let w = PolycarpThemeWatcher(path: file, load: { p in Thread.sleep(forTimeInterval: 0.6); return PolycarpThemeFile.load(path: p) },
                                     deliver: { seen.add($0); arrived.fulfill() })
        defer { w.stop() }
        let t0 = Date()
        XCTAssertEqual(w.start(firstLookWithin: 0.05), .pending)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 0.4, "launch did not wait for the disk")
        wait(for: [arrived], timeout: 5)
        XCTAssertEqual(seen.themes.last??.name, "still-water")
    }

    func testAccentIsTheThemesWhileOneIsInForceAndComesFromTheLook() throws {
        var settings = AppearanceSettings()
        settings.accent = .preset(.red)
        let system = RGB(r: 0.1, g: 0.2, b: 0.3)
        let t = try good()
        for dark in [false, true] {
            let look = t.look(systemDark: dark)
            XCTAssertEqual(settings.accentRGB(look: look, system: system), t.accent(systemDark: dark))
            XCTAssertEqual(settings.accentRGB(look: look, system: system), look.color("accent"))
        }
        let own = settings.look(systemAccent: system)
        XCTAssertEqual(settings.accentRGB(look: own, system: system), settings.accentRGB(system: system), "no theme, no change")
        XCTAssertNotEqual(settings.accentRGB(system: system), t.accent(systemDark: false))
    }

    func testTheTimerPollsOnItsOwnQueueNotTheMainThread() throws {
        let seen = Seen()
        let ran = expectation(description: "delivered")
        ran.assertForOverFulfill = false
        let w = PolycarpThemeWatcher(path: file, interval: 0.05, log: { _ in }, deliver: { t in
            XCTAssertFalse(Thread.isMainThread)
            seen.add(t)
            if t != nil { ran.fulfill() }
        })
        w.start()
        try PolycarpFixtures.still_water.write(toFile: file, atomically: true, encoding: .utf8)
        wait(for: [ran], timeout: 3)
        w.stop()
        XCTAssertEqual(seen.themes.last??.name, "still-water")
    }

    func testAWatcherWithNoPathDoesNothing() {
        let seen = Seen()
        let w = PolycarpThemeWatcher(path: nil, deliver: seen.add)
        w.start(); w.tickNow()
        XCTAssertTrue(seen.themes.isEmpty)
    }

    // MARK: Precedence

    func testAPolycarpThemeWinsAndRemovingItBringsTheStoredChoiceBackUntouched() throws {
        var stored = AppearanceSettings()
        stored.theme = .omarchy
        stored.colorPalette = PaletteCatalog.shared.names.first!
        let before = stored
        let accent = AccentPreset.red.rgb
        let own = stored.look(systemAccent: accent)

        let t = try good()
        let withPolycarp = stored.look(systemAccent: accent, polycarp: t, systemDark: true)
        XCTAssertEqual(withPolycarp, t.look(systemDark: true))
        XCTAssertNotEqual(withPolycarp.palette, own.palette)
        XCTAssertNotEqual(withPolycarp.spec, own.spec)
        XCTAssertEqual(stored, before, "the stored choice is never rewritten")
        XCTAssertEqual(stored.encoded(), before.encoded())

        let removed = stored.look(systemAccent: accent, polycarp: nil, systemDark: true)
        XCTAssertEqual(removed, own, "without the file the person's own choice draws")
        XCTAssertEqual(stored.theme, .omarchy)
        XCTAssertEqual(stored.colorPalette, before.colorPalette)
    }

    func testThemeCenterUsesThePolycarpSpecAndGivesBackTheCatalogOne() throws {
        let t = try good(PolycarpFixtures.blocks)
        ThemeCenter.use(.omarchy)
        let before = ThemeCenter.spec
        ThemeCenter.use(.omarchy, polycarp: t)
        XCTAssertEqual(ThemeCenter.spec, t.spec)
        XCTAssertEqual(ThemeCenter.id, PolycarpTheme.carrier)
        XCTAssertEqual(ThemeCenter.polycarp, "blocks")
        XCTAssertEqual(DockMotion.dockIn, 0.1, "code with no view reads the Polycarp motion")
        ThemeCenter.use(.omarchy)
        XCTAssertEqual(ThemeCenter.spec, before)
        XCTAssertEqual(ThemeCenter.id, .omarchy)
        XCTAssertNil(ThemeCenter.polycarp)
    }

    func testEverySurfaceResolvesInAPolycarpLookWithoutAnOutlier() throws {
        for fixture in [PolycarpFixtures.still_water, PolycarpFixtures.blocks] {
            let t = try good(fixture)
            let look = t.look(systemDark: true)
            for s in Surface.allCases {
                let style = SurfaceStyle.make(s, theme: look.theme, spec: look.spec)
                XCTAssertEqual(style.radius, s.shippedRadius * look.spec.radius.value(s.kind) / ThemeCatalog.shared.spec(.baneyspaces).radius.value(s.kind), accuracy: 1e-9, s.rawValue)
                XCTAssertEqual(style.borderWidth, t.spec.border.width, s.rawValue)
                let panel = PanelLook.make(s, look: look, settings: AppearanceSettings(), accent: look.color("accent"))
                XCTAssertEqual(panel.fill, look.color("background"))
                XCTAssertNil(panel.wash, "a Polycarp panel is never tinted by Settings")
            }
        }
    }

    // MARK: The real command

    private func polycarpBinary() throws -> String {
        if let b = ProcessInfo.processInfo.environment["POLYCARP_BIN"], !b.isEmpty { return b }
        let cli = Repo.root.deletingLastPathComponent().appendingPathComponent("cli/target")
        for p in ["debug", "release"] {
            let c = cli.appendingPathComponent(p).appendingPathComponent("polycarp").path
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        throw XCTSkip("the polycarp binary is not built: set POLYCARP_BIN or run `cargo build --manifest-path cli/Cargo.toml`. The checked-in fixtures still run.")
    }

    private func polycarp(_ bin: String, _ config: URL, _ args: [String]) throws -> Data {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["POLYCARP_CONFIG_DIR"] = config.path
        env["XDG_CONFIG_HOME"] = nil
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        try p.run()
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "polycarp \(args): \(String(decoding: e, as: UTF8.self))")
        return o
    }

    func testEveryBuiltInThemeFromTheRealCommandLoadsInEveryMode() throws {
        let bin = try polycarpBinary()
        let list = try JSONSerialization.jsonObject(with: polycarp(bin, dir, ["theme", "list", "--json"])) as! [String: Any]
        let names = ((list["data"] as! [String: Any])["themes"] as! [[String: Any]])
            .filter { $0["source"] as? String == "built-in" }.map { $0["name"] as! String }
        XCTAssertGreaterThanOrEqual(names.count, 6, "\(names)")
        let path = dir.appendingPathComponent("current/theme.json").path
        for name in names {
            for mode in ["auto", "light", "dark"] {
                _ = try polycarp(bin, dir, ["theme", "set", name, "--mode", mode])
                let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
                let spaces = (raw["surfaces"] as! [String: Any])["spaces"] as! [String: Any]
                let shape = spaces["shape"] as! [String: Any], type = spaces["type"] as! [String: Any], motion = spaces["motion"] as! [String: Any]
                func n(_ d: [String: Any], _ k: String) -> Double { (d[k] as! NSNumber).doubleValue }

                guard let t = PolycarpThemeFile.load(path: path).theme else {
                    return XCTFail("\(name) \(mode): \(PolycarpThemeFile.load(path: path))")
                }
                XCTAssertEqual(t.name, name)
                XCTAssertEqual(t.mode.rawValue, mode, name)
                // The spec, derived from the raw file here and not from PolycarpTheme.
                let s = t.spec
                XCTAssertEqual(s.radius.bar, n(shape, "radius_large"), "\(name) \(mode)")
                XCTAssertEqual(s.radius.tile, n(shape, "radius"))
                XCTAssertEqual(s.radius.list, n(shape, "radius"))
                XCTAssertEqual(s.radius.row, n(shape, "radius_small"))
                XCTAssertEqual(s.border.width, n(shape, "border_width"))
                XCTAssertEqual(s.fill.material != nil, n(shape, "blur") > 0)
                XCTAssertEqual(s.shadow == nil, n(shape, "shadow") == 0)
                XCTAssertEqual(s.indicator.rawValue, shape["indicator"] as? String)
                XCTAssertEqual(s.font.size, n(type, "size") * 0.75)
                XCTAssertEqual(s.font.weight, n(type, "weight") >= 500 ? "medium" : "regular")
                let reduced = motion["reduced"] as! Bool
                XCTAssertEqual(s.motion.inMs, reduced ? 0 : n(motion, "normal"))
                XCTAssertEqual(s.motion.outMs, reduced ? 0 : n(motion, "fast"))
                XCTAssertEqual(s.motion.scaleFrom, reduced ? 1 : n(motion, "scale_from"))
                // The palette: both modes carry the file's twelve roles.
                for (key, roles) in [("light", t.light.roles), ("dark", t.dark.roles)] {
                    let c = spaces[key] as! [String: String]
                    for role in Palette.roles { XCTAssertEqual(roles[role], RGB(hex: c[role]!), "\(name) \(mode) \(key).\(role)") }
                    XCTAssertEqual(t.palette(systemDark: key == "dark").isDark, mode == "auto" ? key == "dark" : mode == "dark")
                }
                // And a Look and ThemeCenter built from it agree with that spec.
                ThemeCenter.use(.baneyspaces, polycarp: t)
                XCTAssertEqual(ThemeCenter.spec, s)
                XCTAssertEqual(t.look(systemDark: false).spec, s)
                for dark in [false, true] {
                    let look = t.look(systemDark: dark)
                    for p in look.textPairs(accent: look.color("accent")) {
                        XCTAssertGreaterThanOrEqual(p.text.contrast(with: p.fill), 4.5, "\(name) \(mode) dark=\(dark) \(p.name)")
                    }
                }
            }
        }
    }
}

/// The app's wiring, as source checks (the app target has no unit tests): a Polycarp theme wins in
/// `Appearance` without rewriting the stored settings, the watcher applies on the main queue, Settings
/// says so, and `doctor` reports it. The behavior itself is held by the tests above.
final class PolycarpWiringTests: XCTestCase {
    func testAppearanceKeepsTheStoredChoiceAndLetsPolycarpWin() throws {
        let code = try Repo.code("Sources/BaneySpaces/Appearance.swift")
        XCTAssertTrue(code.contains("settings.look(systemAccent: Appearance.systemAccent, polycarp: polycarp, systemDark: Appearance.systemDark)"))
        XCTAssertTrue(code.contains("ThemeCenter.use(settings.theme, polycarp: polycarp)"))
        XCTAssertFalse(code.contains("settings.theme = polycarp"), "a Polycarp theme never writes the stored theme")
        XCTAssertFalse(code.contains("colorPalette = "), "…or the stored palette")
        XCTAssertFalse(code.contains("ThemeCenter.use(settings.theme)\n            if persists") , "the settings observer must keep ThemeCenter's Polycarp spec")
    }

    func testTheWatcherAppliesOnTheMainQueueAndNeverPollsThere() throws {
        let app = try Repo.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("PolycarpThemeWatcher(path: PolycarpThemeFile.path()"))
        XCTAssertTrue(app.contains("DispatchQueue.main.async { Appearance.shared.usePolycarp(theme) }"))
        XCTAssertTrue(app.contains("watcher.start(firstLookWithin:"), "the first look is applied before the first panel")
        let core = try Repo.code("Sources/BaneySpacesCore/PolycarpTheme.swift")
        XCTAssertFalse(core.contains("DispatchQueue.main"), "the watcher's queue is its own")
        XCTAssertFalse(core.contains("FileManager"), "a poll is one stat")
    }

    func testSettingsAndDoctorReportIt() throws {
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Setup.swift").contains("section(\"Polycarp theme\")"))
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Setup.swift").contains("polycarp theme set <name>"))
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Session/SessionController.swift").contains("info[\"polycarp_theme\"]"))
        XCTAssertTrue(try Repo.text("spec/themes.md").contains("## Polycarp themes"))
        XCTAssertTrue(try Repo.text("spec/cli.md").contains("polycarp_theme"))
    }
}

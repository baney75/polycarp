import XCTest
@testable import BaneySpacesCore

/// style.css (docs/style.md): the CSS subset, every property's edges, every color form, var() with fallbacks and cycles,
/// @media, specificity, inheritance, the places problems are reported at, the contrast warning, edits that keep comments,
/// the watcher that applies a change within 200 ms, and input that must never crash or hang the parser.
final class StyleSheetTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent("style.css").path }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-style-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    static let white = StyleColor(red: 1, green: 1, blue: 1)
    static let black = StyleColor(red: 0, green: 0, blue: 0)
    static let gold = StyleColor(red: 212 / 255, green: 175 / 255, blue: 55 / 255)

    /// Stand-in theme roles: a light mode on white and a dark mode on near-black.
    static func roles(_ dark: Bool) -> [String: StyleColor] {
        var r: [String: StyleColor] = [:]
        for name in StyleProperty.roles { r[name] = dark ? StyleColor(red: 0.5, green: 0.5, blue: 0.6) : StyleColor(red: 0.4, green: 0.4, blue: 0.3) }
        r["background"] = dark ? StyleColor(red: 0.07, green: 0.07, blue: 0.07) : white
        r["surface"] = dark ? StyleColor(red: 0.13, green: 0.13, blue: 0.13) : StyleColor(red: 0.95, green: 0.95, blue: 0.95)
        r["foreground"] = dark ? white : StyleColor(red: 0.1, green: 0.1, blue: 0.1)
        r["accent"] = dark ? gold : StyleColor(red: 0.6, green: 0.1, blue: 0.1)
        return r
    }

    private func sheet(_ css: String) -> StyleSheet { StyleSheet.parse(css).sheet }
    private func problems(_ css: String) -> [StyleProblem] { StyleSheet.parse(css).problems }
    private func errors(_ css: String) -> [String] { problems(css).filter(\.isError).map(\.message) }

    private func style(_ css: String, _ surface: StyleSurface = .bar, _ part: String? = nil, region: String? = nil,
                       states: Set<StyleState> = [], dark: Bool = false) -> ComputedStyle {
        sheet(css).computed(surface: surface, part: part, region: region, states: states, dark: dark, roles: Self.roles(dark))
    }

    private func assertColor(_ c: StyleColor?, _ r: Double, _ g: Double, _ b: Double, _ a: Double = 1, _ what: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        guard let c else { return XCTFail("\(what): no color", file: file, line: line) }
        XCTAssertEqual(c.red, r, accuracy: 0.002, what, file: file, line: line)
        XCTAssertEqual(c.green, g, accuracy: 0.002, what, file: file, line: line)
        XCTAssertEqual(c.blue, b, accuracy: 0.002, what, file: file, line: line)
        XCTAssertEqual(c.alpha, a, accuracy: 0.002, what, file: file, line: line)
    }

    // MARK: The empty sheet

    func testNoSheetAndOnlyCommentsAreEmptyAndSilent() {
        for css in ["", "   \n", "/* just a note */", "/* a */ /* b */\n"] {
            let (s, p) = StyleSheet.parse(css)
            XCTAssertTrue(s.isEmpty, css)
            XCTAssertEqual(p, [], css)
            XCTAssertEqual(s.computed(surface: .bar, dark: false, roles: Self.roles(false)), .empty)
        }
        XCTAssertTrue(sheet("bar { }").isEmpty)
        XCTAssertTrue(sheet(":root { --gold: red; }").isEmpty, "custom properties alone change nothing")
        XCTAssertFalse(sheet("bar { color: red }").isEmpty)
    }

    // MARK: Colors

    func testEveryColorForm() {
        let cases: [(String, Double, Double, Double, Double)] = [
            ("#fff", 1, 1, 1, 1), ("#F00", 1, 0, 0, 1), ("#0f08", 0, 1, 0, 0x88 / 255.0),
            ("#d4af37", 212 / 255.0, 175 / 255.0, 55 / 255.0, 1), ("#D4AF3780", 212 / 255.0, 175 / 255.0, 55 / 255.0, 128 / 255.0),
            ("rgb(255, 0, 0)", 1, 0, 0, 1), ("rgba(0, 0, 255, 0.5)", 0, 0, 1, 0.5), ("rgb(0 128 0)", 0, 128 / 255.0, 0, 1),
            ("rgb(0 0 0 / 25%)", 0, 0, 0, 0.25), ("rgba(100%, 50%, 0%, 1)", 1, 0.5, 0, 1), ("rgb(10 20 30 / 0.3)", 10 / 255.0, 20 / 255.0, 30 / 255.0, 0.3),
            ("hsl(0, 100%, 50%)", 1, 0, 0, 1), ("hsl(120 100% 25%)", 0, 0.5, 0, 1), ("hsla(240, 100%, 50%, 0.5)", 0, 0, 1, 0.5),
            ("hsl(60deg 100% 50% / 50%)", 1, 1, 0, 0.5), ("hsl(0.5turn, 100%, 50%)", 0, 1, 1, 1), ("hsl(-120, 100%, 50%)", 0, 0, 1, 1),
            ("transparent", 0, 0, 0, 0), ("TRANSPARENT", 0, 0, 0, 0),
        ]
        for (value, r, g, b, a) in cases {
            XCTAssertEqual(errors("bar { color: \(value) }"), [], value)
            assertColor(style("bar { color: \(value) }").color, r, g, b, a, value)
        }
        let named: [String: UInt32] = ["black": 0x000000, "silver": 0xC0C0C0, "gray": 0x808080, "white": 0xFFFFFF, "maroon": 0x800000,
                                       "red": 0xFF0000, "purple": 0x800080, "fuchsia": 0xFF00FF, "green": 0x008000, "lime": 0x00FF00,
                                       "olive": 0x808000, "yellow": 0xFFFF00, "navy": 0x000080, "blue": 0x0000FF, "teal": 0x008080, "aqua": 0x00FFFF]
        XCTAssertEqual(named.count, 16)
        for (name, v) in named {
            assertColor(style("bar { color: \(name.uppercased()) }").color, Double(v >> 16) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255, 1, name)
        }
        // currentColor in `color` is the parent's color; elsewhere the part's own color.
        let cur = style("bar { color: red } bar .clock { color: currentColor; border: 1px solid currentColor }", .bar, "clock")
        assertColor(cur.color, 1, 0, 0, 1, "currentColor in color")
        XCTAssertEqual(cur.border, .solid(width: 1, color: StyleColor(red: 1, green: 0, blue: 0)))
        // A role, by mode.
        assertColor(style("bar { color: var(--accent) }", dark: true).color, Self.gold.red, Self.gold.green, Self.gold.blue, 1, "dark accent")
        assertColor(style("bar { color: var(--accent) }", dark: false).color, 0.6, 0.1, 0.1, 1, "light accent")
    }

    func testBadColorsAreRefusedWithWhatAColorIs() {
        for bad in ["#12345", "#ggg", "#1234567", "rgb(300, 0, 0)", "rgb(1, 2)", "rgb(1, 2, 3, 4, 5)", "rgb(1, 2 3)", "rgb(1 2 3 0.5)",
                    "rgba(0, 0, 0, 2)", "rgb(-1, 0, 0)", "rgb(101%, 0%, 0%)", "hsl(0, 120%, 50%)", "hsl(red, 50%, 50%)", "orange",
                    "rebeccapurple", "rgb()", "lab(50 0 0)", "\"red\"", "red blue", "12px"] {
            let e = errors("bar { color: \(bad) }")
            XCTAssertEqual(e.count, 1, "\(bad): \(e)")
        }
        XCTAssertTrue(errors("bar { color: orange }")[0].contains("rgb()"), "the message lists the forms")
        XCTAssertTrue(errors("bar { color: rgb(300, 0, 0) }")[0].contains("0 to 255"))
    }

    // MARK: Every property's edges

    /// (selector, property, values it takes, values it refuses).
    static let edges: [(String, String, [String], [String])] = [
        ("bar", "background", ["none", "glass", "red", "transparent", "linear-gradient(red, blue)", "linear-gradient(to right, red, var(--accent))",
                               "linear-gradient(to bottom, #000, #fff8)"],
         ["linear-gradient(to left, red, blue)", "linear-gradient(red)", "linear-gradient(red, blue, green)", "url(x.png)", "blur", "none glass"]),
        ("bar", "opacity", ["0", "1", "0.5", "50%", "100%"], ["-0.1", "1.1", "2px", "101%", "half"]),
        ("bar", "font-family", ["system-ui", "\"SF Pro Text\", system-ui, sans-serif", "Georgia, serif", "ui-monospace, 'SF Mono', monospace"],
         ["Comic <Sans", "\"\"", "var(--accent)", "a, , b"]),
        ("bar .clock", "font-size", ["6px", "40pt", "12.5px", "13px"], ["5px", "41px", "12", "12em", "1rem", "big"]),
        ("bar", "font-weight", ["100", "900", "450", "normal", "bold", "NORMAL"], ["50", "950", "400px", "bolder", "lighter"]),
        ("bar", "font-style", ["normal", "italic"], ["oblique", "slanted"]),
        ("bar", "letter-spacing", ["-2px", "10px", "0", "normal", "0.5pt"], ["-3px", "11px", "2", "1em"]),
        ("bar", "text-transform", ["none", "uppercase", "lowercase", "capitalize"], ["small-caps", "upper"]),
        ("bar", "font-variant-numeric", ["normal", "tabular-nums"], ["oldstyle-nums", "slashed-zero"]),
        ("bar", "height", ["18px", "64px", "28pt"], ["17px", "65px", "28", "0"]),
        ("bar .clock", "padding", ["0", "4px", "0 8px", "1px 2px 3px", "1px 2px 3px 4px", "40px"], ["1px 2px 3px 4px 5px", "41px", "-1px", "8", "auto"]),
        ("bar", "gap", ["0", "40px", "8pt"], ["41px", "-1px", "8"]),
        ("dock .tile", "border-radius", ["0", "40px", "6pt"], ["-1px", "41px", "50%"]),
        ("dock .tile", "border", ["none", "1px solid red", "solid 2px var(--border)", "1px solid", "0 solid red", "8px solid red"],
         ["9px solid red", "1px dashed red", "1px red", "solid", "1px solid red blue", "thin solid red"]),
        ("bar", "border-bottom", ["none", "1px solid var(--border)", "0.5px solid rgba(255, 255, 255, 0.2)"], ["1px", "2px dotted red"]),
        ("dock .tile", "box-shadow", ["none", "0 4px 12px black", "red 1px 2px 3px", "-40px 40px 64px rgba(0, 0, 0, 0.3)"],
         ["0 4px 12px 2px black", "41px 0 0 black", "0 0 65px black", "0 0 -1px black", "inset 0 0 4px black", "0 4px 12px", "0 4px black"]),
        ("bar .clock", "display", ["none", "flex"], ["block", "hidden", "inline"]),
        ("dock .tile", "transition-duration", ["0", "0ms", "2000ms", "2s", "150ms", "0.25s"], ["2001ms", "3s", "150", "-1ms", "fast"]),
        ("bar", "color", ["red", "var(--foreground)"], ["12px", "none"]),
    ]

    func testEveryPropertyTakesItsEdgesAndRefusesPastThem() {
        var covered = Set<String>()
        for (selector, property, good, bad) in Self.edges {
            covered.insert(property)
            for v in good { XCTAssertEqual(errors("\(selector) { \(property): \(v); }"), [], "\(selector) { \(property): \(v) }") }
            for v in bad {
                let e = errors("\(selector) { \(property): \(v); }")
                XCTAssertEqual(e.count, 1, "\(selector) { \(property): \(v) } should be one error: \(e)")
            }
        }
        XCTAssertEqual(covered, Set(StyleProperty.all.map(\.name)), "every property has its edges tested")
    }

    func testValuesResolveToConcreteNumbersAndEnums() {
        let s = style("""
        bar .clock {
          opacity: 50%; font-size: 13pt; font-weight: bold; font-style: italic; letter-spacing: normal;
          text-transform: uppercase; font-variant-numeric: tabular-nums; padding: 1px 2px 3px; border-radius: 4px;
          border: 2px solid #000; border-bottom: none; display: none;
          transition-duration: 250ms; font-family: "SF Pro Text", system-ui; background: linear-gradient(to right, red, blue);
        }
        """, .bar, "clock")
        XCTAssertEqual(s.opacity, 0.5)
        XCTAssertEqual(s.fontSize, 13)
        XCTAssertEqual(s.fontWeight, 700)
        XCTAssertEqual(s.fontStyle, .italic)
        XCTAssertEqual(s.letterSpacing, 0)
        XCTAssertEqual(s.textTransform, .uppercase)
        XCTAssertEqual(s.fontVariantNumeric, .tabularNums)
        XCTAssertEqual(s.padding, StyleInsets(top: 1, right: 2, bottom: 3, left: 2))
        XCTAssertEqual(s.borderRadius, 4)
        XCTAssertEqual(s.border, .solid(width: 2, color: Self.black))
        XCTAssertEqual(s.borderBottom, StyleLine.none)
        XCTAssertEqual(style("dock .tile { box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5) }", .dock, "tile").boxShadow,
                       .drop(x: 0, y: 2, blur: 6, color: StyleColor(red: 0, green: 0, blue: 0, alpha: 0.5)))
        XCTAssertTrue(s.isHidden)
        XCTAssertEqual(s.transitionDuration, 0.25)
        XCTAssertEqual(s.fontFamily, ["SF Pro Text", "system-ui"])
        XCTAssertEqual(s.background, .linearGradient(StyleColor(red: 1, green: 0, blue: 0), StyleColor(red: 0, green: 0, blue: 1), .toRight))
        XCTAssertEqual(style("bar { background: glass; height: 30px; gap: 6px }").background, .glass)
        XCTAssertEqual(style("bar { height: 30px }").height, 30)
        XCTAssertEqual(style("bar { padding: 1px 2px 3px 4px }").padding, StyleInsets(top: 1, right: 2, bottom: 3, left: 4))
        XCTAssertEqual(style("bar { padding: 5px 6px }").padding, StyleInsets(top: 5, right: 6, bottom: 5, left: 6))
        XCTAssertEqual(style("dock .tile { transition-duration: 1.5s }", .dock, "tile").transitionDuration, 1.5)
        XCTAssertEqual(style("bar { font-weight: normal }").fontWeight, 400)
    }

    func testAPropertyASelectorCantUseIsAProblemNotIgnored() {
        let e = errors("dock .tile { height: 30px; }")
        XCTAssertEqual(e.count, 1)
        XCTAssertTrue(e[0].contains("`height` doesn't apply to `dock .tile`") && e[0].contains("applies to bar"), e[0])
        XCTAssertTrue(errors("bar { display: none }")[0].contains("bar.enabled"), "the bar is turned off in surfaces.json")
        XCTAssertEqual(errors("dock .icon { color: red }").count, 1, "an app icon has no text color")
        XCTAssertEqual(errors("dock .tile { gap: 4px }").count, 1)
        // In a list, it still applies where it can.
        let (s, p) = StyleSheet.parse("bar, dock .tile { height: 30px }")
        XCTAssertEqual(p.count, 1)
        XCTAssertEqual(s.computed(surface: .bar, dark: false, roles: Self.roles(false)).height, 30)
    }

    func testUnknownPropertiesSuggestTheNearestOne() {
        XCTAssertTrue(errors("bar { colour: red }")[0].contains("did you mean `color`"))
        XCTAssertTrue(errors("bar { font-sise: 12px }")[0].contains("did you mean `font-size`"))
        XCTAssertTrue(errors("bar { zzzzzzzzzz: 1 }")[0].contains("style example"))
        XCTAssertTrue(errors("bar { color: red !important }")[0].contains("!important"))
        XCTAssertTrue(errors("bar { color: inherit }")[0].contains("isn't supported"))
        XCTAssertTrue(errors("bar { color: }")[0].contains("has no value"))
    }

    // MARK: Selectors

    func testEverySelectorTheDocsListParses() {
        for t in StyleTarget.allCases {
            for sel in t.selectors {
                XCTAssertEqual(problems("\(sel) { opacity: 1 }"), [], sel)
                for st in t.states { XCTAssertEqual(problems("\(sel)\(st.selector) { opacity: 1 }"), [], sel + st.selector) }
            }
        }
        for m in Surfaces.BarModule.builtIn {
            XCTAssertEqual(problems("bar .\(m.id) { color: red }"), [], "every bar module has its class: \(m.id)")
        }
        XCTAssertEqual(StyleTarget.barModule.parts, ["mark", "workspaces", "app-menus", "status", "hour", "clock", "date", "verse",
                                                     "battery", "network", "notifications"])
        XCTAssertEqual(problems("dock .tile.current:hover { color: red } dock .label:hover.current { color: red } :root { --x: 1px }"), [])
        XCTAssertEqual(problems("BAR { color: red }"), [], "a type selector is case-insensitive")
    }

    func testABadSelectorDropsItsRuleAndNamesTheChoices() {
        let cases: [(String, String)] = [
            ("baz { color: red }", "the surfaces are `bar` and `dock`"),
            ("bar .clok { color: red }", "`.clock`"),
            ("bar .clok { color: red }", "`.hour`"),
            ("dock .tile.active { color: red }", "takes `.current` and `:hover`"),
            ("bar .left:hover { color: red }", "takes no states"),
            ("bar:hover { color: red }", "takes no states"),
            ("* { color: red }", "`*` isn't supported"),
            ("bar.clock { color: red }", "write `bar .clock` with a space"),
            ("bar .left .clock { color: red }", "at most one part"),
            ("#clock { color: red }", "ids"),
            ("bar > .clock { color: red }", "isn't supported"),
            (".clock { color: red }", "write `bar .clock`"),
            (".tile { color: red }", "write `dock .tile`"),
            (":root, bar { --x: red }", "must be alone"),
            ("bar ::before { color: red }", "pseudo-elements"),
            ("bar .clock::after { color: red }", "pseudo-elements"),
            ("dock .tile[x] { color: red }", "attribute"),
            ("bar, { color: red }", "empty selector"),
        ]
        for (css, says) in cases {
            let (s, p) = StyleSheet.parse(css)
            XCTAssertTrue(p.contains { $0.isError && $0.message.contains(says) && $0.message.contains("dropped") || $0.message.contains(says) }, "\(css): \(p)")
            XCTAssertTrue(s.isEmpty, "\(css) drops its rule")
        }
        // A bad rule doesn't take the next one with it.
        XCTAssertEqual(style("baz { color: blue } bar { color: red }").color, StyleColor(red: 1, green: 0, blue: 0))
    }

    // MARK: var()

    func testVarTakesCustomPropertiesRolesAndFallbacks() {
        let css = """
        :root { --gold: #d4af37; --line: 1px solid var(--gold); --pad: 4px 8px; }
        bar { color: var(--gold); border-bottom: var(--line); }
        bar .clock { color: var(--missing, var(--accent)); padding: var(--pad); background: rgb(var(--rgb, 0 0 0) / 50%); }
        """
        XCTAssertEqual(problems(css), [])
        let bar = style(css)
        assertColor(bar.color, Self.gold.red, Self.gold.green, Self.gold.blue, 1, "custom property")
        XCTAssertEqual(bar.borderBottom, .solid(width: 1, color: Self.gold))
        let clock = style(css, .bar, "clock", dark: true)
        XCTAssertEqual(clock.color, Self.gold, "fallback to a role, dark accent")
        XCTAssertEqual(clock.padding, StyleInsets(top: 4, right: 8, bottom: 4, left: 8))
        XCTAssertEqual(clock.background, .color(StyleColor(red: 0, green: 0, blue: 0, alpha: 0.5)))
        // The sheet's own --accent wins over the theme's.
        XCTAssertEqual(style(":root { --accent: red } bar { color: var(--accent) }").color, StyleColor(red: 1, green: 0, blue: 0))
        // Custom properties per mode.
        let modes = ":root { --ink: red } @media (prefers-color-scheme: dark) { :root { --ink: blue } } bar { color: var(--ink) }"
        XCTAssertEqual(problems(modes), [])
        XCTAssertEqual(style(modes, dark: false).color, StyleColor(red: 1, green: 0, blue: 0))
        XCTAssertEqual(style(modes, dark: true).color, StyleColor(red: 0, green: 0, blue: 1))
    }

    func testVarProblemsAreReportedNotHung() {
        let cycle = problems(":root { --a: var(--b); --b: var(--a); } bar { color: var(--a) }").filter(\.isError)
        XCTAssertTrue(cycle.contains { $0.message.contains("refers back to itself") && $0.message.contains("--a -> --b -> --a") }, "\(cycle)")
        XCTAssertTrue(errors(":root { --self: var(--self) }").contains { $0.contains("refers back to itself") })
        XCTAssertEqual(style(":root { --a: var(--b); --b: var(--a); } bar { color: var(--a) }").color, nil, "a cycle sets nothing")
        XCTAssertTrue(errors("bar { color: var(--nope) }")[0].contains("not defined and has no fallback"))
        XCTAssertTrue(errors("bar { color: var(--nope) }")[0].contains("--accent"), "it names the roles")
        XCTAssertTrue(errors("bar { color: var(nope) }")[0].contains("custom property name"))
        XCTAssertTrue(errors("bar { font-size: var(--accent) }")[0].contains("takes a length"), "a role is a color")
        XCTAssertTrue(errors("bar { --x: red }")[0].contains("go in `:root"))
        XCTAssertTrue(errors(":root { color: red }")[0].contains("only custom properties"))
        // Only in one mode.
        let half = errors(":root { --c: red } @media (prefers-color-scheme: dark) { :root { --c: 12px } } bar { color: var(--c) }")
        XCTAssertEqual(half.count, 1)
        XCTAssertTrue(half[0].hasSuffix("(in dark mode)"), half[0])
        // A sheet that doubles a value ten times over is refused, quickly.
        var bomb = ":root { --v0: red; "
        for i in 1...30 { bomb += "--v\(i): var(--v\(i - 1)) var(--v\(i - 1)); " }
        bomb += "} bar { color: var(--v30) }"
        let t0 = Date()
        XCTAssertTrue(errors(bomb).contains { $0.contains("longer than 4096 tokens") })
        _ = style(bomb)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 5)
        // The same bomb used by 2500 declarations: each is resolved once per mode and dropped, so check stays quick
        // (review of #604: every declaration expanded the chain again, once per mode and per role set).
        let many = bomb.replacingOccurrences(of: "} bar { color: var(--v30) }", with: "} ")
            + (0..<2500).map { "bar .clock { color: var(--v30) } /* \($0) */" }.joined(separator: "\n")
        let t1 = Date()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? many.write(toFile: file, atomically: true, encoding: .utf8)
        let report = StyleOps.check(file: file, roles: Self.roles)
        let spent = Date().timeIntervalSince(t1)
        XCTAssertLessThan(spent, 1, "check took \(spent) s")
        XCTAssertEqual(style(many).color, nil, "a declaration the chain broke sets nothing")
        _ = report
        // A fallback nested far too deep.
        let deep = "bar { color: " + String(repeating: "var(--x, ", count: 2000) + "red" + String(repeating: ")", count: 2000) + " }"
        XCTAssertTrue(errors(deep).contains { $0.contains("nested more than 32 deep") })
    }

    // MARK: @media

    func testMediaPicksTheModeAndOtherAtRulesAreDropped() {
        let css = """
        bar { color: red }
        @media (prefers-color-scheme: dark) { bar { color: blue } }
        @media (prefers-color-scheme: light) { bar .clock { color: lime } }
        """
        XCTAssertEqual(problems(css), [])
        XCTAssertEqual(style(css, dark: false).color, StyleColor(red: 1, green: 0, blue: 0))
        XCTAssertEqual(style(css, dark: true).color, StyleColor(red: 0, green: 0, blue: 1))
        XCTAssertEqual(style(css, .bar, "clock", dark: false).color, StyleColor(red: 0, green: 1, blue: 0))
        XCTAssertEqual(style(css, .bar, "clock", dark: true).color, StyleColor(red: 0, green: 0, blue: 1), "light-only rule skipped; inherits dark bar")
        for (bad, says) in [("@media (min-width: 100px) { bar { color: red } }", "only `@media (prefers-color-scheme"),
                            ("@media screen { bar { color: red } }", "only `@media (prefers-color-scheme"),
                            ("@import url(x.css);", "`@import` isn't supported"),
                            ("@font-face { font-family: x }", "`@font-face` isn't supported"),
                            ("@keyframes spin { from { opacity: 0 } to { opacity: 1 } }", "`@keyframes` isn't supported"),
                            ("@media (prefers-color-scheme: dark) { @media (prefers-color-scheme: dark) { bar { color: red } } }", "can't go inside"),
                            ("@media (prefers-color-scheme: dark);", "needs a `{ ... }` block")] {
            let (s, p) = StyleSheet.parse(bad + "\ndock { opacity: 0.5 }")
            XCTAssertTrue(p.contains { $0.message.contains(says) }, "\(bad): \(p)")
            XCTAssertNil(s.computed(surface: .bar, dark: true, roles: Self.roles(true)).color, bad)
            XCTAssertEqual(s.computed(surface: .dock, dark: true, roles: Self.roles(true)).opacity, 0.5, "the rule after \(bad) still applies")
        }
    }

    // MARK: Specificity, order and inheritance

    func testSpecificityThenOrder() {
        let css = """
        dock .tile.current { color: blue }
        dock .tile { color: red; border-radius: 2px }
        dock .tile:hover { color: lime }
        dock .tile { border-radius: 4px }
        dock .tile.current:hover { color: yellow }
        """
        XCTAssertEqual(style(css, .dock, "tile").color, StyleColor(red: 1, green: 0, blue: 0))
        XCTAssertEqual(style(css, .dock, "tile").borderRadius, 4, "a tie: the later rule wins")
        XCTAssertEqual(style(css, .dock, "tile", states: [.current]).color, StyleColor(red: 0, green: 0, blue: 1), "a class beats an earlier type")
        XCTAssertEqual(style(css, .dock, "tile", states: [.hover]).color, StyleColor(red: 0, green: 1, blue: 0))
        XCTAssertEqual(style(css, .dock, "tile", states: [.current, .hover]).color, StyleColor(red: 1, green: 1, blue: 0), "two states beat one")
        let tie = "dock .tile:hover { color: lime } dock .tile.current { color: blue }"
        XCTAssertEqual(style(tie, .dock, "tile", states: [.current, .hover]).color, StyleColor(red: 0, green: 0, blue: 1), "equal: later wins")
        XCTAssertEqual(style("bar .clock { color: red; color: blue }", .bar, "clock").color, StyleColor(red: 0, green: 0, blue: 1))
        XCTAssertEqual(style("bar .clock { color: blue; color: 12px }", .bar, "clock").color, StyleColor(red: 0, green: 0, blue: 1),
                       "a bad later declaration leaves the good one")
    }

    func testTextPropertiesInheritFromTheSurfaceAndRegionAndOthersDont() {
        let css = """
        bar { color: red; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; padding: 9px; background: navy; font-family: Georgia, serif }
        bar .right { color: blue; gap: 4px }
        bar .clock { font-weight: bold }
        dock { color: lime; font-style: italic }
        dock .tile.current { color: yellow }
        """
        let inLeft = style(css, .bar, "clock", region: "left")
        XCTAssertEqual(inLeft.color, StyleColor(red: 1, green: 0, blue: 0))
        XCTAssertEqual(inLeft.fontSize, 12)
        XCTAssertEqual(inLeft.letterSpacing, 1)
        XCTAssertEqual(inLeft.textTransform, .uppercase)
        XCTAssertEqual(inLeft.fontFamily, ["Georgia", "serif"])
        XCTAssertEqual(inLeft.fontWeight, 700)
        XCTAssertNil(inLeft.padding, "padding doesn't inherit")
        XCTAssertNil(inLeft.background, "background doesn't inherit")
        XCTAssertEqual(style(css, .bar, "clock", region: "right").color, StyleColor(red: 0, green: 0, blue: 1), "the region passes its color on")
        XCTAssertNil(style(css, .bar, "clock", region: "right").gap)
        XCTAssertEqual(style(css, .bar, "clock").color, StyleColor(red: 1, green: 0, blue: 0), "no region: from the bar")
        XCTAssertEqual(style(css, .dock, "label").color, StyleColor(red: 0, green: 1, blue: 0))
        XCTAssertEqual(style(css, .dock, "label", states: [.current]).color, StyleColor(red: 1, green: 1, blue: 0), "a current tile's label")
        XCTAssertEqual(style(css, .dock, "badge").fontStyle, .italic)
        XCTAssertNil(style(css, .dock, "icon").color, "an icon has no text color")
        XCTAssertEqual(style("bar .clock { border: 1px solid currentColor }", .bar, "clock").border,
                       .solid(width: 1, color: Self.roles(false)["foreground"]!), "currentColor with no color set is the theme's text")
        XCTAssertEqual(style("bar .clock { border: 1px solid }", .bar, "clock").border, .solid(width: 1, color: Self.roles(false)["foreground"]!))
    }

    func testAnUnknownPartIsTheEmptyStyle() {
        let s = sheet("bar { color: red }")
        XCTAssertEqual(s.computed(surface: .bar, part: "nope", dark: false, roles: [:]), .empty)
        XCTAssertEqual(s.computed(surface: .dock, part: "clock", dark: false, roles: [:]), .empty)
        XCTAssertEqual(s.computed(surface: .bar, part: "clock", region: "nowhere", dark: false, roles: [:]).color, StyleColor(red: 1, green: 0, blue: 0))
    }

    // MARK: Where problems are reported

    func testProblemsCarryTheirLineAndColumn() {
        let css = """
        /* a comment
           over two lines */
        bar {
          color: red;
          colr: blue;
          font-size: 99px;
        }
        dock .nope { color: red }
          @import "x.css";
        bar .clock { height: 30px }
        """
        let p = problems(css)
        func at(_ says: String) -> String? { p.first { $0.message.contains(says) }.map { "\($0.line):\($0.column)" } }
        XCTAssertEqual(at("unknown property `colr`"), "5:3")
        XCTAssertEqual(at("font-size"), "6:14", "a value problem points at the value")
        XCTAssertEqual(at("no part `.nope`"), "8:1")
        XCTAssertEqual(at("@import"), "9:3")
        XCTAssertEqual(at("doesn't apply"), "10:14")
        XCTAssertEqual(p.map(\.line), p.map(\.line).sorted(), "in file order")
        XCTAssertEqual(style(css).color, StyleColor(red: 1, green: 0, blue: 0), "the good declaration applies")
        XCTAssertEqual(problems("bar {\n  color: red;\n").first.map { "\($0.line):\($0.column) \($0.message)" }, "1:5 the block opened here is never closed: a `}` is missing")
        XCTAssertEqual(style("bar {\n  color: red;\n").color, StyleColor(red: 1, green: 0, blue: 0), "an unclosed block still applies, as in CSS")
        XCTAssertEqual(problems("bar { color: red } /* never closed").last.map { "\($0.line):\($0.column)" }, "1:20")
        XCTAssertTrue(problems("bar { font-family: \"SF Pro }").contains { $0.message.contains("never closed on its line") })
        XCTAssertEqual(problems("color: red;\nbar { color: blue }").first?.message, "`color: red` is outside any rule; put it in a block, like `bar { color: red; }`")
        XCTAssertTrue(problems("bar { .clock { color: red } }").contains { $0.message.contains("nested CSS isn't supported") })
        XCTAssertTrue(problems("bar { color red; opacity: 1 }").contains { $0.message.contains("expected `:` after `color`") })
        XCTAssertTrue(problems("} bar { color: red }").contains { $0.message.contains("no `{` before it") })
        XCTAssertEqual(StyleProblem(line: 3, column: 7, message: "x").description, "3:7: error: x")
    }

    // MARK: Contrast

    func testLowContrastTextIsAWarningInCheck() throws {
        let css = """
        bar { background: #111; }
        bar .clock { color: #222; }
        dock .tile.current { background: var(--accent); color: var(--foreground) }
        bar .date { color: white }
        """
        let all = StyleOps.problems(css, roles: Self.roles).problems
        let warnings = all.filter { $0.severity == .warning }
        XCTAssertTrue(all.allSatisfy { !$0.isError }, "\(all)")
        XCTAssertTrue(warnings.contains { $0.line == 2 && $0.column == 21 && $0.message.contains("`bar .clock`") && $0.message.contains("needs at least 3:1") },
                      "\(warnings)")
        XCTAssertFalse(warnings.contains { $0.line == 4 }, "white on #111 reads")
        // A theme's own colors the sheet doesn't touch are the theme's business.
        XCTAssertEqual(StyleOps.problems("bar { padding: 2px }", roles: { _ in ["background": Self.white, "foreground": Self.white] }).problems, [])
        // check passes with warnings alone.
        try css.write(toFile: file, atomically: true, encoding: .utf8)
        guard case .success(let d) = StyleOps.check(file: file, roles: Self.roles) else { return XCTFail("warnings alone pass") }
        XCTAssertFalse(d.object?["warnings"]?.array?.isEmpty ?? true)
    }

    // MARK: What the bar and the dock read

    /// A rule reaches the values the bar and the dock draw with (`StyleBook`), and a part the sheet leaves alone stays nil,
    /// so the view draws what it drew before (review of #604: the sheet was parsed but drawn nowhere).
    func testASheetRuleReachesTheValuesTheBarAndTheDockDraw() {
        let css = """
        bar { height: 30px; font-family: monospace; gap: 18px }
        bar .right { color: #888888 }
        bar .clock { color: #d4af37 }
        bar .clock:hover { color: red }
        bar .workspace { color: var(--muted) }
        bar .workspace.current { color: var(--foreground); border-bottom: 2px solid var(--accent) }
        dock .tile.current { border: 2px solid var(--accent) }
        dock .badge { display: none }
        @media (prefers-color-scheme: light) { bar .clock { color: #8a6d1f } }
        """
        XCTAssertEqual(problems(css).filter(\.isError), [])
        let dark = StyleBook(sheet(css), dark: true, roles: Self.roles(true))
        XCTAssertEqual(dark.barHeight(26), 30)
        XCTAssertEqual(StyleBook.empty.barHeight(26), 26, "no sheet: surfaces.json's height")
        XCTAssertEqual(dark.bar.gap, 18)
        XCTAssertEqual(dark.module(.clock, in: .right).color, Self.gold)
        XCTAssertEqual(dark.module(.clock, in: .right, hover: true).color, StyleColor(red: 1, green: 0, blue: 0))
        XCTAssertEqual(dark.module(.clock, in: .right).fontFamily, ["monospace"], "inherited from the bar")
        XCTAssertEqual(dark.module(.battery, in: .right).color, StyleColor(red: 0x88 / 255, green: 0x88 / 255, blue: 0x88 / 255), "from its region")
        XCTAssertNil(dark.module(.battery, in: .left).color, "another region's color isn't its")
        XCTAssertEqual(dark.module(.custom("x"), in: .left), .empty)
        XCTAssertEqual(dark.workspace(in: .left, current: true).borderBottom, .solid(width: 2, color: Self.gold))
        XCTAssertEqual(dark.workspace(in: .left, current: true).color, Self.white)
        XCTAssertNil(dark.workspace(in: .left, current: false).borderBottom)
        XCTAssertEqual(dark.tile(current: true).border, .solid(width: 2, color: Self.gold))
        XCTAssertNil(dark.tile(current: false).border)
        XCTAssertTrue(dark.badge(current: false).isHidden)
        XCTAssertNil(dark.dock.background, "the dock keeps the theme's panel")
        let light = StyleBook(sheet(css), dark: false, roles: Self.roles(false))
        XCTAssertEqual(light.module(.clock, in: .right).color, StyleColor(red: 0x8a / 255, green: 0x6d / 255, blue: 0x1f / 255))
        // The text helpers.
        XCTAssertEqual(style("bar { text-transform: capitalize }").cased("the day is near"), "The Day Is Near")
        XCTAssertEqual(style("bar { text-transform: uppercase }").cased("Mon"), "MON")
        XCTAssertEqual(ComputedStyle.empty.cased("Mon"), "Mon")
        XCTAssertFalse(ComputedStyle.empty.hasBox)
        XCTAssertTrue(style("bar { border-radius: 2px }").hasBox)
    }

    /// `style preset omarchy` writes the Omarchy look in one command, checks clean in both modes, keeps the sheet that
    /// was there in style.css.bak, and draws what it says: a dark strip, monospace, muted numbers with an accent line
    /// under the current one, and a quiet right side.
    func testTheOmarchyPresetAppliesInOneCommandAndChecksClean() throws {
        XCTAssertEqual(StyleOps.problems(StyleSheet.omarchy.text, roles: Self.roles).problems, [], "no errors and no contrast warnings")
        try "bar { color: red }".write(toFile: file, atomically: true, encoding: .utf8)
        guard case .success(let d) = StyleOps.preset("Omarchy", file: file, roles: Self.roles) else { return XCTFail("preset omarchy") }
        XCTAssertEqual(d.object?["preset"]?.string, "omarchy")
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), StyleSheet.omarchy.text)
        XCTAssertEqual(try String(contentsOfFile: file + ".bak", encoding: .utf8), "bar { color: red }", "the old sheet is kept")
        guard case .success = StyleOps.check(file: file, roles: Self.roles) else { return XCTFail("the written sheet checks") }
        for dark in [true, false] {
            let book = StyleBook(sheet(StyleSheet.omarchy.text), dark: dark, roles: Self.roles(dark))
            XCTAssertEqual(book.bar.background, .color(StyleColor(red: 0x1a / 255, green: 0x1b / 255, blue: 0x26 / 255)), "a solid dark strip")
            XCTAssertEqual(book.module(.clock, in: .right).fontFamily?.last, "monospace")
            XCTAssertEqual(book.workspace(in: .left, current: true).borderBottom, .solid(width: 2, color: Self.roles(dark)["accent"]!))
            XCTAssertNil(book.workspace(in: .left, current: false).borderBottom, "only the current one is underlined")
            let quiet = StyleColor(red: 0x78 / 255, green: 0x7c / 255, blue: 0x99 / 255)
            XCTAssertEqual(book.workspace(in: .left, current: false).color, quiet)
            XCTAssertEqual(book.module(.battery, in: .right).color, quiet, "the right side is quiet")
            XCTAssertEqual(book.module(.battery, in: .right).color.map { $0.red == $0.green }, false, "a cool gray, as Omarchy's")
        }
        // No name lists them; an unknown one says which there are.
        guard case .success(let list) = StyleOps.preset(nil, file: file, roles: Self.roles) else { return XCTFail("list") }
        XCTAssertEqual(list.object?["presets"]?.array?.first?.object?["name"]?.string, "omarchy")
        guard case .failure(let f) = StyleOps.preset("waybar", file: file, roles: Self.roles) else { return XCTFail("unknown preset") }
        XCTAssertTrue(f.message.contains("`omarchy`"), f.message)
        XCTAssertEqual(f.exit, 2)
        // Into an empty folder: the backup is an empty sheet, so `restore` puts back no rules (review of #609).
        try FileManager.default.removeItem(atPath: file)
        for b in StyleOps.backups(file) { try FileManager.default.removeItem(atPath: b) }
        guard case .success(let fresh) = StyleOps.preset("omarchy", file: file, roles: Self.roles) else { return XCTFail("fresh") }
        XCTAssertEqual(fresh.object?["backup"]?.string.map { $0.hasSuffix("style.css.bak") }, true)
        XCTAssertEqual(try String(contentsOfFile: file + ".bak", encoding: .utf8), StyleOps.noSheet)
    }

    /// A sheet written by hand is never lost to `preset` and `reset`, in any order and however often they run (review
    /// of #604: `reset` renamed the preset over the only backup, and a second preset did the same).
    func testPresetAndResetNeverLoseAHandWrittenSheet() throws {
        let mine = "/* mine */\nbar .clock { color: #d4af37; }\n"
        let steps: [[String]] = [["preset", "reset"], ["preset", "preset"], ["preset", "reset", "preset"]]
        for run in steps {
            for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) { try FileManager.default.removeItem(atPath: dir.appendingPathComponent(name).path) }
            try mine.write(toFile: file, atomically: true, encoding: .utf8)
            for step in run {
                let r = step == "preset" ? StyleOps.preset("omarchy", file: file, roles: Self.roles) : StyleOps.reset(file: file)
                XCTAssertNoThrow(try r.get(), "\(run): \(step)")
            }
            let kept = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter {
                (try? String(contentsOfFile: dir.appendingPathComponent($0).path, encoding: .utf8)) == mine
            }
            XCTAssertFalse(kept.isEmpty, "\(run.joined(separator: ", ")): the hand-written sheet is still on disk")
            // One `restore` undoes the last change: it brings the hand-written sheet back, except after a reset, when
            // the second preset went over no sheet and restore leaves none (review of #609). A second restore undoes
            // the first.
            let afterReset = run == ["preset", "reset", "preset"]
            let before = try? String(contentsOfFile: file, encoding: .utf8)
            XCTAssertNoThrow(try StyleOps.restore(file: file).get(), "\(run): restore")
            XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), afterReset ? StyleOps.noSheet : mine, "\(run): restore undoes the last change")
            if let before {
                if !afterReset { XCTAssertEqual(try StyleOps.restore(file: file).get().object?["restored"]?.string?.hasSuffix(".bak.1"), true, "\(run)") }
                else { XCTAssertNoThrow(try StyleOps.restore(file: file).get(), "\(run)") }
                XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), before, "\(run): a second restore undoes the first")
                XCTAssertTrue(StyleOps.backups(file).contains { (try? String(contentsOfFile: $0, encoding: .utf8)) == mine }, "\(run): still kept")
            }
        }
        // The preset already in force is left alone: no write, no backup.
        let backups = StyleOps.backups(file)
        let again = try StyleOps.preset("omarchy", file: file, roles: Self.roles).get().object
        XCTAssertEqual(again?["unchanged"], .bool(true))
        XCTAssertEqual(again?["backup"], .null)
        XCTAssertEqual(StyleOps.backups(file), backups)
        // Reset of an unedited preset only removes it; the backup before it stays the newest, for restore.
        let reset = try StyleOps.reset(file: file).get().object
        XCTAssertEqual(reset?["preset"]?.string, "omarchy")
        XCTAssertEqual(reset?["backup"], .null)
        XCTAssertEqual(StyleOps.backups(file), backups)
        XCTAssertEqual(reset?["restorable"], StyleOps.backups(file).last.map { .string(StyleSheetFile.display($0)) })
        // Restore with no backup at all says so.
        for b in StyleOps.backups(file) { try FileManager.default.removeItem(atPath: b) }
        XCTAssertEqual(StyleOps.restore(file: file).failure?.code, "no_backup")
        XCTAssertEqual(StyleOps.restore(file: nil).failure?.code, "io_error")
    }

    /// A preset over no sheet is undone to no sheet: `restore` leaves no rules in force, and never brings back an older
    /// backup that a `reset` put away (review of #609).
    func testRestoreAfterAPresetOverNothingLeavesNoRules() throws {
        func clear() throws {
            for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) { try FileManager.default.removeItem(atPath: dir.appendingPathComponent(name).path) }
        }
        func rulesInForce() -> Int {
            guard case .text(let t) = StyleSheetFile.load(path: file) else { return 0 }
            return StyleSheet.parse(t).sheet.ruleCount
        }
        try clear()
        XCTAssertNoThrow(try StyleOps.preset("omarchy", file: file, roles: Self.roles).get())
        XCTAssertGreaterThan(rulesInForce(), 0)
        XCTAssertNoThrow(try StyleOps.restore(file: file).get(), "a preset over nothing can be undone")
        XCTAssertEqual(rulesInForce(), 0, "restore puts back no sheet: the theme alone styles")
        // A sheet put away by an earlier reset stays away.
        try clear()
        let old = "bar .clock { color: #ff0000; }\n"
        try old.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertNoThrow(try StyleOps.reset(file: file).get())
        XCTAssertNoThrow(try StyleOps.preset("omarchy", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.restore(file: file).get())
        XCTAssertEqual(rulesInForce(), 0, "the sheet reset away is not brought back")
        XCTAssertTrue(StyleOps.backups(file).contains { (try? String(contentsOfFile: $0, encoding: .utf8)) == old }, "and it is still kept")
        // A restore with no sheet in force keeps an empty one as its undo: the second restore goes back to no rules,
        // never on to a sheet a reset put away (review of #609, round 2).
        try clear()
        let b = "bar .clock { color: #0000ff; }\n", a = "bar .clock { color: #00ff00; }\n"
        try b.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertNoThrow(try StyleOps.reset(file: file).get())
        try a.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertNoThrow(try StyleOps.preset("omarchy", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.reset(file: file).get(), "an unedited preset is only removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
        XCTAssertNoThrow(try StyleOps.restore(file: file).get())
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), a, "restore brings back the sheet the preset replaced")
        XCTAssertNoThrow(try StyleOps.restore(file: file).get(), "a second restore undoes the first")
        XCTAssertEqual(rulesInForce(), 0, "back to no rules, not the sheet reset away")
        XCTAssertNotEqual(try? String(contentsOfFile: file, encoding: .utf8), b)
    }

    /// The app starts the store and the bar redraws on its notification (review of #604).
    func testTheAppStartsTheSheetAndTheBarFollowsIt() throws {
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("StyleSheetStore.shared.start("), "AppDelegate starts the style sheet store")
        let top = try SourceText.code("Sources/BaneySpaces/TopBar.swift")
        XCTAssertTrue(top.contains("StyleSheetStore.didChange"), "the bar redraws when the sheet changes")
        XCTAssertTrue(top.contains("Styles.shared"), "the bar draws from the sheet")
        XCTAssertTrue(top.contains("barHeight("), "the bar's height comes from the sheet")
        XCTAssertTrue(top.contains("!= self.placedHeight"), "the bar re-places on a mode change that moves its height")
    }

    /// Review of PR #624 second-F7: the dock's Appearance observer used to rebuild the book. With the dock gone, a mode
    /// switch must still rebuild it on main, so `@media (prefers-color-scheme)` rules follow Light and Dark: `Styles`
    /// does on its own, and the bar's observer does before it compares heights.
    func testAModeChangeRebuildsTheBookWithoutTheDock() throws {
        let styled = try SourceText.code("Sources/BaneySpaces/Styled.swift")
        let initBlock = try XCTUnwrap(SourceText.block(after: "private init()", in: styled))
        XCTAssertTrue(initBlock.contains("Appearance.didChange"), "Styles follows the mode itself")
        XCTAssertTrue(initBlock.contains("queue: .main"), "on the main thread")
        XCTAssertTrue(initBlock.contains("self?.sync()"))
        let top = try SourceText.code("Sources/BaneySpaces/TopBar.swift")
        let start = try XCTUnwrap(SourceText.block(after: "func start()", in: top))
        let mode = try XCTUnwrap(SourceText.block(after: "forName: Appearance.didChange, object: nil, queue: .main)", in: start))
        let sync = try XCTUnwrap(mode.range(of: "Styles.shared.sync()"), "the bar's Appearance observer rebuilds the book")
        let compare = try XCTUnwrap(mode.range(of: "!= self.placedHeight"))
        XCTAssertLessThan(sync.lowerBound, compare.lowerBound, "the book is rebuilt before the bar compares heights")
    }

    // MARK: The docs and the starter sheet can't drift from the table

    func testTheDocsHoldTheGeneratedTables() throws {
        let doc = try String(contentsOf: SourceText.root.appendingPathComponent("docs/style.md"), encoding: .utf8)
        XCTAssertTrue(doc.contains(StyleSheet.propertyTable), "docs/style.md's property table differs from StyleProperty.all; paste StyleSheet.propertyTable:\n\(StyleSheet.propertyTable)")
        XCTAssertTrue(doc.contains(StyleSheet.selectorTable), "docs/style.md's selector table differs from StyleTarget; paste StyleSheet.selectorTable:\n\(StyleSheet.selectorTable)")
        for role in StyleProperty.roles { XCTAssertTrue(doc.contains("--\(role)"), role) }
        // Every example in the docs parses with no problem.
        var blocks = doc.components(separatedBy: "```css\n").dropFirst().map { $0.components(separatedBy: "```")[0] }
        XCTAssertGreaterThanOrEqual(blocks.count, 3)
        for b in blocks { XCTAssertEqual(StyleOps.problems(b, roles: Self.roles).problems, [], b) }
        blocks = []
    }

    func testTheExampleNamesEverySurfacePartAndPropertyAndChecksClean() {
        let ex = StyleSheet.example
        let (s, p) = StyleSheet.parse(ex)
        XCTAssertEqual(p, [], "the starter sheet checks clean")
        XCTAssertTrue(s.isEmpty, "and applies nothing until a line is uncommented")
        for prop in StyleProperty.all { XCTAssertTrue(ex.contains("/* \(prop.name): "), prop.name) }
        for t in StyleTarget.allCases {
            for sel in t.selectors { XCTAssertTrue(ex.contains(sel), sel) }
            XCTAssertTrue(ex.contains(t.help), t.rawValue)
        }
        // Uncommented, every example value is valid where the example puts it.
        var uncommented = 0
        let live = ex.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            guard line.hasPrefix("  /* "), line.hasSuffix("; */") else { return String(line) }
            let body = line.dropFirst(5).dropLast(3)
            guard let colon = body.firstIndex(of: ":") else { return String(line) }
            let name = String(body[..<colon])
            guard name.hasPrefix("--") || StyleProperty.byName[name] != nil else { return String(line) }
            uncommented += 1
            return "  " + body
        }.joined(separator: "\n")
        XCTAssertGreaterThan(uncommented, StyleProperty.all.count)
        XCTAssertEqual(StyleSheet.parse(live).problems.filter(\.isError).map(\.description), [])
        XCTAssertFalse(StyleSheet.parse(live).sheet.isEmpty)
        XCTAssertFalse(ex.contains("\u{2014}") || ex.contains("\u{2013}"), "no em or en dashes")
    }

    // MARK: Editing in place

    func testSetEditsInPlaceKeepingCommentsAndOrder() throws {
        let start = """
        /* my sheet */
        bar {
          /* the bar's own ink */
          color: red;
          padding: 2px;
        }

        dock .tile { opacity: 0.9 }
        """
        try start.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertNoThrow(try StyleOps.set("bar", "color", "var(--accent)", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.set("bar", "height", "30px", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.set("dock .tile", "border-radius", "0", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.set("bar .clock", "color", "#d4af37", file: file, roles: Self.roles).get())
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), """
        /* my sheet */
        bar {
          /* the bar's own ink */
          color: var(--accent);
          padding: 2px;
          height: 30px;
        }

        dock .tile { opacity: 0.9; border-radius: 0; }

        bar .clock {
          color: #d4af37;
        }

        """)
        // The same selector written another way is the same rule.
        XCTAssertNoThrow(try StyleOps.set("dock .tile:hover.current", "opacity", "1", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.set("dock   .tile.current:hover", "opacity", "0.5", file: file, roles: Self.roles).get())
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8).components(separatedBy: "dock .tile.current:hover {").count, 2)
        XCTAssertTrue(try String(contentsOfFile: file, encoding: .utf8).contains("opacity: 0.5;"))
        // A custom property on :root, and a value set in dark mode.
        XCTAssertNoThrow(try StyleOps.set(":root", "--gold", "#d4af37", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.set("bar", "background", "glass", media: "dark", file: file, roles: Self.roles).get())
        XCTAssertNoThrow(try StyleOps.set("bar .clock", "color", "var(--gold)", media: "dark", file: file, roles: Self.roles).get())
        let text = try String(contentsOfFile: file, encoding: .utf8)
        XCTAssertTrue(text.contains("@media (prefers-color-scheme: dark) {\n  bar {\n    background: glass;\n  }\n  bar .clock {\n    color: var(--gold);\n  }\n}\n"), text)
        XCTAssertEqual(StyleSheet.parse(text).problems, [])
        let s = StyleSheet.parse(text).sheet
        XCTAssertEqual(s.computed(surface: .bar, dark: true, roles: Self.roles(true)).background, .glass)
        XCTAssertNil(s.computed(surface: .bar, dark: false, roles: Self.roles(false)).background)
    }

    func testSetIntoAnEmptyFileStartsASheetAndIntoOneLineRules() throws {
        XCTAssertNoThrow(try StyleOps.set("bar", "height", "30px", file: file, roles: Self.roles).get())
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8),
                       "/* Polycarp style sheet. `polycarp-spaces style example` lists every selector and property. */\nbar {\n  height: 30px;\n}\n")
        XCTAssertEqual(StyleEdit.set("bar {}", selector: StyleSelector(surface: .bar), property: "gap", value: "2px", media: nil), "bar { gap: 2px; }")
        XCTAssertEqual(StyleEdit.set("bar { }", selector: StyleSelector(surface: .bar), property: "gap", value: "2px", media: nil), "bar { gap: 2px; }")
        XCTAssertEqual(StyleEdit.set("bar { color: red }", selector: StyleSelector(surface: .bar), property: "gap", value: "2px", media: nil),
                       "bar { color: red; gap: 2px; }")
        XCTAssertEqual(StyleEdit.set("bar { color:; }", selector: StyleSelector(surface: .bar), property: "color", value: "red", media: nil),
                       "bar { color: red; }")
        XCTAssertEqual(StyleEdit.set("bar { color: red /* why */ ; }", selector: StyleSelector(surface: .bar), property: "color", value: "blue", media: nil),
                       "bar { color: blue /* why */ ; }")
        // A rule in a list isn't the selector alone: a new rule is added.
        XCTAssertEqual(StyleEdit.set("bar, dock { opacity: 1 }", selector: StyleSelector(surface: .bar), property: "opacity", value: "0.5", media: nil),
                       "bar, dock { opacity: 1 }\n\nbar {\n  opacity: 0.5;\n}\n")
    }

    func testASetThatWouldAddAnErrorWritesNothingAndSaysWhy() throws {
        let start = "bar { color: red }\n"
        try start.write(toFile: file, atomically: true, encoding: .utf8)
        for (sel, prop, value, code) in [("dock .tile", "height", "30px", "invalid_value"), ("bar", "font-size", "99px", "invalid_value"),
                                         ("bar", "color", "red; height: 99px", "invalid_value"), ("bar", "color", "red } dock { opacity: 0", "invalid_value"),
                                         ("bar", "color", "/* x */ red", "invalid_value"), ("bar", "colr", "red", "unknown_property"),
                                         ("bar .clok", "color", "red", "invalid_selector"), ("bar, dock", "color", "red", "invalid_selector"),
                                         ("bar", "--x", "red", "invalid_value"), ("bar", "color", "var(--nope)", "invalid_value"),
                                         ("bar", "color", "", "invalid_value")] {
            guard case .failure(let f) = StyleOps.set(sel, prop, value, file: file, roles: Self.roles) else { XCTFail("\(sel) \(prop) \(value)"); continue }
            XCTAssertEqual(f.code, code, "\(sel) \(prop) \(value): \(f.message)")
            XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), start, "nothing written for \(sel) \(prop) \(value)")
        }
        guard case .failure(let f) = StyleOps.set("dock .tile", "height", "30px", file: file, roles: Self.roles) else { return XCTFail() }
        XCTAssertTrue(f.message.contains("doesn't apply"), f.message)
        XCTAssertEqual(f.problems.first?.line, 4, "the problem's place in the sheet it would have made")
        XCTAssertEqual(StyleOps.set("bar", "color", "red", media: "dim", file: file, roles: Self.roles).failure?.exit, 2)
        // A file that already has an error can still be edited.
        try "bar { colr: red }\n".write(toFile: file, atomically: true, encoding: .utf8)
        let ok = try StyleOps.set("bar", "color", "blue", file: file, roles: Self.roles).get()
        XCTAssertNotNil(ok.object?["errors_already_there"])
    }

    func testUnsetRemovesDeclarationsAndEmptiedRulesKeepingTheRest() throws {
        let start = """
        /* keep me */
        bar {
          color: red;
          height: 30px; /* tall */
        }
        bar .clock { color: blue }
        dock .tile {
          /* a note */
          opacity: 1;
        }
        @media (prefers-color-scheme: dark) {
          bar { color: white }
        }
        """
        try start.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(try StyleOps.unset("bar", "color", file: file).get().object?["removed"], .number(1))
        XCTAssertEqual(try StyleOps.unset("bar .clock", "color", file: file).get().object?["removed"], .number(1))
        XCTAssertEqual(try StyleOps.unset("dock .tile", "opacity", file: file).get().object?["removed"], .number(1))
        XCTAssertEqual(try StyleOps.unset("bar", "color", media: "dark", file: file).get().object?["removed"], .number(1))
        XCTAssertEqual(try StyleOps.unset("bar", "gap", file: file).get().object?["removed"], .number(0))
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), """
        /* keep me */
        bar {
          height: 30px; /* tall */
        }
        dock .tile {
          /* a note */
        }

        """)
        XCTAssertEqual(try StyleOps.unset("bar", nil, file: file).get().object?["removed"], .number(1))
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), "/* keep me */\ndock .tile {\n  /* a note */\n}\n")
        XCTAssertEqual(StyleOps.unset("nope", nil, file: file).failure?.code, "invalid_selector")
    }

    func testSetThenUnsetRoundTripsToTheSameText() throws {
        let start = "/* a */\nbar {\n  color: red; /* b */\n}\n/* c */\n"
        try start.write(toFile: file, atomically: true, encoding: .utf8)
        for (sel, prop, value) in [("bar", "gap", "4px"), ("dock .badge", "color", "white"), ("bar .hour", "font-style", "italic")] {
            _ = try StyleOps.set(sel, prop, value, file: file, roles: Self.roles).get()
            _ = try StyleOps.unset(sel, prop, file: file).get()
        }
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), start, "set then unset leaves the text as it was")
    }

    // MARK: Fuzz: nothing crashes or hangs

    struct Seeded: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    func testRandomAndHostileInputNeverCrashesOrHangs() {
        let t0 = Date()
        var rng = Seeded(state: 20261121)
        let alphabet = Array("bar dock .clock .tile:hover.current{}();:,/*\"'#@-+.0123456789px%!var(--a,)rgb hsl linear-gradient \n\t\\".unicodeScalars)
        for _ in 0..<400 {
            let n = Int.random(in: 0...400, using: &rng)
            var bytes = [UInt8]()
            var s = String.UnicodeScalarView()
            for _ in 0..<n {
                if Bool.random(using: &rng) { s.append(alphabet[Int.random(in: 0..<alphabet.count, using: &rng)]) } else { bytes.append(UInt8.random(in: 0...255, using: &rng)) }
            }
            let text = String(s) + String(decoding: bytes, as: UTF8.self)
            let (sheet, _) = StyleSheet.parse(text)
            _ = sheet.computed(surface: .bar, part: "clock", region: "left", states: [.hover], dark: true, roles: Self.roles(true))
            _ = sheet.contrastWarnings(roles: Self.roles)
            _ = StyleEdit.set(text, selector: StyleSelector(surface: .bar), property: "color", value: "red", media: .dark)
            _ = StyleEdit.unset(text, selector: StyleSelector(surface: .bar), property: nil, media: nil)
        }
        let hostile = [
            String(repeating: "{", count: 100_000), String(repeating: "}", count: 100_000), String(repeating: "bar {", count: 20_000),
            String(repeating: "(", count: 50_000), "bar { color: " + String(repeating: "rgb(", count: 20_000) + " }",
            String(repeating: "@media (prefers-color-scheme: dark) {", count: 10_000),
            "bar { font-size: 1e99999px; height: " + String(repeating: "9", count: 10_000) + "px; opacity: -1e308; gap: 1e-400px }",
            "bar { color: #" + String(repeating: "f", count: 10_000) + " }", String(repeating: "a", count: 60_000),
            "/*" + String(repeating: "*", count: 60_000), String(repeating: "\"", count: 30_000), String(repeating: "bar, ", count: 10_000) + "dock {}",
            "bar { " + String(repeating: "color: red; ", count: 5000) + "}", "\u{0}\u{1}\u{FFFF}\u{10FFFF} bar { color: red }",
        ]
        for h in hostile {
            let (sheet, problems) = StyleSheet.parse(h)
            _ = sheet.computed(surface: .dock, part: "label", states: [.current], dark: false, roles: Self.roles(false))
            _ = sheet.contrastWarnings(roles: Self.roles)
            XCTAssertTrue(sheet.ruleCount >= 0 && problems.count >= 0)
        }
        XCTAssertTrue(errors("bar { font-size: 1e99999px }")[0].contains("too big"))
        XCTAssertEqual(errors("bar { height: 1e400px }").count, 1)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 60, "the fuzz finishes in time")
    }

    // MARK: The file

    func testTheFileLivesInTheConfigFolder() {
        XCTAssertEqual(StyleSheetFile.path(env: ["POLYCARP_CONFIG_DIR": "/tmp/pc"], home: "/Users/x"), "/tmp/pc/style.css")
        XCTAssertNil(StyleSheetFile.path(env: ["POLYCARP_CONFIG_DIR": "relative"], home: "/Users/x"))
        XCTAssertEqual(StyleSheetFile.path(env: ["XDG_CONFIG_HOME": "/x", "HOME": "/nonexistent-home"], home: nil), "/x/polycarp/style.css")
        XCTAssertEqual(StyleSheetFile.path(env: ["HOME": "/nonexistent-home"], home: nil), "/nonexistent-home/.config/polycarp/style.css")
    }

    func testReadingRefusesWhatIsntASmallUTF8File() throws {
        XCTAssertEqual(StyleSheetFile.load(path: file), .missing)
        try "\u{FEFF}bar { color: red }".write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(StyleSheetFile.load(path: file), .text("bar { color: red }"), "a byte order mark is dropped")
        try Data([0x62, 0xFF, 0xFE, 0x00]).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(StyleSheetFile.load(path: file), .rejected("not UTF-8 text"))
        try Data(repeating: 0x20, count: StyleSheetFile.maxBytes + 1).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(StyleSheetFile.load(path: file), .rejected("over \(StyleSheetFile.maxBytes) bytes"))
        try Data(repeating: 0x20, count: StyleSheetFile.maxBytes).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(StyleSheetFile.load(path: file), .text(String(repeating: " ", count: StyleSheetFile.maxBytes)))
        try FileManager.default.removeItem(atPath: file)
        try FileManager.default.createDirectory(atPath: file, withIntermediateDirectories: false)
        if case .rejected = StyleSheetFile.load(path: file) {} else { XCTFail("a folder is not a sheet") }
    }

    func testTheCommandsAnswerInTheThemeEnvelope() throws {
        XCTAssertEqual(StyleOps.check(file: file, roles: Self.roles).failure?.code, "io_error")
        try "bar {\n  colr: red;\n  color: red;\n}\n".write(toFile: file, atomically: true, encoding: .utf8)
        guard case .failure(let f) = StyleOps.check(file: file, roles: Self.roles) else { return XCTFail() }
        XCTAssertEqual(f.code, "invalid_style")
        XCTAssertEqual(f.exit, 1)
        let e = f.envelope.object?["error"]?.object
        XCTAssertEqual(f.envelope.object?["ok"], .bool(false))
        XCTAssertEqual(e?["retry"], .string("never"))
        let first = e?["data"]?.object?["errors"]?.array?.first?.object
        XCTAssertEqual(first?["line"], .number(2))
        XCTAssertEqual(first?["column"], .number(3))
        XCTAssertEqual(first?["severity"], .string("error"))
        XCTAssertTrue(first?["message"]?.string?.contains("did you mean `color`") ?? false)
        let shown = try StyleOps.show(file: file).get().object
        XCTAssertEqual(shown?["text"]?.string, "bar {\n  colr: red;\n  color: red;\n}\n")
        XCTAssertEqual(shown?["rules"]?.array?.first?.object?["declarations"]?.array?.count, 2)
        XCTAssertEqual(try StyleOps.path(file: file).get().object?["exists"], .bool(true))
        XCTAssertEqual(StyleOps.path(file: nil).failure?.code, "io_error")
        XCTAssertNotNil(try StyleOps.example().get().object?["text"]?.string)
        // reset moves the sheet aside to the next backup, never over an older one.
        try "old".write(toFile: file + ".bak", atomically: true, encoding: .utf8)
        try "older still".write(toFile: file + ".bak.07", atomically: true, encoding: .utf8)
        XCTAssertEqual(try StyleOps.reset(file: file).get().object?["backup"]?.string.map { $0.hasSuffix("style.css.bak.1") }, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
        XCTAssertEqual(try String(contentsOfFile: file + ".bak", encoding: .utf8), "old", "the older backup is kept")
        XCTAssertEqual(try String(contentsOfFile: file + ".bak.1", encoding: .utf8), "bar {\n  colr: red;\n  color: red;\n}\n")
        XCTAssertEqual(StyleOps.backups(file).map { ($0 as NSString).lastPathComponent }, ["style.css.bak", "style.css.bak.1"], "only names it writes count")
        XCTAssertEqual(try StyleOps.reset(file: file).get().object?["backup"], .null, "nothing to move is fine")
    }

    // MARK: Following the file

    final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var v = false
        func set(_ b: Bool) { lock.lock(); v = b; lock.unlock() }
        var value: Bool { lock.lock(); defer { lock.unlock() }; return v }
    }

    final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [StyleSheet] = []
        private var logged: [String] = []
        func add(_ s: StyleSheet) { lock.lock(); items.append(s); lock.unlock() }
        func log(_ s: String) { lock.lock(); logged.append(s); lock.unlock() }
        var all: [StyleSheet] { lock.lock(); defer { lock.unlock() }; return items }
        var lines: [String] { lock.lock(); defer { lock.unlock() }; return logged }
    }

    func testTheWatcherLogsEachChangeOnceAndAppliesWhatParsed() throws {
        let queue = DispatchQueue(label: "style-test")
        let seen = Seen()
        let w = StyleSheetWatcher(path: file, queue: queue, log: seen.log, schedule: { _, _, _, _ in {} }, watch: { _, _, _ in {} }, deliver: seen.add)
        w.start()
        queue.sync {}
        XCTAssertEqual(seen.all, [.empty], "no file: the empty sheet")
        XCTAssertEqual(seen.lines, [], "and no log")
        try "bar { color: red }\nbar .clock { colr: blue }\n".write(toFile: file, atomically: true, encoding: .utf8)
        w.tickNow()
        XCTAssertEqual(seen.lines, ["style.css: applied, 2 rules, 1 problem"])
        XCTAssertEqual(seen.all.last?.computed(surface: .bar, dark: false, roles: [:]).color, StyleColor(red: 1, green: 0, blue: 0))
        w.tickNow()
        XCTAssertEqual(seen.lines.count, 1, "an unchanged file is not logged again")
        try FileManager.default.removeItem(atPath: file)
        w.tickNow()
        XCTAssertEqual(seen.lines.last, "style.css: removed")
        XCTAssertEqual(seen.all.last, .empty)
        try FileManager.default.createDirectory(atPath: file, withIntermediateDirectories: false)
        w.tickNow()
        XCTAssertTrue(seen.lines.last?.hasPrefix("style.css: ignored") ?? false, "\(seen.lines)")
        XCTAssertTrue(seen.lines.last?.hasSuffix("; no style sheet") ?? false)
        w.stop()
    }

    func testAnEventsBrokenSheetWaitsAMomentBeforeItApplies() throws {
        let queue = DispatchQueue(label: "style-settle")
        let seen = Seen()
        try "bar { color: red }".write(toFile: file, atomically: true, encoding: .utf8)
        let w = StyleSheetWatcher(path: file, queue: queue, log: seen.log, schedule: { _, _, _, _ in {} }, watch: { _, _, _ in {} }, deliver: seen.add)
        w.start()
        queue.sync {}
        try "bar { color: re".write(toFile: file, atomically: true, encoding: .utf8)
        queue.sync { w.tick(fromEvent: true) }
        XCTAssertEqual(seen.all.count, 1, "held while an edit may still be under way")
        let landed = expectation(description: "applies after the settle")
        queue.asyncAfter(deadline: .now() + .milliseconds(250)) { landed.fulfill() }
        wait(for: [landed], timeout: 2)
        queue.sync {}
        XCTAssertEqual(seen.all.count, 2, "unchanged and still broken: it applies what parsed")
        w.stop()
    }

    /// A file that keeps failing to read waits on one retry at a time, however many looks fail meanwhile (review of #604).
    func testAFailingReadKeepsOneRetryWaiting() throws {
        try "bar { color: red }".write(toFile: file, atomically: true, encoding: .utf8)
        let queue = DispatchQueue(label: "style-retry")
        let seen = Seen()
        let pending = Pending()
        let w = StyleSheetWatcher(path: file, queue: queue, log: seen.log, schedule: { _, _, _, _ in {} }, watch: { _, _, _ in {} },
                                  load: { _ in .failed("busy") }, after: { _, _, f in pending.add(f) }, numbered: { s, _ in seen.add(s) })
        w.start()
        queue.sync {}
        for n in 1...5 {
            // Each look must see a new stamp, or it is skipped before the read.
            try ("bar { color: red }" + String(repeating: " ", count: n)).write(toFile: file, atomically: true, encoding: .utf8)
            w.tickNow()
        }
        XCTAssertEqual(pending.count, 1, "five failed looks, one retry")
        queue.sync { pending.runAll() }
        XCTAssertEqual(pending.count, 1, "the retry failed too and set up the next one, only one")
        XCTAssertEqual(seen.lines.count, 1, "the same problem is logged once")
        w.stop()
    }

    /// The first look comes back on the caller's thread while the watcher may already have delivered a newer sheet: the
    /// older one never replaces it (review of #604).
    func testAnOlderSheetNeverReplacesANewerOne() {
        let store = StyleSheetStore(center: NotificationCenter())
        let s1 = StyleSheet.parse("bar { color: red }").sheet
        let s2 = StyleSheet.parse("bar { color: blue }").sheet
        store.take(s2, generation: 2)
        store.take(s1, generation: 1, post: false)
        XCTAssertEqual(store.current, s2)
        store.take(s1, generation: 3)
        XCTAssertEqual(store.current, s1, "a newer one still lands")
    }

    private final class Pending: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [() -> Void] = []
        func add(_ f: @escaping () -> Void) { lock.lock(); items.append(f); lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
        func runAll() {
            lock.lock(); let now = items; items = []; lock.unlock()
            now.forEach { $0() }
        }
    }

    /// The watcher as the app builds it (`StyleSheetStore.start`): each `style set` reaches the notification on the main
    /// queue within 200 ms, with the new sheet already in `current`.
    func testTwentySetsEachReachTheNotificationWithinTwoHundredMilliseconds() throws {
        let center = NotificationCenter()
        let store = StyleSheetStore(center: center)
        store.start(path: file, firstLookWithin: 0.15)
        defer { store.stop() }
        XCTAssertEqual(store.current, .empty)
        var took: [Double] = []
        for i in 0..<20 {
            let size = Double(8 + i)
            let arrived = expectation(description: "set \(i + 1)")
            let onMain = Flag()
            let token = center.addObserver(forName: StyleSheetStore.didChange, object: nil, queue: nil) { note in
                guard let s = note.userInfo?[StyleSheetStore.key] as? StyleSheet,
                      s.computed(surface: .bar, part: "clock", dark: false, roles: [:]).fontSize == size else { return }
                onMain.set(Thread.isMainThread)
                arrived.fulfill()
            }
            let t0 = Date()
            XCTAssertNoThrow(try StyleOps.set("bar .clock", "font-size", "\(Int(size))px", file: file, roles: Self.roles).get())
            wait(for: [arrived], timeout: 1.5)
            took.append(Date().timeIntervalSince(t0) * 1000)
            center.removeObserver(token)
            XCTAssertTrue(onMain.value, "the notification comes on the main queue")
            XCTAssertEqual(store.current.computed(surface: .bar, part: "clock", dark: false, roles: [:]).fontSize, size)
        }
        let sorted = took.sorted()
        print(String(format: "style reload: 20 sets, median %.1f ms, max %.1f ms", sorted[10], sorted[19]))
        XCTAssertLessThan(sorted[19], 200, "every set lands within 200 ms: \(took.map { Int($0) })")
    }
}

private extension Result {
    var failure: Failure? { if case .failure(let f) = self { f } else { nil } }
}

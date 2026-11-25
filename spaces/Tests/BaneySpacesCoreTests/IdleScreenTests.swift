@testable import BaneySpacesCore
import XCTest

final class IdleScreenTests: XCTestCase {
    private let tz = TimeZone(identifier: "America/New_York")!
    private var on: Surfaces.Idle {
        var i = Surfaces.defaults.idle
        i.enabled = true
        return i
    }

    private func at(_ h: Int, _ m: Int, day: Int = 21) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        return cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: h, minute: m))!
    }

    func testItWaitsForTheMinutesAndForTheSwitch() {
        XCTAssertFalse(IdleScreen.shouldStart(idle: 3600, settings: Surfaces.defaults.idle, displayHeldAwake: false), "off by default")
        XCTAssertFalse(IdleScreen.shouldStart(idle: 599, settings: on, displayHeldAwake: false))
        XCTAssertTrue(IdleScreen.shouldStart(idle: 600, settings: on, displayHeldAwake: false), "ten minutes by default")
        XCTAssertFalse(IdleScreen.shouldStart(idle: 3600, settings: on, displayHeldAwake: true), "never over a video or a call")
        XCTAssertFalse(IdleScreen.shouldStart(idle: 3600, settings: on, displayHeldAwake: false, systemHasScreen: true),
                       "not behind the screen saver, the lock or a sleeping display")
        var soon = on
        soon.startAfterMinutes = 1
        XCTAssertTrue(IdleScreen.shouldStart(idle: 61, settings: soon, displayHeldAwake: false))
    }

    /// From a timer behind another app, activating Polycarp can fail, and then the waking key would land in that app.
    /// The cover takes the keyboard as a non-activating panel instead (review first-F1).
    func testTheCoverTakesTheKeyboardWithoutActivatingTheApp() throws {
        let code = try Repo.code("Sources/BaneySpaces/IdleCover.swift")
        XCTAssertTrue(code.contains(".nonactivatingPanel"))
        XCTAssertTrue(code.contains("class CoverWindow: NSPanel"))
        XCTAssertFalse(code.contains("NSApp.activate"), "the key must not depend on activation")
    }

    func testInputIsTheIdleTimeGoingDown() {
        XCTAssertTrue(IdleScreen.inputSince(lastIdle: 700, idle: 0.1))
        XCTAssertFalse(IdleScreen.inputSince(lastIdle: 700, idle: 700.5), "time going on is no input")
        XCTAssertFalse(IdleScreen.inputSince(lastIdle: 700, idle: 699.9), "a read a little off is no input")
    }

    func testMartyrNightShowsTheNameTheTimeAVerseAndALine() {
        let c = IdleScreen.content(on, at: at(21, 41), machine: "Rectory1", twentyFourHour: false, timeZone: tz)
        XCTAssertEqual(c.name, "R E C T O R Y 1")
        XCTAssertEqual(c.time, "9:41")
        XCTAssertNotNil(c.verse)
        XCTAssertNotNil(c.line)
        XCTAssertEqual(IdleScreen.content(on, at: at(21, 41), machine: "Rectory1", twentyFourHour: true, timeZone: tz).time, "21:41")
    }

    func testEachPartCanBeLeftOff() {
        var quiet = on
        quiet.showMachineName = false
        quiet.showVerse = false
        quiet.showKierkegaard = false
        let c = IdleScreen.content(quiet, at: at(9, 5), machine: "Rectory1", twentyFourHour: false, timeZone: tz)
        XCTAssertNil(c.name)
        XCTAssertNil(c.verse)
        XCTAssertNil(c.line)
        XCTAssertEqual(c.time, "9:05", "the time always shows")
        var verse = on
        verse.style = .verse
        let v = IdleScreen.content(verse, at: at(9, 5), machine: "Rectory1", twentyFourHour: false, timeZone: tz)
        XCTAssertNil(v.name, "one verse on black")
        XCTAssertNil(v.time)
        XCTAssertNil(v.line)
        XCTAssertNotNil(v.verse)
    }

    func testTheVerseTurnsHourlyAndTheLineDaily() {
        let a = IdleScreen.content(on, at: at(21, 0), machine: "m", twentyFourHour: false, timeZone: tz)
        let b = IdleScreen.content(on, at: at(22, 0), machine: "m", twentyFourHour: false, timeZone: tz)
        let c = IdleScreen.content(on, at: at(21, 0, day: 22), machine: "m", twentyFourHour: false, timeZone: tz)
        XCTAssertNotEqual(a.verse, b.verse)
        XCTAssertEqual(a.line, b.line)
        XCTAssertNotEqual(a.line, c.line)
    }

    func testEveryLineSaysWhereItIsFrom() {
        XCTAssertFalse(IdleScreen.kierkegaard.isEmpty)
        for line in IdleScreen.kierkegaard {
            XCTAssertTrue(line.source.contains("SKS"), line.text)
            XCTAssertFalse(line.text.contains("\u{2014}") || line.text.contains("\u{2013}"), "no dashes")
        }
    }

    func testALongNameStaysPlain() {
        XCTAssertEqual(IdleScreen.spaced("mac"), "M A C")
        XCTAssertEqual(IdleScreen.spaced("Donovan's MacBook Pro"), "DONOVAN'S MACBOOK PRO")
        XCTAssertEqual(IdleScreen.spaced("  "), "")
    }

    func testTheWordsDriftALittle() {
        let a = IdleScreen.drift(at: at(21, 0)), b = IdleScreen.drift(at: at(21, 30))
        XCTAssertNotEqual(a.x, b.x)
        for m in 0..<600 {
            let d = IdleScreen.drift(at: at(0, 0).addingTimeInterval(Double(m) * 60))
            XCTAssertLessThanOrEqual(abs(d.x), 14)
            XCTAssertLessThanOrEqual(abs(d.y), 14)
        }
    }

    func testTheSkyIsTheSameEveryRunAndStaysOnScreen() {
        XCTAssertEqual(IdleSky.embers(), IdleSky.embers())
        XCTAssertEqual(IdleSky.stars().count, IdleSky.starCount)
        for e in IdleSky.embers() {
            for t in stride(from: 0.0, to: 600, by: 7.3) {
                let p = IdleSky.place(e, at: t)
                XCTAssertTrue((0...1).contains(p.alpha))
                XCTAssertTrue((0.3...1.03).contains(p.y), "rises from the foot to two thirds up")
            }
        }
        for s in IdleSky.stars() { XCTAssertLessThanOrEqual(s.y, 0.55, "stars stay above the words") }
    }

    /// Every palette Polycarp ships reads on the idle screen's sky, at its top and its foot.
    func testTheThemeStyleReadsInEveryShippedTheme() throws {
        var seen = 0
        for palette in PaletteCatalog.shared.palettes.map(\.name) + ["auto"] {
            let c = IdleScreen.Colors.of(.theme, look: Look(theme: .omarchy, palette: palette, accent: AccentPreset.red.rgb), overPicture: false)
            for (what, color) in [("text", c.text), ("muted", c.muted), ("faint", c.faint), ("name", c.name)] {
                for sky in [c.skyTop, c.skyFoot] { XCTAssertGreaterThanOrEqual(color.contrast(with: sky), 4.5, "\(palette) \(what)") }
            }
            seen += 1
        }
        XCTAssertGreaterThan(seen, 20)
    }

    func testOnlyTheThemeStyleTakesTheThemeAndNeverOverAPicture() throws {
        var look = Look(theme: .omarchy, palette: "auto", accent: RGB(r: 0.2, g: 0.4, b: 0.9))
        look.palette = Palette(name: "t", isDark: false, colors: ["sunken": RGB(r: 0.9, g: 0.9, b: 0.9), "background": RGB(r: 1, g: 1, b: 1),
                                                                  "foreground": RGB(r: 0, g: 0, b: 0), "muted": RGB(r: 0.3, g: 0.3, b: 0.3),
                                                                  "accent": RGB(r: 1, g: 0.9, b: 0.3)])
        let c = IdleScreen.Colors.of(.theme, look: look, overPicture: false)
        XCTAssertEqual(c.skyTop, look.color("sunken"))
        XCTAssertEqual(c.skyFoot, look.color("background"))
        XCTAssertEqual(c.ember, look.color("accent"))
        XCTAssertEqual(c.name, look.color("foreground"), "an accent that doesn't read there is not the name's color")
        XCTAssertFalse(c.stars, "a light theme has no stars")
        XCTAssertEqual(IdleScreen.Colors.of(.theme, look: look, overPicture: true), .night)
        for style in Surfaces.IdleStyle.allCases where style != .theme {
            XCTAssertEqual(IdleScreen.Colors.of(style, look: look, overPicture: false), .night)
        }
    }

    func testTheNightKeepsItsColors() {
        XCTAssertEqual(IdleScreen.Colors.night.skyTop, RGB(hex: "#140F12"))
        XCTAssertEqual(IdleScreen.Colors.night.name, RGB(hex: "#D5B66F"))
        XCTAssertTrue(IdleScreen.Colors.night.stars)
    }
}

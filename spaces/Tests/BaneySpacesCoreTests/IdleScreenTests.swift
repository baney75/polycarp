import BaneySpacesCore
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
        var soon = on
        soon.startAfterMinutes = 1
        XCTAssertTrue(IdleScreen.shouldStart(idle: 61, settings: soon, displayHeldAwake: false))
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
}

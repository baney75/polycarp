import XCTest
import ImageIO
@testable import BaneySpacesCore

/// The desktop scene from surfaces.json: its light, its verse, its picture, and the keeper setting it.
final class DesktopSceneTests: XCTestCase {
    private let ny = TimeZone(identifier: "America/New_York")!

    private func date(_ s: String, _ tz: TimeZone? = nil) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = tz ?? ny
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.date(from: s)!
    }

    private func desktop(scene: Surfaces.Scene = .field, daylight: Bool = true, verse: Bool = true,
                         position: Surfaces.VersePosition = .bottomLeft, rotation: Surfaces.VerseRotation = .daily) -> Surfaces.Desktop {
        var d = Surfaces.defaults.desktop
        d.scene = scene; d.followDaylight = daylight; d.verse = verse; d.versePosition = position; d.verseRotation = rotation
        return d
    }

    // MARK: Light

    func testTheLightFollowsTheLocalDay() {
        // Midsummer in New York: sunrise about 5:25, sunset about 8:30.
        XCTAssertEqual(DaylightPhase.at(date("2026-06-21 03:00"), timeZone: ny), .night)
        XCTAssertEqual(DaylightPhase.at(date("2026-06-21 05:30"), timeZone: ny), .dawn)
        XCTAssertEqual(DaylightPhase.at(date("2026-06-21 12:00"), timeZone: ny), .day)
        XCTAssertEqual(DaylightPhase.at(date("2026-06-21 20:15"), timeZone: ny), .dusk)
        XCTAssertEqual(DaylightPhase.at(date("2026-06-21 22:30"), timeZone: ny), .night)
        // Midwinter: 5:30 is still dark, 4:45 in the afternoon is dusk.
        XCTAssertEqual(DaylightPhase.at(date("2026-12-21 05:30"), timeZone: ny), .night)
        XCTAssertEqual(DaylightPhase.at(date("2026-12-21 16:15"), timeZone: ny), .dusk)
    }

    func testSunriseIsWithinHalfAnHourOfTheAlmanac() throws {
        // New York, 2026-06-21: sunrise 5:25 and sunset 8:31 EDT. The zone's meridian (75 W) is 1 degree east of the city.
        let t = try XCTUnwrap(Sun.times(on: date("2026-06-21 12:00"), timeZone: ny, latitude: 40.7))
        XCTAssertEqual(t.rise, date("2026-06-21 05:25").timeIntervalSince1970, accuracy: 30 * 60)
        XCTAssertEqual(t.set, date("2026-06-21 20:31").timeIntervalSince1970, accuracy: 30 * 60)
    }

    func testPolarDayAndNightNeverCrash() {
        let svalbard = TimeZone(identifier: "Arctic/Longyearbyen")!
        XCTAssertEqual(DaylightPhase.at(date("2026-06-21 00:30", svalbard), timeZone: svalbard, latitude: 78), .day)
        XCTAssertEqual(DaylightPhase.at(date("2026-12-21 12:00", svalbard), timeZone: svalbard, latitude: 78), .night)
        let next = DaylightPhase.nextChange(after: date("2026-12-21 12:00", svalbard), timeZone: svalbard, latitude: 78)
        XCTAssertGreaterThan(next, date("2026-12-21 12:00", svalbard))
    }

    func testTheNextLightChangeIsTheNextEdge() {
        let now = date("2026-06-21 12:00")
        let next = DaylightPhase.nextChange(after: now, timeZone: ny)
        XCTAssertGreaterThan(next, now)
        XCTAssertLessThan(next.timeIntervalSince(now), 10 * 3600)
        XCTAssertEqual(DaylightPhase.at(next.addingTimeInterval(60), timeZone: ny), .dusk)
        XCTAssertEqual(DaylightPhase.at(next.addingTimeInterval(-60), timeZone: ny), .day)
    }

    // MARK: Verses

    func testEveryVerseIsShortPlainAndHasAReference() {
        XCTAssertGreaterThanOrEqual(Verses.desktop.count, 28)
        XCTAssertEqual(Set(Verses.desktop.map(\.ref)).count, Verses.desktop.count, "no verse twice")
        let reference = try! NSRegularExpression(pattern: SurfaceCheck.referencePattern)
        for v in Verses.desktop {
            XCTAssertLessThanOrEqual(v.text.count, 170, v.ref)
            XCTAssertFalse(v.text.contains("\u{2014}") || v.text.contains("\u{2013}"), "\(v.ref) has a dash")
            XCTAssertNotNil(reference.firstMatch(in: v.ref, range: NSRange(v.ref.startIndex..., in: v.ref)), "\(v.ref) is a reference fixed: takes")
        }
    }

    func testDailyTurnsAtMidnightAndHourlyOnTheHour() {
        let morning = date("2026-11-21 08:10"), evening = date("2026-11-21 21:50"), tomorrow = date("2026-11-22 00:05")
        XCTAssertEqual(Verses.pick(.daily, at: morning, timeZone: ny), Verses.pick(.daily, at: evening, timeZone: ny))
        XCTAssertNotEqual(Verses.pick(.daily, at: evening, timeZone: ny), Verses.pick(.daily, at: tomorrow, timeZone: ny))
        XCTAssertNotEqual(Verses.pick(.hourly, at: morning, timeZone: ny), Verses.pick(.hourly, at: morning.addingTimeInterval(3600), timeZone: ny))
        XCTAssertEqual(Verses.nextChange(.daily, after: evening, timeZone: ny), date("2026-11-22 00:00"))
        XCTAssertEqual(Verses.nextChange(.hourly, after: morning, timeZone: ny), date("2026-11-21 09:00"))
    }

    func testAFixedVerseStaysAndAnUnknownOneTurnsDaily() {
        let now = date("2026-11-21 08:10")
        XCTAssertEqual(Verses.pick(.fixed("psalm  46:10"), at: now, timeZone: ny)?.ref, "Psalm 46:10")
        XCTAssertEqual(Verses.pick(.fixed("Lamentations 3:22\u{2013}23"), at: now, timeZone: ny)?.ref, "Lamentations 3:22-23")
        XCTAssertNil(Verses.nextChange(.fixed("Psalm 46:10"), after: now, timeZone: ny), "a fixed verse never turns")
        XCTAssertEqual(Verses.pick(.fixed("Obadiah 1:4"), at: now, timeZone: ny), Verses.pick(.daily, at: now, timeZone: ny))
        XCTAssertNotNil(Verses.nextChange(.fixed("Obadiah 1:4"), after: now, timeZone: ny))
    }

    func testTheDivineNameIsSetInSmallCapitals() {
        let runs = DesktopScene.smallCaps("the LORD is my shepherd, the Lord GOD")
        XCTAssertEqual(runs.map(\.0).joined(), "the LORD is my shepherd, the Lord GOD", "no letter lost")
        XCTAssertEqual(runs.filter(\.1).map(\.0), ["ORD", "OD"])
        XCTAssertEqual(DesktopScene.smallCaps("LORDS of war").filter(\.1).count, 0, "only the whole word")
    }

    // MARK: The scene

    func testSurfacesPickTheScene() throws {
        let now = date("2026-11-21 12:00")
        XCTAssertNil(DesktopScene.of(desktop(scene: .solid), at: now, timeZone: ny, systemDark: false))
        XCTAssertNil(DesktopScene.of(desktop(scene: .image("dawn.png")), at: now, timeZone: ny, systemDark: false))
        let s = try XCTUnwrap(DesktopScene.of(desktop(scene: .olive), at: now, timeZone: ny, systemDark: false))
        XCTAssertEqual(s.kind, .olive)
        XCTAssertEqual(s.phase, .day)
        XCTAssertNotNil(s.verse)
        XCTAssertNil(DesktopScene.of(desktop(verse: false), at: now, timeZone: ny, systemDark: false)?.verse)
        XCTAssertEqual(DesktopScene.of(desktop(daylight: false), at: date("2026-11-21 23:00"), timeZone: ny, systemDark: false)?.phase, .day)
        XCTAssertEqual(DesktopScene.of(desktop(daylight: false), at: now, timeZone: ny, systemDark: true)?.phase, .night)
        XCTAssertNil(DesktopScene.nextChange(desktop(daylight: false, verse: false), after: now, timeZone: ny), "nothing turns")
    }

    func testTheNameChangesWithAnythingDrawn() {
        let v = Verses.desktop[0]
        let a = DesktopScene(kind: .field, phase: .day, verse: v, versePosition: .bottomLeft)
        var names: Set<String> = [a.fileName(width: 100, height: 60)]
        for b in [DesktopScene(kind: .water, phase: .day, verse: v, versePosition: .bottomLeft),
                  DesktopScene(kind: .field, phase: .dusk, verse: v, versePosition: .bottomLeft),
                  DesktopScene(kind: .field, phase: .day, verse: Verses.desktop[1], versePosition: .bottomLeft),
                  DesktopScene(kind: .field, phase: .day, verse: nil, versePosition: .bottomLeft),
                  DesktopScene(kind: .field, phase: .day, verse: v, versePosition: .topRight)] {
            names.insert(b.fileName(width: 100, height: 60))
        }
        names.insert(a.fileName(width: 200, height: 60))
        XCTAssertEqual(names.count, 7)
    }

    /// Mean brightness (0 to 1) of a rectangle of the picture, top-left origin, as fractions of its size.
    private func brightness(_ png: Data, _ r: CGRect) throws -> Double {
        let src = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
        let img = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        let w = img.width, h = img.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = try XCTUnwrap(CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        var sum = 0.0, n = 0.0
        for y in Int(r.minY * Double(h))..<Int(r.maxY * Double(h)) {
            for x in Int(r.minX * Double(w))..<Int(r.maxX * Double(w)) {
                let i = (y * w + x) * 4
                sum += (Double(px[i]) + Double(px[i + 1]) + Double(px[i + 2])) / 765
                n += 1
            }
        }
        return sum / n
    }

    func testTheSceneDrawsAtTheDisplaysSizeInItsLight() throws {
        let v = Verses.desktop[0]
        let day = try XCTUnwrap(DesktopScene(kind: .field, phase: .day, verse: v, versePosition: .bottomLeft).png(width: 640, height: 400))
        let night = try XCTUnwrap(DesktopScene(kind: .field, phase: .night, verse: v, versePosition: .bottomLeft).png(width: 640, height: 400))
        let src = try XCTUnwrap(CGImageSourceCreateWithData(day as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 640)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 400)
        let all = CGRect(x: 0, y: 0, width: 1, height: 1)
        XCTAssertGreaterThan(try brightness(day, all), 0.7)
        XCTAssertLessThan(try brightness(night, all), 0.25)
        for kind in DesktopScene.Kind.allCases {
            for phase in DaylightPhase.allCases {
                XCTAssertNotNil(DesktopScene(kind: kind, phase: phase, verse: v, versePosition: .center).png(width: 320, height: 200), "\(kind) \(phase)")
            }
        }
    }

    func testTheVerseIsDrawnWhereItIsAskedAndTheLiliesStandOpposite() throws {
        let v = Verses.desktop[0]
        let plain = try XCTUnwrap(DesktopScene(kind: .parchment, phase: .day, verse: nil, versePosition: .bottomLeft).png(width: 800, height: 500))
        let left = try XCTUnwrap(DesktopScene(kind: .parchment, phase: .day, verse: v, versePosition: .bottomLeft).png(width: 800, height: 500))
        // The verse darkens the lower left and leaves the lower right alone.
        let lowerLeft = CGRect(x: 0.05, y: 0.62, width: 0.34, height: 0.18), lowerRight = CGRect(x: 0.61, y: 0.62, width: 0.34, height: 0.18)
        XCTAssertLessThan(try brightness(left, lowerLeft), try brightness(plain, lowerLeft) - 0.01)
        XCTAssertEqual(try brightness(left, lowerRight), try brightness(plain, lowerRight), accuracy: 0.002)

        // Lilies stand at the right with the verse on the left, and move left when the verse moves right.
        let lilies = CGRect(x: 0.72, y: 0.72, width: 0.12, height: 0.2), mirror = CGRect(x: 0.16, y: 0.72, width: 0.12, height: 0.2)
        let fieldL = try XCTUnwrap(DesktopScene(kind: .field, phase: .day, verse: nil, versePosition: .bottomLeft).png(width: 800, height: 500))
        let fieldR = try XCTUnwrap(DesktopScene(kind: .field, phase: .day, verse: nil, versePosition: .bottomRight).png(width: 800, height: 500))
        XCTAssertEqual(try brightness(fieldL, lilies), try brightness(fieldR, mirror), accuracy: 0.01)
        XCTAssertNotEqual(try brightness(fieldL, lilies), try brightness(fieldL, mirror), accuracy: 0.005)
    }

    // MARK: Setting it

    func testTheKeeperSetsTheSceneAndClearsOldOnes() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-scene-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let own = dir.appendingPathComponent("own.jpg")
        try Data("own".utf8).write(to: own)
        let d = ThemeWallpaperTests.FakeDesktop()
        d.shown = ["A": (own, PictureOptions())]
        d.pixels = ["A": (320, 200)]
        let k = WallpaperKeeper(folder: dir.appendingPathComponent("support"), desktop: d)

        // A scene from a day and a half ago, and one from an hour ago (another Space may still show it).
        try FileManager.default.createDirectory(at: k.pictures, withIntermediateDirectories: true)
        let stale = k.pictures.appendingPathComponent("scene-field-dawn-00000000-320x200.png")
        let recent = k.pictures.appendingPathComponent("scene-field-dawn-11111111-320x200.png")
        for (f, age) in [(stale, 36.0), (recent, 1.0)] {
            try Data("old".utf8).write(to: f)
            try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-age * 3600)], ofItemAtPath: f.path)
        }

        let scene = DesktopScene(kind: .field, phase: .day, verse: Verses.desktop[0], versePosition: .bottomLeft)
        XCTAssertEqual(k.sync(.scene(scene)).set, ["A"])
        XCTAssertEqual(d.shown["A"]?.url.lastPathComponent, scene.fileName(width: 320, height: 200))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path), "a day-old scene goes")
        XCTAssertTrue(FileManager.default.fileExists(atPath: recent.path), "a recent one stays")
        XCTAssertEqual(k.sync(nil).restored, ["A"], "the person's own picture comes back")
        XCTAssertEqual(d.shown["A"]?.url, own)
    }
}

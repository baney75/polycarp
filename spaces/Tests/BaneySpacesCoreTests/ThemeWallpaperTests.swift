import XCTest
import ImageIO
@testable import BaneySpacesCore

/// T2: a theme's desktop picture, and the person's own picture kept and put back. The desktop is a fake: no test ever
/// reads or sets the real one.
final class ThemeWallpaperTests: XCTestCase {
    private var dir: URL!
    private var userPics: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-wallpaper-\(UUID().uuidString)")
        userPics = dir.appendingPathComponent("user")
        try FileManager.default.createDirectory(at: userPics, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    final class FakeDesktop: DesktopPictures {
        var shown: [String: (url: URL, options: PictureOptions)] = [:]
        var pixels: [String: (width: Int, height: Int)] = [:]
        var refuse = false
        var sets = 0
        func displays() -> [(key: String, pixels: (width: Int, height: Int))] { shown.keys.sorted().map { ($0, pixels[$0] ?? (64, 40)) } }
        func picture(_ display: String) -> (url: URL, options: PictureOptions)? { shown[display] }
        func set(_ display: String, url: URL, options: PictureOptions) throws {
            if refuse { throw CocoaError(.fileWriteNoPermission) }
            sets += 1
            shown[display] = (url, options)
        }
    }

    private func userPicture(_ name: String) throws -> URL {
        let u = userPics.appendingPathComponent(name)
        try Data("picture \(name)".utf8).write(to: u)
        return u
    }

    private func theme(_ fixture: String = PolycarpFixtures.still_water) throws -> PolycarpTheme {
        try PolycarpTheme.parse(Data(fixture.utf8)).get()
    }

    /// The picture a fixture's theme shows, as the app works it out.
    private func wall(_ fixture: String = PolycarpFixtures.still_water, dark: Bool = false) throws -> ThemeWallpaper {
        ThemeWallpaper.of(try theme(fixture), json: Data(fixture.utf8), systemDark: dark)
    }

    private func keeper(_ d: FakeDesktop) -> WallpaperKeeper { WallpaperKeeper(folder: dir.appendingPathComponent("support"), desktop: d) }

    func testAThemeSetsEveryDisplayAndTurningItOffPutsEachOwnPictureBack() throws {
        let d = FakeDesktop()
        let a = try userPicture("beach.jpg"), b = try userPicture("hills.heic")
        d.shown = ["A": (a, PictureOptions(scaling: 3, allowClipping: false)), "B": (b, PictureOptions(scaling: 1))]
        let k = keeper(d)
        let w = try wall()
        let out = k.sync(w)
        XCTAssertEqual(out.set, ["A", "B"])
        XCTAssertTrue(k.isOurs(d.shown["A"]!.url) && k.isOurs(d.shown["B"]!.url), "every display shows the theme's picture")
        let back = k.sync(nil)
        XCTAssertEqual(back.restored, ["A", "B"])
        XCTAssertEqual(d.shown["A"]!.url, a)
        XCTAssertEqual(d.shown["A"]!.options, PictureOptions(scaling: 3, allowClipping: false), "and how it filled the display")
        XCTAssertEqual(d.shown["B"]!.url, b)
    }

    func testTheOwnPictureIsRecordedAndCopiedBeforeItIsCovered() throws {
        let d = FakeDesktop()
        let a = try userPicture("beach.jpg")
        d.shown = ["A": (a, PictureOptions())]
        let k = keeper(d)
        k.sync(try wall())
        // A new keeper (the next launch) reads the record from disk.
        let again = keeper(d)
        XCTAssertEqual(again.saved.map(\.url), [a])
        let copy = try XCTUnwrap(again.saved.first?.copy)
        XCTAssertEqual(try Data(contentsOf: copy), try Data(contentsOf: a), "a copy of the file itself")
        // The original is deleted while the theme shows: the copy comes back.
        try FileManager.default.removeItem(at: a)
        XCTAssertEqual(again.sync(nil).restored, ["A"])
        XCTAssertEqual(d.shown["A"]!.url, copy)
    }

    func testAPictureThatCannotBeKeptIsNeverCovered() throws {
        let d = FakeDesktop()
        d.shown = ["A": (userPics.appendingPathComponent("gone.jpg"), PictureOptions())]
        let k = keeper(d)
        let out = k.sync(try wall())
        XCTAssertEqual(out.set, [])
        XCTAssertNotNil(out.skipped["A"])
        XCTAssertEqual(d.sets, 0, "nothing set without a saved copy")
    }

    func testChangingThemesNeverRecordsPolycarpsOwnPictureAsTheirs() throws {
        let d = FakeDesktop()
        let a = try userPicture("beach.jpg")
        d.shown = ["A": (a, PictureOptions())]
        let k = keeper(d)
        k.sync(try wall())
        k.sync(try wall(PolycarpFixtures.blocks, dark: true))
        XCTAssertEqual(k.saved.map(\.url), [a], "the second theme's look found the first theme's picture: not theirs")
        k.sync(nil)
        XCTAssertEqual(d.shown["A"]!.url, a)
    }

    func testAPictureChosenWhileTheThemeShowsIsTheOneThatComesBack() throws {
        let d = FakeDesktop()
        let a = try userPicture("beach.jpg"), b = try userPicture("forest.png")
        d.shown = ["A": (a, PictureOptions())]
        let k = keeper(d)
        let w = try wall()
        k.sync(w)
        d.shown["A"] = (b, PictureOptions())   // they picked another in System Settings
        k.sync(w)
        XCTAssertEqual(k.saved.map(\.url), [b])
        k.sync(nil)
        XCTAssertEqual(d.shown["A"]!.url, b)
    }

    func testOffWithNothingOfOursShowingChangesNothing() throws {
        let d = FakeDesktop()
        d.shown = ["A": (try userPicture("beach.jpg"), PictureOptions())]
        let out = keeper(d).sync(nil)
        XCTAssertEqual(out, WallpaperKeeper.Outcome())
        XCTAssertEqual(d.sets, 0)
    }

    func testARefusedSetLeavesTheDisplayAndSaysWhy() throws {
        let d = FakeDesktop()
        d.shown = ["A": (try userPicture("beach.jpg"), PictureOptions())]
        d.refuse = true
        let out = keeper(d).sync(try wall())
        XCTAssertEqual(out.set, [])
        XCTAssertTrue(out.skipped["A"]!.contains("refused"))
    }

    func testTheGradientIsTheThemesColorsTopToBottomAtTheDisplaysSize() throws {
        let t = try theme()
        let roles = t.colors(systemDark: false).roles
        guard case .gradient(let top, let bottom) = try wall() else { return XCTFail("a gradient by default") }
        XCTAssertEqual(top, roles["background"])
        XCTAssertEqual(bottom, roles["sunken"])
        let png = try XCTUnwrap(ThemeWallpaper.gradient(top, bottom).png(width: 30, height: 200))
        let src = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
        let img = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        XCTAssertEqual(img.width, 30); XCTAssertEqual(img.height, 200)
        let data = try XCTUnwrap(img.dataProvider?.data as Data?)
        func pixel(row: Int) -> RGB {
            let o = row * img.bytesPerRow + 15 * 4
            return RGB(r: Double(data[o]) / 255, g: Double(data[o + 1]) / 255, b: Double(data[o + 2]) / 255)
        }
        func near(_ a: RGB, _ b: RGB) -> Bool { abs(a.r - b.r) + abs(a.g - b.g) + abs(a.b - b.b) < 0.04 }
        XCTAssertTrue(near(pixel(row: 0), top), "top row is the background")
        XCTAssertTrue(near(pixel(row: 199), bottom), "bottom row is sunken")
    }

    func testAThemeCanNameItsPicture() throws {
        let roles = try theme().colors(systemDark: false).roles
        XCTAssertEqual(ThemeWallpaper.parse("solid:accent", roles: roles), .solid(roles["accent"]!))
        XCTAssertEqual(ThemeWallpaper.parse("gradient:surface, accent", roles: roles), .gradient(roles["surface"]!, roles["accent"]!))
        XCTAssertEqual(ThemeWallpaper.parse("image:dunes-1.heic", roles: roles), .image("dunes-1.heic"))
        for bad in ["image:../etc/passwd", "image:a.gif", "solid:nope", "gradient:accent", "plasma", ""] {
            XCTAssertEqual(ThemeWallpaper.parse(bad, roles: roles), .standard(roles), bad)
        }
    }

    func testTheThemeFileNamesItsPictureAndStaysATheme() throws {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(PolycarpFixtures.still_water.utf8)) as? [String: Any])
        var surfaces = try XCTUnwrap(root["surfaces"] as? [String: Any])
        var spaces = try XCTUnwrap(surfaces["spaces"] as? [String: Any])
        spaces["wallpaper"] = "solid:accent"
        surfaces["spaces"] = spaces
        root["surfaces"] = surfaces
        let json = try JSONSerialization.data(withJSONObject: root)
        let t = try PolycarpTheme.parse(json).get()
        XCTAssertEqual(ThemeWallpaper.of(t, json: json, systemDark: true), .solid(t.colors(systemDark: true).roles["accent"]!))
        XCTAssertEqual(ThemeWallpaper.of(t, json: nil, systemDark: true), .standard(t.colors(systemDark: true).roles), "no file: the theme's own gradient")
        let path = dir.appendingPathComponent("theme.json")
        try json.write(to: path)
        XCTAssertEqual(ThemeWallpaper.themeJSON(atPath: path.path), json)
        XCTAssertNil(ThemeWallpaper.themeJSON(atPath: dir.path), "a folder is no theme file")
    }

    func testTheSwitchIsOffUntilTurnedOn() throws {
        XCTAssertFalse(AppearanceSettings().themeWallpaper)
        XCTAssertFalse(AppearanceSettings.decoded(Data("{}".utf8)).themeWallpaper)
        var s = AppearanceSettings()
        s.themeWallpaper = true
        XCTAssertTrue(AppearanceSettings.decoded(s.encoded()).themeWallpaper)
    }

    func testEachSpaceGetsItsOwnPictureBackAndNothingIsLeftToKeep() throws {
        let d = FakeDesktop()
        let beach = try userPicture("beach.jpg"), hills = try userPicture("hills.heic")
        let k = keeper(d)
        let w = try wall()
        d.shown = ["A space 1": (beach, PictureOptions())]
        k.sync(w)
        let ours = try XCTUnwrap(d.shown["A space 1"]?.url)
        // The person goes to Space 2, which has its own picture: the theme covers that one too.
        d.shown = ["A space 2": (hills, PictureOptions())]
        k.sync(w)
        XCTAssertEqual(Set(k.saved.map(\.url)), [beach, hills])
        // Off on Space 2, then back to Space 1, which still shows the theme's picture.
        k.sync(nil)
        XCTAssertEqual(d.shown["A space 2"]?.url, hills)
        d.shown = ["A space 1": (ours, PictureOptions())]
        k.sync(nil)
        XCTAssertEqual(d.shown["A space 1"]?.url, beach, "Space 1 gets its own picture, not Space 2's")
        XCTAssertEqual(k.saved, [], "everything is back: nothing left to keep or look at")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: k.kept.path), [], "and no copies left behind")
    }
}

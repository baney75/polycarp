import XCTest
@testable import BaneySpacesCore

/// The browser's frame, tabs and toolbar in the theme in force (spec/browser.md R-B16).
final class BrowserThemeTests: XCTestCase {
    private func rgb(_ hex: String) -> RGB { RGB(hex: hex)! }
    private func colors(_ change: [String: String] = [:]) -> PolycarpTheme.Colors {
        var roles = ["background": "#101418", "surface": "#1C2026", "sunken": "#0A0C10", "foreground": "#E8E4DC", "strong": "#FFFFFF",
                     "muted": "#A09A90", "accent": "#7FB0FF", "border": "#30343A", "selection": "#2A3A55", "urgent": "#FF7070",
                     "working": "#F0C060", "done": "#70D090"]
        roles.merge(change) { $1 }
        return PolycarpTheme.Colors(roles: roles.mapValues(rgb), onAccent: rgb("#000000"))
    }

    func testEachColorTakesItsRole() {
        let got = BrowserTheme.colors(colors()).mapValues(\.hex)
        XCTAssertEqual(got, ["frame": "#0A0C10", "frame_inactive": "#0A0C10", "toolbar": "#1C2026", "omnibox_background": "#101418",
                             "ntp_background": "#101418", "tab_text": "#E8E4DC", "tab_background_text": "#A09A90",
                             "tab_background_text_inactive": "#A09A90", "bookmark_text": "#E8E4DC", "toolbar_text": "#E8E4DC",
                             "toolbar_button_icon": "#E8E4DC", "omnibox_text": "#E8E4DC", "ntp_text": "#E8E4DC", "ntp_link": "#7FB0FF"])
    }

    func testTabTextAlwaysReads() {
        // Muted too dim on the frame goes to the foreground; a foreground too dim to strong; strong too, to white.
        let dim = BrowserTheme.colors(colors(["muted": "#202020"]))
        XCTAssertEqual(dim["tab_background_text"]?.hex, "#E8E4DC")
        let dimmer = BrowserTheme.colors(colors(["muted": "#202020", "foreground": "#303030"]))
        XCTAssertEqual([dimmer["tab_background_text"]?.hex, dimmer["tab_text"]?.hex, dimmer["ntp_link"]?.hex], ["#FFFFFF", "#FFFFFF", "#7FB0FF"])
        let none = BrowserTheme.colors(colors(["muted": "#202020", "foreground": "#303030", "strong": "#252525", "accent": "#202020"]))
        XCTAssertEqual([none["tab_text"]?.hex, none["ntp_link"]?.hex], ["#FFFFFF", "#FFFFFF"])
        let light = BrowserTheme.colors(colors(["sunken": "#F0F0F0", "surface": "#FAFAFA", "background": "#FFFFFF", "muted": "#E0E0E0", "foreground": "#F5F5F5", "strong": "#EEEEEE", "accent": "#DDDDDD"]))
        XCTAssertEqual([light["tab_text"]?.hex, light["tab_background_text"]?.hex, light["ntp_link"]?.hex], ["#000000", "#000000", "#000000"])
        let strong = BrowserTheme.colors(colors(["foreground": "#303030", "strong": "#D0D0D0", "accent": "#203040"]))
        XCTAssertEqual([strong["tab_text"]?.hex, strong["ntp_link"]?.hex], ["#D0D0D0", "#D0D0D0"], "accent goes to foreground, then strong")
        let link = BrowserTheme.colors(colors(["accent": "#203040"]))
        XCTAssertEqual(link["ntp_link"]?.hex, "#E8E4DC")
        let near = BrowserTheme.colors(colors(["muted": "#707070"]))
        XCTAssertEqual(near["tab_background_text"]?.hex, "#E8E4DC", "3.9 to 1 is not enough")
        let pale = BrowserTheme.colors(colors(["surface": "#808080"]))
        XCTAssertEqual([pale["tab_text"]?.hex, pale["tab_background_text"]?.hex], ["#000000", "#A09A90"], "tab text reads on the toolbar, the others on the frame")
        for c in [dim, strong, link, near, pale, dimmer, none, light, BrowserTheme.colors(colors())] {
            for (text, ground) in [("tab_text", "toolbar"), ("tab_background_text", "frame"), ("tab_background_text_inactive", "frame_inactive"), ("omnibox_text", "omnibox_background"), ("ntp_text", "ntp_background")] {
                XCTAssertGreaterThanOrEqual(c[text]!.contrast(with: c[ground]!), 4.5, text)
            }
        }
    }

    func testEachChannelIsRounded() throws {
        var roles = colors().roles
        roles["sunken"] = RGB(r: 0.5, g: 0.2, b: 0.9)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: BrowserTheme.manifest(PolycarpTheme.Colors(roles: roles, onAccent: rgb("#000000")))) as? [String: Any])
        XCTAssertEqual(((o["theme"] as? [String: Any])?["colors"] as? [String: [Int]])?["frame"], [128, 51, 230])
    }

    func testTheManifestIsATheme() throws {
        let theme = try PolycarpTheme.parse(Data(PolycarpFixtures.still_water.utf8)).get()
        for dark in [false, true] {
            let o = try XCTUnwrap(JSONSerialization.jsonObject(with: BrowserTheme.manifest(theme, systemDark: dark)) as? [String: Any])
            XCTAssertEqual(o["manifest_version"] as? Int, 3)
            XCTAssertEqual(o["version"] as? String, "1.0")
            XCTAssertNil(o["permissions"] ?? o["background"] ?? o["content_scripts"], "a theme and nothing else")
            let got = try XCTUnwrap((o["theme"] as? [String: Any])?["colors"] as? [String: [Int]])
            let want = BrowserTheme.colors(theme.isDark(systemDark: dark) ? theme.dark : theme.light)
            XCTAssertEqual(got.keys.sorted(), want.keys.sorted())
            XCTAssertEqual(got["frame"], [want["frame"]!.r, want["frame"]!.g, want["frame"]!.b].map { Int(($0 * 255).rounded()) })
            XCTAssertTrue(got.values.allSatisfy { $0.count == 3 && $0.allSatisfy((0...255).contains) })
        }
        XCTAssertEqual(theme.mode, .auto)
        XCTAssertNotEqual(BrowserTheme.manifest(theme, systemDark: false), BrowserTheme.manifest(theme, systemDark: true), "auto follows Dark Mode")
    }
}

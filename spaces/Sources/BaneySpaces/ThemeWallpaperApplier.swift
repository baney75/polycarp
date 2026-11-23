import AppKit
import BaneySpacesCore

@_silgen_name("CGSMainConnectionID") private func CGSMainConnectionID() -> Int32
// The same declaration as Keys.swift: one symbol may have only one Swift type in this module.
@_silgen_name("CGSCopyManagedDisplaySpaces") private func CGSCopyManagedDisplaySpaces(_ cid: Int32) -> CFArray

/// Settings › Appearance › "Theme sets the desktop picture" on the real desktop: `WallpaperKeeper` with NSWorkspace's
/// public desktop picture calls. It looks when the theme or the switch changes, when the macOS Space changes (each Space
/// keeps its own picture, and the public call sets the one in front, so another Space takes the theme's when you go to
/// it) and when a display comes or goes. Off and with nothing of Polycarp's showing, a look is one read per display.
final class ThemeWallpaperApplier {
    static let shared = ThemeWallpaperApplier()

    private lazy var keeper = WallpaperKeeper(folder: Product.supportDir(home: URL(fileURLWithPath: NSHomeDirectory())).appendingPathComponent("Wallpaper", isDirectory: true),
                                              desktop: SystemDesktop(),
                                              bundledFolder: Bundle.main.resourceURL?.appendingPathComponent("Wallpapers", isDirectory: true),
                                              papersFolder: Self.papers.folder)
    /// Papers/ beside surfaces.json, where `paper set` keeps pictures.
    static let papers = PaperStore.beside(surfacesFile: SurfacesFile.path())
    private var observers: [NSObjectProtocol] = []
    private var last: ThemeWallpaper??

    /// Wires the looks once. Main thread.
    func start() {
        guard observers.isEmpty else { return }
        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.sync(force: true) })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sync(force: true)
        })
        observers.append(NotificationCenter.default.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { [weak self] _ in self?.sync(force: false) })
        observers.append(NotificationCenter.default.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in self?.sync(force: false) })
        // A Mac asleep through dawn wakes to the old light: look again.
        observers.append(ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.sync(force: false) })
        sync(force: true)
    }

    /// Fires at the scene's next phase edge or verse change, so the desktop turns with the day.
    private var turn: Timer?

    /// What should show now. A paper (`desktop.paper`, else `paper`) first, whatever the switch and the theme: someone
    /// asked for it by name. Else, while the switch is on and a Polycarp theme is in force (else nothing): the desktop
    /// scene surfaces.json names (`desktop.scene`), drawn in the hour's light with its verse; for `solid`, the theme's
    /// own picture; for `image:<file>`, that picture from the app's Wallpapers.
    var wanted: ThemeWallpaper? {
        let a = Appearance.shared
        let surfaces = SurfacesStore.shared.current
        let themeJSON = { PolycarpThemeFile.path().flatMap(ThemeWallpaper.themeJSON(atPath:)) }
        if let paper = surfaces.paper(on: .desktop),
           let w = paper.wallpaper(desktop: surfaces.desktop, papers: Self.papers.folder, at: Date(), systemDark: Appearance.systemDark, themeOwn: {
               if let t = a.polycarp { return ThemeWallpaper.of(t, json: themeJSON(), systemDark: Appearance.systemDark) }
               let look = a.look
               return .gradient(look.color("background"), look.color("sunken"))
           }) {
            return w
        }
        guard a.settings.themeWallpaper, let t = a.polycarp else { return nil }
        let desktop = surfaces.desktop
        if let scene = DesktopScene.of(desktop, at: Date(), systemDark: Appearance.systemDark) { return .scene(scene) }
        if case .image(let file) = desktop.scene { return .image(file) }
        return ThemeWallpaper.of(t, json: themeJSON(), systemDark: Appearance.systemDark)
    }

    /// `force` looks even if what should show hasn't changed (a Space or a display did).
    func sync(force: Bool) {
        let want = wanted
        schedule(want)
        if !force, let last, last == want { return }
        // Never asked and never covered anything: nothing to put back.
        if want == nil, last == nil || last == .some(nil), keeper.saved.isEmpty { last = .some(nil); return }
        last = .some(want)
        let out = keeper.sync(want)
        if !out.set.isEmpty { Trace.log("theme wallpaper: set on \(out.set.count) display(s)") }
        if !out.restored.isEmpty { Trace.log("theme wallpaper: your own picture back on \(out.restored.count) display(s)") }
        for (d, why) in out.skipped.sorted(by: { $0.key < $1.key }) { Trace.log("theme wallpaper: left display \(d) alone: \(why)") }
    }

    /// One timer, for the next moment a scene may look different; none when no scene shows. It times the drawn scene, a
    /// scene paper's when one is set, not `desktop.scene`.
    private func schedule(_ want: ThemeWallpaper?) {
        turn?.invalidate()
        turn = nil
        guard let next = SurfacesStore.shared.current.nextDesktopTurn(want, after: Date()) else { return }
        let t = Timer(fire: next.addingTimeInterval(1), interval: 0, repeats: false) { [weak self] _ in self?.sync(force: false) }
        t.tolerance = 30
        RunLoop.main.add(t, forMode: .common)
        turn = t
    }
}

/// The real desktop through NSWorkspace. macOS keeps a picture for each Space on each display and the public calls read and
/// set the one in front, so a key is the display's UUID and the Space it shows (`<uuid> space <id>`): each Space's own
/// picture is kept on its own and comes back to that Space.
private struct SystemDesktop: DesktopPictures {
    private func screen(_ key: String) -> NSScreen? { NSScreen.screens.first { key.hasPrefix(Self.uuid($0)) } }

    static func uuid(_ s: NSScreen) -> String {
        guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let uuid = CGDisplayCreateUUIDFromDisplayID(n.uint32Value)?.takeRetainedValue() else { return s.localizedName }
        return CFUUIDCreateString(nil, uuid) as String
    }

    /// The Space each display shows, by display UUID; "Main" when displays share one set of Spaces.
    private static func currentSpaces() -> [String: Int] {
        guard let displays = CGSCopyManagedDisplaySpaces(CGSMainConnectionID()) as? [[String: Any]] else { return [:] }
        var out: [String: Int] = [:]
        for d in displays {
            guard let id = d["Display Identifier"] as? String, let space = (d["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int else { continue }
            out[id] = space
        }
        return out
    }

    func displays() -> [(key: String, pixels: (width: Int, height: Int))] {
        let spaces = Self.currentSpaces()
        return NSScreen.screens.map { s in
            let u = Self.uuid(s)
            let key = (spaces[u] ?? spaces["Main"]).map { "\(u) space \($0)" } ?? u
            return (key, (Int((s.frame.width * s.backingScaleFactor).rounded()), Int((s.frame.height * s.backingScaleFactor).rounded())))
        }
    }

    func picture(_ display: String) -> (url: URL, options: PictureOptions)? {
        guard let s = screen(display), let url = NSWorkspace.shared.desktopImageURL(for: s) else { return nil }
        let o = NSWorkspace.shared.desktopImageOptions(for: s) ?? [:]
        let fill = (o[.fillColor] as? NSColor)?.usingColorSpace(.sRGB).map { RGB(r: Double($0.redComponent), g: Double($0.greenComponent), b: Double($0.blueComponent)) }
        return (url, PictureOptions(scaling: (o[.imageScaling] as? NSNumber)?.intValue, allowClipping: (o[.allowClipping] as? NSNumber)?.boolValue, fill: fill))
    }

    func set(_ display: String, url: URL, options: PictureOptions) throws {
        guard let s = screen(display) else { throw CocoaError(.fileNoSuchFile) }
        var o: [NSWorkspace.DesktopImageOptionKey: Any] = [:]
        if let v = options.scaling { o[.imageScaling] = NSNumber(value: v) }
        if let v = options.allowClipping { o[.allowClipping] = NSNumber(value: v) }
        if let c = options.fill { o[.fillColor] = NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1) }
        try NSWorkspace.shared.setDesktopImageURL(url, for: s, options: o)
    }
}

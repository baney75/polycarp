import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Wallpaper per theme. Opt-in (Settings › Appearance › "Theme sets the desktop picture"): while a Polycarp theme is
// in force, every display shows the theme's picture; turn it off or take the theme off and each display gets the
// person's own picture back. Before Polycarp first covers a display's picture it records that picture and keeps a copy of
// the file, so it can always be put back, even if the original is moved or deleted. Pure parts here, with the desktop
// behind `DesktopPictures` so tests never touch the real one; `ThemeWallpaperApplier` in the app is the NSWorkspace side.

/// What a theme's desktop picture is.
public enum ThemeWallpaper: Equatable, Sendable {
    case solid(RGB)
    /// Top to bottom.
    case gradient(RGB, RGB)
    /// A picture that ships with Polycarp, by file name (`Wallpapers/<name>` in the app's resources).
    case image(String)

    /// The theme's own colors when it names none: its `background` at the top fading to `sunken` at the bottom. A theme
    /// always has both (`PolycarpTheme.parse` refuses one without); black stands in for either if not.
    public static func standard(_ roles: [String: RGB]) -> ThemeWallpaper {
        let black = RGB(r: 0, g: 0, b: 0)
        let top = roles["background"] ?? roles["sunken"] ?? black
        return .gradient(top, roles["sunken"] ?? top)
    }

    /// The picture for a theme in force: `surfaces.spaces.wallpaper` from its theme.json, in the colors of the mode it
    /// draws now. `json` is the file's bytes; nil or unreadable means the theme names none.
    public static func of(_ theme: PolycarpTheme, json: Data?, systemDark: Bool) -> ThemeWallpaper {
        parse(json.flatMap(named(inThemeJSON:)), roles: theme.colors(systemDark: systemDark).roles)
    }

    /// `surfaces.spaces.wallpaper` in a theme.json, when it is a string. The theme reader ignores the key, so a file
    /// with it is a theme to every build.
    public static func named(inThemeJSON data: Data) -> String? {
        guard data.count <= PolycarpTheme.maxBytes,
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let surfaces = root["surfaces"] as? [String: Any], let spaces = surfaces["spaces"] as? [String: Any] else { return nil }
        return spaces["wallpaper"] as? String
    }

    /// The theme file's bytes for `of`: a regular file within the reader's size limit, else nil.
    public static func themeJSON(atPath path: String) -> Data? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path), a[.type] as? FileAttributeType == .typeRegular,
              let size = a[.size] as? NSNumber, size.intValue <= PolycarpTheme.maxBytes else { return nil }
        return FileManager.default.contents(atPath: path)
    }

    /// `wallpaper` in theme.json, optional: `solid:<role>`, `gradient:<role>,<role>` or `image:<file>` (lowercase letters,
    /// digits and hyphens, then `.png`, `.jpg` or `.heic`). Roles are the mode's twelve colors. Anything else, or nothing,
    /// is `standard`.
    public static func parse(_ text: String?, roles: [String: RGB]) -> ThemeWallpaper {
        guard let text, text.utf8.count <= 80 else { return standard(roles) }
        let parts = text.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return standard(roles) }
        switch parts[0] {
        case "solid": if let c = roles[parts[1]] { return .solid(c) }
        case "gradient":
            let r = parts[1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            if r.count == 2, let a = roles[r[0]], let b = roles[r[1]] { return .gradient(a, b) }
        case "image":
            if parts[1].range(of: #"^[a-z0-9][a-z0-9-]{0,47}\.(png|jpg|heic)$"#, options: .regularExpression) != nil { return .image(parts[1]) }
        default: break
        }
        return standard(roles)
    }

    /// A name for the rendered file that changes whenever the picture does (the Dock caches a picture by its URL).
    public func fileName(width: Int, height: Int) -> String? {
        func hex(_ c: RGB) -> String { String(format: "%02x%02x%02x", Int((c.r * 255).rounded()), Int((c.g * 255).rounded()), Int((c.b * 255).rounded())) }
        switch self {
        case .solid(let c): return "solid-\(hex(c))-\(width)x\(height).png"
        case .gradient(let a, let b): return "gradient-\(hex(a))-\(hex(b))-\(width)x\(height).png"
        case .image: return nil
        }
    }

    /// A solid or gradient as a PNG of `width` by `height` pixels (sRGB). Nil for a bundled image.
    public func png(width: Int, height: Int) -> Data? {
        let (top, bottom): (RGB, RGB)
        switch self {
        case .solid(let c): (top, bottom) = (c, c)
        case .gradient(let a, let b): (top, bottom) = (a, b)
        case .image: return nil
        }
        guard width > 0, height > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let colors = [top, bottom].map { CGColor(colorSpace: space, components: [$0.r, $0.g, $0.b, 1])! } as CFArray
        guard let g = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) else { return nil }
        // CoreGraphics' y runs up: the top color starts at the top edge.
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: height), end: .zero, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        guard let image = ctx.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }
}

/// How a picture fills its display, as macOS keeps it per display (NSWorkspace's desktop image options).
public struct PictureOptions: Codable, Equatable, Sendable {
    public var scaling: Int?
    public var allowClipping: Bool?
    public var fill: RGB?
    public init(scaling: Int? = nil, allowClipping: Bool? = nil, fill: RGB? = nil) {
        self.scaling = scaling; self.allowClipping = allowClipping; self.fill = fill
    }
}

/// The desktop as the keeper sees it: each display by a stable key, its picture now, and setting one.
public protocol DesktopPictures {
    func displays() -> [(key: String, pixels: (width: Int, height: Int))]
    func picture(_ display: String) -> (url: URL, options: PictureOptions)?
    func set(_ display: String, url: URL, options: PictureOptions) throws
}

/// The person's own picture for one display, as it was before Polycarp covered it, and the copy kept of its file.
public struct SavedPicture: Codable, Equatable, Sendable {
    public var display: String
    public var url: URL
    public var copy: URL
    public var options: PictureOptions
}

/// Puts the theme's picture on every display, or the person's own back. `folder` holds the rendered pictures
/// (`Pictures/`), the kept copies (`Kept/`) and the record (`saved.json`). Never sets a display's picture before its
/// own is recorded and copied; a display whose picture can't be read or copied is left alone and named in the result.
public final class WallpaperKeeper {
    public let folder: URL
    private let desktop: DesktopPictures
    /// Where the pictures that ship with Polycarp are (the app's `Wallpapers` folder), if anywhere.
    private let bundledFolder: URL?
    public private(set) var saved: [SavedPicture]

    public var pictures: URL { folder.appendingPathComponent("Pictures", isDirectory: true) }
    public var kept: URL { folder.appendingPathComponent("Kept", isDirectory: true) }
    private var record: URL { folder.appendingPathComponent("saved.json") }

    public init(folder: URL, desktop: DesktopPictures, bundledFolder: URL? = nil) {
        self.folder = folder
        self.desktop = desktop
        self.bundledFolder = bundledFolder
        saved = (try? JSONDecoder().decode([SavedPicture].self, from: Data(contentsOf: folder.appendingPathComponent("saved.json")))) ?? []
    }

    /// Whether `url` is a picture this keeper made or shipped (so it is never recorded as the person's own).
    public func isOurs(_ url: URL) -> Bool {
        let p = url.standardizedFileURL.path
        return [pictures, bundledFolder].contains { f in f.map { p.hasPrefix($0.standardizedFileURL.path + "/") } ?? false }
    }

    /// A stable name for a kept copy (Swift's own hash changes every launch).
    static func stableName(_ url: URL) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in url.standardizedFileURL.path.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return String(format: "%016llx-", h) + url.lastPathComponent
    }

    public struct Outcome: Equatable, Sendable {
        public var set: [String] = []
        public var restored: [String] = []
        /// Display key and why it was left alone.
        public var skipped: [String: String] = [:]
    }

    /// Brings every display in line: the theme's picture when `wallpaper` is given, else the person's own wherever
    /// Polycarp's still shows. Cheap when nothing needs doing: one read per display.
    @discardableResult
    public func sync(_ wallpaper: ThemeWallpaper?) -> Outcome {
        var out = Outcome()
        for d in desktop.displays() {
            guard let now = desktop.picture(d.key) else { out.skipped[d.key] = "its picture could not be read"; continue }
            if let wallpaper {
                guard let ours = picture(wallpaper, pixels: d.pixels) else { out.skipped[d.key] = "the theme's picture could not be made"; continue }
                if now.url.standardizedFileURL == ours.standardizedFileURL { continue }
                if !isOurs(now.url) {
                    do { try keep(d.key, now.url, now.options) } catch { out.skipped[d.key] = "its picture could not be kept: \(error.localizedDescription)"; continue }
                }
                guard saved.contains(where: { $0.display == d.key }) else { out.skipped[d.key] = "no saved picture to go back to"; continue }
                do { try desktop.set(d.key, url: ours, options: PictureOptions(scaling: 0, allowClipping: true)); out.set.append(d.key) } catch {
                    out.skipped[d.key] = "macOS refused the picture: \(error.localizedDescription)"
                }
            } else {
                guard isOurs(now.url), let s = saved.first(where: { $0.display == d.key }) else { continue }
                let back = FileManager.default.fileExists(atPath: s.url.path) ? s.url : s.copy
                guard FileManager.default.fileExists(atPath: back.path) else { out.skipped[d.key] = "the saved picture and its copy are both gone"; continue }
                do { try desktop.set(d.key, url: back, options: s.options); out.restored.append(d.key) } catch {
                    out.skipped[d.key] = "macOS refused the saved picture: \(error.localizedDescription)"
                    continue
                }
                forget(d.key, showing: back)
            }
        }
        return out
    }

    /// Records a display's own picture and copies its file into `Kept/`, before anything covers it. The record is on disk
    /// before this returns. A later picture the person chose replaces the earlier one for that display.
    private func keep(_ display: String, _ url: URL, _ options: PictureOptions) throws {
        if let s = saved.first(where: { $0.display == display }), s.url.standardizedFileURL == url.standardizedFileURL { return }
        let fm = FileManager.default
        try fm.createDirectory(at: kept, withIntermediateDirectories: true)
        // A missing file, or a folder (a rotating set, which can't be copied whole), can't be kept: that display is left alone.
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { throw NotAFile() }
        let copy = kept.appendingPathComponent(WallpaperKeeper.stableName(url))
        if !fm.fileExists(atPath: copy.path) { try fm.copyItem(at: url, to: copy) }
        let old = saved.first { $0.display == display }?.copy
        saved.removeAll { $0.display == display }
        saved.append(SavedPicture(display: display, url: url, copy: copy, options: options))
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONEncoder().encode(saved).write(to: record, options: .atomic)
        if let old, old != copy, !saved.contains(where: { $0.copy == old }) { try? fm.removeItem(at: old) }
    }

    /// Drops a display's record once its own picture is back, so a keeper with nothing covered costs nothing. The copy
    /// stays while the display shows it (the original was gone) and goes otherwise.
    private func forget(_ display: String, showing: URL) {
        guard let s = saved.first(where: { $0.display == display }) else { return }
        saved.removeAll { $0.display == display }
        try? JSONEncoder().encode(saved).write(to: record, options: .atomic)
        if s.copy != showing, !saved.contains(where: { $0.copy == s.copy }) { try? FileManager.default.removeItem(at: s.copy) }
    }

    struct NotAFile: LocalizedError { var errorDescription: String? { "it is missing or a folder of pictures" } }

    /// The theme's picture for a display of this many pixels: a bundled file, or a solid or gradient made once.
    func picture(_ w: ThemeWallpaper, pixels: (width: Int, height: Int)) -> URL? {
        if case .image(let name) = w {
            guard let f = bundledFolder?.appendingPathComponent(name), FileManager.default.fileExists(atPath: f.path) else { return nil }
            return f
        }
        guard let name = w.fileName(width: pixels.width, height: pixels.height) else { return nil }
        let url = pictures.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: url.path) { return url }
        guard let data = w.png(width: pixels.width, height: pixels.height) else { return nil }
        do {
            try FileManager.default.createDirectory(at: pictures, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch { return nil }
        return url
    }
}

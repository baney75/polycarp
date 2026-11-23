import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

// The paper: what lies behind a place. One idea for three places that each had their own: the desktop picture, the
// browser's new tab page and the idle screen. `paper` in surfaces.json is every place's; `desktop.paper`,
// `newtab.paper` and `idle.paper` override it for one place, and empty follows `paper`. An unset paper changes nothing:
// each place shows what it showed before paper existed. `polycarp-spaces paper set <what>` (PaperOps) turns a picture
// file, an https URL, a color or a scene name into the value, copying pictures into Papers/ beside surfaces.json under
// a name it makes, so nobody has to follow a naming rule by hand (docs/surfaces.md, docs/newtab.md).

/// A place a paper lies behind.
public enum PaperPlace: String, CaseIterable, Sendable {
    case desktop, newtab, idle

    /// The surfaces.json path of this place's own paper.
    public var path: String { rawValue + ".paper" }

    /// `desktop,newtab`, `all` or one place, as `--on` takes it. Nil when a name is not a place.
    public static func parse(_ text: String) -> Set<PaperPlace>? {
        var out = Set<PaperPlace>()
        for part in text.split(separator: ",", omittingEmptySubsequences: false) {
            let name = part.trimmingCharacters(in: .whitespaces).lowercased()
            if name == "all" { out.formUnion(allCases); continue }
            guard let p = PaperPlace(rawValue: name) else { return nil }
            out.insert(p)
        }
        return out.isEmpty ? nil : out
    }
}

/// What a paper is, as surfaces.json keeps it: a color (`#RRGGBB`), a scene by name (`field`), or a picture in
/// Papers/ (`picture:<name>`).
public enum Paper: Equatable, Sendable {
    case color(RGB)
    /// One of `Surfaces.Scene.named`; never `.image`.
    case scene(Surfaces.Scene)
    /// A file name in Papers/.
    case picture(String)

    /// The names `paper set` gives the pictures it keeps, and the only ones a `picture:` value may hold.
    public static let picturePattern = "^paper-[0-9a-f]{16}\\.(png|jpg|heic|webp)$"
    static let colorPattern = "^#[0-9A-Fa-f]{6}$"

    /// The value from surfaces.json. Empty, or anything that isn't a paper, is nil (no paper).
    public init?(id: String) {
        if id.isEmpty { return nil }
        if SurfaceCheck.matches(id, Self.colorPattern), let c = RGB(hex: id) { self = .color(c); return }
        if Surfaces.Scene.named.contains(id) { self = .scene(Surfaces.Scene(id: id)); return }
        if id.hasPrefix("picture:"), SurfaceCheck.matches(String(id.dropFirst(8)), Self.picturePattern) {
            self = .picture(String(id.dropFirst(8))); return
        }
        return nil
    }

    public var id: String {
        switch self {
        case .color(let c): return Paper.hex(c)
        case .scene(let s): return s.id
        case .picture(let n): return "picture:" + n
        }
    }

    /// `#RRGGBB`, uppercase.
    public static func hex(_ c: RGB) -> String {
        String(format: "#%02X%02X%02X", Int((c.r * 255).rounded()), Int((c.g * 255).rounded()), Int((c.b * 255).rounded()))
    }

    /// The scene a desktop draws for this paper, the theme's own picture for `solid`, or the picture's file. Nil when
    /// the paper can't be shown (its picture is gone), so the place falls back to what it showed before paper.
    public func wallpaper(desktop: Surfaces.Desktop, papers: URL, at date: Date, systemDark: Bool,
                          themeOwn: () -> ThemeWallpaper?) -> ThemeWallpaper? {
        switch self {
        case .color(let c): return .solid(c)
        case .scene(.solid): return themeOwn()
        case .scene(let s):
            var d = desktop
            d.scene = s
            return DesktopScene.of(d, at: date, systemDark: systemDark).map { .scene($0) }
        case .picture(let name):
            let url = papers.appendingPathComponent(name)
            return FileManager.default.fileExists(atPath: url.path) ? .picture(url) : nil
        }
    }

    /// The paper as a picture `width` by `height` pixels (a picture is fitted within it, keeping its shape), for the
    /// idle screen. A scene is drawn without its verse; `solid` is `background`. Nil when it can't be made.
    public func image(width: Int, height: Int, desktop: Surfaces.Desktop, papers: URL, at date: Date, systemDark: Bool,
                      background: RGB) -> CGImage? {
        guard width > 0, height > 0 else { return nil }
        switch self {
        case .color(let c): return PaperImage.fill(c)
        case .scene(.solid): return PaperImage.fill(background)
        case .scene(let s):
            var d = desktop
            d.scene = s
            guard var scene = DesktopScene.of(d, at: date, systemDark: systemDark) else { return nil }
            scene.verse = nil
            return scene.image(width: width, height: height)
        case .picture(let name):
            return PaperImage.thumbnail(papers.appendingPathComponent(name), longest: max(width, height))
        }
    }
}

extension Surfaces {
    /// The paper behind `place`: its own when set, else `paper`, else nil (the place shows what it did before paper).
    public func paper(on place: PaperPlace) -> Paper? {
        switch place {
        case .desktop: return desktop.paper ?? paper
        case .newtab: return newtab.paper ?? paper
        case .idle: return idle.paper ?? paper
        }
    }

    /// Every picture a paper names, by file name, so pruning keeps them.
    public var paperPictures: Set<String> {
        Set(([paper] + PaperPlace.allCases.map { paper(on: $0) }).compactMap { p in
            if case .picture(let n)? = p { return n }
            return nil
        })
    }
}

// MARK: What `paper set` takes

/// What `paper set <what>` was given, before anything is read or fetched.
public enum PaperInput: Equatable, Sendable {
    case color(RGB)
    case scene(Surfaces.Scene)
    /// A picture on this Mac, as an absolute path.
    case file(String)
    case url(URL)

    /// The extensions a picture path may have.
    public static let pictureExtensions = ["png", "jpg", "jpeg", "heic", "webp"]

    /// Reads `what`: `#RRGGBB`, a scene name, an https URL, or a path to a picture (`~/` is home; a relative path starts
    /// at `cwd`). A path is not checked for being there; `PaperOps` does that when it reads it.
    public static func parse(_ what: String, cwd: String, home: String = NSHomeDirectory()) -> Result<PaperInput, PaperFailure> {
        let text = what.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .failure(PaperFailure("invalid_paper", "say what the paper is: a picture, an https URL, a #RRGGBB color or a scene")) }
        if text.hasPrefix("#") {
            guard SurfaceCheck.matches(text, Paper.colorPattern), let c = RGB(hex: text) else {
                return .failure(PaperFailure("invalid_paper", "\"\(text)\" is not a color: write six hex digits after #, as #2B2E26"))
            }
            return .success(.color(c))
        }
        if Surfaces.Scene.named.contains(text.lowercased()) { return .success(.scene(Surfaces.Scene(id: text.lowercased()))) }
        let lower = text.lowercased()
        if lower.hasPrefix("https://") {
            guard let u = URL(string: text), u.scheme?.lowercased() == "https", let host = u.host, !host.isEmpty else {
                return .failure(PaperFailure("invalid_paper", "\"\(text)\" is not a URL Polycarp can fetch"))
            }
            return .success(.url(u))
        }
        if lower.hasPrefix("http://") {
            return .failure(PaperFailure("invalid_paper", "only https URLs are fetched; \(text) is plain http"))
        }
        if lower.contains("://") || lower.hasPrefix("data:") {
            return .failure(PaperFailure("invalid_paper", "\"\(text)\" is not a picture, an https URL, a #RRGGBB color or a scene"))
        }
        var path = text
        if path == "~" || path.hasPrefix("~/") { path = home + path.dropFirst() }
        if !path.hasPrefix("/") { path = (cwd as NSString).appendingPathComponent(path) }
        path = (path as NSString).standardizingPath
        let ext = (path as NSString).pathExtension.lowercased()
        guard pictureExtensions.contains(ext) else {
            let scenes = Surfaces.Scene.named.joined(separator: ", ")
            return .failure(PaperFailure("invalid_paper",
                                         "\"\(text)\" is not a picture (.png, .jpg, .heic or .webp), an https URL, a #RRGGBB color or a scene (\(scenes))"))
        }
        return .success(.file(path))
    }
}

/// A refusal from `paper`, shaped like the surfaces command's (`SurfacesFailure`).
public typealias PaperFailure = SurfacesFailure

// MARK: The pictures kept

/// Papers/ beside surfaces.json: the pictures `paper set` copied in, each named for its content, and `.newtab/`, the
/// small copies the new tab page is sent.
public struct PaperStore {
    public let folder: URL
    /// The largest picture taken, from a file or the web.
    public static let maxBytes = 25 * 1024 * 1024
    /// How many pictures stay, newest first, besides the ones a paper names.
    public static let keep = 10

    public init(folder: URL) { self.folder = folder }

    /// Papers/ in the folder that holds surfaces.json at `surfacesFile`.
    public static func beside(surfacesFile: String) -> PaperStore {
        PaperStore(folder: URL(fileURLWithPath: surfacesFile).deletingLastPathComponent().appendingPathComponent("Papers", isDirectory: true))
    }

    public var newtab: URL { folder.appendingPathComponent(".newtab", isDirectory: true) }

    public func url(_ name: String) -> URL { folder.appendingPathComponent(name) }

    /// The extension a picture of this type keeps, or nil for a type a paper can't be.
    static func ext(forType type: String) -> String? {
        switch type {
        case UTType.png.identifier: "png"
        case UTType.jpeg.identifier: "jpg"
        case UTType.heic.identifier, "public.heif": "heic"
        case UTType.webP.identifier: "webp"
        default: nil
        }
    }

    /// Checks `data` is a picture that decodes (PNG, JPEG, HEIC or WebP, at most `maxBytes`), and keeps it as
    /// `paper-<hash>.<ext>`. The same picture twice is the same file, made newest again. Returns its name.
    public func add(_ data: Data, now: Date = Date()) -> Result<String, PaperFailure> {
        guard data.count <= Self.maxBytes else {
            return .failure(PaperFailure("too_large", "the picture is \(data.count / (1024 * 1024)) MB; a paper may be at most 25 MB"))
        }
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), let type = CGImageSourceGetType(src) as String?,
              let ext = Self.ext(forType: type) else {
            return .failure(PaperFailure("not_a_picture", "that is not a PNG, JPEG, HEIC or WebP picture"))
        }
        let probe: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 64]
        guard CGImageSourceGetCount(src) > 0, CGImageSourceCreateThumbnailAtIndex(src, 0, probe as CFDictionary) != nil else {
            return .failure(PaperFailure("not_a_picture", "the picture doesn't decode; it may be cut short or damaged"))
        }
        let hash = SHA256.hash(data: data).prefix(8).map { String(format: "%02x", $0) }.joined()
        let name = "paper-\(hash).\(ext)"
        let target = url(name)
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            if fm.fileExists(atPath: target.path) {
                try fm.setAttributes([.modificationDate: now], ofItemAtPath: target.path)
            } else {
                try data.write(to: target, options: .atomic)
                try? fm.setAttributes([.modificationDate: now], ofItemAtPath: target.path)
            }
        } catch {
            return .failure(PaperFailure("io_error", "can't keep the picture in \(SurfacesOps.display(folder.path)): \(error.localizedDescription)"))
        }
        return .success(name)
    }

    /// The pictures kept, newest first.
    public func pictures() -> [String] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: folder.path) else { return [] }
        let dated = names.filter { SurfaceCheck.matches($0, Paper.picturePattern) }.map { n -> (String, Date) in
            (n, ((try? fm.attributesOfItem(atPath: url(n).path))?[.modificationDate] as? Date) ?? .distantPast)
        }
        return dated.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }.map(\.0)
    }

    /// Removes pictures no paper names past the newest `keep`, and the new tab copies of any picture gone. The ones in
    /// `inUse` always stay. Returns what it removed.
    @discardableResult
    public func prune(inUse: Set<String>, keep: Int = PaperStore.keep) -> [String] {
        let fm = FileManager.default
        let all = pictures()
        let kept = Set(all.prefix(keep)).union(inUse)
        var removed: [String] = []
        for n in all where !kept.contains(n) {
            if (try? fm.removeItem(at: url(n))) != nil { removed.append(n) }
        }
        if let small = try? fm.contentsOfDirectory(atPath: newtab.path) {
            let still = Set(pictures())
            for s in small where !still.contains((s as NSString).deletingPathExtension) {
                try? fm.removeItem(at: newtab.appendingPathComponent(s))
            }
        }
        return removed
    }
}

// MARK: Fetching a picture

/// One https GET for `paper set <url>`, cut off past `PaperStore.maxBytes`. A redirect may only go to https.
public enum PaperDownload {
    public static func fetch(_ url: URL, cap: Int = PaperStore.maxBytes, timeout: TimeInterval = 45) -> Result<Data, PaperFailure> {
        guard url.scheme?.lowercased() == "https" else { return .failure(PaperFailure("invalid_paper", "only https URLs are fetched")) }
        let fetcher = Fetcher(cap: cap)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.httpAdditionalHeaders = ["Accept": "image/*"]
        let session = URLSession(configuration: config, delegate: fetcher, delegateQueue: nil)
        session.dataTask(with: url).resume()
        fetcher.done.wait()
        session.invalidateAndCancel()
        return fetcher.result
    }

    private final class Fetcher: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        let cap: Int
        let done = DispatchSemaphore(value: 0)
        private var data = Data()
        private var refusal: PaperFailure?
        var result: Result<Data, PaperFailure> = .failure(PaperFailure("fetch_failed", "the picture couldn't be fetched"))

        init(cap: Int) { self.cap = cap }

        private var tooLarge: PaperFailure { PaperFailure("too_large", "the picture is over \(cap / (1024 * 1024)) MB, the most a paper may be") }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            if let h = response as? HTTPURLResponse, !(200..<300).contains(h.statusCode) {
                refusal = PaperFailure("fetch_failed", "the server answered \(h.statusCode)")
                return completionHandler(.cancel)
            }
            if response.expectedContentLength > Int64(cap) { refusal = tooLarge; return completionHandler(.cancel) }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
            data.append(chunk)
            if data.count > cap { refusal = tooLarge; dataTask.cancel() }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            guard request.url?.scheme?.lowercased() == "https" else {
                refusal = PaperFailure("fetch_failed", "the URL sent Polycarp to a plain http address, which it doesn't fetch")
                return completionHandler(nil)
            }
            completionHandler(request)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if let refusal {
                result = .failure(refusal)
            } else if let error {
                result = .failure(PaperFailure("fetch_failed", "the picture couldn't be fetched: \(error.localizedDescription)"))
            } else {
                result = .success(data)
            }
            done.signal()
        }
    }
}

// MARK: Pictures for the new tab and the idle screen

public enum PaperImage {
    /// A 1 by 1 picture of one color; a view stretches it.
    static func fill(_ c: RGB) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(colorSpace: space, components: [c.r, c.g, c.b, 1])!)
        ctx.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        return ctx.makeImage()
    }

    /// The picture at `url` with its longest side at most `longest` pixels, turned upright. Nil when it doesn't decode.
    public static func thumbnail(_ url: URL, longest: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let o: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                  kCGImageSourceThumbnailMaxPixelSize: max(1, longest)]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, o as CFDictionary)
    }

    /// The widest a picture is sent to the new tab page.
    public static let newTabWidth = 1920
    /// The most a picture sent to the new tab page may be, as its data URL: the reply stays well under Chrome's 1 MB
    /// native message limit with the rest of the page in it.
    public static let newTabBytes = 700 * 1024

    /// The picture at `url` as a `data:image/jpeg;base64,` URL at most `newTabWidth` pixels wide and under `maxBytes`
    /// characters: JPEG at falling quality, then smaller, until it fits. Nil when it doesn't decode or never fits.
    public static func dataURL(_ url: URL, maxWidth: Int = newTabWidth, maxBytes: Int = newTabBytes) -> String? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              var w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              var h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue, w > 0, h > 0 else { return nil }
        // Orientations 5 to 8 turn the picture a quarter: its upright width is its stored height.
        if let o = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue, (5...8).contains(o) { swap(&w, &h) }
        let prefix = "data:image/jpeg;base64,"
        var width = min(Double(maxWidth), w)
        for _ in 0..<8 {
            let longest = Int((max(width, width * h / w)).rounded())
            let o: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                      kCGImageSourceThumbnailMaxPixelSize: max(1, longest)]
            guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, o as CFDictionary) else { return nil }
            for quality in [0.82, 0.68, 0.52] {
                guard let jpeg = jpeg(image, quality: quality) else { return nil }
                // Base64 is four characters for every three bytes, padded.
                if prefix.utf8.count + (jpeg.count + 2) / 3 * 4 < maxBytes { return prefix + jpeg.base64EncodedString() }
            }
            width *= 0.75
            if width < 16 { return nil }
        }
        return nil
    }

    static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    /// The new tab copy of a kept picture: made once into `.newtab/<name>.jpg` and read from there after. A folder that
    /// can't be written only costs the copy; the URL is still made.
    public static func newTabDataURL(_ name: String, store: PaperStore) -> String? {
        let source = store.url(name)
        let cached = store.newtab.appendingPathComponent(name + ".jpg")
        let fm = FileManager.default
        if let data = fm.contents(atPath: cached.path), data.count < newTabBytes {
            let url = String(decoding: data, as: UTF8.self)
            if url.hasPrefix("data:image/jpeg;base64,"), fm.fileExists(atPath: source.path) { return url }
        }
        guard fm.fileExists(atPath: source.path), let url = dataURL(source) else { return nil }
        try? fm.createDirectory(at: store.newtab, withIntermediateDirectories: true)
        try? Data(url.utf8).write(to: cached, options: .atomic)
        return url
    }
}

extension Paper {
    /// The new tab page's `paper`: `{"color":"#RRGGBB"}`, `{"scene":"field"}` or `{"image":"data:image/jpeg;base64,..."}`.
    /// Nil when a picture is gone, won't decode or has no `store` to be in: the page then shows no paper.
    public func newTab(store: PaperStore?) -> [String: String]? {
        switch self {
        case .color(let c): return ["color": Paper.hex(c)]
        case .scene(let s): return ["scene": s.id]
        case .picture(let n): return store.flatMap { PaperImage.newTabDataURL(n, store: $0) }.map { ["image": $0] }
        }
    }
}

// MARK: The operations the command and the MCP tools run

public enum PaperOps {
    public typealias Result = SurfacesOps.Result
    public typealias Fetch = (URL) -> Swift.Result<Data, PaperFailure>

    /// `paper set <what> [--on ...]`: makes `what` a paper value (copying a picture in), writes it for `places` in one
    /// write, then prunes Papers/. All three places set `paper` and clear the places' own; fewer set each one's own.
    public static func set(_ what: String, on places: Set<PaperPlace>, file: String, cwd: String,
                           fetch: Fetch = { PaperDownload.fetch($0) }) -> Result {
        let store = PaperStore.beside(surfacesFile: file)
        let input: PaperInput
        switch PaperInput.parse(what, cwd: cwd) { case .failure(let f): return .failure(f); case .success(let i): input = i }
        let value: Paper
        switch input {
        case .color(let c): value = .color(c)
        case .scene(let s): value = .scene(s)
        case .file(let path):
            let data: Data
            switch read(path) { case .failure(let f): return .failure(f); case .success(let d): data = d }
            switch store.add(data) { case .failure(let f): return .failure(f); case .success(let n): value = .picture(n) }
        case .url(let u):
            let data: Data
            switch fetch(u) { case .failure(let f): return .failure(f); case .success(let d): data = d }
            switch store.add(data) { case .failure(let f): return .failure(f); case .success(let n): value = .picture(n) }
        }
        let places = places.isEmpty ? Set(PaperPlace.allCases) : places
        return write(file: file, store: store) { tree in
            var t = tree
            if places.count == PaperPlace.allCases.count {
                t = t.setting(["paper"], to: .string(value.id))
                for p in PaperPlace.allCases { t = t.removing([p.rawValue, "paper"]) }
            } else {
                for p in places { t = t.setting([p.rawValue, "paper"], to: .string(value.id)) }
            }
            return t
        }
    }

    /// `paper reset [--on ...]`: those places back to what they showed before paper. A shared `paper` stays on the
    /// other places as their own.
    public static func reset(on places: Set<PaperPlace>, file: String) -> Result {
        let store = PaperStore.beside(surfacesFile: file)
        let places = places.isEmpty ? Set(PaperPlace.allCases) : places
        return write(file: file, store: store) { tree in
            var t = tree
            if let shared = t.at(["paper"])?.string, !shared.isEmpty {
                for p in PaperPlace.allCases where !places.contains(p) {
                    if (t.at([p.rawValue, "paper"])?.string ?? "").isEmpty { t = t.setting([p.rawValue, "paper"], to: .string(shared)) }
                }
            }
            t = t.removing(["paper"])
            for p in places { t = t.removing([p.rawValue, "paper"]) }
            return t
        }
    }

    /// `paper get`: each place's paper, where it comes from, and a picture's file.
    public static func get(file: String) -> Result {
        switch SurfacesFile.load(path: file) {
        case .missing: return .success(describe(Surfaces.defaults, file: file))
        case .document(let d): return .success(describe(d.surfaces, file: file))
        case .invalid(let e, _):
            return .failure(SurfacesFailure("invalid_file", "\(SurfacesOps.display(file)) is invalid, so the app keeps its last good config: \(e.summary)",
                                            suggestion: "run `polycarp-spaces surfaces validate`, then fix or reset the paths it names", issues: e.issues))
        case .rejected(let why), .failed(let why):
            return .failure(SurfacesFailure("io_error", "can't read \(SurfacesOps.display(file)): \(why)"))
        }
    }

    /// The data `get`, `set` and `reset` answer with.
    static func describe(_ s: Surfaces, file: String) -> SurfaceValue {
        let store = PaperStore.beside(surfacesFile: file)
        func one(_ p: Paper?) -> SurfaceValue {
            guard let p else { return .null }
            var o: [String: SurfaceValue] = ["value": .string(p.id)]
            switch p {
            case .color: o["kind"] = .string("color")
            case .scene: o["kind"] = .string("scene")
            case .picture(let n):
                o["kind"] = .string("picture")
                o["picture"] = .string(SurfacesOps.display(store.url(n).path))
                if !FileManager.default.fileExists(atPath: store.url(n).path) { o["missing"] = .bool(true) }
            }
            return .object(o)
        }
        var out: [String: SurfaceValue] = ["paper": one(s.paper), "file": .string(SurfacesOps.display(file))]
        for place in PaperPlace.allCases {
            let own: Paper? = switch place { case .desktop: s.desktop.paper; case .newtab: s.newtab.paper; case .idle: s.idle.paper }
            var o = one(s.paper(on: place)).object ?? ["value": .null]
            o["from"] = own != nil ? .string(place.path) : (s.paper != nil ? .string("paper") : .null)
            out[place.rawValue] = .object(o)
        }
        return .object(out)
    }

    /// A picture file's bytes, refusing a missing one, a folder or one over the limit before reading it.
    static func read(_ path: String) -> Swift.Result<Data, PaperFailure> {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else {
            return .failure(PaperFailure("not_found", "no picture at \(SurfacesOps.display(path))"))
        }
        if let size = (try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber, size.intValue > PaperStore.maxBytes {
            return .failure(PaperFailure("too_large", "\(SurfacesOps.display(path)) is over 25 MB, the most a paper may be"))
        }
        guard let data = fm.contents(atPath: path) else { return .failure(PaperFailure("io_error", "can't read \(SurfacesOps.display(path))")) }
        return .success(data)
    }

    /// Edits the file's tree, checks it whole, writes it once, then prunes the pictures no paper names.
    private static func write(file: String, store: PaperStore, _ edit: (SurfaceValue) -> SurfaceValue) -> Result {
        var tree: SurfaceValue
        switch SurfacesOps.editable(file) { case .failure(let f): return .failure(f); case .success(let t): tree = t }
        tree = edit(tree)
        if tree.at(["version"]) == nil { tree = tree.setting(["version"], to: .number(Double(Surfaces.version))) }
        switch Surfaces.check(tree) {
        case .failure(let e):
            return .failure(SurfacesFailure("invalid_file", "the file has other errors, so the paper was not set: \(e.summary)",
                                            suggestion: "fix or `polycarp-spaces surfaces reset` the paths listed, then try again", issues: e.issues))
        case .success(let c):
            do { try SurfacesFile.write(tree, to: file) } catch { return .failure(SurfacesFailure("io_error", "\(error)")) }
            store.prune(inUse: c.surfaces.paperPictures)
            return .success(describe(c.surfaces, file: file))
        }
    }
}

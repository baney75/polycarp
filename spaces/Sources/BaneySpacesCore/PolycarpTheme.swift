import Foundation

// A Polycarp theme (`polycarp theme set ...`) as BaneySpaces reads it. The command writes
// `<config>/current/theme.json`; this file reads `surfaces.spaces` and the top-level `mode`,
// checks every value, and turns what passed into a `ThemeSpec` and a `Palette` that the rest of
// the app already draws from. A missing or bad file is nil and one log line, never a crash, and
// the person's own theme and palette (Settings) draw as before. See spec/themes.md, "Polycarp themes".

public struct PolycarpTheme: Equatable, Sendable {
    public enum Mode: String, Sendable { case auto, light, dark }

    /// One mode's colors: the twelve roles BaneySpaces draws, plus the text color on the accent.
    public struct Colors: Equatable, Sendable {
        public let roles: [String: RGB]
        public let onAccent: RGB
    }

    public let name: String
    /// What Settings shows: the theme's title, or its name.
    public let title: String
    public let mode: Mode
    public let light: Colors
    public let dark: Colors

    // shape
    public let radiusSmall, radius, radiusLarge: Double
    public let borderWidth, blur, shadow: Double
    public let density: String
    public let indicator: ThemeIndicator
    // type
    public let ui: String
    public let fontSize: Double
    public let fontWeight: Double
    // motion
    public let fast, normal, slow: Double
    public let scaleFrom: Double
    public let reduced: Bool

    /// The `ThemeID` a Polycarp look carries. It is the id of the look that draws palette colors
    /// everywhere (no BaneySpaces washes, the theme's own border widths), which `minimal` does.
    public static let carrier: ThemeID = .minimal
    /// `ThemeSpec.Font.family` for a UI font that is neither the system's nor the monospace key.
    public static let fontKey = "polycarp-ui"

    /// Dark or light for this system appearance: `light` and `dark` are fixed, `auto` follows the system.
    public func isDark(systemDark: Bool) -> Bool {
        switch mode {
        case .auto: systemDark
        case .light: false
        case .dark: true
        }
    }

    public func colors(systemDark: Bool) -> Colors { isDark(systemDark: systemDark) ? dark : light }
    public func accent(systemDark: Bool) -> RGB { colors(systemDark: systemDark).roles["accent"]! }

    public func palette(systemDark: Bool) -> Palette {
        Palette(name: "polycarp", isDark: isDark(systemDark: systemDark), colors: colors(systemDark: systemDark).roles)
    }

    /// The font names to try, in order, for `fontKey` (nil when the UI font is the system's or the monospace key).
    public var fontFamilies: [String]? {
        guard fontKeyName == PolycarpTheme.fontKey, let all = PolycarpTheme.parseStack(ui) else { return nil }
        let generic: Set = ["system-ui", "-apple-system", "blinkmacsystemfont", "ui-sans-serif", "sans-serif", "ui-rounded",
                            "ui-serif", "serif", "ui-monospace", "monospace", "cursive", "fantasy"]
        let named = all.filter { !generic.contains($0.lowercased()) }
        // The first generic name in the stack says what to draw when none of the named fonts is installed.
        let firstGeneric = all.first { generic.contains($0.lowercased()) }?.lowercased()
        return firstGeneric == "serif" || firstGeneric == "ui-serif" ? named + [FontFace.systemSerif] : named
    }

    public func look(systemDark: Bool) -> Look {
        Look(theme: PolycarpTheme.carrier, spec: spec, palette: palette(systemDark: systemDark),
             polycarp: name, families: fontFamilies)
    }

    /// Shape, type and motion as the `ThemeSpec` every surface reads.
    public var spec: ThemeSpec {
        let base = ThemeCatalog.shared.spec(.baneyspaces)
        // Density scales BaneySpaces' gap, padding and tile.
        let space: ThemeSpec.Space = switch density {
        case "compact": .init(gap: 6, padding: 8, tile: 56)
        case "spacious": .init(gap: 10, padding: 12, tile: 72)
        default: base.space
        }
        let still = reduced
        let scale = still ? 1 : scaleFrom
        func ms(_ v: Double) -> Double { still ? 0 : v }
        return ThemeSpec(
            label: title,
            radius: .init(bar: radiusLarge, tile: radius, row: radiusSmall, list: radius),
            border: .init(width: borderWidth, role: "border", opacity: 1, gradient: nil, focusedRole: "accent",
                          focusedWidth: borderWidth > 0 ? min(8, borderWidth * 1.5) : 0),
            fill: .init(material: blur > 0 ? "ultra-thin" : nil, tintRole: "background", tintOpacity: 1,
                        opacity: blur > 0 ? 0.92 : 1, adjustable: false),
            shadow: shadow > 0 ? .init(radius: base.shadow?.radius ?? 24, y: base.shadow?.y ?? 10, opacity: shadow) : nil,
            font: .init(family: fontKeyName, size: fontSize * 0.75, weight: fontWeight >= 500 ? "medium" : "regular"),
            space: space,
            indicator: indicator,
            motion: .init(inMs: ms(normal), outMs: ms(fast), listInMs: ms(normal), listOutMs: ms(fast), rowMs: ms(fast),
                          scaleFrom: scale, lift: scale == 1 ? 1 : base.motion.lift))
    }

    /// Which `ThemeSpec.Font.family` the UI stack maps to: the system font when the stack starts with
    /// a system or generic sans name (a serif name is `fontKey`: the named fonts, then the system serif), the monospace key when it starts with a monospace one, else `fontKey`.
    var fontKeyName: String {
        guard let first = PolycarpTheme.parseStack(ui)?.first?.lowercased() else { return "system-sans" }
        let system: Set = ["system-ui", "-apple-system", "blinkmacsystemfont", "ui-sans-serif", "sans-serif", "ui-rounded"]
        let mono: Set = ["ui-monospace", "monospace"]
        if system.contains(first) { return "system-sans" }
        if mono.contains(first) { return "monospace" }
        return PolycarpTheme.fontKey
    }

    // MARK: Reading

    /// Port of `check_font` in cli/src/theme.rs: names separated by commas, each plain (letters, digits,
    /// spaces, hyphens, underscores) or in matching quotes with no quote, backslash, `<`, control
    /// character or `/*` inside. Nothing else gets through.
    static func parseStack(_ s: String) -> [String]? {
        if s.utf8.count > 300 || s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        var names: [String] = []
        var rest = Substring(s)
        while true {
            rest = rest.drop(while: { $0.isWhitespace })
            var after: Substring
            if let q = rest.first, q == "\"" || q == "'" {
                let body = rest.dropFirst()
                guard let end = body.firstIndex(of: q) else { return nil }
                let inner = body[..<end]
                if inner.trimmingCharacters(in: .whitespaces).isEmpty || inner.contains("/*") { return nil }
                if inner.contains(where: { $0.unicodeScalars.contains { $0.properties.generalCategory == .control } || "\\\"'<".contains($0) }) { return nil }
                names.append(String(inner))
                after = body[body.index(after: end)...]
            } else {
                let end = rest.firstIndex(of: ",") ?? rest.endIndex
                var name = rest[..<end]
                while let l = name.last, l.isWhitespace { name = name.dropLast() }
                if name.isEmpty { return nil }
                if !name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == " " || $0 == "-" || $0 == "_" }) { return nil }
                names.append(String(name))
                after = rest[end...]
            }
            after = after.drop(while: { $0.isWhitespace })
            if after.isEmpty { return names }
            guard after.first == "," else { return nil }
            rest = after.dropFirst()
        }
    }

    /// Biggest file read. A real one is about 3 KB.
    public static let maxBytes = 256 * 1024
    /// Contrast the main text pairs need, as the CLI guarantees (`TEXT_MIN`).
    public static let minContrast = 4.5

    /// Parses and checks the text of `theme.json`. A problem is one plain sentence.
    public static func parse(_ data: Data) -> Result<PolycarpTheme, PolycarpThemeError> {
        guard data.count <= maxBytes else { return .failure(.init("over \(maxBytes) bytes")) }
        guard let any = try? JSONSerialization.jsonObject(with: data), let root = any as? [String: Any] else {
            return .failure(.init("not a JSON object"))
        }
        do { return .success(try build(root)) } catch let e as PolycarpThemeError { return .failure(e) } catch { return .failure(.init("\(error)")) }
    }

    /// `pairs()` in cli/src/theme.rs: text on its fills at `minContrast`, and the status colors on `sunken` at 3.0.
    static let cliPairs: [(String, String, Double)] = {
        var v: [(String, String, Double)] = []
        for fg in ["foreground", "strong", "muted"] { for bg in ["background", "surface", "sunken"] { v.append((fg, bg, minContrast)) } }
        for fg in ["foreground", "strong"] { v.append((fg, "selection", minContrast)) }
        for fg in ["urgent", "working", "done", "accent"] { for bg in ["background", "surface"] { v.append((fg, bg, minContrast)) } }
        v.append(("on_accent", "accent", minContrast))
        for fg in ["urgent", "working", "done", "accent"] { v.append((fg, "sunken", 3.0)) }
        return v
    }()

    private static let roleNames = ["accent", "background", "border", "done", "foreground", "muted", "on_accent",
                                    "selection", "strong", "sunken", "surface", "urgent", "working"]

    /// The `schema` this reads. A newer file may keep a key and change what it means, so it is refused, not guessed at.
    public static let schema = 1

    private static func build(_ root: [String: Any]) throws -> PolycarpTheme {
        guard let n = root["schema"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded() else {
            throw PolycarpThemeError("schema is missing or not a whole number")
        }
        if n.intValue > schema { throw PolycarpThemeError("schema \(n.intValue) is newer than this BaneySpaces reads (schema \(schema)): update BaneySpaces") }
        guard n.intValue == schema else { throw PolycarpThemeError("schema \(n.intValue) is not one this BaneySpaces reads (schema \(schema))") }
        guard let modeText = root["mode"] as? String, let mode = Mode(rawValue: modeText) else {
            throw PolycarpThemeError("mode is missing or not auto, light or dark")
        }
        guard let surfaces = root["surfaces"] as? [String: Any], let spaces = surfaces["spaces"] as? [String: Any] else {
            throw PolycarpThemeError("surfaces.spaces is missing")
        }
        func section(_ key: String) throws -> [String: Any] {
            guard let s = spaces[key] as? [String: Any] else { throw PolycarpThemeError("\(key) is missing") }
            return s
        }
        func colors(_ key: String) throws -> Colors {
            let c = try section(key)
            var roles: [String: RGB] = [:]
            for r in roleNames {
                guard let text = c[r] as? String else { throw PolycarpThemeError("\(key).\(r) is missing") }
                guard let v = hexColor(text) else { throw PolycarpThemeError("\(key).\(r) is not #rrggbb") }
                roles[r] = v
            }
            let onAccent = roles.removeValue(forKey: "on_accent")!
            let out = Colors(roles: roles, onAccent: onAccent)
            // Every pair the CLI checks (`pairs()` in cli/src/theme.rs), so a file by hand holds to what a built-in does.
            var all = roles
            all["on_accent"] = onAccent
            for (fa, fb, min) in cliPairs {
                let r = all[fa]!.contrast(with: all[fb]!)
                if r < min {
                    throw PolycarpThemeError("\(key).\(fa) on \(key).\(fb) is \(String(format: "%.2f", r)), needs \(min)")
                }
            }
            return out
        }
        func number(_ s: [String: Any], _ key: String, _ lo: Double, _ hi: Double) throws -> Double {
            guard let n = s[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw PolycarpThemeError("\(key) is missing or not a number") }
            let v = n.doubleValue
            guard v.isFinite, v >= lo, v <= hi else { throw PolycarpThemeError("\(key) is \(v), needs \(lo) to \(hi)") }
            return v
        }
        func choice(_ s: [String: Any], _ key: String, _ allowed: [String]) throws -> String {
            guard let v = s[key] as? String, allowed.contains(v) else { throw PolycarpThemeError("\(key) is missing or not one of \(allowed.joined(separator: ", "))") }
            return v
        }
        func stack(_ s: [String: Any], _ key: String) throws -> String {
            guard let v = s[key] as? String else { throw PolycarpThemeError("\(key) is missing") }
            guard parseStack(v) != nil else { throw PolycarpThemeError("\(key) is not a font stack") }
            return v
        }

        let light = try colors("light"), dark = try colors("dark")
        let shape = try section("shape"), type = try section("type"), motion = try section("motion")
        let indicator = ThemeIndicator(rawValue: try choice(shape, "indicator", ["dot", "bar", "number-block"]))!
        let easing = try easingText(motion)
        _ = easing
        guard let reduced = motion["reduced"] as? NSNumber, CFGetTypeID(reduced) == CFBooleanGetTypeID() else {
            throw PolycarpThemeError("reduced is missing or not true or false")
        }
        _ = try stack(type, "display"); _ = try stack(type, "mono")
        let name = printable(root["name"], limit: 48) ?? ""
        let title = printable(root["title"], limit: 48) ?? (name.isEmpty ? "Polycarp" : name)
        let built = PolycarpTheme(
            name: name, title: title, mode: mode, light: light, dark: dark,
            radiusSmall: try number(shape, "radius_small", 0, 64), radius: try number(shape, "radius", 0, 64),
            radiusLarge: try number(shape, "radius_large", 0, 64),
            borderWidth: try number(shape, "border_width", 0, 8), blur: try number(shape, "blur", 0, 80),
            shadow: try number(shape, "shadow", 0, 1),
            density: try choice(shape, "density", ["compact", "regular", "spacious"]), indicator: indicator,
            ui: try stack(type, "ui"), fontSize: try number(type, "size", 10, 24), fontWeight: try number(type, "weight", 300, 800),
            fast: try number(motion, "fast", 0, 1000), normal: try number(motion, "normal", 0, 1000), slow: try number(motion, "slow", 0, 1000),
            scaleFrom: try number(motion, "scale_from", 0.5, 1), reduced: reduced.boolValue)
        try built.checkDrawnPairs()
        return built
    }

    /// The pairs this look really draws (`Look.textPairs`), in both modes whatever `mode` says. A file can
    /// pass the CLI's pairs and still fail one of these (on_accent is checked, but the badge text is drawn
    /// by `Look.text(onAccent:)`).
    func checkDrawnPairs() throws {
        for (key, colors, dark) in [("light", light, false), ("dark", dark, true)] {
            let look = Look(theme: PolycarpTheme.carrier, spec: spec, palette: Palette(name: "polycarp", isDark: dark, colors: colors.roles),
                            polycarp: name, families: nil)
            for p in look.textPairs(accent: colors.roles["accent"]!) {
                let r = p.text.contrast(with: p.fill)
                if r < PolycarpTheme.minContrast {
                    throw PolycarpThemeError("\(key): \(p.name) text is \(String(format: "%.2f", r)) on its fill, needs \(PolycarpTheme.minContrast)")
                }
            }
        }
    }

    /// Strict `#rrggbb`, either case: nothing shorter, longer or without the hash.
    static func hexColor(_ s: String) -> RGB? {
        let b = Array(s.utf8)
        guard b.count == 7, b[0] == UInt8(ascii: "#"), b[1...].allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102) }) else { return nil }
        return RGB(hex: s)
    }

    private static func printable(_ v: Any?, limit: Int) -> String? {
        guard let s = v as? String, !s.isEmpty, s.utf8.count <= limit,
              !s.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else { return nil }
        return s
    }

    /// The easing curve, checked as the CLI checks it. BaneySpaces animates with ease-out, so it is read and not used.
    private static func easingText(_ m: [String: Any]) throws -> String {
        guard let s = m["easing"] as? String else { throw PolycarpThemeError("easing is missing") }
        if ["ease", "ease-in", "ease-out", "ease-in-out", "linear"].contains(s) { return s }
        guard s.hasPrefix("cubic-bezier("), s.hasSuffix(")") else { throw PolycarpThemeError("easing is not a known curve") }
        let inner = s.dropFirst("cubic-bezier(".count).dropLast()
        let parts = inner.split(separator: ",", omittingEmptySubsequences: false)
        let n = parts.compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4, n.count == 4, n.allSatisfy({ $0.isFinite && abs($0) <= 10 }),
              (0...1).contains(n[0]), (0...1).contains(n[2]) else { throw PolycarpThemeError("easing is not a valid cubic-bezier") }
        return s
    }
}

public struct PolycarpThemeError: Error, Equatable, Sendable, CustomStringConvertible {
    public let description: String
    init(_ d: String) { description = d }
}

// MARK: Where the file is, and reading it

public enum PolycarpThemeFile {
    /// The config folder, by the rules `polycarp theme` uses. An empty value counts as unset; a relative
    /// `POLYCARP_CONFIG_DIR` is refused (nil), as the command does.
    public static func configDir(env: (String) -> String?, home: String?, windows: Bool = false) -> String? {
        func get(_ k: String) -> String? { env(k).flatMap { $0.isEmpty ? nil : $0 } }
        if let d = get("POLYCARP_CONFIG_DIR") { return d.hasPrefix("/") || (windows && d.contains(":")) ? d : nil }
        if windows { return get("APPDATA").map { $0 + "\\Polycarp" } }
        if let x = get("XDG_CONFIG_HOME"), x.hasPrefix("/") { return x + "/polycarp" }
        return home.flatMap { $0.isEmpty ? nil : $0 + "/.config/polycarp" }
    }

    public static func path(env: [String: String] = ProcessInfo.processInfo.environment,
                            home: String? = NSHomeDirectory()) -> String? {
        configDir(env: { env[$0] }, home: env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home).map { $0 + "/current/theme.json" }
    }

    public enum Loaded: Equatable, Sendable {
        case missing
        case theme(PolycarpTheme)
        case rejected(String)

        public var theme: PolycarpTheme? { if case .theme(let t) = self { t } else { nil } }
    }

    /// Reads one file through one handle: opened without blocking (a named pipe cannot hang the read),
    /// checked with `fstat` (a regular file under the size limit), then read up to the limit plus one byte.
    /// The check and the read are the same file, so it cannot be swapped between them.
    public static func load(path: String) -> Loaded {
        let fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            return errno == ENOENT || errno == ENOTDIR ? .missing : .rejected("unreadable: \(String(cString: strerror(errno)))")
        }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0 else { return .rejected("unreadable: \(String(cString: strerror(errno)))") }
        guard (st.st_mode & S_IFMT) == S_IFREG else { return .rejected("not a regular file") }
        guard st.st_size <= off_t(PolycarpTheme.maxBytes) else { return .rejected("over \(PolycarpTheme.maxBytes) bytes") }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        while data.count <= PolycarpTheme.maxBytes {
            let n = read(fd, &buf, buf.count)
            if n < 0 { if errno == EINTR { continue }; return .rejected("unreadable: \(String(cString: strerror(errno)))") }
            if n == 0 { break }
            data.append(buf, count: n)
        }
        switch PolycarpTheme.parse(data) {
        case .success(let t): return .theme(t)
        case .failure(let e): return .rejected(e.description)
        }
    }

    /// What one stat says about the file: when it changed, how big, which file. Nil when it isn't there.
    public struct Stamp: Equatable, Sendable {
        let sec: Int, nsec: Int, size: Int64, inode: UInt64
    }

    public static func stamp(_ path: String) -> Stamp? {
        var st = stat()
        guard stat(path, &st) == 0 else { return nil }
        return Stamp(sec: Int(st.st_mtimespec.tv_sec), nsec: Int(st.st_mtimespec.tv_nsec), size: Int64(st.st_size), inode: UInt64(st.st_ino))
    }
}

// MARK: Following the file

/// Looks at the file about once a second (a stat, on its own queue) and hands over the theme when it
/// appears, changes or goes. Nothing here touches the main thread: `deliver` is called on the watcher's
/// queue and the caller moves to the main queue to apply.
public final class PolycarpThemeWatcher: @unchecked Sendable {
    private let path: String?
    private let interval: TimeInterval
    private let queue: DispatchQueue
    private let deliver: (PolycarpTheme?) -> Void
    private let log: (String) -> Void
    private var timer: DispatchSourceTimer?
    // Only touched on `queue`.
    private var last: PolycarpThemeFile.Stamp?
    private var started = false
    private var lastProblem: String?
    private var lastName: String?

    public init(path: String?, interval: TimeInterval = 1,
                queue: DispatchQueue = DispatchQueue(label: "com.baney.baneyspaces.polycarp-theme", qos: .utility),
                log: @escaping (String) -> Void = { _ in },
                deliver: @escaping (PolycarpTheme?) -> Void) {
        self.path = path; self.interval = interval; self.queue = queue; self.log = log; self.deliver = deliver
    }

    public func start() {
        queue.async { [self] in
            guard timer == nil, path != nil else { return }
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(100))
            t.setEventHandler { [weak self] in self?.tick() }
            timer = t
            t.resume()
        }
    }

    public func stop() {
        queue.async { [self] in timer?.cancel(); timer = nil }
    }

    /// One look. Stat, read if it changed, stat again: a file that moved while being read is tried again on
    /// the next tick, so half a write never sticks. Call it on `queue` only (tests do, through `tickNow`).
    func tick() {
        guard let path else { return }
        let before = PolycarpThemeFile.stamp(path)
        if started && before == last { return }
        let loaded: PolycarpThemeFile.Loaded = before == nil ? .missing : PolycarpThemeFile.load(path: path)
        if PolycarpThemeFile.stamp(path) != before { return }
        last = before
        started = true
        switch loaded {
        case .rejected(let why):
            if why != lastProblem { log("polycarp theme: ignored \(displayPath(path)): \(why)") }
            lastProblem = why
            lastName = nil
        case .missing:
            if lastName != nil { log("polycarp theme: file removed, your own theme is back") }
            lastProblem = nil
            lastName = nil
        case .theme(let t):
            if lastName != t.name || lastProblem != nil { log("polycarp theme: \(t.name) (\(t.mode.rawValue)) from \(displayPath(path))") }
            lastProblem = nil
            lastName = t.name
        }
        deliver(loaded.theme)
    }

    /// For tests: one tick on the watcher's queue, waited for.
    func tickNow() { queue.sync { tick() } }

    private func displayPath(_ p: String) -> String {
        let home = NSHomeDirectory()
        return p.hasPrefix(home + "/") ? "~" + p.dropFirst(home.count) : p
    }
}

// MARK: In force

extension AppearanceSettings {
    /// The look to draw: a Polycarp theme when one is in force, else the person's own theme and palette.
    /// The settings themselves are never changed by a Polycarp theme.
    public func look(systemAccent: RGB, polycarp: PolycarpTheme?, systemDark: Bool) -> Look {
        polycarp?.look(systemDark: systemDark) ?? look(systemAccent: systemAccent)
    }
}

extension Look {
    public init(theme: ThemeID, spec: ThemeSpec, palette: Palette, polycarp name: String, families: [String]?) {
        self.theme = theme
        self.spec = spec
        self.palette = palette
        isAuto = false
        polycarp = name
        fontFamilies = families
    }

    /// The font names to try for a `ThemeSpec.Font.family` key.
    public func families(for key: String) -> [String] {
        if key == PolycarpTheme.fontKey, let f = fontFamilies { return f }
        return ThemeCatalog.shared.fontFamilies(key)
    }
}

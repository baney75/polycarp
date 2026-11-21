import Foundation

// How every Polycarp surface looks and behaves, in one file that agents and the owner edit: surfaces.json in the
// support folder (docs/surfaces.md). Every field is optional; a missing one takes its default, compiled in here.
// `SurfaceField.all` is the one list of fields: validation, defaults, the typed model and the JSON Schema all read it,
// so they cannot disagree. Keys this build doesn't know are kept as they came (a newer build wrote them) and only warned
// about. Values are checked strictly: a wrong one is an error with its JSON path, and an app that reads an invalid file
// keeps the last good config (`SurfacesWatcher`).

/// One problem in a surfaces file: where (`bar.modules.left[2]`, `$` for the whole file) and what.
public struct SurfacesIssue: Equatable, Sendable, CustomStringConvertible {
    public let path: String
    public let message: String
    public init(_ path: String, _ message: String) { self.path = path; self.message = message }
    public var description: String { "\(path): \(message)" }
}

/// What one field may hold.
public enum SurfaceKind: Equatable, Sendable {
    case bool
    case integer(ClosedRange<Int>)
    /// One of these strings.
    case choice([String])
    /// One of `choices`, or `<prefix>:<rest>` with `rest` matching `pattern` (as `image:dawn.png`).
    case tagged(choices: [String], prefix: String, pattern: String, example: String)
    /// One line of text, not blank, up to `max` characters.
    case text(max: Int)
    /// An https URL with `{query}` where the search words go.
    case searchTemplate
    /// An ordered list of ids, each once: one of `known`, or `custom:<name>` when `custom`.
    case ids(known: [String], custom: Bool)
}

/// One field of surfaces.json.
public struct SurfaceField: Sendable {
    public let path: String
    public let kind: SurfaceKind
    public let defaultValue: SurfaceValue
    public let help: String

    public var keys: [String] { path.split(separator: ".").map(String.init) }

    init(_ path: String, _ kind: SurfaceKind, _ value: SurfaceValue, _ help: String) {
        self.path = path; self.kind = kind; defaultValue = value; self.help = help
    }
}

// MARK: The typed model views read

public struct Surfaces: Equatable, Sendable {
    /// The format this build writes. A file with a higher one is read for the fields this build knows.
    public static let version = 1

    public enum BarStyle: String, CaseIterable, Sendable { case solid, glass, hairline }
    public enum ClockFormat: String, CaseIterable, Sendable { case twelveHour = "12h", twentyFourHour = "24h" }

    /// A top bar module. `custom` carries the name after `custom:`.
    public enum BarModule: Hashable, Sendable {
        case mark, workspaces, purpose, oneThing, appMenus, status, hour, clock, date, verse, battery, network
        case custom(String)

        public static let builtIn: [BarModule] = [.mark, .workspaces, .purpose, .oneThing, .appMenus, .status, .hour, .clock,
                                                  .date, .verse, .battery, .network]

        public var id: String {
            switch self {
            case .mark: "mark"
            case .workspaces: "workspaces"
            case .purpose: "purpose"
            case .oneThing: "one-thing"
            case .appMenus: "app-menus"
            case .status: "status"
            case .hour: "hour"
            case .clock: "clock"
            case .date: "date"
            case .verse: "verse"
            case .battery: "battery"
            case .network: "network"
            case let .custom(name): "custom:" + name
            }
        }

        public init?(id: String) {
            if let b = BarModule.builtIn.first(where: { $0.id == id }) { self = b; return }
            guard id.hasPrefix("custom:"), SurfaceCheck.matches(String(id.dropFirst(7)), SurfaceCheck.namePattern) else { return nil }
            self = .custom(String(id.dropFirst(7)))
        }
    }

    public struct Bar: Equatable, Sendable {
        public var enabled: Bool
        public var height: Int
        public var style: BarStyle
        public var left: [BarModule]
        public var center: [BarModule]
        public var right: [BarModule]
        public var clockFormat: ClockFormat
        public var hourNames: Bool
        public var hideSystemMenuBar: Bool
    }

    public enum Scene: Equatable, Sendable {
        case field, olive, water, parchment, solid
        /// A picture by file name.
        case image(String)
        public static let named: [String] = ["field", "olive", "water", "parchment", "solid"]
        public var id: String {
            switch self {
            case .field: "field"
            case .olive: "olive"
            case .water: "water"
            case .parchment: "parchment"
            case .solid: "solid"
            case let .image(f): "image:" + f
            }
        }
        init(id: String) {
            switch id {
            case "olive": self = .olive
            case "water": self = .water
            case "parchment": self = .parchment
            case "solid": self = .solid
            case _ where id.hasPrefix("image:"): self = .image(String(id.dropFirst(6)))
            default: self = .field
            }
        }
    }

    public enum VersePosition: String, CaseIterable, Sendable {
        case bottomLeft = "bottom-left", bottomCenter = "bottom-center", bottomRight = "bottom-right"
        case topLeft = "top-left", topCenter = "top-center", topRight = "top-right", center
    }

    public enum VerseRotation: Equatable, Sendable {
        case daily, hourly
        /// One verse always, by reference ("Psalm 46:10"). One outside `Verses.desktop` turns daily.
        case fixed(String)
        public var id: String {
            switch self {
            case .daily: "daily"
            case .hourly: "hourly"
            case let .fixed(r): "fixed:" + r
            }
        }
        init(id: String) {
            if id == "hourly" { self = .hourly } else if id.hasPrefix("fixed:") { self = .fixed(String(id.dropFirst(6))) } else { self = .daily }
        }
    }

    public struct Desktop: Equatable, Sendable {
        public var scene: Scene
        public var followDaylight: Bool
        public var verse: Bool
        public var versePosition: VersePosition
        public var verseRotation: VerseRotation
    }

    public enum TileLabel: String, CaseIterable, Sendable { case purpose, number, icons }

    public struct Dock: Equatable, Sendable {
        public var tileLabel: TileLabel
        public var restTile: Bool
        public var restAfterMinutes: Int
    }

    /// The status menu's rows, by id.
    public enum MenuRow: String, CaseIterable, Sendable {
        case workspaces, showAll = "show-all", find, agents, update, dock, settings, quit
        /// Rows that can never be hidden: without them there is no way to Settings or out.
        public static let required: [MenuRow] = [.settings, .quit]
    }

    public struct Menu: Equatable, Sendable {
        /// The order the file gives; rows it leaves out follow in their default order (`rows`).
        public var order: [MenuRow]
        public var hidden: [MenuRow]
        /// Every row to show, in order: `order`, then any row it left out, without the hidden ones.
        public var rows: [MenuRow] {
            let all = order + MenuRow.allCases.filter { !order.contains($0) }
            return all.filter { !hidden.contains($0) }
        }
    }

    public struct NewTab: Equatable, Sendable {
        public var question: String
        public var chips: Bool
        public var verse: Bool
        /// An https URL with `{query}` in it.
        public var searchURL: String
        /// The search URL for `words`, percent-encoded into the template.
        public func searchURL(for words: String) -> URL? {
            let q = words.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? ""
            return URL(string: searchURL.replacingOccurrences(of: "{query}", with: q))
        }
    }

    public enum IdleStyle: String, CaseIterable, Sendable { case martyrNight = "martyr-night", field, verse }

    public struct Idle: Equatable, Sendable {
        public var style: IdleStyle
        public var effects: Bool
        public var showMachineName: Bool
        public var showVerse: Bool
        public var showKierkegaard: Bool
        public var startAfterMinutes: Int
    }

    public enum Translation: String, CaseIterable, Sendable { case bsb = "BSB" }

    public enum VerseSource: Equatable, Sendable {
        case builtIn
        /// A list in the support folder's `verses/` folder, by file name.
        case file(String)
        public var id: String { if case let .file(f) = self { "file:" + f } else { "built-in" } }
        init(id: String) { self = id.hasPrefix("file:") ? .file(String(id.dropFirst(5))) : .builtIn }
    }

    public struct Text: Equatable, Sendable {
        public var translation: Translation
        public var verseSource: VerseSource
    }

    public var bar: Bar
    public var desktop: Desktop
    public var dock: Dock
    public var menu: Menu
    public var newtab: NewTab
    public var idle: Idle
    public var text: Text

    /// Every default, as compiled in.
    public static let defaults = Surfaces(resolved: SurfaceField.defaultTree)
}

// MARK: Every field

extension SurfaceField {
    private static func ids(_ list: [String]) -> SurfaceValue { .array(list.map { .string($0) }) }

    /// The groups above the fields, with what each one is for.
    public static let groups: [(path: String, help: String)] = [
        ("bar", "The top bar that stands in for the macOS menu bar."),
        ("bar.modules", "What the top bar shows, left to right in each of its three places. Each module id may appear once in all three."),
        ("desktop", "The desktop scene behind every window, and its verse."),
        ("dock", "The Workspace Dock's tiles."),
        ("menu", "The status menu (Polycarp's menu bar icon)."),
        ("newtab", "The browser's new tab page."),
        ("idle", "The idle screen (Martyr Night)."),
        ("text", "Where verses come from."),
    ]

    public static let all: [SurfaceField] = [
        SurfaceField("version", .integer(1...1_000), .number(Double(Surfaces.version)),
                     "The format of this file. This build writes 1; a higher number is read for the fields this build knows."),

        SurfaceField("bar.enabled", .bool, .bool(false), "Show Polycarp's top bar. Off until you turn it on."),
        SurfaceField("bar.height", .integer(22...40), .number(28), "The bar's height in points, 22 to 40."),
        SurfaceField("bar.style", .choice(Surfaces.BarStyle.allCases.map(\.rawValue)), .string("solid"),
                     "solid: the theme's surface color. glass: blurred and see-through. hairline: the desktop shows through, with a thin line under it."),
        SurfaceField("bar.modules.left", .ids(known: Surfaces.BarModule.builtIn.map(\.id), custom: true),
                     ids(["mark", "workspaces", "app-menus"]), "Modules at the left, in order."),
        SurfaceField("bar.modules.center", .ids(known: Surfaces.BarModule.builtIn.map(\.id), custom: true),
                     ids(["one-thing"]), "Modules in the middle, in order."),
        SurfaceField("bar.modules.right", .ids(known: Surfaces.BarModule.builtIn.map(\.id), custom: true),
                     ids(["status", "network", "battery", "date", "clock"]), "Modules at the right, in order."),
        SurfaceField("bar.clockFormat", .choice(Surfaces.ClockFormat.allCases.map(\.rawValue)), .string("12h"),
                     "The clock module: 12h (3:05) or 24h (15:05)."),
        SurfaceField("bar.hourNames", .bool, .bool(true), "The hour module names the hour of prayer (Lauds, Terce, Sext, None, Vespers, Compline)."),
        SurfaceField("bar.hideSystemMenuBar", .bool, .bool(false),
                     "Hide the macOS menu bar while Polycarp's bar is on. Off: the two share the top of the screen."),

        SurfaceField("desktop.scene", .tagged(choices: Surfaces.Scene.named, prefix: "image", pattern: SurfaceCheck.picturePattern,
                                              example: "image:dawn.png"),
                     .string("field"), "field, olive, water, parchment, solid (the theme's background), or image:<file> for a picture of your own."),
        SurfaceField("desktop.followDaylight", .bool, .bool(true), "The scene's light follows the day: dawn, noon, dusk and night."),
        SurfaceField("desktop.verse", .bool, .bool(true), "A small verse on the desktop."),
        SurfaceField("desktop.versePosition", .choice(Surfaces.VersePosition.allCases.map(\.rawValue)), .string("bottom-right"),
                     "Where the verse sits."),
        SurfaceField("desktop.verseRotation", .tagged(choices: ["daily", "hourly"], prefix: "fixed", pattern: SurfaceCheck.referencePattern,
                                                      example: "fixed:Psalm 46:10"),
                     .string("daily"), "daily, hourly, or fixed:<reference> for one verse always."),

        SurfaceField("dock.tileLabel", .choice(Surfaces.TileLabel.allCases.map(\.rawValue)), .string("number"),
                     "What each workspace tile says: its purpose, its number, or only its apps' icons."),
        SurfaceField("dock.restTile", .bool, .bool(true), "An \"At rest\" tile gathers apps that have sat idle in the background."),
        SurfaceField("dock.restAfterMinutes", .integer(1...1_440), .number(30), "Minutes in the background, unused, before an app moves to the rest tile."),

        SurfaceField("menu.order", .ids(known: Surfaces.MenuRow.allCases.map(\.rawValue), custom: false),
                     ids(Surfaces.MenuRow.allCases.map(\.rawValue)), "The rows in order. Rows left out follow in their default order."),
        SurfaceField("menu.hidden", .ids(known: Surfaces.MenuRow.allCases.map(\.rawValue), custom: false), ids([]),
                     "Rows not shown. settings and quit can't be hidden."),

        SurfaceField("newtab.question", .text(max: 160), .string("What is the one thing today?"), "The question at the top of a new tab."),
        SurfaceField("newtab.chips", .bool, .bool(true), "Shortcut chips under the question."),
        SurfaceField("newtab.verse", .bool, .bool(true), "A verse on the new tab page."),
        SurfaceField("newtab.searchURL", .searchTemplate, .string("https://duckduckgo.com/?q={query}"),
                     "The search engine: an https URL with {query} where the words go."),

        SurfaceField("idle.style", .choice(Surfaces.IdleStyle.allCases.map(\.rawValue)), .string("martyr-night"),
                     "martyr-night (night sky and embers), field (the desktop scene, dimmed) or verse (one verse on black)."),
        SurfaceField("idle.effects", .bool, .bool(true), "Motion on the idle screen. Reduce Motion turns it off regardless."),
        SurfaceField("idle.showMachineName", .bool, .bool(true), "The Mac's name on the idle screen."),
        SurfaceField("idle.showVerse", .bool, .bool(true), "A verse on the idle screen."),
        SurfaceField("idle.showKierkegaard", .bool, .bool(true), "A line from Kierkegaard on the idle screen."),
        SurfaceField("idle.startAfterMinutes", .integer(1...240), .number(10), "Minutes without input before the idle screen comes up."),

        SurfaceField("text.translation", .choice(Surfaces.Translation.allCases.map(\.rawValue)), .string("BSB"),
                     "The Bible translation. Only BSB (the Berean Standard Bible, public domain) for now."),
        SurfaceField("text.verseSource", .tagged(choices: ["built-in"], prefix: "file", pattern: SurfaceCheck.listPattern,
                                                 example: "file:psalms.json"),
                     .string("built-in"), "built-in, or file:<name>.json for a list of references in the support folder's verses/ folder."),
    ]

    static let byPath: [String: SurfaceField] = Dictionary(uniqueKeysWithValues: all.map { ($0.path, $0) })
    static let groupPaths: Set<String> = Set(groups.map(\.path))

    /// Every default as one tree, the shape of a complete file.
    public static let defaultTree: SurfaceValue = all.reduce(SurfaceValue.object([:])) { $0.setting($1.keys, to: $1.defaultValue) }

    /// Whether `path` names a field or a group (the whole file is "").
    public static func isKnown(_ path: String) -> Bool { path.isEmpty || byPath[path] != nil || groupPaths.contains(path) }

    /// The known paths closest to `path`, for "did you mean".
    public static func nearest(_ path: String) -> [String] {
        let candidates = all.map(\.path) + groups.map(\.path)
        let scored = candidates.map { ($0, SurfaceCheck.distance(path.lowercased(), $0.lowercased())) }
        let best = scored.map(\.1).min() ?? 0
        guard best <= max(2, path.count / 3) else { return [] }
        return scored.filter { $0.1 == best }.map(\.0).sorted()
    }
}

// MARK: Checking

extension Surfaces {
    /// A checked file: the model, and the keys it didn't know.
    public struct Checked: Equatable, Sendable {
        public let surfaces: Surfaces
        public let warnings: [SurfacesIssue]
    }

    /// Checks a whole file's tree. Errors are in path order; unknown keys are warnings, kept in the tree.
    public static func check(_ doc: SurfaceValue) -> Result<Checked, SurfacesErrors> {
        var errors: [SurfacesIssue] = []
        var warnings: [SurfacesIssue] = []
        guard case .object = doc else { return .failure(SurfacesErrors([SurfacesIssue("$", "the file must be a JSON object, not \(doc.kind)")])) }
        SurfaceCheck.walk(doc, at: [], errors: &errors, warnings: &warnings)
        if let v = doc.at(["version"])?.integer, v > Surfaces.version {
            warnings.append(SurfacesIssue("version", "written by a newer Polycarp (format \(v)); this build reads the fields it knows"))
        }
        SurfaceCheck.crossChecks(doc, errors: &errors)
        guard errors.isEmpty else { return .failure(SurfacesErrors(errors.sorted { $0.path < $1.path })) }
        let resolved = SurfaceField.defaultTree.merged(with: doc)
        return .success(Checked(surfaces: Surfaces(resolved: resolved), warnings: warnings.sorted { $0.path < $1.path }))
    }

    /// The model from a tree already checked (defaults merged in). A value that is somehow wrong takes the default.
    init(resolved t: SurfaceValue) {
        func v(_ path: String) -> SurfaceValue {
            let f = SurfaceField.byPath[path]!
            guard let got = t.at(f.keys), SurfaceCheck.problem(got, kind: f.kind) == nil else { return f.defaultValue }
            return got
        }
        func b(_ p: String) -> Bool { v(p).bool ?? false }
        func n(_ p: String) -> Int { v(p).integer ?? 0 }
        func s(_ p: String) -> String { v(p).string ?? "" }
        func list(_ p: String) -> [String] { (v(p).array ?? []).compactMap(\.string) }
        bar = Bar(enabled: b("bar.enabled"), height: n("bar.height"), style: BarStyle(rawValue: s("bar.style")) ?? .solid,
                  left: list("bar.modules.left").compactMap(BarModule.init(id:)),
                  center: list("bar.modules.center").compactMap(BarModule.init(id:)),
                  right: list("bar.modules.right").compactMap(BarModule.init(id:)),
                  clockFormat: ClockFormat(rawValue: s("bar.clockFormat")) ?? .twelveHour,
                  hourNames: b("bar.hourNames"), hideSystemMenuBar: b("bar.hideSystemMenuBar"))
        desktop = Desktop(scene: Scene(id: s("desktop.scene")), followDaylight: b("desktop.followDaylight"), verse: b("desktop.verse"),
                          versePosition: VersePosition(rawValue: s("desktop.versePosition")) ?? .bottomRight,
                          verseRotation: VerseRotation(id: s("desktop.verseRotation")))
        dock = Dock(tileLabel: TileLabel(rawValue: s("dock.tileLabel")) ?? .number, restTile: b("dock.restTile"),
                    restAfterMinutes: n("dock.restAfterMinutes"))
        menu = Menu(order: list("menu.order").compactMap(MenuRow.init(rawValue:)), hidden: list("menu.hidden").compactMap(MenuRow.init(rawValue:)))
        newtab = NewTab(question: s("newtab.question"), chips: b("newtab.chips"), verse: b("newtab.verse"), searchURL: s("newtab.searchURL"))
        idle = Idle(style: IdleStyle(rawValue: s("idle.style")) ?? .martyrNight, effects: b("idle.effects"),
                    showMachineName: b("idle.showMachineName"), showVerse: b("idle.showVerse"),
                    showKierkegaard: b("idle.showKierkegaard"), startAfterMinutes: n("idle.startAfterMinutes"))
        text = Text(translation: Translation(rawValue: s("text.translation")) ?? .bsb, verseSource: VerseSource(id: s("text.verseSource")))
    }
}

/// Every error a check found, in path order.
public struct SurfacesErrors: Error, Equatable, Sendable, CustomStringConvertible {
    public let issues: [SurfacesIssue]
    public init(_ issues: [SurfacesIssue]) { self.issues = issues }
    public var description: String { issues.map(\.description).joined(separator: "\n") }
    /// One line for a log: the first error, and how many more.
    public var summary: String {
        guard let first = issues.first else { return "invalid" }
        return issues.count > 1 ? "\(first) (and \(issues.count - 1) more)" : first.description
    }
}

enum SurfaceCheck {
    static let namePattern = "^[a-z0-9][a-z0-9-]{0,31}$"
    /// The same file names `ThemeWallpaper` takes for `image:`.
    static let picturePattern = "^[a-z0-9][a-z0-9-]{0,47}\\.(png|jpg|heic)$"
    static let listPattern = "^[a-z0-9][a-z0-9-]{0,47}\\.json$"
    /// A Bible reference: an optional book number, the book's name, a chapter, optionally a verse or a range.
    static let referencePattern = "^([1-3] )?[A-Za-z]+( [A-Za-z]+){0,3} [0-9]{1,3}(:[0-9]{1,3}(-[0-9]{1,3})?)?$"
    static let maxTemplate = 512

    static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }

    static func render(_ path: [String]) -> String { path.isEmpty ? "$" : path.joined(separator: ".") }

    /// Walks the file: a field is checked, a group must be an object and is walked, anything else is an unknown key.
    static func walk(_ v: SurfaceValue, at path: [String], errors: inout [SurfacesIssue], warnings: inout [SurfacesIssue]) {
        let p = path.joined(separator: ".")
        if let f = SurfaceField.byPath[p] {
            if let why = problem(v, kind: f.kind) { errors.append(SurfacesIssue(why.at.map { p + $0 } ?? p, why.message)) }
            return
        }
        guard path.isEmpty || SurfaceField.groupPaths.contains(p) else {
            warnings.append(SurfacesIssue(p, "not a field this build knows; kept as it is"))
            return
        }
        guard let o = v.object else {
            errors.append(SurfacesIssue(render(path), "must be an object, not \(v.kind)"))
            return
        }
        for k in o.keys.sorted() { walk(o[k]!, at: path + [k], errors: &errors, warnings: &warnings) }
    }

    /// What is wrong with `v` for `kind`, with a suffix for a list item ("[2]"); nil when it is right.
    static func problem(_ v: SurfaceValue, kind: SurfaceKind) -> (at: String?, message: String)? {
        func quoted(_ list: [String]) -> String { list.map { "\"\($0)\"" }.joined(separator: ", ") }
        switch kind {
        case .bool:
            return v.bool == nil ? (nil, "must be true or false, not \(v.kind)") : nil
        case let .integer(range):
            guard let n = v.integer else { return (nil, "must be a whole number from \(range.lowerBound) to \(range.upperBound), not \(v.kind == "a number" ? v.json(pretty: false) : v.kind)") }
            return range.contains(n) ? nil : (nil, "must be from \(range.lowerBound) to \(range.upperBound), not \(n)")
        case let .choice(list):
            guard let s = v.string else { return (nil, "must be one of \(quoted(list)), not \(v.kind)") }
            return list.contains(s) ? nil : (nil, "must be one of \(quoted(list)), not \"\(s)\"")
        case let .tagged(choices, prefix, pattern, example):
            let want = "one of \(quoted(choices)) or \(prefix):<...> (as \"\(example)\")"
            guard let s = v.string else { return (nil, "must be \(want), not \(v.kind)") }
            if choices.contains(s) { return nil }
            guard s.hasPrefix(prefix + ":") else { return (nil, "must be \(want), not \"\(s)\"") }
            let rest = String(s.dropFirst(prefix.count + 1))
            return matches(rest, pattern) ? nil : (nil, "\"\(rest)\" is not a valid \(prefix) value (as \"\(example)\")")
        case let .text(max):
            guard let s = v.string else { return (nil, "must be text, not \(v.kind)") }
            if s.trimmingCharacters(in: .whitespaces).isEmpty { return (nil, "must not be blank") }
            if s.count > max { return (nil, "must be at most \(max) characters, not \(s.count)") }
            if s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return (nil, "must be one line, with no control characters") }
            return nil
        case .searchTemplate:
            guard let s = v.string else { return (nil, "must be a URL template, not \(v.kind)") }
            if s.count > maxTemplate { return (nil, "must be at most \(maxTemplate) characters") }
            guard s.hasPrefix("https://") else { return (nil, "must start with https://") }
            guard s.components(separatedBy: "{query}").count == 2 else { return (nil, "must hold {query} exactly once, where the search words go") }
            guard !s.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
                  let u = URL(string: s.replacingOccurrences(of: "{query}", with: "q")), let host = u.host, !host.isEmpty else {
                return (nil, "is not a valid URL with {query} in it")
            }
            return nil
        case let .ids(known, custom):
            guard let a = v.array else { return (nil, "must be a list of ids, not \(v.kind)") }
            var seen = Set<String>()
            for (i, item) in a.enumerated() {
                guard let id = item.string else { return ("[\(i)]", "must be an id (a string), not \(item.kind)") }
                let ok = known.contains(id) || (custom && id.hasPrefix("custom:") && matches(String(id.dropFirst(7)), namePattern))
                if !ok {
                    let extra = custom ? " or custom:<name> (lowercase letters, digits and hyphens)" : ""
                    return ("[\(i)]", "\"\(id)\" is not a known id; use one of \(quoted(known))\(extra)")
                }
                if !seen.insert(id).inserted { return ("[\(i)]", "\"\(id)\" is listed twice") }
            }
            return nil
        }
    }

    /// Rules across fields: a bar module in one place only, and the menu rows that can't be hidden.
    static func crossChecks(_ doc: SurfaceValue, errors: inout [SurfacesIssue]) {
        // Only lists that passed on their own are compared, so one mistake is one error.
        func list(_ p: String) -> [String]? {
            let f = SurfaceField.byPath[p]!
            guard let v = doc.at(f.keys), problem(v, kind: f.kind) == nil else { return nil }
            return v.array?.compactMap(\.string)
        }
        let places = ["left", "center", "right"]
        var placed: [String: (place: String, index: Int, fromFile: Bool)] = [:]
        for place in places {
            let path = "bar.modules." + place
            let own = list(path).flatMap { doc.at(["bar", "modules", place]) != nil ? $0 : nil }
            let ids = own ?? (SurfaceField.byPath[path]!.defaultValue.array ?? []).compactMap(\.string)
            for (j, id) in ids.enumerated() {
                guard let other = placed[id] else { placed[id] = (place, j, own != nil); continue }
                if own != nil {
                    let note = other.fromFile ? "" : " (its default; set bar.modules.\(other.place) too)"
                    errors.append(SurfacesIssue("\(path)[\(j)]", "\"\(id)\" is already in bar.modules.\(other.place)\(note); a module goes in one place"))
                } else {
                    errors.append(SurfacesIssue("bar.modules.\(other.place)[\(other.index)]",
                                                "\"\(id)\" is also in \(path) (its default; set \(path) too); a module goes in one place"))
                }
            }
        }
        if let hidden = list("menu.hidden") {
            for (i, id) in hidden.enumerated() where Surfaces.MenuRow.required.map(\.rawValue).contains(id) {
                errors.append(SurfacesIssue("menu.hidden[\(i)]", "\"\(id)\" can't be hidden: it is the way to Settings or out"))
            }
        }
    }

    /// Edit distance, for "did you mean".
    static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.isEmpty { return b.count }
        var row = Array(0...b.count)
        for i in 1...a.count {
            var prev = row[0]
            row[0] = i
            for j in 1...max(b.count, 1) where !b.isEmpty {
                let cur = row[j]
                row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
                prev = cur
            }
        }
        return row[b.count]
    }
}

// MARK: The JSON Schema

extension Surfaces {
    /// JSON Schema (draft 2020-12) for surfaces.json, from the same field list the checker uses. Unknown keys are allowed
    /// (`additionalProperties: true`) because a newer build's file must still read; this build warns about them.
    public static var schema: SurfaceValue {
        func fieldSchema(_ f: SurfaceField) -> SurfaceValue {
            var o: [String: SurfaceValue] = ["description": .string(f.help + " Path: " + f.path + "."), "default": f.defaultValue]
            switch f.kind {
            case .bool: o["type"] = .string("boolean")
            case let .integer(r):
                o["type"] = .string("integer"); o["minimum"] = .number(Double(r.lowerBound)); o["maximum"] = .number(Double(r.upperBound))
            case let .choice(l):
                o["type"] = .string("string"); o["enum"] = .array(l.map { .string($0) })
            case let .tagged(choices, prefix, pattern, example):
                o["type"] = .string("string")
                o["anyOf"] = .array([.object(["enum": .array(choices.map { .string($0) })]),
                                     .object(["pattern": .string("^" + prefix + ":" + pattern.dropFirst())])])
                o["examples"] = .array([.string(choices[0]), .string(example)])
            case let .text(max):
                o["type"] = .string("string"); o["minLength"] = .number(1); o["maxLength"] = .number(Double(max))
            case .searchTemplate:
                o["type"] = .string("string"); o["maxLength"] = .number(Double(SurfaceCheck.maxTemplate))
                o["pattern"] = .string("^https://[^\\s{}]+[^\\s]*\\{query\\}[^\\s]*$")
            case let .ids(known, custom):
                var item: [String: SurfaceValue] = ["type": .string("string")]
                if custom {
                    item["anyOf"] = .array([.object(["enum": .array(known.map { .string($0) })]),
                                            .object(["pattern": .string("^custom:" + SurfaceCheck.namePattern.dropFirst())])])
                } else {
                    item["enum"] = .array(known.map { .string($0) })
                }
                o["type"] = .string("array"); o["items"] = .object(item); o["uniqueItems"] = .bool(true)
            }
            return .object(o)
        }
        var root: SurfaceValue = .object([
            "$schema": .string("https://json-schema.org/draft/2020-12/schema"),
            "$id": .string("https://github.com/baney75/polycarp/blob/main/spaces/docs/surfaces.md"),
            "title": .string("Polycarp surfaces"),
            "description": .string("""
                How every Polycarp surface looks and behaves: surfaces.json in ~/Library/Application Support/Polycarp. \
                Every field is optional and takes its default when missing. A path is the keys joined with dots \
                (bar.modules.left); `polycarp-spaces surfaces get|set|reset <path>` takes it. Unknown keys are kept and \
                warned about. Colors and fonts are the theme's (polycarp theme), not this file's.
                """),
            "type": .string("object"),
            "additionalProperties": .bool(true),
        ])
        for (path, help) in SurfaceField.groups {
            let keys = path.split(separator: ".").map(String.init)
            let group: SurfaceValue = .object(["type": .string("object"), "description": .string(help + " Path: " + path + "."),
                                               "additionalProperties": .bool(true)])
            root = root.setting(Array(keys.flatMap { ["properties", $0] }), to: group)
        }
        for f in SurfaceField.all {
            root = root.setting(Array(f.keys.flatMap { ["properties", $0] }), to: fieldSchema(f))
        }
        return root
    }
}

import CoreGraphics
import Foundation

/// A display as the window book needs it: its UUID and its whole and usable areas, in
/// Accessibility coordinates (top-left origin, y down).
public struct DisplayArea: Equatable, Sendable {
    public var key: DisplayKey
    public var frame: CGRect
    public var visible: CGRect
    public init(key: DisplayKey, frame: CGRect, visible: CGRect) {
        self.key = key; self.frame = frame; self.visible = visible
    }
}

/// A window as it can be known again once its window number and process are new: after its app
/// relaunches or the Mac restarts. It is known by its app's bundle id, its title and its creation
/// order among its process's windows, and it keeps where it was: its workspace, its display and
/// its frame on that display.
public struct WindowRecord: Codable, Equatable, Sendable {
    public var bundle: String
    public var title: String
    /// Creation order among the windows of its process, oldest first (window numbers only grow).
    public var order: Int
    public var workspace: Int
    /// The display it was on, by UUID. Nil when it was on none: `frame` is then global.
    public var display: DisplayKey?
    /// Its frame, relative to the top-left corner of `display`.
    public var frame: CGRect?
    /// The size of `display` when this was written, to carry the frame onto another display.
    public var displaySize: CGSize?
    /// The window and process it was written from, so a restart that kept both skips it.
    public var window: WindowID
    public var pid: Int32
    /// When it was written, in seconds since 1970.
    public var at: Double

    public init(bundle: String, title: String, order: Int, workspace: Int, frame: CGRect?, displays: [DisplayArea],
                window: WindowID, pid: Int32, at: Double) {
        self.bundle = bundle; self.title = title; self.order = order; self.workspace = workspace
        self.window = window; self.pid = pid; self.at = at
        let byKey = Dictionary(displays.map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        if let frame, let key = Geometry.display(of: frame, in: byKey), let d = displays.first(where: { $0.key == key }) {
            display = key
            displaySize = d.frame.size
            self.frame = frame.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY)
        } else {
            self.frame = frame
        }
    }

    /// Where the window goes now, in global Accessibility coordinates. On its own display when that is
    /// connected, wherever that display now sits; otherwise carried onto `fallback` (the display
    /// showing its workspace) or the main display, in proportion and inside its usable area.
    public func place(on displays: [DisplayArea], fallback: DisplayKey? = nil) -> CGRect? {
        guard let frame else { return nil }
        guard let key = display else { return frame }
        if let d = displays.first(where: { $0.key == key }) { return frame.offsetBy(dx: d.frame.minX, dy: d.frame.minY) }
        guard let to = displays.first(where: { $0.key == fallback }) ?? displays.first else { return nil }
        let size = displaySize ?? CGSize(width: max(frame.maxX, 1), height: max(frame.maxY, 1))
        return Geometry.carry(frame, from: CGRect(origin: .zero, size: size), to: to.visible)
    }
}

/// The part of a window title that names what the window shows, so a title that only changed its
/// marks still matches: lowercased, without an unsaved-changes mark ("●", "•", "*" in front or at the
/// end), an "Edited" note, a count of unread items in front ("(3) Inbox", "[3] Inbox") or extra spaces.
public enum TitleRules {
    private static let dashes = ["-", "\u{2013}", "\u{2014}"]

    public static func key(_ title: String) -> String {
        var s = title.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        var changed = true
        while changed {
            changed = false
            for mark in ["\u{25CF}", "\u{2022}", "*"] where s.hasPrefix(mark) {
                s = String(s.dropFirst(mark.count)).trimmingCharacters(in: .whitespaces); changed = true
            }
            if s.hasSuffix("*") { s = String(s.dropLast()).trimmingCharacters(in: .whitespaces); changed = true }
            for open in ["(", "["] where s.hasPrefix(open) {
                let close: Character = open == "(" ? ")" : "]"
                guard let end = s.firstIndex(of: close) else { continue }
                let inside = s[s.index(after: s.startIndex)..<end]
                guard !inside.isEmpty, inside.allSatisfy(\.isNumber) else { continue }
                s = String(s[s.index(after: end)...]).trimmingCharacters(in: .whitespaces); changed = true
            }
            for dash in dashes where s.hasSuffix(" \(dash) edited") {
                s = String(s.dropLast(dash.count + 8)).trimmingCharacters(in: .whitespaces); changed = true
            }
            if s.hasSuffix("(edited)") { s = String(s.dropLast(8)).trimmingCharacters(in: .whitespaces); changed = true }
        }
        return s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

/// A window on screen now, as the matcher sees it.
public struct LiveWindow: Equatable, Sendable {
    public var id: WindowID
    public var bundle: String
    public var title: String
    /// Creation order among its process's windows, oldest first.
    public var order: Int
    public init(id: WindowID, bundle: String, title: String, order: Int) {
        self.id = id; self.bundle = bundle; self.title = title; self.order = order
    }
}

/// Pairs windows on screen with records of windows from before. Same bundle id only, and each
/// record goes to one window. Three passes, strongest first: the same title; the same title by
/// `TitleRules`; then the same creation order. Among several records that fit, the one closest in
/// creation order wins.
public enum WindowPairing {
    public enum Rule: String, Sendable {
        case title
        case titleRule = "title rule"
        case order = "creation order"
    }

    public struct Pair: Equatable, Sendable {
        public var window: WindowID
        public var record: Int
        public var rule: Rule
    }

    public static func pair(_ live: [LiveWindow], with records: [WindowRecord]) -> [Pair] {
        var used = Set<Int>(), done = Set<WindowID>(), out: [Pair] = []
        let windows = live.sorted { ($0.bundle, $0.order, $0.id) < ($1.bundle, $1.order, $1.id) }
        func pass(_ rule: Rule, _ fits: (LiveWindow, WindowRecord) -> Bool) {
            for w in windows where !done.contains(w.id) {
                let best = records.indices
                    .filter { !used.contains($0) && records[$0].bundle == w.bundle && fits(w, records[$0]) }
                    .min { (abs(records[$0].order - w.order), $0) < (abs(records[$1].order - w.order), $1) }
                guard let i = best else { continue }
                used.insert(i); done.insert(w.id)
                out.append(Pair(window: w.id, record: i, rule: rule))
            }
        }
        pass(.title) { !$0.title.isEmpty && $0.title == $1.title }
        pass(.titleRule) { w, r in
            let k = TitleRules.key(w.title)
            return !k.isEmpty && k == TitleRules.key(r.title)
        }
        pass(.order) { $0.order == $1.order }
        return out
    }
}

/// Where windows were, kept so they go back after their app relaunches or the Mac restarts. Saved as
/// `placements.json` in Polycarp's support folder, apart from the parking record (`frames.json`)
/// and the workspace layout (`layout.json`), which go by window number.
public struct PlacementBook: Codable, Equatable, Sendable {
    /// Every window at the last look, for the next launch of Polycarp.
    public var live: [WindowRecord] = []
    /// Windows of apps that quit (or did not come back yet after a restart), waiting for them.
    public var gone: [WindowRecord] = []
    /// Windows from displays that went away, waiting for the same display to come back.
    public var stash = DisplayStash()

    /// How long a quit app's windows wait for it.
    public static let keepFor: Double = 7 * 24 * 3600
    /// How young a process must be for its new windows to count as ones it restored. Later windows
    /// are new ones and join the workspace you are on.
    public static let restoreWithin: Double = 60

    public init(live: [WindowRecord] = [], gone: [WindowRecord] = [], stash: DisplayStash = DisplayStash()) {
        self.live = live; self.gone = gone; self.stash = stash
    }

    private enum CodingKeys: String, CodingKey { case live, gone, stash }

    /// A file written before a part was added still loads, with that part empty.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        live = try c.decodeIfPresent([WindowRecord].self, forKey: .live) ?? []
        gone = try c.decodeIfPresent([WindowRecord].self, forKey: .gone) ?? []
        stash = try c.decodeIfPresent(DisplayStash.self, forKey: .stash) ?? DisplayStash()
    }

    /// An app quit: its windows' last records wait for it, in place of older ones for the same app.
    public mutating func quit(bundle: String, records: [WindowRecord]) {
        guard !records.isEmpty else { return }
        gone.removeAll { $0.bundle == bundle }
        gone += records
    }

    /// Polycarp started. The last run's records join the waiting ones (the newer wins for each app),
    /// except those whose window is still here in the same process (`alive`, window to pid): those
    /// windows kept their number, so they need no matching. Old records are dropped.
    public mutating func started(alive: [WindowID: Int32], now: Double) {
        let fresh = live.filter { alive[$0.window] != $0.pid }
        let bundles = Set(live.map(\.bundle))
        gone = gone.filter { !bundles.contains($0.bundle) } + fresh
        live = []
        expire(now: now)
    }

    public mutating func expire(now: Double) {
        gone.removeAll { now - $0.at > Self.keepFor }
    }

    /// The records for these windows, taken out of `gone`. Only a process started after a record
    /// was written can have restored its window (`started`, process start in seconds since 1970).
    /// With `orderNeedsTitle`, creation order counts only for a process that also restored a window by
    /// its title: a relaunched app's new window (nothing in common) is new, not the old one back.
    public mutating func claim(_ windows: [LiveWindow], started: [WindowID: Double],
                               orderNeedsTitle: Bool = false) -> [(window: WindowID, record: WindowRecord, rule: WindowPairing.Rule)] {
        var taken: [(WindowID, WindowRecord, WindowPairing.Rule)] = []
        var used = Set<Int>()
        // Each process in start order, against the records written before it started and not taken yet.
        let byStart = Dictionary(grouping: windows.filter { started[$0.id] != nil }, by: { started[$0.id]! })
        for start in byStart.keys.sorted() {
            let open = gone.indices.filter { !used.contains($0) && gone[$0].at < start }
            let pairs = WindowPairing.pair(byStart[start]!, with: open.map { gone[$0] })
            let byTitle = pairs.contains { $0.rule != .order }
            for p in pairs where !orderNeedsTitle || byTitle || p.rule != .order {
                let i = open[p.record]
                used.insert(i)
                taken.append((p.window, gone[i], p.rule))
            }
        }
        gone = gone.enumerated().filter { !used.contains($0.offset) }.map(\.element)
        return taken
    }

    public static func load(from url: URL) -> PlacementBook {
        guard let data = try? Data(contentsOf: url),
              let book = try? JSONDecoder().decode(PlacementBook.self, from: data) else { return PlacementBook() }
        return book
    }

    public func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

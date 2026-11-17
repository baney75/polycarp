import CoreGraphics
import CryptoKit
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

/// Window titles never reach disk: each is kept as a keyed hash (HMAC-SHA256 under a key made once on this Mac), so
/// equal titles still match while the file names no window, private browser windows and mail subjects included.
public enum TitleHash {
    /// Empty for an empty title, which never matches anything.
    public static func of(_ title: String, key: Data) -> String {
        guard !title.isEmpty else { return "" }
        let mac = HMAC<SHA256>.authenticationCode(for: Data(title.utf8), using: SymmetricKey(data: key))
        return Data(mac).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// The key kept at `url` (mode 0600), made the first time.
    public static func key(at url: URL) -> Data {
        if let data = try? Data(contentsOf: url), data.count == 32 { return data }
        let made = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        PrivateFile.write(made, to: url)
        return made
    }
}

/// A file only you can read (mode 0600), written whole: it is never on disk with wider permissions, even for a moment.
public enum PrivateFile {
    public static func write(_ data: Data, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.appendingPathExtension("tmp")
        try? FileManager.default.removeItem(at: tmp)
        guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        if rename(tmp.path, url.path) != 0 { try? FileManager.default.removeItem(at: tmp) }
    }
}

/// A window as it can be known again once its window number and process are new: after its app
/// relaunches or the Mac restarts. It is known by its app's bundle id, its title (as `TitleHash`es) and its creation
/// order among its process's windows, and it keeps where it was: its workspace, its display and its frame on that
/// display.
public struct WindowRecord: Codable, Equatable, Sendable {
    public var bundle: String
    /// Keyed hashes of its title and of the title by `TitleRules`. The title itself is never kept.
    public var titleHash: String
    public var keyHash: String
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
                window: WindowID, pid: Int32, at: Double, key: Data = Data()) {
        self.bundle = bundle; self.order = order; self.workspace = workspace
        titleHash = TitleHash.of(title, key: key); keyHash = TitleHash.of(TitleRules.key(title), key: key)
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

    /// The same window on a new workspace or at a new frame (a move, a drag), without reading its title again.
    public func moved(workspace: Int, frame: CGRect?, displays: [DisplayArea], at: Double) -> WindowRecord {
        var r = WindowRecord(bundle: bundle, title: "", order: order, workspace: workspace, frame: frame ?? place(on: displays),
                             displays: displays, window: window, pid: pid, at: at)
        r.titleHash = titleHash; r.keyHash = keyHash
        return r
    }

    /// Where the window goes now, in global Accessibility coordinates. `showing` is the display showing its workspace
    /// now, and it wins: a window lands among its workspace's windows. On its own display when that one shows the
    /// workspace or nothing shows it, wherever that display now sits; otherwise carried onto `showing` (or the main
    /// display), in proportion and inside its usable area.
    public func place(on displays: [DisplayArea], showing: DisplayKey? = nil) -> CGRect? {
        guard let frame else { return nil }
        guard let key = display else { return frame }
        if showing == nil || showing == key, let d = displays.first(where: { $0.key == key }) {
            return frame.offsetBy(dx: d.frame.minX, dy: d.frame.minY)
        }
        guard let to = displays.first(where: { $0.key == showing }) ?? displays.first else { return nil }
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

/// A window on screen now, as the matcher sees it. Its title is kept only as the hashes records hold.
public struct LiveWindow: Equatable, Sendable {
    public var id: WindowID
    public var bundle: String
    public var titleHash: String
    public var keyHash: String
    /// Creation order among its process's windows, oldest first.
    public var order: Int
    public var pid: Int32
    public init(id: WindowID, bundle: String, title: String, order: Int, pid: Int32 = 0, key: Data = Data()) {
        self.id = id; self.bundle = bundle; self.order = order; self.pid = pid
        titleHash = TitleHash.of(title, key: key); keyHash = TitleHash.of(TitleRules.key(title), key: key)
    }
}

/// Pairs windows on screen with records of windows from before. Same bundle id only, and each
/// record goes to one window. Three passes, strongest first: the same title; the same title by
/// `TitleRules`; then the same creation order. Among several records that fit, the one closest in
/// creation order wins. A window with an empty title (one an app hasn't titled yet) pairs with nothing.
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
        let windows = live.filter { !$0.titleHash.isEmpty }.sorted { ($0.bundle, $0.order, $0.id) < ($1.bundle, $1.order, $1.id) }
        // Each window looks only at its own app's records: hundreds of windows pair in a few milliseconds.
        let byBundle = Dictionary(grouping: records.indices, by: { records[$0].bundle })
        func pass(_ rule: Rule, _ fits: (LiveWindow, WindowRecord) -> Bool) {
            for w in windows where !done.contains(w.id) {
                var best: Int?
                for i in byBundle[w.bundle] ?? [] where !used.contains(i) && fits(w, records[i]) {
                    if let b = best, abs(records[b].order - w.order) <= abs(records[i].order - w.order) { continue }
                    best = i
                }
                guard let i = best else { continue }
                used.insert(i); done.insert(w.id)
                out.append(Pair(window: w.id, record: i, rule: rule))
            }
        }
        pass(.title) { $0.titleHash == $1.titleHash }
        pass(.titleRule) { !$0.keyHash.isEmpty && $0.keyHash == $1.keyHash }
        pass(.order) { $0.order == $1.order }
        return out
    }
}

/// Where windows were, kept so they go back after their app relaunches or the Mac restarts. Saved as
/// `placements.json` (mode 0600) in Polycarp's support folder, apart from the parking record (`frames.json`)
/// and the workspace layout (`layout.json`), which go by window number.
public struct PlacementBook: Codable, Equatable, Sendable {
    /// Every window at the last look, for the next launch of Polycarp.
    public var live: [WindowRecord] = []
    /// Windows of apps that quit (or did not come back yet after a restart), waiting for them.
    public var gone: [WindowRecord] = []
    /// Windows each young process got back by title so far, by process start: evidence it is restoring windows. Not saved.
    private var byTitle: [Double: Int] = [:]

    /// How long a quit app's windows wait for it.
    public static let keepFor: Double = 7 * 24 * 3600
    /// How young a process must be for its new windows to count as ones it restored. Later windows
    /// are new ones and join the workspace you are on.
    public static let restoreWithin: Double = 60
    /// How many of a relaunched app's windows must come back by title before any is taken off the workspace you are on.
    public static let evidence = 2

    private enum CodingKeys: String, CodingKey { case live, gone }

    public init(live: [WindowRecord] = [], gone: [WindowRecord] = []) {
        self.live = live; self.gone = gone
    }

    /// How things stand as windows are claimed.
    public struct Scene: Sendable {
        /// Each workspace in sight and the display showing it.
        public var inSight: [Int: DisplayKey]
        public var displays: [DisplayArea]
        public var agentWorkspace: Int?
        /// Processes an agent started or a launch claimed: their windows are theirs.
        public var skip: Set<Int32>
        /// The focused window of the app in front, when it is one of these.
        public var focused: WindowID?
        public init(inSight: [Int: DisplayKey], displays: [DisplayArea], agentWorkspace: Int? = nil,
                    skip: Set<Int32> = [], focused: WindowID? = nil) {
            self.inSight = inSight; self.displays = displays; self.agentWorkspace = agentWorkspace
            self.skip = skip; self.focused = focused
        }
    }

    /// A window going back: to `workspace`, at `frame`. `now`: its workspace is in sight, so it moves now; otherwise
    /// `frame` is its parked record, where it comes back when you go there.
    public struct Placement: Equatable, Sendable {
        public var window: WindowID
        public var workspace: Int
        public var frame: CGRect?
        public var now: Bool
        public var rule: WindowPairing.Rule
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
        byTitle = byTitle.filter { now - $0.key < 2 * Self.restoreWithin }
    }

    /// A new look by process. A process still running that shows no window now keeps its last records (⌘Q closes an
    /// app's windows before it quits), so its quit still hands them over.
    public static func carry(_ now: [Int32: [WindowRecord]], previous: [Int32: [WindowRecord]],
                             alive: (Int32) -> Bool) -> [Int32: [WindowRecord]] {
        var out = now
        for (pid, records) in previous where now[pid] == nil && alive(pid) { out[pid] = records }
        return out
    }

    /// Where these windows go, their records taken out of `gone`. Only a process started after a record was written
    /// can have restored its window (`started`, process start in seconds since 1970). The agent workspace and the
    /// processes in `scene.skip` are never touched.
    ///
    /// `relaunch` (an app started again while Polycarp runs, so you may have just opened it where you are): creation
    /// order counts only for a process that got a window back by title, in this look or an earlier one, and a window
    /// leaves the workspaces in sight only once its process got back `evidence` windows by title, and never the app in
    /// front's focused window. A fresh open of an app makes one window, often with the same fixed title as before
    /// (Messages, Calculator, a New Tab), and it stays where you opened it; an app restoring its windows brings back
    /// several. A record matched to a window that stays is used up all the same.
    public mutating func claim(_ windows: [LiveWindow], started: [WindowID: Double], relaunch: Bool,
                               scene: Scene) -> [Placement] {
        var out: [Placement] = [], used = Set<Int>()
        // Each process in start order, against the records written before it started and not taken yet.
        let mine = windows.filter { started[$0.id] != nil && !scene.skip.contains($0.pid) }
        let byStart = Dictionary(grouping: mine, by: { started[$0.id]! })
        for start in byStart.keys.sorted() {
            let open = gone.indices.filter { !used.contains($0) && gone[$0].at < start }
            let pairs = WindowPairing.pair(byStart[start]!, with: open.map { gone[$0] })
            let titled = byTitle[start, default: 0] + pairs.filter { $0.rule != .order }.count
            if relaunch { byTitle[start] = titled }
            for p in pairs where !relaunch || p.rule != .order || titled > 0 {
                let i = open[p.record], r = gone[i]
                used.insert(i)
                guard Workspaces.range.contains(r.workspace), r.workspace != scene.agentWorkspace else { continue }
                let inSight = scene.inSight[r.workspace] != nil
                if relaunch, !inSight, titled < Self.evidence || p.window == scene.focused { continue }
                out.append(Placement(window: p.window, workspace: r.workspace, frame: r.place(on: scene.displays, showing: scene.inSight[r.workspace]),
                                     now: inSight, rule: p.rule))
            }
        }
        gone = gone.enumerated().filter { !used.contains($0.offset) }.map(\.element)
        return out
    }

    public static func load(from url: URL) -> PlacementBook {
        guard let data = try? Data(contentsOf: url),
              let book = try? JSONDecoder().decode(PlacementBook.self, from: data) else { return PlacementBook() }
        return book
    }

    public func save(to url: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        PrivateFile.write(data, to: url)
    }
}

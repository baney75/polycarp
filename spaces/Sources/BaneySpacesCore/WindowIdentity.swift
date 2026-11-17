import CoreGraphics
import CryptoKit
import Foundation

/// A display as a window record needs it: its UUID and its whole and usable areas, in
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

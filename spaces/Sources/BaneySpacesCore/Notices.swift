import Foundation

/// One element of Notification Center as Accessibility reads it. Nothing here calls Accessibility, so tests can hold a tree.
public struct NoticeNode: Equatable, Sendable {
    public var subrole, identifier, text, label, stacking: String
    public var actions: [String]
    public var children: [NoticeNode]

    public init(subrole: String = "", identifier: String = "", text: String = "", label: String = "", stacking: String = "",
                actions: [String] = [], children: [NoticeNode] = []) {
        self.subrole = subrole; self.identifier = identifier; self.text = text; self.label = label; self.stacking = stacking
        self.actions = actions; self.children = children
    }
}

/// A banner or alert on screen, read from its element. Its words come from other people: shown, never acted on.
public struct NoticeBanner: Equatable, Sendable {
    public var app: String
    /// The bundle id, when macOS gives one.
    public var bundle: String?
    public var title, subtitle, body: String
    /// The child indexes from the windows down to its element, and the action that closes it, for pressing.
    public var path: [Int]
    public var close: String?
    /// An alert stays until you answer it, and can count down in place.
    public var alert = false
    /// Several as one: pressing it spreads them out, and it opens none.
    public var stack = false

    /// What makes two reads the same notification: who sent it and every word of it.
    var same: [String] { [bundle ?? app, title, subtitle, body] }
    public func matches(_ other: NoticeBanner) -> Bool { same == other.same }
    /// Whether this is `old` a tick later, in its place ("in 10 minutes", "in 9 minutes"): one small number in its body went
    /// down, and nothing else changed but a plural. "Your code is 987654" is another notification.
    public func ticks(from old: NoticeBanner, moved: Bool = false) -> Bool {
        guard alert, old.alert, moved || path == old.path, same.dropLast() == old.same.dropLast() else { return false }
        let a = Self.counted(old.body), b = Self.counted(body)
        guard a.text == b.text, a.numbers.count == b.numbers.count else { return false }
        let changed = zip(a.numbers, b.numbers).filter { $0 != $1 }
        return changed.count == 1 && changed[0].1 < changed[0].0 && changed[0].0 <= 120
    }
    /// The numbers in it, and the words around them without a plural's s.
    private static func counted(_ s: String) -> (numbers: [Int], text: [String]) {
        var numbers: [Int] = [], text = "", inside = false
        for c in s {
            guard let d = c.wholeNumberValue, d < 10 else { text.append(c); inside = false; continue }
            if inside { numbers[numbers.count - 1] = min(1_000_000, numbers[numbers.count - 1] * 10 + d) } else { numbers.append(d); text += "#" }
            inside = true
        }
        return (numbers, text.split(separator: " ").map { $0.hasSuffix("s") ? String($0.dropLast()) : String($0) })
    }
}

public enum NoticeReader {
    public static let maxDepth = 14, maxNodes = 800, maxText = 400
    static let subroles: Set = ["AXNotificationCenterBanner", "AXNotificationCenterBannerStack",
                                "AXNotificationCenterAlert", "AXNotificationCenterAlertStack"]

    public struct Reading: Equatable, Sendable {
        /// Notification Center itself is open, with its history, or the tree was cut at a limit, where that can't be told:
        /// either way what it lists is not new.
        public var centerOpen: Bool
        public var banners: [NoticeBanner]
    }

    /// Every banner and alert under Notification Center's windows, first to last. A banner's own children are its words,
    /// so nothing under one is a second banner. Its process also draws the desktop's widgets, in windows that hold no
    /// banner: only a window with both, or with a header over its notifications, is Notification Center open.
    /// `close` is what macOS calls closing one, in English and in this Mac's language.
    public static func read(_ windows: [NoticeNode], close: Set<String> = ["Close"]) -> Reading {
        var out: [NoticeBanner] = [], open = false
        for (i, w) in windows.enumerated() {
            // Each window has its own limit, so one full of widgets doesn't hide the banners in the next.
            let before = out.count
            var marked = false, left = maxNodes
            func walk(_ n: NoticeNode, _ path: [Int]) {
                guard left > 0 else { return }
                left -= 1
                if n.identifier == "header" { marked = true }
                if isWidget(n) { marked = true; return }
                guard path.count <= maxDepth else { return }
                if subroles.contains(n.subrole) {
                    if let b = banner(n, path, close, &left) { out.append(b) }
                    return
                }
                for (j, c) in n.children.enumerated() { walk(c, path + [j]) }
            }
            walk(w, [i])
            if out.count > before ? marked || left <= 0 : !marked && left <= 0 { open = true }
        }
        return Reading(centerOpen: open, banners: out)
    }

    /// The banners of one read that `wanted` are: every copy of each with `copies`, else the first.
    public static func find(_ wanted: [NoticeBanner], in r: Reading, copies: Bool) -> [NoticeBanner] {
        var out: [NoticeBanner] = []
        for w in wanted {
            var here = r.banners.filter { $0.matches(w) }
            if here.isEmpty { here = r.banners.filter { $0.ticks(from: w, moved: true) } }
            for b in copies ? here : Array(here.prefix(1)) where !out.contains(where: { $0.path == b.path }) { out.append(b) }
        }
        return out
    }

    /// The name of a notification that doesn't say whose it is.
    public static let unknown = "Notification"

    /// A widget, under which nothing is read.
    public static func isWidget(_ n: NoticeNode) -> Bool { n.identifier.hasPrefix("widget") }

    private static func banner(_ n: NoticeNode, _ path: [Int], _ names: Set<String>, _ left: inout Int) -> NoticeBanner? {
        var words: [String: String] = [:]
        func gather(_ e: NoticeNode, _ depth: Int) {
            guard depth <= maxDepth, left > 0 else { return }
            left -= 1
            if ["title", "subtitle", "body"].contains(e.identifier), words[e.identifier] == nil {
                let t = clean(e.text.isEmpty ? e.label : e.text)
                if !t.isEmpty { words[e.identifier] = t }
            }
            e.children.forEach { gather($0, depth + 1) }
        }
        n.children.forEach { gather($0, path.count + 1) }
        let label = clean(n.label, most: maxText * 4)
        var title = words["title"] ?? "", body = words["body"] ?? "", app = ""
        if let first = words["title"] ?? words["subtitle"] ?? words["body"] {
            if let r = label.range(of: ", " + first) { app = String(label[..<r.lowerBound]) }
        } else {
            // No named parts: the label is "App, Title, Body".
            let parts = label.components(separatedBy: ", ")
            app = parts.first ?? ""
            if parts.count > 1 { title = clean(parts[1]) }
            if parts.count > 2 { body = clean(parts[2...].joined(separator: ", ")) }
        }
        let bundle = bundle(n.stacking)
        app = clean(app, most: 80)
        if app.isEmpty { app = bundle ?? unknown }
        guard !title.isEmpty || !body.isEmpty else { return nil }
        return NoticeBanner(app: app, bundle: bundle, title: title, subtitle: words["subtitle"] ?? "", body: body, path: path,
                            // A stack has no Close, only Clear All, which takes older ones too: it is never closed from here.
                            close: n.actions.first { names.contains(actionName($0)) }, alert: n.subrole == "AXNotificationCenterAlert", stack: n.subrole.hasSuffix("Stack"))
    }

    /// `bundleIdentifier=com.apple.mail,threadIdentifier=...` gives `com.apple.mail`.
    static func bundle(_ stacking: String) -> String? {
        guard let r = stacking.range(of: "bundleIdentifier=") else { return nil }
        let id = stacking[r.upperBound...].unicodeScalars.prefix { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-" || $0 == "_") }
        return id.isEmpty || id.count > 200 ? nil : String(String.UnicodeScalarView(id))
    }

    /// The name in a custom action, which reads `Name:Close` and then lines for its target and selector.
    public static func actionName(_ action: String) -> String {
        guard action.hasPrefix("Name:") else { return action }
        return String(action.dropFirst(5).prefix { !$0.isNewline })
    }

    /// Text as it may be shown: on one line, with no control characters and none that turn the reading order around.
    static func clean(_ s: String, most: Int = maxText) -> String {
        let turns: Set<Unicode.Scalar> = ["\u{200E}", "\u{200F}", "\u{061C}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}"]
        var text = String.UnicodeScalarView()
        var kept = 0
        for u in s.unicodeScalars.prefix(most * 4) {
            if kept == most { break }
            if CharacterSet.newlines.contains(u) || u == "\t" { text.append(" "); kept += 1; continue }
            // The joiners emoji and some scripts need are format characters, and stay.
            if turns.contains(u) || CharacterSet.controlCharacters.contains(u) && u != "\u{200D}" && u != "\u{200C}" { continue }
            text.append(u)
            kept += 1
        }
        return String(text).trimmingCharacters(in: .whitespaces)
    }
}

/// The notifications Polycarp has seen since it started, newest first. Kept in memory only and never written or logged.
public struct NoticeShelf: Equatable, Sendable {
    public static let most = 200

    public struct Notice: Equatable, Sendable, Identifiable {
        public var id: Int
        public var banner: NoticeBanner
        public var at: Date
        public var seen: Bool
        /// On screen as of the last read, at `banner.path`.
        public var live: Bool
        public var key: String { banner.bundle ?? banner.app }
        /// Whether it says whose it is: quieting one that doesn't would quiet every app like it.
        public var named: Bool { key != NoticeReader.unknown }
    }

    public struct Group: Equatable, Sendable, Identifiable {
        public var id: String
        public var app: String
        public var notices: [Notice]
    }

    public private(set) var notices: [Notice] = []
    /// Apps whose banners Polycarp closes and files without counting, by `Notice.key`.
    public var quiet: Set<String> = []
    private var next = 1
    /// What the last read saw, and how many of each: apart from `notices`, so clearing one doesn't make it new again.
    private var onScreen: [[String]: Int] = [:]
    /// The alerts among them.
    private var alerts: [NoticeBanner] = []
    /// Whether the last read saw anything up, on the shelf or not.
    public var watching: Bool { !onScreen.isEmpty }

    public init() {}

    /// Takes one read of the screen. Gives back the notices that just came, and leaves each gone banner on the shelf.
    /// A notification sent again word for word moves to the top instead of being listed twice. One dismissed or cleared
    /// here while its banner is still up stays gone, and what was up before Notification Center opened is not new after.
    @discardableResult
    public mutating func take(_ r: NoticeReader.Reading, at now: Date) -> [Notice] {
        var up: [[String]: Int] = [:]
        for b in r.banners { up[b.same, default: 0] += 1 }
        // Ticked against what the last read saw, not the shelf: a countdown dismissed here stays gone as it ticks.
        for b in r.banners where !alerts.contains(where: { $0.same == b.same }) {
            guard let k = alerts.firstIndex(where: { up[$0.same] == nil && b.ticks(from: $0, moved: r.centerOpen) }) else { continue }
            let old = alerts[k], was = onScreen.removeValue(forKey: old.same) ?? 1
            alerts[k] = b
            // Notification Center's own list is not where its banner is.
            if r.centerOpen { alerts[k].path = old.path }
            onScreen[b.same] = max(was, onScreen[b.same, default: 0])
            guard let i = notices.firstIndex(where: { $0.banner.same == old.same }) else { continue }
            notices[i].banner = b
            let id = notices[i].id
            notices.removeAll { $0.banner.same == b.same && $0.id != id }
        }
        if !r.centerOpen { alerts = r.banners.filter(\.alert) }
        for i in notices.indices { notices[i].live = false }
        if r.centerOpen {
            see()
            onScreen.merge(up) { max($0, $1) }
            return []
        }
        var came: [Notice] = [], done: Set<[String]> = []
        for b in r.banners.reversed() where done.insert(b.same).inserted {
            if up[b.same, default: 0] <= onScreen[b.same, default: 0] {
                guard let i = notices.firstIndex(where: { $0.banner.same == b.same }) else { continue }
                notices[i].banner = b
                notices[i].live = true
                continue
            }
            notices.removeAll { $0.banner.same == b.same }
            let n = Notice(id: next, banner: b, at: now, seen: quiet.contains(b.bundle ?? b.app), live: true)
            next += 1
            notices.insert(n, at: 0)
            came.append(n)
        }
        onScreen = up
        if notices.count > Self.most { notices.removeLast(notices.count - Self.most) }
        return came
    }

    public var unread: Int { notices.filter { !$0.seen }.count }

    /// What the bar's count reads: nothing for none.
    public var count: String { unread == 0 ? "" : unread > 99 ? "99+" : String(unread) }

    /// By app, the app with the newest first.
    public var groups: [Group] {
        var out: [Group] = []
        for n in notices {
            if let i = out.firstIndex(where: { $0.id == n.key }) { out[i].notices.append(n) } else { out.append(Group(id: n.key, app: n.banner.app, notices: [n])) }
        }
        return out
    }

    public mutating func see() { for i in notices.indices { notices[i].seen = true } }
    public mutating func dismiss(_ id: Int) { notices.removeAll { $0.id == id } }
    public mutating func clear(key: String) { notices.removeAll { $0.key == key } }
    public mutating func clearAll() { notices.removeAll() }
}

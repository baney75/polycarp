import AppKit

/// Clipboard history in the launcher. It has no rows in the main search (what you copied stays in its
/// own menu); opening the Clipboard menu the first time turns history on.
public final class ClipboardProvider: LauncherMenuProvider {
    public let name = "clipboard"
    public let menu = "clipboard"
    let store: ClipboardStore
    private let now: () -> Date
    private var appNames: [String: String] = [:]

    public init(store: ClipboardStore, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.now = now
    }

    public func results(for query: String) -> [LauncherResult] { [] }

    public func opened() { store.enable() }

    public func listing(_ query: String) -> [LauncherResult] {
        let found = store.search(query)
        var rows = found.map { e -> LauncherResult in
            let oneLine = e.text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ⏎ ")
            var about = [Self.age(e.copiedAt, now: now())]
            if let app = e.app.flatMap(appName) { about.append(app) }
            if e.text.count > 80 { about.append("\(e.text.count) characters") }
            return LauncherResult(id: "clip:\(e.copiedAt.timeIntervalSince1970):\(e.text.hashValue)", section: "Copied",
                                  title: oneLine.count > 80 ? String(oneLine.prefix(80)) + "…" : oneLine,
                                  subtitle: about.joined(separator: " · "), symbol: "doc.on.clipboard", badge: "Copy",
                                  action: .copy(e.text))
        }
        let hours = store.retentionHours
        if found.isEmpty, query.trimmingCharacters(in: .whitespaces).isEmpty {
            rows.append(LauncherResult(id: "clip-empty", section: "Copied", title: "Nothing copied yet",
                                       subtitle: "Text you copy from now on shows here for \(ClipboardRetention.label(hours)). Passwords never do.",
                                       symbol: "doc.on.clipboard", action: .none))
        }
        let next = ClipboardRetention.next(after: hours)
        let commands = [
            LauncherResult(id: "clip-keep", section: "Clipboard History", title: "Keep for \(ClipboardRetention.label(hours))",
                           subtitle: "Return changes it to \(ClipboardRetention.label(next))", symbol: "clock",
                           action: .command(provider: name, id: "keep")),
            LauncherResult(id: "clip-clear", section: "Clipboard History", title: "Clear Clipboard History",
                           subtitle: "Deletes everything kept so far", symbol: "trash",
                           confirm: "Clear clipboard history?", action: .command(provider: name, id: "clear")),
            LauncherResult(id: "clip-off", section: "Clipboard History", title: "Turn Off Clipboard History",
                           subtitle: "Stops keeping what you copy and deletes what was kept; opening this menu turns it on again",
                           symbol: "pause.circle", confirm: "Turn off clipboard history and delete it?",
                           action: .command(provider: name, id: "off")),
        ]
        let q = query.trimmingCharacters(in: .whitespaces)
        return rows + commands.filter { q.isEmpty || Fuzzy.score(q, $0.title) != nil }
    }

    public func perform(_ command: String) -> LauncherAction? {
        switch command {
        case "keep": store.setRetention(hours: ClipboardRetention.next(after: store.retentionHours))
        case "clear": store.clear()
        case "off":
            store.disable()
            return .close
        default: break
        }
        return nil
    }

    private func appName(_ bundleID: String) -> String? {
        if let n = appNames[bundleID] { return n.isEmpty ? nil : n }
        let n = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
            .map { FileManager.default.displayName(atPath: $0.path).replacingOccurrences(of: ".app", with: "") } ?? ""
        appNames[bundleID] = n
        return n.isEmpty ? nil : n
    }

    static func age(_ d: Date, now: Date) -> String {
        let s = Int(now.timeIntervalSince(d))
        if s < 60 { return "Just now" }
        if s < 3600 { return "\(s / 60) min ago" }
        if s < 86400 { return "\(s / 3600) h ago" }
        return "\(s / 86400) d ago"
    }
}

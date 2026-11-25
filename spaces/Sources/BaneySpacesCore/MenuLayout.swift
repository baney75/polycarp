import Foundation

/// Which workspaces the menu bar menu lists, and how. Nine rows, most of them empty, buried the
/// rest of the menu (Donovan, 2026-10-14), so it lists the workspaces in use, the one you're on,
/// and one empty workspace to start fresh on. ⌘1 to ⌘9 still reach every one of them. Each row leads with its
/// number alone ("1  Helium", "3  Empty"): the word "Workspace" on every row was clutter.
public enum MenuLayout {
    public struct Row: Equatable, Sendable {
        public let workspace: Int
        public let title: String
        /// Every app on it, for the tooltip, when the title had to shorten the list.
        public let fullList: String?
        public let isCurrent: Bool
    }

    /// `apps` is each workspace's app names in order; a workspace missing from it is empty and reads "5  Empty".
    public static func rows(current: Int, apps: [Int: [String]], range: ClosedRange<Int> = 1...9) -> [Row] {
        var out: [Row] = []
        for n in range {
            let names = apps[n] ?? []
            guard !names.isEmpty || n == current else { continue }
            let short = summary(names)
            out.append(Row(workspace: n,
                           title: "\(n)  \(names.isEmpty ? "Empty" : short)",
                           fullList: names.count > shownApps ? names.joined(separator: ", ") : nil,
                           isCurrent: n == current))
        }
        if let empty = range.first(where: { (apps[$0] ?? []).isEmpty && $0 != current }) {
            out.append(Row(workspace: empty, title: "\(empty)  Empty", fullList: nil, isCurrent: false))
        }
        return out
    }

    public static let shownApps = 3

    /// "Helium, Ghostty, Obsidian +2": a long list stays one short line.
    public static func summary(_ names: [String]) -> String {
        guard names.count > shownApps else { return names.joined(separator: ", ") }
        return names.prefix(shownApps).joined(separator: ", ") + " +\(names.count - shownApps)"
    }
}

/// A release waiting to be installed, or installing, as the menu bar menu and Settings word it.
public struct UpdateNotice: Equatable, Sendable {
    public let name: String
    public let installing: Bool

    public init(name: String, installing: Bool) {
        self.name = name
        self.installing = installing
    }

    /// "Update to Polycarp 0.4.0 (2026-11-18)…"; "Updating to …" while it installs.
    public var menuTitle: String { installing ? "Updating to \(name)…" : "Update to \(name)…" }

    /// A sentence of its own: "Polycarp 0.4.0 (2026-11-18) is available."
    public var sentence: String { "\(name) is available." }
}

/// The menu bar menu's one update row, always there just above Settings…: a check once a day never showed one, so a
/// check is a click away. "Check for Updates…" with nothing known, "Checking for Updates…" (disabled) while a check
/// runs, then the release on offer or installing (`UpdateNotice`).
public enum MenuUpdate: Equatable, Sendable {
    case check, checking
    case notice(UpdateNotice)

    /// What the updater knows: a release on offer or installing wins over a check in flight.
    public init(notice: UpdateNotice?, checking: Bool) {
        if let notice { self = .notice(notice) } else { self = checking ? .checking : .check }
    }

    public var title: String {
        switch self {
        case .check: return "Check for Updates…"
        case .checking: return "Checking for Updates…"
        case .notice(let notice): return notice.menuTitle
        }
    }

    /// False while a check runs or an update installs: there is nothing to click.
    public var enabled: Bool {
        switch self {
        case .check: return true
        case .checking: return false
        case .notice(let notice): return !notice.installing
        }
    }

    /// A release waiting to be installed: the row is bold and offers it.
    public var offersRelease: Bool {
        if case .notice(let notice) = self { return !notice.installing }
        return false
    }
}

/// The menu bar menu, as a list of what it holds. The app builds exactly these and nothing else, so
/// a test can read what a person would see (Donovan, 2026-10-31: five kinds of rows). It stays short (2026-11-21,
/// "minimally cluttered"), and it never asks what you are doing (2026-11-22): switches live in Settings. A row for finished agents is there only while there is something to act on; the update row is always
/// there.
public enum MenuEntry: Equatable, Sendable {
    case workspace(MenuLayout.Row)
    case showAll, find, settings, quit
    /// One of the Baney Extended System's rooms; `waiting` is the Inbox's count (nil for the other four). Opens the
    /// room in Finder.
    case room(Room, waiting: Int?)
    /// "N agents finished while you were away", a submenu listing them.
    case finished(count: Int)
    case update(MenuUpdate)
    case separator
}

extension MenuLayout {
    /// The workspaces first, then the two finders, and last the finished agents, the `update` row, Settings and Quit
    /// together.
    public static func entries(rows: [Row], rooms inbox: Int? = nil, finished: Int, update: MenuUpdate) -> [MenuEntry] {
        var out = rows.map(MenuEntry.workspace)
        out += [.separator, .showAll, .find, .separator]
        // The rooms, when a BES root is set up (`inbox` is its Inbox count): five rows that open, never a question.
        if let inbox { out += Room.allCases.map { .room($0, waiting: $0 == .inbox ? inbox : nil) } + [.separator] }
        if finished > 0 { out.append(.finished(count: finished)) }
        out += [.update(update), .settings, .quit]
        return out
    }

    /// "Inbox (3)", or a room's name. An empty Inbox shows no count.
    public static func roomTitle(_ room: Room, waiting: Int?) -> String {
        guard let waiting, waiting > 0 else { return room.name }
        return "\(room.name) (\(waiting))"
    }

    /// "1 Agent Finished While You Were Away" / "3 Agents Finished While You Were Away".
    public static func finishedTitle(_ count: Int) -> String {
        "\(count) \(count == 1 ? "Agent Finished" : "Agents Finished") While You Were Away"
    }
}

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

    /// `apps` is each workspace's app names in order; a workspace missing from it is empty. A workspace with a purpose
    /// is listed by it ("2  Gannon letter"), even with no windows, since you named it for something; its apps go to
    /// the tooltip. One with neither reads "5  Empty".
    public static func rows(current: Int, apps: [Int: [String]], purposes: [Int: String] = [:], range: ClosedRange<Int> = 1...9) -> [Row] {
        var out: [Row] = []
        for n in range {
            let names = apps[n] ?? []
            let purpose = purposes[n].flatMap { $0.isEmpty ? nil : $0 }
            guard !names.isEmpty || n == current || purpose != nil else { continue }
            if let purpose {
                out.append(Row(workspace: n, title: "\(n)  \(purpose)", fullList: names.isEmpty ? nil : names.joined(separator: ", "),
                               isCurrent: n == current))
                continue
            }
            let short = summary(names)
            out.append(Row(workspace: n,
                           title: "\(n)  \(names.isEmpty ? "Empty" : short)",
                           fullList: names.count > shownApps ? names.joined(separator: ", ") : nil,
                           isCurrent: n == current))
        }
        if let empty = range.first(where: { (apps[$0] ?? []).isEmpty && $0 != current && (purposes[$0] ?? "").isEmpty }) {
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
    public let isNightly: Bool
    public let installing: Bool

    public init(name: String, isNightly: Bool, installing: Bool) {
        self.name = name
        self.isNightly = isNightly
        self.installing = installing
    }

    /// "Update to BaneySpaces 0.3.1…" or "Update to the Nightly Build…"; "Updating to …" while it installs.
    public var menuTitle: String {
        installing ? "Updating to \(isNightly ? "the Nightly Build" : name)…" : "Update to \(isNightly ? "the Nightly Build" : name)…"
    }

    /// A sentence of its own: "BaneySpaces 0.3.1 is available." / "The nightly build is available."
    public var sentence: String {
        isNightly ? "The nightly build is available." : "\(name) is available."
    }
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

/// The head of the menu bar menu: what you are doing now. "Gannon letter" over "Workspace 2  ·  since 8:40"; a
/// workspace with no purpose reads "Workspace 2" over "No purpose named  ·  since 8:40".
public struct MenuNow: Equatable, Sendable {
    public let title: String
    public let detail: String

    public init(title: String, detail: String) { self.title = title; self.detail = detail }

    /// `since` is when you came to this workspace, if known. The time has no AM or PM; `twentyFourHour` follows the
    /// Mac's clock setting (`usesTwentyFourHourClock`).
    public static func make(workspace n: Int, purpose: String?, since: Date?, twentyFourHour: Bool = usesTwentyFourHourClock,
                            calendar: Calendar = .current) -> MenuNow {
        let named = purpose.flatMap { $0.isEmpty ? nil : $0 }
        var detail = named == nil ? "No purpose named" : "Workspace \(n)"
        if let since {
            let c = calendar.dateComponents([.hour, .minute], from: since)
            let h = c.hour ?? 0
            let shown = twentyFourHour ? h : (h % 12 == 0 ? 12 : h % 12)
            detail += "  ·  since " + String(format: "%d:%02d", shown, c.minute ?? 0)
        }
        return MenuNow(title: named ?? "Workspace \(n)", detail: detail)
    }

    /// Whether the Mac shows a 24-hour clock: its short time format has an hour from 0 to 23.
    public static var usesTwentyFourHourClock: Bool {
        let f = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? ""
        return f.contains("H") || f.contains("k")
    }
}

/// The menu bar menu, as a list of what it holds. The app builds exactly these and nothing else, so
/// a test can read what a person would see (Donovan, 2026-10-31: five kinds of rows). It stays short (2026-11-21,
/// "minimally cluttered"): the head names the hour itself, the one thing is one row with the rest under it, and the
/// dock's switch lives in the dock and Settings. A row for finished agents is there only while there is something
/// to act on; the update row is always there.
public enum MenuEntry: Equatable, Sendable {
    /// What you are doing now, at the top ("Now first", Donovan's pick, 2026-11-21). Clicking it names the hour.
    case now(MenuNow)
    /// "Set the One Thing…": no one thing yet.
    case setOneThing
    /// The one thing itself, with a submenu: change it, its timer, and in the evening the examen.
    case oneThing(MenuOneThing)
    /// "Stop the timer (12 min left)": a timer running with no one thing set, the one case of two rhythm rows.
    case timer(MenuTimer)
    /// "Evening Examen…", once the evening has started (`evening`), when there is no one thing to hold it.
    case examen
    case workspace(MenuLayout.Row)
    case showAll, find, settings, quit
    /// "N agents finished while you were away", a submenu listing them.
    case finished(count: Int)
    case update(MenuUpdate)
    case separator
}

/// The menu's one-thing timer: start one of `minutes` (`alarm.timerMinutes`), or stop the one running with `left`
/// seconds to go.
public struct MenuTimer: Equatable, Sendable {
    public let minutes: Int
    public let left: TimeInterval?

    public init(minutes: Int, left: TimeInterval?) { self.minutes = minutes; self.left = left }

    public var running: Bool { left != nil }

    /// "Start a timer (25 min)" or "Stop the timer (12 min left)".
    public var title: String {
        guard let left else { return "Start a timer (\(minutes) min)" }
        return "Stop the timer (\(BarText.timer(remaining: left)) left)"
    }
}

/// The one thing as the menu's rhythm row: its own words as the title, and what you do with it in a submenu.
public struct MenuOneThing: Equatable, Sendable {
    public enum Item: Equatable, Sendable {
        case change
        case timer(MenuTimer)
        case examen

        public var title: String {
            switch self {
            case .change: return "Change the One Thing…"
            case .timer(let timer): return timer.title
            case .examen: return "Evening Examen…"
            }
        }
    }

    public let text: String
    public let timer: MenuTimer?
    public let examen: Bool

    public init(text: String, timer: MenuTimer?, examen: Bool) { self.text = text; self.timer = timer; self.examen = examen }

    /// "Gannon letter", or "Gannon letter  ·  12 min left" while its timer runs.
    public var title: String {
        guard let left = timer?.left else { return text }
        return "\(text)  ·  \(BarText.timer(remaining: left)) left"
    }

    /// The submenu: change it, then the timer, then in the evening the examen, last.
    public var items: [Item] { [.change] + (timer.map { [.timer($0)] } ?? []) + (examen ? [.examen] : []) }
}

extension MenuLayout {
    /// With `now`, the menu opens on what you are doing and one rhythm row: "Set the One Thing…", or the `oneThing`
    /// itself with its `timer` and (in the `evening`) the examen under it. With no one thing, a running timer and the
    /// examen get rows of their own. Then the workspaces, the two finders, and last the finished agents, the
    /// `update` row, Settings and Quit together.
    public static func entries(now: MenuNow? = nil, oneThing: String? = nil, timer: MenuTimer? = nil, evening: Bool = false, rows: [Row],
                               finished: Int, update: MenuUpdate) -> [MenuEntry] {
        var out: [MenuEntry] = []
        if let now {
            out.append(.now(now))
            if let text = oneThing.flatMap({ $0.isEmpty ? nil : $0 }) {
                out.append(.oneThing(MenuOneThing(text: text, timer: timer, examen: evening)))
            } else {
                out.append(.setOneThing)
                if let timer, timer.running { out.append(.timer(timer)) }
                if evening { out.append(.examen) }
            }
            out.append(.separator)
        }
        out += rows.map(MenuEntry.workspace)
        out += [.separator, .showAll, .find, .separator]
        if finished > 0 { out.append(.finished(count: finished)) }
        out += [.update(update), .settings, .quit]
        return out
    }

    /// "1 Agent Finished While You Were Away" / "3 Agents Finished While You Were Away".
    public static func finishedTitle(_ count: Int) -> String {
        "\(count) \(count == 1 ? "Agent Finished" : "Agents Finished") While You Were Away"
    }
}

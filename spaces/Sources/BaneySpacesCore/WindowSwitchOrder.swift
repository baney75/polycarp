#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Foundation

/// What ⌘Tab does (spec/switcher.md). The raw value is what Settings stores.
public enum CmdTabMode: String, CaseIterable, Identifiable, Sendable {
    /// Every window on every workspace, most recently used first.
    case windows
    /// Every app with a window, on any workspace, most recent first; picking one goes there.
    case apps
    /// Workspaces, most recent first.
    case workspaces
    /// macOS's app switcher, untouched.
    case off

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .windows: "Windows"
        case .apps: "Apps on every workspace"
        case .workspaces: "Workspaces"
        case .off: "macOS"
        }
    }

    /// `legacy` is 0.2's one switch (⌘Tab switches workspaces), nil when it was never set.
    public static func resolve(stored: String?, legacy: Bool?) -> CmdTabMode {
        if let mode = stored.flatMap(CmdTabMode.init(rawValue:)) { return mode }
        return legacy.map { $0 ? .workspaces : .off } ?? .windows
    }
}

/// The ⌘Tab window order (R-W1). Nothing comes from a Set's or a Dictionary's iteration order, so the same input
/// always gives the same list.
public struct WindowSwitchOrder: Sendable {
    public struct Window: Sendable {
        public let id: WindowID
        public let workspace: Int
        public let minimized: Bool
        public init(id: WindowID, workspace: Int, minimized: Bool = false) {
            (self.id, self.workspace, self.minimized) = (id, workspace, minimized)
        }
    }

    public struct List: Equatable, Sendable {
        public let ids: [WindowID]
        /// The window you're in, first in `ids`; nil when none is in front (an empty workspace).
        public let front: WindowID?
    }

    /// How long a window ⌘Tab picked counts as in front while its app is still coming forward, so a second tap goes
    /// back to the window the first one left.
    public static let landing: Double = 0.5

    /// Windows as they were last focused, most recent first.
    private var focused: [WindowID] = []
    private var picked: (id: WindowID, at: Double)?

    public init() {}

    public mutating func note(_ id: WindowID) {
        focused.removeAll { $0 == id }
        focused.insert(id, at: 0)
    }

    /// ⌘Tab chose this window at `time` (system uptime).
    public mutating func pick(_ id: WindowID, at time: Double) {
        note(id)
        picked = (id, time)
    }

    /// Windows not in `alive` closed: their numbers may come back as other windows.
    public mutating func forget(except alive: Set<WindowID>) {
        focused.removeAll { !alive.contains($0) }
        if let p = picked, !alive.contains(p.id) { picked = nil }
    }

    /// `front` is the window you're in, as the window server has it, and `stacking` the `current` workspace's windows
    /// front to back. `recent` is workspaces, most recent first.
    public func list(front drawn: WindowID?, stacking: [WindowID], windows: [Window], current: Int, recent: [Int], at time: Double) -> List {
        let known = Dictionary(windows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let depth = Dictionary(stacking.enumerated().map { ($1, $0) }, uniquingKeysWith: min)
        let landed = picked.flatMap { time - $0.at < Self.landing && known[$0.id] != nil ? $0.id : nil }
        let front = landed ?? drawn.flatMap { known[$0] != nil ? $0 : nil }
        func rank(_ w: Window) -> (Int, Int, WindowID) {
            let place = w.workspace == current ? -1 : recent.firstIndex(of: w.workspace) ?? recent.count + w.workspace
            return (place, w.workspace == current ? depth[w.id] ?? Int.max : 0, w.id)
        }
        let rest = known.values.sorted { rank($0) < rank($1) }.map(\.id)
        var seen = Set<WindowID>()
        let order = ([front].compactMap { $0 } + focused + rest).filter { known[$0] != nil && seen.insert($0).inserted }
        // One on screen isn't minimized, whatever the last scan said of it.
        func last(_ id: WindowID) -> Bool { id != front && known[id]?.minimized == true }
        return List(ids: order.filter { !last($0) } + order.filter(last), front: front)
    }
}

/// When the ⌘Tab panel comes up: once the gesture has lasted `delay`, or at its second step, whichever is first. A
/// quicker tap commits with no panel at all. A gesture is `active` from its first Tab until ⌘ comes up or Esc, with
/// or without its panel.
public struct SwitcherReveal: Sendable {
    public static let delay: Double = 0.12
    private var startedAt: Double?
    public private(set) var isUp = false

    public init() {}
    public var active: Bool { startedAt != nil }

    /// `t` is when the key arrived (system uptime).
    public mutating func begin(at t: Double) { (startedAt, isUp) = (t, false) }

    public mutating func end() { (startedAt, isUp) = (nil, false) }

    /// Seconds until a panel that isn't up is due.
    public func wait(at t: Double) -> Double { startedAt.map { max(0, Self.delay - (t - $0)) } ?? 0 }

    /// The second step (Tab or an arrow). True when the panel comes up now.
    public mutating func stepped() -> Bool { come(active) }

    /// Time passed. True once, when the gesture has lasted `delay` and the panel isn't up.
    public mutating func lasted(at t: Double) -> Bool { come(startedAt.map { t - $0 >= Self.delay } ?? false) }

    private mutating func come(_ due: Bool) -> Bool {
        guard due, !isUp else { return false }
        isUp = true
        return true
    }
}

/// The ⌘Tab window cards in even rows that always fit the screen (R-W4): the biggest card whose rows fit.
public struct WindowGrid: Equatable, Sendable {
    public let columns: Int
    public let rows: Int
    public let cardWidth: Double
    public let cardHeight: Double
    /// The icon and badge above a two-line title; else all on one line.
    public let isStacked: Bool

    public static let spacing: Double = 8
    /// The panel's edges and the screen's, both sides together.
    public static let padding: Double = 28
    public static let margin: Double = 48
    /// A row this long reads at a glance; rows are longer only when that is what fits.
    static let easyColumns = 6
    static let cards: [(width: Double, height: Double, stacked: Bool)] = [(200, 100, true), (200, 44, false), (160, 40, false)]

    public var size: CGSize {
        func length(_ n: Int, _ card: Double) -> Double { Double(n) * (card + Self.spacing) - Self.spacing + Self.padding }
        return CGSize(width: length(columns, cardWidth), height: length(rows, cardHeight))
    }

    public static func fit(count: Int, maxWidth: Double, maxHeight: Double) -> WindowGrid {
        let n = max(count, 1)
        let width = maxWidth - margin - padding, height = maxHeight - margin - padding
        var tightest = (columns: 1, width: width, height: height)
        for card in cards {
            let most = max(Int((width + spacing) / (card.width + spacing)), 1)
            for wide in min(easyColumns, most)...most {
                let rows = (n + wide - 1) / wide
                let g = WindowGrid(columns: (n + rows - 1) / rows, rows: rows, cardWidth: min(card.width, width),
                                   cardHeight: card.height, isStacked: card.stacked)
                if g.size.height <= maxHeight - margin { return g }
            }
            tightest = (most, min(card.width, width), card.height)
        }
        // More windows than the smallest card has room for: the rows get thinner, never off the screen.
        let rows = (n + tightest.columns - 1) / tightest.columns
        return WindowGrid(columns: tightest.columns, rows: rows, cardWidth: tightest.width,
                          cardHeight: max(1, min(tightest.height, (height + spacing) / Double(rows) - spacing)), isStacked: false)
    }
}

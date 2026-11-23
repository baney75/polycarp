import Foundation

/// The Workspace Dock's right-click menu for one app on one tile, laid out like the macOS Dock's. The menus were
/// "way too cluttered" (Donovan, 2026-10-14), so depth goes into submenus, not length: the window list shows only
/// when there is a choice to make, and moving or finding the app sit one level down. `WorkspaceDock.appMenu` draws
/// exactly these items, in this order.
public enum DockAppMenu {
    public struct Window: Equatable, Sendable {
        public let id: WindowID
        public let title: String

        public init(id: WindowID, title: String) { self.id = id; self.title = title }
    }

    /// One workspace in "Move to Workspace": "Workspace 2".
    public struct Target: Equatable, Sendable {
        public let workspace: Int
        public let title: String
    }

    public enum Item: Equatable, Sendable {
        /// One of the app's windows on this workspace, by title: a click goes to it.
        case window(Window)
        /// "Show <App>".
        case show
        /// "Move to Workspace", a submenu: every other workspace, moving all this app's windows here there.
        case moveTo([Target])
        /// "Move Front Window Here", on another workspace's tile: the tile's own action, since icons cover most of it.
        case moveFrontHere
        /// "Hide <App>".
        case hide
        /// "Options", a submenu: "Show in Finder".
        case options
        /// "Quit <App>", "Force Quit <App>" while ⌥ is held.
        case quit
        /// "Dock", a submenu of the dock's own settings.
        case dock
        case divider
    }

    /// `windows` is the app's windows on the tile's `workspace`.
    public static func items(windows: [Window], app: String, workspace: Int, isCurrent: Bool, range: ClosedRange<Int> = 1...9) -> [Item] {
        var out: [Item] = []
        if windows.count >= 2 {
            out += windows.map { .window(Window(id: $0.id, title: $0.title.isEmpty ? app : $0.title)) }
            out.append(.divider)
        }
        out.append(.show)
        let targets = range.filter { $0 != workspace }.map { Target(workspace: $0, title: "Workspace \($0)") }
        if !windows.isEmpty, !targets.isEmpty { out.append(.moveTo(targets)) }
        if !isCurrent { out.append(.moveFrontHere) }
        out += [.hide, .options, .divider, .quit, .divider, .dock]
        return out
    }
}

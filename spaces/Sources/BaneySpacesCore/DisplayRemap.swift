import CoreGraphics
import Foundation

/// Where windows from a display that went away stood on it, so they go back when the same display (by its UUID)
/// comes back: an undock and a redock, a monitor unplugged and plugged in again. Kept in `placements.json`.
public struct DisplayStash: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var display: DisplayKey
        /// Its frame relative to that display's top-left corner.
        public var frame: CGRect
        /// The workspace it had then. A window moved to another workspace since stays where you put it.
        public var workspace: Int
        public var at: Double
        public init(display: DisplayKey, frame: CGRect, workspace: Int, at: Double) {
            self.display = display; self.frame = frame; self.workspace = workspace; self.at = at
        }
    }

    public var entries: [WindowID: Entry] = [:]
    /// How long a window waits for its display.
    public static let keepFor: Double = 30 * 24 * 3600

    public init(entries: [WindowID: Entry] = [:]) { self.entries = entries }

    /// Drops entries for windows that are gone, and old ones.
    public mutating func prune(alive: Set<WindowID>, now: Double) {
        entries = entries.filter { alive.contains($0.key) && now - $0.value.at <= Self.keepFor }
    }
}

/// What a display change does to windows. A window keeps its workspace whatever happens; only its frame moves.
public enum DisplayRemap {
    public struct Move: Equatable, Sendable {
        public var window: WindowID
        public var frame: CGRect
        public init(window: WindowID, frame: CGRect) { self.window = window; self.frame = frame }
    }

    /// Displays went away. `lost` are as they were; `frames` is each window's frame from before the change (a parked
    /// window's by its record, not the hiding spot). Each window mostly on a lost display is stashed and moves, in
    /// proportion and inside the usable area, to the display that shows its workspace now, else the main one
    /// (`remaining.first`).
    public static func unplug(lost: [DisplayArea], remaining: [DisplayArea], frames: [WindowID: CGRect],
                              workspace: [WindowID: Int], showing: [DisplayKey: Int], stash: inout DisplayStash,
                              now: Double) -> [Move] {
        guard !lost.isEmpty, let main = remaining.first else { return [] }
        let all = Dictionary((lost + remaining).map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        var moves: [Move] = []
        for (id, frame) in frames.sorted(by: { $0.key < $1.key }) {
            guard let n = workspace[id], let key = Geometry.display(of: frame, in: all),
                  let from = lost.first(where: { $0.key == key }) else { continue }
            let to = remaining.first { showing[$0.key] == n } ?? main
            stash.entries[id] = .init(display: key, frame: frame.offsetBy(dx: -from.frame.minX, dy: -from.frame.minY),
                                      workspace: n, at: now)
            moves.append(Move(window: id, frame: Geometry.carry(frame, from: from.visible, to: to.visible)))
        }
        return moves
    }

    /// A display came back: windows stashed from it that are still on the same workspace go back to their frames on
    /// it, wherever it now sits. Their entries are used up; a window that changed workspace loses its entry and stays.
    public static func replug(_ display: DisplayArea, workspace: [WindowID: Int], stash: inout DisplayStash) -> [Move] {
        var moves: [Move] = []
        for (id, e) in stash.entries.sorted(by: { $0.key < $1.key }) where e.display == display.key {
            stash.entries[id] = nil
            guard workspace[id] == e.workspace else { continue }
            moves.append(Move(window: id, frame: e.frame.offsetBy(dx: display.frame.minX, dy: display.frame.minY)))
        }
        return moves
    }
}

import Foundation

/// Which write a window's frame came from last (spec/tiling-speed.md R-TS4): a settle reports only the windows whose
/// latest write is its own, since a newer look may take a window while an older settle still watches it.
public struct TilingWrites: Equatable, Sendable {
    private var serial = 0
    private var latest: [WindowID: Int] = [:]

    public init() {}

    /// A write of `ids` starts; its number.
    public mutating func wrote(_ ids: Set<WindowID>) -> Int {
        serial += 1
        for id in ids { latest[id] = serial }
        return serial
    }

    /// Of `ids`, the ones write `serial` still holds.
    public func own(_ ids: Set<WindowID>, _ serial: Int) -> Set<WindowID> { ids.filter { latest[$0] == serial } }

    /// Write `serial`'s settle reported or gave up: it holds its windows no longer.
    public mutating func done(_ ids: Set<WindowID>, _ serial: Int) {
        for id in own(ids, serial) { latest[id] = nil }
    }
}

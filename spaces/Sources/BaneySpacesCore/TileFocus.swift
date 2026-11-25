import CoreGraphics

/// A way across the screen.
public enum TileDirection: String, CaseIterable, Codable, Sendable {
    case left, right, up, down

    var axis: TileAxis { self == .left || self == .right ? .horizontal : .vertical }
    /// Toward the smaller coordinate, which is the earlier part of a split.
    var back: Bool { self == .left || self == .up }
}

extension TileLayout {
    /// The window across `id`'s edge. Of several, the one used last (`recent` is most recent first), so going over and
    /// back lands where you were; else the one sharing the most of the edge, then the one nearest its middle. Nil at the
    /// area's edge, where the app can cross to the next display. With `full` the windows are a row to step through.
    public func neighbor(of id: WindowID, toward d: TileDirection, in area: CGRect, gaps: TileGaps,
                         minimums: [WindowID: CGSize] = [:], recent: [WindowID] = []) -> WindowID? {
        if full {
            let row = windows
            guard let at = row.firstIndex(of: id) else { return nil }
            let to = d.back ? at - 1 : at + 1
            return row.indices.contains(to) ? row[to] : nil
        }
        guard let root, let box = gaps.inset(area) else { return nil }
        // Cells and not tiles: a tile shorter than a gap can face only the gap, but every cell borders another.
        let solver = TileSolver(root, in: box, gap: gaps.inner, minimums: minimums)
        let cells = solver.cells(root, in: solver.grown(box)).mapValues(solver.rounded)
        guard let from = cells[id] else { return nil }
        let across = d.axis.other, middle = from.lo(across) + from.hi(across)
        let facing = windows.compactMap { w -> (id: WindowID, shared: Double, off: Double)? in
            guard w != id, let c = cells[w] else { return nil }
            guard d.back ? c.hi(d.axis) == from.lo(d.axis) : c.lo(d.axis) == from.hi(d.axis) else { return nil }
            let shared = min(c.hi(across), from.hi(across)) - max(c.lo(across), from.lo(across))
            return shared > 0 ? (w, shared, abs(c.lo(across) + c.hi(across) - middle)) : nil
        }
        if let used = recent.first(where: { r in facing.contains { $0.id == r } }) { return used }
        return facing.reduce(nil as (id: WindowID, shared: Double, off: Double)?) { best, f in
            guard let best else { return f }
            // A point of rounding is no difference; then the first in the order stays.
            if abs(f.shared - best.shared) > 1 { return f.shared > best.shared ? f : best }
            return f.off < best.off - 2 ? f : best
        }?.id
    }

    /// The next window in the order, around the end. A window alone is its own next one.
    public func next(after id: WindowID, backward: Bool) -> WindowID? {
        let row = windows
        guard let at = row.firstIndex(of: id) else { return nil }
        return row[(at + (backward ? row.count - 1 : 1)) % row.count]
    }

    /// Two windows trade slots; each slot keeps its size and nesting.
    public mutating func swap(_ a: WindowID, _ b: WindowID) {
        guard !full, a != b, contains(a), contains(b) else { return }
        root?.relabel { $0 == a ? b : $0 == b ? a : $0 }
    }

    /// Makes a window the main one; the old main window takes its slot. Only the `main` style has one.
    public mutating func promote(_ id: WindowID) {
        guard style == .main, let first = windows.first else { return }
        swap(id, first)
    }

    /// Moves a window one step. Along its split it trades places with the next window, or joins the split standing there
    /// the other way; from a split across the direction it steps out, to sit beside that split. So every step shows, and
    /// enough of them reach the edge, where this is false and the app can send the window to the next display. It is
    /// false for a window it hasn't and with `full` too, which no step shows in.
    /// In `main` a step is a trade, so there is always one main window and one stack; the gaps and minimums say who stands
    /// there on screen.
    @discardableResult
    public mutating func move(_ id: WindowID, toward d: TileDirection, area: CGRect, gaps: TileGaps = TileGaps(),
                              minimums: [WindowID: CGSize] = [:]) -> Bool {
        guard !full, let tree = root, let path = tree.path(of: id) else { return false }
        if style == .main {
            guard let other = neighbor(of: id, toward: d, in: area, gaps: gaps, minimums: minimums) else { return false }
            swap(id, other)
            return true
        }
        let step = d.back ? -1 : 1
        // The nearest split along the direction with something on that side.
        guard let k = path.indices.last(where: { k in
            guard let s = tree[split: Array(path[..<k])], s.axis == d.axis else { return false }
            return s.parts.indices.contains(path[k] + step)
        }) else { return false }
        let parent = Array(path[..<k])
        if (k..<path.count).contains(where: { tree[split: Array(path[..<$0])]?.axis != d.axis }) {
            relocate(id, area) { $0.admit(id, into: parent, at: d.back ? path[k] : path[k] + 1) }
            return true
        }
        // Through splits nested on the same axis, to the window or the crosswise split that stands next to this one.
        var beside = parent + [path[k] + step]
        while let s = tree[split: beside], s.axis == d.axis { beside.append(d.back ? s.parts.count - 1 : 0) }
        switch tree[beside] {
        case .window(let other): swap(id, other)
        case .split(let s):
            let box = TileBox(area), across = d.axis.other
            let here = tree.box(at: path, in: box), middle = here.lo(across) + here.hi(across)
            let above = s.boxes(in: tree.box(at: beside, in: box)).filter { $0.lo(across) + $0.hi(across) < middle - 1e-6 }
            relocate(id, area) { $0.admit(id, into: beside, at: above.count) }
        }
        return true
    }

    /// Takes a window from its slot to one `place` adds. The old slot goes last, under a number no window has, so paths
    /// worked out before hold and a split that takes the window in is already marked as a person's when shapes change.
    mutating func relocate(_ id: WindowID, _ area: CGRect, _ place: (inout TileNode) -> Void) {
        guard var tree = root else { return }
        let taken = Set(windows)
        var hole = WindowID.max
        while taken.contains(hole) { hole -= 1 }
        tree.relabel { $0 == id ? hole : $0 }
        place(&tree)
        _ = tree.remove(hole, in: TileBox(area), rechoosing: style == .dwindle)
        root = tree
        settle(area)
    }
}

extension TileNode {
    /// A person puts a window into a split, which from then on keeps its direction. The root stays as it was: its shape
    /// is the area's, so it only turns with the display.
    mutating func admit(_ id: WindowID, into path: [Int], at index: Int) {
        guard var s = self[split: path] else { return }
        s.add(.window(id), at: index)
        if !path.isEmpty { s.automatic = false }
        self[split: path] = s
    }
}

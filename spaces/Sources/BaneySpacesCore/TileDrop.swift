import CoreGraphics

/// What letting go of a dragged window does.
public enum TileDrop: Equatable, Sendable {
    /// Trade slots with this window.
    case swap(WindowID)
    /// Next to this window, on this side: half of its tile, unless the two are in a row that way already.
    case beside(WindowID, TileDirection)
    /// Along this edge of the area.
    case edge(TileDirection)
}

extension TileLayout {
    /// How close to the area's own edge, in points, a drop is for the whole edge.
    public static let edgeZone = 24.0
    /// The middle share of a tile, on both axes, where a drop is a swap.
    public static let swapZone = 0.4

    /// What letting go of `id` with the pointer there would do: in the middle of a tile a swap, else beside it on the side
    /// the pointer leans to (as a share of the tile, so a wide tile isn't all top and bottom), and by the ends of the
    /// area's long side the whole edge. Nil over its own tile, outside the area, or with `full`.
    public func drop(_ id: WindowID, at point: CGPoint, area: CGRect, gaps: TileGaps, minimums: [WindowID: CGSize] = [:]) -> TileDrop? {
        guard !full, contains(id), area.contains(point), let root, let box = gaps.inset(area) else { return nil }
        let solver = TileSolver(root, in: box, gap: gaps.inner, minimums: minimums)
        let all = cells(solver, in: box)
        // The gaps belong to the nearest cell, so there is no dead strip between tiles or along the area's edges.
        let x = min(max(point.x, box.x0), box.x1 - 1), y = min(max(point.y, box.y0), box.y1 - 1)
        guard let over = windows.first(where: { w in
            guard let c = all[w].map(solver.rounded) else { return false }
            return x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1
        }), over != id, let cell = all[over] else { return nil }
        let whole = TileBox(area), axis = whole.axis
        let along = axis == .horizontal ? point.x : point.y
        if along - whole.lo(axis) < TileLayout.edgeZone { return .edge(axis == .horizontal ? .left : .up) }
        if whole.hi(axis) - along <= TileLayout.edgeZone { return .edge(axis == .horizontal ? .right : .down) }
        let tile = solver.tile(cell, in: box)
        let u = (point.x - tile.midX) / tile.width, v = (point.y - tile.midY) / tile.height
        if abs(u) <= TileLayout.swapZone / 2, abs(v) <= TileLayout.swapZone / 2 { return .swap(over) }
        return .beside(over, abs(u) >= abs(v) ? (u < 0 ? .left : .right) : (v < 0 ? .up : .down))
    }

    /// Where `id` would be after the drop, for the outline: worked out by doing it on a copy, so it can't promise
    /// anything else than `apply` does.
    public func dropFrame(_ drop: TileDrop, _ id: WindowID, area: CGRect, gaps: TileGaps, minimums: [WindowID: CGSize] = [:]) -> CGRect? {
        var after = self
        after.apply(drop, to: id, area: area)
        return after == self ? nil : after.frames(in: area, gaps: gaps, minimums: minimums)[id]
    }

    /// Does a drop. In `main` the windows trade slots so that `id` comes before or after the one it was dropped beside,
    /// or first or last for an edge: there is still one main window and one stack.
    public mutating func apply(_ drop: TileDrop, to id: WindowID, area: CGRect) {
        guard !full, contains(id) else { return }
        switch drop {
        case .swap(let other): swap(id, other)
        case .beside(let other, let d):
            guard other != id, contains(other) else { return }
            if style == .main {
                reorder(id) { $0.firstIndex(of: other).map { d.back ? $0 : $0 + 1 } ?? 0 }
            } else {
                put(id, beside: other, d, area)
            }
        case .edge(let d):
            guard windows.count > 1 else { return }
            if style == .main {
                reorder(id) { d.back ? 0 : $0.count }
            } else {
                wrap(id, d, area)
            }
        }
    }

    /// Moves a window to another place in the order; the slots keep their sizes.
    private mutating func reorder(_ id: WindowID, to index: ([WindowID]) -> Int) {
        let was = windows
        var order = was.filter { $0 != id }
        order.insert(id, at: index(order))
        let slot = Dictionary(uniqueKeysWithValues: zip(was, order))
        root?.relabel { slot[$0] ?? $0 }
    }

    /// Beside a sibling along their split, a window changes places and keeps its size. In `columns` it joins a column's
    /// split the way a new window does. Else the two share the tile in a split of their own, so when the window leaves
    /// again the tile gets back just what it gave.
    private mutating func put(_ id: WindowID, beside other: WindowID, _ d: TileDirection, _ area: CGRect) {
        guard var tree = root, let from = tree.path(of: id), let path = tree.path(of: other) else { return }
        let parent = Array(path.dropLast())
        if let i = path.last, let old = from.last, var s = tree[split: parent], s.axis == d.axis {
            if from.dropLast() == path.dropLast() {
                let part = s.parts.remove(at: old)
                s.parts.insert(part, at: (old < i ? i - 1 : i) + (d.back ? 0 : 1))
                tree[split: parent] = s
                root = tree
                return
            }
            if style.inColumns {
                relocate(id, area) { $0.admit(id, into: parent, at: d.back ? i : i + 1) }
                return
            }
        }
        relocate(id, area) {
            $0[path] = .split(TileSplit(d.axis, automatic: false, d.back ? [.window(id), $0[path]] : [$0[path], .window(id)]))
        }
    }

    /// A window takes half the area along an edge. In `columns`, or where a person set the direction, a root along it
    /// takes the window in; a dwindle root that chose its own goes inside and chooses again for the half it has left.
    mutating func wrap(_ id: WindowID, _ d: TileDirection, _ area: CGRect) {
        // Two columns are one and a window now; their row still turns with the display.
        let turns = style.inColumns && (root?[split: []].map { $0.automatic && $0.axis == d.axis } ?? false)
        remove(id, area: area)
        guard let tree = root else { return }
        var top = TileSplit(d.axis, automatic: turns, [tree])
        if let s = tree[split: []], s.axis == d.axis, style.inColumns || !s.automatic { top = s }
        let weight = style == .scrolling ? top.total / Double(top.parts.count) : top.total
        top.parts.insert(TilePart(weight: weight, node: .window(id)), at: d.back ? 0 : top.parts.count)
        if style.dwindles { top.rechooseParts(in: TileBox(area)) }
        root = .split(top)
    }
}

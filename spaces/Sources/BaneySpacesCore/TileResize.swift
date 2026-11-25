import CoreGraphics

extension TileLayout {
    /// Grows a window (or with negative `points` shrinks it) at its nearest split on that axis. Its siblings there give
    /// or take in proportion to their size, none under its minimum. False when nothing can change.
    @discardableResult
    public mutating func resize(_ id: WindowID, axis: TileAxis, by points: Double, area: CGRect, gaps: TileGaps,
                                minimums: [WindowID: CGSize] = [:]) -> Bool {
        grow(id, axis, by: points, side: nil, area: area, gaps: gaps, minimums: minimums)
    }

    /// The pointer dragged a window's edge or corner and left it at `frame`. Each edge moves the cut line on its own side,
    /// so the opposite edge stays put. A window that only moved is left alone, and so is an edge on the area's own.
    @discardableResult
    public mutating func resize(_ id: WindowID, to frame: CGRect, area: CGRect, gaps: TileGaps,
                                minimums: [WindowID: CGSize] = [:]) -> Bool {
        guard !full, let was = frames(in: area, gaps: gaps, minimums: minimums)[id] else { return false }
        let from = TileBox(was), to = TileBox(frame)
        guard to.usable else { return false }
        var changed = false
        for axis in TileAxis.allCases where abs(to.length(axis) - from.length(axis)) >= 1 {
            for (side, by) in [(true, from.lo(axis) - to.lo(axis)), (false, to.hi(axis) - from.hi(axis))] where abs(by) >= 1 {
                if grow(id, axis, by: by, side: side, area: area, gaps: gaps, minimums: minimums) { changed = true }
            }
        }
        return changed
    }

    /// Moves the cut lines of one split: the part with `id` grows by `points`, and the parts before it (`side` true),
    /// after it (false) or both (nil) pay for it.
    private mutating func grow(_ id: WindowID, _ axis: TileAxis, by points: Double, side before: Bool?, area: CGRect, gaps: TileGaps,
                               minimums: [WindowID: CGSize]) -> Bool {
        guard !full, points.isFinite, var tree = root, let path = tree.path(of: id), let box = gaps.inset(area) else { return false }
        func others(_ k: Int) -> [Int] {
            guard let s = tree[split: Array(path[..<k])], s.axis == axis else { return [] }
            return s.parts.indices.filter { $0 != path[k] && (before == nil || ($0 < path[k]) == before) }
        }
        guard let k = path.indices.last(where: { !others($0).isEmpty }) else { return false }
        let payers = others(k)
        let solver = TileSolver(tree, in: box, gap: gaps.inner, minimums: minimums)
        let cells = solver.cells(tree, in: solver.grown(box))
        // Weights become the lengths on screen, through the whole run of splits on this axis, so what a minimum already
        // pushed out of proportion doesn't jump.
        var top = k
        while top > 0, tree[split: Array(path[..<(top - 1)])]?.axis == axis { top -= 1 }
        tree[Array(path[..<top])].bake(axis, cells)
        // Every split on this axis between the cut line and the window grows the part with the window in it: the rest of
        // what moved stays as long as it was.
        let levels = (k..<path.count).filter { tree[split: Array(path[..<$0])]?.axis == axis }
        for j in levels { tree[Array(path[..<j])].bake(axis, cells) }
        func spare(_ level: Int, _ part: Int) -> Double {
            guard let p = tree[split: Array(path[..<level])]?.parts[part] else { return 0 }
            return max(0, p.weight - solver.need(p.node, axis))
        }
        let most = payers.reduce(0) { $0 + spare(k, $1) }
        let least = levels.map { spare($0, path[$0]) }.min() ?? 0
        let delta = min(most, max(-least, points))
        guard abs(delta) >= 0.5, var s = tree[split: Array(path[..<k])] else { return false }
        let lengths = s.parts.map(\.weight)
        let floors = payers.map { min(lengths[$0], solver.need(s.parts[$0].node, axis)) }
        for (i, length) in zip(payers, TileLayout.shared(payers.map { lengths[$0] }, floors: floors, paying: delta)) { s.parts[i].weight = length }
        tree[split: Array(path[..<k])] = s
        for j in levels {
            let at = Array(path[..<j])
            guard var s = tree[split: at] else { continue }
            s.parts[path[j]].weight += delta
            tree[split: at] = s
        }
        root = tree
        return true
    }

    /// Lengths after paying `total` in proportion to their size, none under its floor. A negative total is taken in.
    private static func shared(_ lengths: [Double], floors: [Double], paying total: Double) -> [Double] {
        var out = lengths, open = Array(lengths.indices), left = total
        while !open.isEmpty {
            let sum = open.reduce(0) { $0 + lengths[$1] }, rate = left / sum
            let low = open.filter { lengths[$0] * (1 - rate) < floors[$0] }
            for i in low {
                out[i] = floors[i]
                left -= lengths[i] - floors[i]
            }
            open.removeAll { low.contains($0) }
            if low.isEmpty {
                for i in open { out[i] = lengths[i] * (1 - rate) }
                break
            }
        }
        return out
    }

    /// Evens out the split a window is in, or with nil every split. A part that is itself a run of windows on the same
    /// axis counts as that many, so a row comes out even however it is nested. In `main` the main window goes back to its
    /// usual share.
    public mutating func balance(_ id: WindowID?) {
        guard var tree = root else { return }
        if let id {
            guard let path = tree.path(of: id), !path.isEmpty else { return }
            let parent = Array(path.dropLast())
            tree[parent].even(deep: false)
            root = tree
        } else {
            tree.even(deep: true)
            root = tree
        }
        guard style == .main, var top = root?[split: []], id == nil || root?.path(of: id!)?.count == 1 else { return }
        for i in top.parts.indices { top.parts[i].weight = i == 0 ? TileLayout.mainShare : 1 - TileLayout.mainShare }
        root = .split(top)
    }

    /// Turns the split a window is in, or the root with nil. The direction is then a person's and stays; automatic
    /// splits inside it choose for their new shapes.
    public mutating func flip(_ id: WindowID?, area: CGRect) {
        guard !full, var tree = root else { return }
        var at: [Int] = []
        if let id {
            guard let path = tree.path(of: id) else { return }
            at = Array(path.dropLast())
        }
        guard var s = tree[split: at] else { return }
        (s.axis, s.automatic) = (s.axis.other, false)
        if style == .dwindle { s.rechooseParts(in: tree.box(at: at, in: TileBox(area))) }
        tree[split: at] = s
        root = tree
        settle(area)
    }
}

extension TileNode {
    /// Sets the weights of a run of splits on one axis to the lengths on screen.
    mutating func bake(_ axis: TileAxis, _ cells: [WindowID: TileBox]) {
        guard case .split(var s) = self, s.axis == axis else { return }
        for i in s.parts.indices {
            let (lo, hi) = s.parts[i].node.span(axis, cells)
            s.parts[i].weight = max(hi - lo, 1e-3)
            s.parts[i].node.bake(axis, cells)
        }
        self = .split(s)
    }

    private func span(_ axis: TileAxis, _ cells: [WindowID: TileBox]) -> (Double, Double) {
        var ids: [WindowID] = []
        collect(into: &ids)
        let boxes = ids.compactMap { cells[$0] }
        return (boxes.map { $0.lo(axis) }.min() ?? 0, boxes.map { $0.hi(axis) }.max() ?? 0)
    }

    mutating func even(deep: Bool) {
        guard case .split(var s) = self else { return }
        for i in s.parts.indices {
            s.parts[i].weight = Double(s.parts[i].node.length(s.axis))
            if deep { s.parts[i].node.even(deep: true) }
        }
        self = .split(s)
    }

    /// How many tiles a run along an axis has; a window or a split the other way is one.
    private func length(_ axis: TileAxis) -> Int {
        guard case .split(let s) = self, s.axis == axis else { return 1 }
        return s.parts.reduce(0) { $0 + $1.node.length(axis) }
    }
}

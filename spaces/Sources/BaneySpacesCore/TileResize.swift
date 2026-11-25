import CoreGraphics

extension TileLayout {
    /// Grows a window (or with negative `points` shrinks it) in its nearest run of windows on that axis. The others in the
    /// run give or take in proportion to their size, none under its minimum. False when nothing can change.
    @discardableResult
    public mutating func resize(_ id: WindowID, axis: TileAxis, by points: Double, area: CGRect, gaps: TileGaps,
                                minimums: [WindowID: CGSize] = [:]) -> Bool {
        grow(id, axis, by: points, side: nil, area: area, gaps: gaps, minimums: minimums)
    }

    /// The pointer dragged a window's edge or corner from `start` and left it at `frame`. Each edge moves the cut line on
    /// its own side: the window there pays, then the one past it once the first is at its minimum, so the opposite edge
    /// and the rest of its row stay put. Windows inside a part that pays share what it lost. A window that only moved is left alone, and so is an edge on the area's own. `start` is the
    /// frame it had, which an app may have made smaller than its tile; nil is its tile.
    @discardableResult
    public mutating func resize(_ id: WindowID, to frame: CGRect, from start: CGRect? = nil, area: CGRect, gaps: TileGaps,
                                minimums: [WindowID: CGSize] = [:]) -> Bool {
        guard !full, let was = start ?? frames(in: area, gaps: gaps, minimums: minimums)[id] else { return false }
        let from = TileBox(was), to = TileBox(frame)
        guard from.usable, to.usable else { return false }
        var changed = false
        for axis in TileAxis.allCases where abs(to.length(axis) - from.length(axis)) >= 1 {
            for (side, by) in [(true, from.lo(axis) - to.lo(axis)), (false, to.hi(axis) - from.hi(axis))] where abs(by) >= 1 {
                if grow(id, axis, by: by, side: side, area: area, gaps: gaps, minimums: minimums) { changed = true }
            }
        }
        return changed
    }

    /// The splits nested on one axis, as the one row they look like: its windows and splits the other way, with the
    /// lengths they have on screen, and which of them holds the window.
    private struct Run {
        var at: [Int]
        var members: [TileNode]
        var lengths: [Double]
        var mine: Int
    }

    /// Every run on an axis that a window is in, from the root in.
    private func runs(_ tree: TileNode, to path: [Int], _ axis: TileAxis, _ cells: [WindowID: TileBox]) -> [Run] {
        var out: [Run] = [], k = 0
        while k < path.count {
            let at = Array(path[..<k])
            k += 1
            guard tree[split: at]?.axis == axis else { continue }
            while k < path.count, tree[split: Array(path[..<k])]?.axis == axis { k += 1 }
            let members = tree[at].members(axis), inside = tree[Array(path[..<k])]
            guard let mine = members.firstIndex(of: inside) else { continue }
            out.append(Run(at: at, members: members, lengths: members.map { $0.length(axis, cells) }, mine: mine))
        }
        return out
    }

    /// Moves the cut lines of one run: the part with `id` grows by `points`, and the parts before it (`side` true), after
    /// it (false) or both (nil) pay for it.
    private mutating func grow(_ id: WindowID, _ axis: TileAxis, by points: Double, side before: Bool?, area: CGRect, gaps: TileGaps,
                               minimums: [WindowID: CGSize]) -> Bool {
        guard !full, points.isFinite, var tree = root, let path = tree.path(of: id), let box = gaps.inset(area) else { return false }
        let solver = TileSolver(tree, in: box, gap: gaps.inner, minimums: minimums)
        var rows = runs(tree, to: path, axis, solver.cells(tree, in: solver.grown(box)))
        func payers(_ r: Run) -> [Int] { r.members.indices.filter { $0 != r.mine && (before == nil || ($0 < r.mine) == before) } }
        func spare(_ r: Run, _ i: Int) -> Double { max(0, r.lengths[i] - solver.need(r.members[i], axis)) }
        // The runs inside the one whose cut line moves grow only their part with the window in it, and the rest of what
        // moved stays as long as it was.
        guard let first = rows.lastIndex(where: { !payers($0).isEmpty }) else { return false }
        let run = rows[first], pay = payers(run)
        let most = pay.reduce(0) { $0 + spare(run, $1) }
        let least = rows[first...].map { spare($0, $0.mine) }.min() ?? 0
        let delta = min(most, max(-least, points))
        guard abs(delta) >= 0.5 else { return false }
        if before == nil {
            let floors = pay.map { run.lengths[$0] - spare(run, $0) }
            for (i, length) in zip(pay, TileLayout.shared(pay.map { run.lengths[$0] }, floors: floors, paying: delta)) { rows[first].lengths[i] = length }
        } else {
            var left = delta
            for i in before == true ? pay.reversed() : pay {
                let part = min(left, spare(run, i))
                rows[first].lengths[i] -= part
                left -= part
            }
        }
        // Weights become the lengths on screen, so what a minimum already pushed out of proportion doesn't jump.
        for i in first..<rows.count {
            rows[i].lengths[rows[i].mine] += delta
            var lengths = rows[i].lengths[...]
            tree[rows[i].at].set(axis, &lengths)
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

    /// Evens out the row or column a window is in, or with nil every one. A part that is itself a run of windows on the
    /// same axis counts as that many, so a row comes out even however it is nested. In `main` the main window goes back to
    /// its usual share.
    public mutating func balance(_ id: WindowID?) {
        guard !full, var tree = root else { return }
        var top: [Int] = []
        if let id {
            guard let path = tree.path(of: id), let axis = tree[split: Array(path.dropLast())]?.axis else { return }
            top = Array(path.dropLast())
            while !top.isEmpty, tree[split: Array(top.dropLast())]?.axis == axis { top.removeLast() }
            tree[top].even(only: axis)
        } else {
            tree.even(only: nil)
        }
        root = tree
        guard style == .main, top.isEmpty, var first = root?[split: []] else { return }
        for i in first.parts.indices { first.parts[i].weight = i == 0 ? TileLayout.mainShare : 1 - TileLayout.mainShare }
        root = .split(first)
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
    /// The run on an axis this node starts: its windows and its splits the other way, however the splits on the axis nest.
    func members(_ axis: TileAxis) -> [TileNode] {
        guard case .split(let s) = self, s.axis == axis else { return [self] }
        return s.parts.flatMap { $0.node.members(axis) }
    }

    /// Gives the run's members these lengths, in order, and every split on the axis the sum of its parts'. Its own length.
    @discardableResult
    mutating func set(_ axis: TileAxis, _ lengths: inout ArraySlice<Double>) -> Double {
        guard case .split(var s) = self, s.axis == axis else { return lengths.popFirst() ?? 0 }
        var sum = 0.0
        for i in s.parts.indices {
            s.parts[i].weight = max(s.parts[i].node.set(axis, &lengths), 1e-3)
            sum += s.parts[i].weight
        }
        self = .split(s)
        return sum
    }

    /// How long a node's cell is.
    fileprivate func length(_ axis: TileAxis, _ cells: [WindowID: TileBox]) -> Double {
        var ids: [WindowID] = []
        collect(into: &ids)
        let boxes = ids.compactMap { cells[$0] }
        return max((boxes.map { $0.hi(axis) }.max() ?? 0) - (boxes.map { $0.lo(axis) }.min() ?? 0), 1e-3)
    }

    /// Evens the splits on one axis nested from here, or with nil every split there is.
    mutating func even(only axis: TileAxis?) {
        guard case .split(var s) = self, axis == nil || s.axis == axis else { return }
        for i in s.parts.indices {
            s.parts[i].weight = Double(s.parts[i].node.members(s.axis).count)
            s.parts[i].node.even(only: axis)
        }
        self = .split(s)
    }
}

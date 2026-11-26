import CoreGraphics

/// The `scrolling` style's columns: a strip that can be wider than the area, looked at through it. A column is as wide
/// as its weight says and never less than its windows need, whatever the others are.
struct TileStrip {
    var columns: [(node: TileNode, box: TileBox)] = []
    var length = 0.0
    var view: TileBox

    /// How far the strip can be scrolled.
    var most: Double { max(0, length - view.width) }

    /// What to move a column by to see it at this scroll. A strip that fits stands in the middle.
    func shift(_ scroll: Double) -> Double {
        length <= view.width ? ((view.width - length) / 2).rounded(.down) : -min(max(0, scroll), most).rounded()
    }
}

extension TileLayout {
    /// A column's share of the area's width at a weight of 1: two new columns side by side fill it.
    public static let columnShare = 0.5
    /// The least a window may show, as a share of its width, to stay where it is at the end of the strip.
    static let peek = 0.5

    /// Nil unless the layout scrolls and has columns to scroll.
    func strip(_ solver: TileSolver, in box: TileBox) -> TileStrip? {
        guard style == .scrolling, let top = root?[split: []], top.axis == .horizontal else { return nil }
        let view = solver.grown(box)
        var out = TileStrip(view: view)
        var at = view.x0
        for p in top.parts {
            let wide = min(view.width, max(p.weight * Self.columnShare * view.width, solver.need(p.node, .horizontal)))
            out.columns.append((p.node, view.cut(.horizontal, at, at + wide)))
            at += wide
        }
        out.length = at - view.x0
        return out
    }

    /// Every window's cell: in `scrolling` where the strip stands now, so some are beside the area.
    func cells(_ solver: TileSolver, in box: TileBox) -> [WindowID: TileBox] {
        guard let root else { return [:] }
        guard let strip = self.strip(solver, in: box) else { return solver.cells(root, in: solver.grown(box)) }
        var out: [WindowID: TileBox] = [:]
        let by = strip.shift(scroll)
        for c in strip.columns {
            for (id, cell) in solver.cells(c.node, in: TileBox(c.box.x0 + by, c.box.y0, c.box.x1 + by, c.box.y1)) { out[id] = cell }
        }
        return out
    }

    /// Scrolls no further than it takes to have all of a window's column in the area.
    public mutating func reveal(_ id: WindowID?, area: CGRect, gaps: TileGaps, minimums: [WindowID: CGSize] = [:]) {
        guard let root, let box = gaps.inset(area) else { return }
        let solver = TileSolver(root, in: box, gap: gaps.inner, minimums: minimums)
        guard let strip = self.strip(solver, in: box) else { return }
        var to = scroll
        if let id, let i = root.path(of: id)?.first {
            let c = strip.columns[i].box
            to = min(max(to, c.x1 - strip.view.x0 - strip.view.width), c.x0 - strip.view.x0)
        }
        scroll = min(max(0, to), strip.most)
    }

    /// A column grows, and the others move over for it.
    mutating func widen(_ id: WindowID, by points: Double, _ solver: TileSolver, in box: TileBox) -> Bool {
        guard points.isFinite, let i = root?.path(of: id)?.first, let strip = self.strip(solver, in: box), var top = root?[split: []] else { return false }
        let was = strip.columns[i].box.width
        let now = min(strip.view.width, max(solver.need(strip.columns[i].node, .horizontal), was + points))
        guard abs(now - was) >= 0.5 else { return false }
        top.parts[i].weight = now / (Self.columnShare * strip.view.width)
        root = .split(top)
        return true
    }

    /// Where a window of a scrolled strip is kept: its own place while enough of it shows there and none of it on
    /// another display, else nil, for out of sight.
    static func shows(_ frame: CGRect, in area: CGRect, displays: [CGRect]) -> Bool {
        if frame.minX >= area.minX - 1, frame.maxX <= area.maxX + 1 { return true }
        guard let mine = displays.first(where: { $0.contains(CGPoint(x: area.midX, y: area.midY)) }) else { return false }
        return frame.intersection(mine).width >= frame.width * peek && !displays.contains { $0 != mine && $0.intersects(frame) }
    }
}

import CoreGraphics

/// The space between tiles and around them, in points. The outer edges are separate because a bar or a notch takes one.
public struct TileGaps: Codable, Equatable, Sendable {
    public var inner, top, bottom, left, right: Double

    public init(inner: Double = 0, top: Double = 0, bottom: Double = 0, left: Double = 0, right: Double = 0) {
        (self.inner, self.top, self.bottom, self.left, self.right) = (inner, top, bottom, left, right)
    }

    public init(inner: Double, outer: Double) {
        self.init(inner: inner, top: outer, bottom: outer, left: outer, right: outer)
    }

    /// The outer gaps never leave less than this to tile in: on a small display big gaps cost more than they give.
    public static let least = CGSize(width: 320, height: 240)

    /// The whole points of `area` inside the outer gaps, nil when there is nothing to tile in.
    func inset(_ area: CGRect) -> TileBox? {
        let box = TileBox(area)
        guard box.usable else { return nil }
        let (x0, y0, x1, y1) = (box.x0.rounded(.up), box.y0.rounded(.up), box.x1.rounded(.down), box.y1.rounded(.down))
        guard x1 - x0 >= 1, y1 - y0 >= 1 else { return nil }
        func give(_ a: Double, _ b: Double, _ spare: Double) -> (Double, Double) {
            let (a, b, spare) = (TileGaps.whole(a), TileGaps.whole(b), max(0, spare))
            guard a + b > spare else { return (a, b) }
            return ((a * spare / (a + b)).rounded(.down), (b * spare / (a + b)).rounded(.down))
        }
        let (l, r) = give(left, right, x1 - x0 - TileGaps.least.width)
        let (t, b) = give(top, bottom, y1 - y0 - TileGaps.least.height)
        return TileBox(x0 + l, y0 + t, x1 - r, y1 - b)
    }

    static func whole(_ gap: Double) -> Double { gap.isFinite ? min(max(0, gap.rounded()), 10_000) : 0 }
}

/// Turns the tree into rectangles. Each window gets a cell, the cells tile the area with no gaps, and a tile is its cell
/// less half the gap on each side. So a cut line is one number shared by both its neighbors, and nesting splits on one
/// axis gives the same cells as one flat split.
struct TileSolver {
    private(set) var gap: Double
    private var minimums: [WindowID: CGSize]

    /// The gap is as wide as asked unless that would leave a tile under a point.
    init(_ root: TileNode, in box: TileBox, gap: Double, minimums: [WindowID: CGSize]) {
        self.minimums = minimums
        self.gap = TileGaps.whole(gap)
        for axis in TileAxis.allCases {
            let n = Double(root.count(axis))
            if n > 1 { self.gap = min(self.gap, max(0, ((box.length(axis) - n) / (n - 1)).rounded(.down))) }
        }
    }

    /// Half the gap on the left and top of a tile; an odd gap's extra point goes to the other side.
    var before: Double { (gap / 2).rounded(.down) }

    /// The box the cells fill: the tiled area and half a gap beyond it, which the outer tiles give back.
    func grown(_ box: TileBox) -> TileBox {
        TileBox(box.x0 - before, box.y0 - before, box.x1 + gap - before, box.y1 + gap - before)
    }

    /// A node as the math needs it, worked out once: the shortest cell that meets every minimum in it, the shortest with
    /// a point per window, and the parts of every split nested on one axis in one run, as shares of 1.
    struct Room {
        var id: WindowID?
        var axis = TileAxis.horizontal
        var share = 1.0
        var need: (w: Double, h: Double)
        var least: (w: Double, h: Double)
        var run: [Room] = []

        func need(_ a: TileAxis) -> Double { a == .horizontal ? need.w : need.h }
        func least(_ a: TileAxis) -> Double { a == .horizontal ? least.w : least.h }
    }

    /// The shortest cell along an axis that meets every minimum in a node.
    func need(_ node: TileNode, _ axis: TileAxis) -> Double { room(node).need(axis) }

    private func room(_ node: TileNode) -> Room {
        switch node {
        case .window(let id):
            func least(_ side: CGFloat) -> Double { side.isFinite ? max(1, side.rounded(.up)) : 1 }
            let m = minimums.isEmpty ? nil : minimums[id]
            return Room(id: id, need: (gap + (m.map { least($0.width) } ?? 1), gap + (m.map { least($0.height) } ?? 1)),
                        least: (gap + 1, gap + 1))
        case .split(let s):
            var out = Room(axis: s.axis, need: (0, 0), least: (0, 0))
            let total = s.total
            for p in s.parts {
                var r = room(p.node)
                if s.axis == .horizontal {
                    out.need = (out.need.w + r.need.w, max(out.need.h, r.need.h))
                    out.least = (out.least.w + r.least.w, max(out.least.h, r.least.h))
                } else {
                    out.need = (max(out.need.w, r.need.w), out.need.h + r.need.h)
                    out.least = (max(out.least.w, r.least.w), out.least.h + r.least.h)
                }
                let share = p.weight / total
                if r.id == nil, r.axis == s.axis {
                    for var inner in r.run { inner.share *= share; out.run.append(inner) }
                } else {
                    r.share = share
                    out.run.append(r)
                }
            }
            return out
        }
    }

    /// Every window's cell, with cut lines still between points.
    func cells(_ root: TileNode, in box: TileBox) -> [WindowID: TileBox] {
        var out: [WindowID: TileBox] = [:]
        place(room(root), in: box, &out)
        return out
    }

    private func place(_ room: Room, in box: TileBox, _ out: inout [WindowID: TileBox]) {
        if let id = room.id { out[id] = box; return }
        let lengths = self.lengths(room.run, room.axis, box.length(room.axis))
        var at = box.lo(room.axis)
        for i in 0..<room.run.count {
            let end = i == room.run.count - 1 ? box.hi(room.axis) : at + lengths[i]
            place(room.run[i], in: box.cut(room.axis, at, end), &out)
            at = end
        }
    }

    /// The parts' lengths: by weight, then each part under its need takes the rest from the others, in proportion to
    /// what they can spare. When the needs don't fit, every tile shrinks in proportion to its minimum, to a point at least.
    private func lengths(_ run: [Room], _ axis: TileAxis, _ length: Double) -> [Double] {
        var out: [Double] = []
        var needed = 0.0, short = 0.0, spare = 0.0
        for r in run {
            let base = r.share * length, need = r.need(axis)
            out.append(base)
            needed += need
            if base < need { short += need - base } else { spare += base - need }
        }
        guard short > 0 else { return out }
        if needed <= length + 1e-6 {
            for i in 0..<run.count {
                let need = run[i].need(axis)
                out[i] = out[i] <= need ? need : out[i] - short * (out[i] - need) / spare
            }
            return out
        }
        var atLeast = Array(repeating: false, count: run.count)
        while true {
            var left = length, shares = 0.0, settled = true
            for i in 0..<run.count {
                left -= atLeast[i] ? run[i].least(axis) : gap
                if !atLeast[i] { shares += run[i].need(axis) - gap }
            }
            for i in 0..<run.count where !atLeast[i] {
                out[i] = gap + left * (run[i].need(axis) - gap) / shares
                if out[i] < run[i].least(axis) - 1e-6 { (atLeast[i], out[i], settled) = (true, run[i].least(axis), false) }
            }
            if settled { break }
        }
        guard !atLeast.contains(false) else { return out }
        // Not a point each: the cells overlap in an area with fewer points than windows, inside it all the same.
        let all = out.reduce(0, +)
        return out.map { $0 * length / all }
    }

    /// A cell's tile in whole points. Cut lines round once, a hair early, so a line halfway between two points falls the
    /// same way however it was reached. The clamps only act in an area with fewer points than windows.
    func tile(_ cell: TileBox, in box: TileBox) -> CGRect {
        let c = rounded(cell)
        let w = min(max(1, c.width - gap), box.width), h = min(max(1, c.height - gap), box.height)
        return CGRect(x: max(box.x0, min(c.x0 + before, box.x1 - w)), y: max(box.y0, min(c.y0 + before, box.y1 - h)),
                      width: w, height: h)
    }

    func rounded(_ c: TileBox) -> TileBox {
        func line(_ v: Double) -> Double { (v + 0.5 + 1e-6).rounded(.down) }
        return TileBox(line(c.x0), line(c.y0), line(c.x1), line(c.y1))
    }
}

extension TileNode {
    /// How many windows sit in a row along an axis, at the widest.
    func count(_ axis: TileAxis) -> Int {
        guard case .split(let s) = self else { return 1 }
        var sum = 0, most = 1
        for p in s.parts {
            let n = p.node.count(axis)
            sum += n
            most = max(most, n)
        }
        return s.axis == axis ? sum : most
    }
}

extension TileLayout {
    /// Where every window goes: whole points, neighbors exactly the inner gap apart, the tiles and gaps filling `area`
    /// less its outer gaps. `minimums` are the sizes windows refuse to go under; `loneMax` keeps the only window from
    /// spreading across an ultrawide. An area under a point has room for nothing and gives no frames.
    public func frames(in area: CGRect, gaps: TileGaps, minimums: [WindowID: CGSize] = [:],
                       loneMax: CGSize? = nil) -> [WindowID: CGRect] {
        guard let root, let box = gaps.inset(area) else { return [:] }
        if full {
            let all = CGRect(x: box.x0, y: box.y0, width: box.width, height: box.height)
            return Dictionary(uniqueKeysWithValues: windows.map { ($0, all) })
        }
        if case .window(let id) = root { return [id: lone(id, in: box, minimums: minimums, loneMax: loneMax)] }
        let solver = TileSolver(root, in: box, gap: gaps.inner, minimums: minimums)
        var out: [WindowID: CGRect] = [:]
        for (id, cell) in solver.cells(root, in: solver.grown(box)) { out[id] = solver.tile(cell, in: box) }
        return out
    }

    private func lone(_ id: WindowID, in box: TileBox, minimums: [WindowID: CGSize], loneMax: CGSize?) -> CGRect {
        func side(_ room: Double, _ most: Double?, _ least: Double?) -> Double {
            guard let most, most.isFinite, most >= 1 else { return room }
            return min(room, max(most.rounded(.down), (least ?? 1).rounded(.up)))
        }
        let w = side(box.width, loneMax.map { Double($0.width) }, minimums[id].map { Double($0.width) })
        let h = side(box.height, loneMax.map { Double($0.height) }, minimums[id].map { Double($0.height) })
        return CGRect(x: box.x0 + ((box.width - w) / 2).rounded(.down), y: box.y0 + ((box.height - h) / 2).rounded(.down),
                      width: w, height: h)
    }
}

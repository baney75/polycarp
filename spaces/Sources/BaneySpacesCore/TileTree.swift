import CoreGraphics

/// Which way a split lays its parts: side by side, or stacked.
public enum TileAxis: String, CaseIterable, Codable, Sendable {
    case horizontal, vertical

    var other: TileAxis { self == .horizontal ? .vertical : .horizontal }
}

/// A rectangle as four edges. Cut lines are shared edges, so the layout math works on edges and never re-adds an
/// origin and a size.
struct TileBox: Equatable, Sendable {
    var x0, y0, x1, y1: Double

    init(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) { (self.x0, self.y0, self.x1, self.y1) = (x0, y0, x1, y1) }

    init(_ r: CGRect) { self.init(r.minX, r.minY, r.maxX, r.maxY) }

    var width: Double { x1 - x0 }
    var height: Double { y1 - y0 }
    /// The long side; a square counts as wide, like every display people tile on.
    var axis: TileAxis { width >= height ? .horizontal : .vertical }
    /// Edges and sides a layout can use. A display on its way out reports an empty or a null rectangle.
    var usable: Bool { x0.isFinite && y0.isFinite && x1.isFinite && y1.isFinite && width >= 1 && height >= 1 }

    func lo(_ axis: TileAxis) -> Double { axis == .horizontal ? x0 : y0 }
    func hi(_ axis: TileAxis) -> Double { axis == .horizontal ? x1 : y1 }
    func length(_ axis: TileAxis) -> Double { hi(axis) - lo(axis) }

    /// The part of this box between two cut lines on `axis`.
    func cut(_ axis: TileAxis, _ lo: Double, _ hi: Double) -> TileBox {
        axis == .horizontal ? TileBox(lo, y0, hi, y1) : TileBox(x0, lo, x1, hi)
    }
}

/// One part of a split. The weight is its share next to its siblings', in any unit.
struct TilePart: Equatable, Codable, Sendable {
    var weight: Double
    var node: TileNode
}

/// Two or more parts along one axis. `automatic` says the axis came from a shape, so a new shape may change it; a
/// direction a person chose stays.
struct TileSplit: Equatable, Codable, Sendable {
    var axis: TileAxis
    var automatic: Bool
    var parts: [TilePart]

    init(_ axis: TileAxis, automatic: Bool, _ nodes: [TileNode], weights: [Double]? = nil) {
        (self.axis, self.automatic) = (axis, automatic)
        parts = nodes.enumerated().map { TilePart(weight: weights?[$0.offset] ?? 1, node: $0.element) }
    }

    var total: Double { parts.reduce(0) { $0 + $1.weight } }

    /// Where each part sits in `box` by weight alone, which is what the shape of a tile is judged by.
    func boxes(in box: TileBox) -> [TileBox] {
        let total = total, lo = box.lo(axis), length = box.length(axis)
        var at = 0.0
        return parts.map { p in
            let from = lo + length * at / total
            at += p.weight
            return box.cut(axis, from, lo + length * at / total)
        }
    }

    /// Adds a part at an average weight, so it gets its even share and the others keep their proportions.
    mutating func add(_ node: TileNode, at index: Int) {
        parts.insert(TilePart(weight: total / Double(parts.count), node: node), at: index)
    }

    mutating func rechooseParts(in box: TileBox) {
        for (i, b) in boxes(in: box).enumerated() { parts[i].node.rechoose(in: b) }
    }

    /// Takes the parts of the split at `index` in as its own, when both axes were automatic and are the same. Gaps come
    /// off the tiles and not off the splits, and minimums are met across nested splits on one axis (`TileSolver`), so
    /// this moves no frame.
    mutating func merge(at index: Int) {
        guard case .split(let child) = parts[index].node, child.axis == axis, automatic, child.automatic else { return }
        let scale = parts[index].weight / child.total
        parts.replaceSubrange(index...index, with: child.parts.map { TilePart(weight: $0.weight * scale, node: $0.node) })
    }
}

/// A window, or a split of more. A window saves as its number and a split as an object.
enum TileNode: Equatable, Codable, Sendable {
    case window(WindowID)
    case split(TileSplit)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let id = try? c.decode(WindowID.self) { self = .window(id) } else { self = .split(try c.decode(TileSplit.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .window(let id): try c.encode(id)
        case .split(let s): try c.encode(s)
        }
    }

    func collect(into out: inout [WindowID]) {
        switch self {
        case .window(let id): out.append(id)
        case .split(let s): for p in s.parts { p.node.collect(into: &out) }
        }
    }

    /// The part indexes that lead to a window: empty when this is it, nil when it isn't here.
    func path(of id: WindowID) -> [Int]? {
        switch self {
        case .window(let w): return w == id ? [] : nil
        case .split(let s):
            for (i, p) in s.parts.enumerated() {
                if let rest = p.node.path(of: id) { return [i] + rest }
            }
            return nil
        }
    }

    var lastPath: [Int] {
        guard case .split(let s) = self else { return [] }
        return [s.parts.count - 1] + s.parts[s.parts.count - 1].node.lastPath
    }

    /// The node a path leads to. Paths come from `path(of:)` on this same tree.
    subscript(path: ArraySlice<Int>) -> TileNode {
        get {
            guard let i = path.first, case .split(let s) = self else { return self }
            return s.parts[i].node[path.dropFirst()]
        }
        set {
            guard let i = path.first, case .split(var s) = self else { self = newValue; return }
            s.parts[i].node[path.dropFirst()] = newValue
            self = .split(s)
        }
    }

    subscript(path: [Int]) -> TileNode {
        get { self[path[...]] }
        set { self[path[...]] = newValue }
    }

    /// The split at a path, nil for a window. Setting it puts the split there.
    subscript(split path: [Int]) -> TileSplit? {
        get { if case .split(let s) = self[path] { return s } else { return nil } }
        set { if let newValue { self[path] = .split(newValue) } }
    }

    /// Where the node at `path` sits by weight alone.
    func box(at path: [Int], in box: TileBox) -> TileBox {
        guard let i = path.first, case .split(let s) = self else { return box }
        return s.parts[i].node.box(at: Array(path.dropFirst()), in: s.boxes(in: box)[i])
    }

    /// Puts `to(id)` in each window's slot, so every slot keeps its size and nesting.
    mutating func relabel(_ to: (WindowID) -> WindowID) {
        switch self {
        case .window(let id): self = .window(to(id))
        case .split(var s):
            for i in s.parts.indices { s.parts[i].node.relabel(to) }
            self = .split(s)
        }
    }

    /// Every automatic split here takes the long side of the shape it has now, outermost first, because a split's axis
    /// decides the shapes inside it.
    mutating func rechoose(in box: TileBox) {
        guard case .split(var s) = self else { return }
        if s.automatic { s.axis = box.axis }
        s.rechooseParts(in: box)
        self = .split(s)
    }

    enum Removal { case missing, emptied, kept, collapsed }

    /// Takes a window out; its siblings get the space. Only the splits whose shape that changes choose an axis again, so
    /// a tile someone resized elsewhere doesn't turn. `emptied` means this whole node was the window.
    mutating func remove(_ id: WindowID, in box: TileBox, rechoosing: Bool) -> Removal {
        guard case .split(var s) = self else { return self == .window(id) ? .emptied : .missing }
        let boxes = s.boxes(in: box)
        for i in s.parts.indices {
            switch s.parts[i].node.remove(id, in: boxes[i], rechoosing: rechoosing) {
            case .missing: continue
            case .kept:
                self = .split(s)
                return .kept
            case .collapsed:
                s.merge(at: i)
                self = .split(s)
                return .kept
            case .emptied:
                s.parts.remove(at: i)
                if s.parts.count == 1 {
                    self = s.parts[0].node
                    if rechoosing { rechoose(in: box) }
                    return .collapsed
                }
                if rechoosing { s.rechooseParts(in: box) }
                self = .split(s)
                return .kept
            }
        }
        return .missing
    }

    /// A saved tree made safe to use: no empty or one-part splits, no window twice, no weight whose sums lose precision.
    /// A tree this code wrote comes back untouched.
    func repaired(_ seen: inout Set<WindowID>) -> TileNode? {
        switch self {
        case .window(let id): return seen.insert(id).inserted ? self : nil
        case .split(var s):
            s.parts = s.parts.compactMap { p in
                p.node.repaired(&seen).map { TilePart(weight: (1e-30...1e30).contains(p.weight) ? p.weight : 1, node: $0) }
            }
            return s.parts.count > 1 ? .split(s) : s.parts.first?.node
        }
    }
}

import CoreGraphics

/// How a workspace's windows share the screen.
public enum TileStyle: String, CaseIterable, Codable, Sendable {
    /// A new window halves the focused tile along its longer side.
    case dwindle
    /// Windows side by side; stacked on a portrait display.
    case columns
    /// One main window, the rest stacked beside it.
    case main
    /// Columns in a strip that can be wider than the area, the one in use scrolled into it.
    case scrolling
    /// Windows stay where the person puts them; the order is kept for the next style.
    case floating

    /// A new window is a column of its own, and a drop beside a column is one more.
    var inColumns: Bool { self == .columns || self == .scrolling }
    /// Automatic splits take the long side of the shape they have.
    var dwindles: Bool { self == .dwindle || self == .floating }
}

/// One workspace's tiling: a tree of splits with a window at each leaf. It holds no frames: the same layout gives them
/// for any area, so a display change or a new gap needs no new state. Every call is total and deterministic: a window it
/// doesn't know is a no-op. Coordinates are Accessibility's, y down.
///
/// The areas passed to the mutating calls only say which way shapes are long; the gaps and minimums don't change that.
public struct TileLayout: Codable, Equatable, Sendable {
    /// The main window's share of the long side in a fresh `main` layout: enough to read as the main one, with room left
    /// for a stack.
    public static let mainShare = 0.55

    public internal(set) var style: TileStyle
    /// Every window gets the whole area and the app raises the focused one. The tree stays as it is, so turning this off
    /// puts everything back; only windows coming and going change it meanwhile.
    public var full = false
    /// How far `scrolling` has the strip scrolled, in points.
    var scroll = 0.0
    var root: TileNode?

    public init(style: TileStyle = .dwindle) { self.style = style }

    private enum CodingKeys: String, CodingKey { case style, full, scroll, root }

    /// A saved layout can have been edited or cut short, so the tree is repaired before anything walks it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        style = try c.decode(TileStyle.self, forKey: .style)
        full = try c.decodeIfPresent(Bool.self, forKey: .full) ?? false
        let at = try c.decodeIfPresent(Double.self, forKey: .scroll) ?? 0
        scroll = at.isFinite ? at : 0
        var seen: Set<WindowID> = []
        root = try c.decodeIfPresent(TileNode.self, forKey: .root)?.repaired(&seen)
    }

    /// Every window once, left to right and top to bottom through the tree.
    public var windows: [WindowID] {
        var out: [WindowID] = []
        root?.collect(into: &out)
        return out
    }

    public func contains(_ id: WindowID) -> Bool { root?.path(of: id) != nil }

    /// Lays the windows out again in another style, in the order they have. The style it already is changes nothing, so
    /// applying settings twice keeps what a person arranged.
    public mutating func setStyle(_ new: TileStyle, area: CGRect) {
        guard new != style else { return }
        let order = windows
        (style, root, scroll) = (new, nil, 0)
        for (i, id) in order.enumerated() { insert(id, beside: i > 0 ? order[i - 1] : nil, area: area) }
    }

    /// Adds a window next to the focused one; with none it knows, after the last.
    public mutating func insert(_ id: WindowID, beside focused: WindowID?, area: CGRect) {
        guard !contains(id) else { return }
        settle(area)
        guard var tree = root else { root = .window(id); return }
        let beside = focused.flatMap { tree.path(of: $0) }
        let box = TileBox(area)
        switch style {
        case .dwindle, .floating:
            let path = beside ?? tree.lastPath
            tree[path] = .split(TileSplit(tree.box(at: path, in: box).axis, automatic: true, [tree[path], .window(id)]))
        case .columns:
            let end = tree[split: []].map { [$0.parts.count - 1] }
            tree.join(id, after: beside ?? end ?? [], axis: box.axis)
        case .scrolling:
            if let top = tree[split: []], top.axis == .horizontal {
                tree.join(id, after: [beside?.first ?? top.parts.count - 1], axis: .horizontal)
            } else {
                // All there is so far, stacked or not, is the first column.
                tree = .split(TileSplit(.horizontal, automatic: true, [tree, .window(id)]))
            }
        case .main:
            if case .window = tree {
                tree = .split(TileSplit(box.axis, automatic: true, [tree, .window(id)],
                                        weights: [TileLayout.mainShare, 1 - TileLayout.mainShare]))
            } else {
                tree.stack(id, beside: beside)
            }
        }
        root = tree
    }

    /// Takes a window out; its siblings share its space. In `main`, the next window becomes the main one and keeps the
    /// main window's slot.
    public mutating func remove(_ id: WindowID, area: CGRect) {
        guard var tree = root, tree.path(of: id) != nil else { return }
        if style == .main, let first = windows.first, first == id, let next = windows.dropFirst().first {
            tree.relabel { $0 == first ? next : $0 == next ? first : $0 }
        }
        let gone = tree.remove(id, in: TileBox(area), rechoosing: style.dwindles)
        root = gone == .emptied ? nil : tree
        settle(area)
    }

    /// Brings the layout in line with the windows there are: drops the gone, then adds the new in order, the first beside
    /// `focused` and each next one beside the one before. Pass the window that had the focus before the new one came.
    /// True when anything changed, including a split that turned because the area did.
    @discardableResult
    public mutating func sync(_ present: [WindowID], focused: WindowID?, area: CGRect) -> Bool {
        let before = self
        let stay = Set(present)
        for id in windows where !stay.contains(id) { remove(id, area: area) }
        var beside = focused
        for id in present where !contains(id) {
            insert(id, beside: beside, area: area)
            beside = id
        }
        settle(area)
        return self != before
    }

    /// Another window takes this one's slot, weight and nesting, as when a native tab comes to the front.
    public mutating func replace(_ old: WindowID, with new: WindowID) {
        guard contains(old), !contains(new) else { return }
        root?.relabel { $0 == old ? new : $0 }
    }

    /// The root's shape is the area's, so an automatic root on the other axis means the display turned or the workspace
    /// moved to one of another shape: the automatic splits choose again for it.
    mutating func settle(_ area: CGRect) {
        let box = TileBox(area)
        guard style != .scrolling, box.usable, var top = root?[split: []] else { return }
        if top.automatic, top.axis != box.axis {
            if style.dwindles {
                root?.rechoose(in: box)
                return
            }
            top.axis = box.axis
        }
        if style == .main, case .split(var rest) = top.parts[1].node, rest.automatic {
            rest.axis = top.axis.other
            top.parts[1].node = .split(rest)
        }
        root = .split(top)
    }
}

extension TileNode {
    /// Adds a window to the split that holds the part at `path`, after it (or before). A lone window becomes a split on
    /// `axis`.
    mutating func join(_ id: WindowID, after path: [Int], axis: TileAxis, before: Bool = false) {
        guard let i = path.last, var s = self[split: Array(path.dropLast())] else {
            self = .split(TileSplit(axis, automatic: true, before ? [.window(id), self] : [self, .window(id)]))
            return
        }
        s.add(.window(id), at: before ? i : i + 1)
        self[split: Array(path.dropLast())] = s
    }

    /// Adds a window to the `main` style's stack: after the focused one there, at the top when the main window has the
    /// focus, at the end when nothing does.
    mutating func stack(_ id: WindowID, beside: [Int]?) {
        guard case .split(let top) = self else { return }
        let fromMain = beside?.first == 0
        if case .split(let rest) = top.parts[1].node {
            let inStack = beside.flatMap { $0.count > 1 && $0[0] == 1 ? $0 : nil }
            join(id, after: fromMain ? [1, 0] : inStack ?? [1, rest.parts.count - 1], axis: rest.axis, before: fromMain)
        } else {
            var rest = TileNode.window(id)
            rest = .split(TileSplit(top.axis.other, automatic: true, fromMain ? [rest, top.parts[1].node] : [top.parts[1].node, rest]))
            self[[1]] = rest
        }
    }
}

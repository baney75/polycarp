import CoreGraphics

/// A group: windows that share one tile, one of them in front, with a strip of tabs above it. Only the front one is in
/// the layout, so everything the layout does to a window it does to the group.
public struct TilingGroup: Equatable, Sendable {
    /// What the strip of tabs takes off the top of the tile, its gap with it.
    public static let strip = 30.0
    /// A tile lower than this keeps its whole height for the window.
    static let least = 120.0
    /// Between the strip and the window.
    static let gap = 4.0

    /// In tab order.
    public var members: [WindowID]

    /// The tile less the strip.
    static func inner(_ tile: CGRect) -> CGRect {
        guard tile.height >= least else { return tile }
        return CGRect(x: tile.minX, y: tile.minY + strip, width: tile.width, height: tile.height - strip)
    }
}

/// A strip of tabs to draw.
public struct TilingTabs: Equatable, Sendable {
    /// The strip's place, in Accessibility coordinates.
    public var frame: CGRect
    public var windows: [WindowID]
    public var front: WindowID
}

extension TilingEngine.Slot {
    func group(_ id: WindowID) -> Int? { groups.firstIndex { $0.members.contains(id) } }

    /// Whether a window has a tile here, its own or its group's.
    func holds(_ id: WindowID) -> Bool { layout.contains(id) || group(id) != nil }

    /// The window that stands for this one in the layout.
    func front(of id: WindowID) -> WindowID? {
        layout.contains(id) ? id : group(id).flatMap { front(of: groups[$0]) }
    }

    func front(of group: TilingGroup) -> WindowID? { group.members.first(where: layout.contains) }

    /// Every window, the hidden ones of a group after its front.
    var all: [WindowID] {
        layout.windows.flatMap { w in group(w).map { [w] + groups[$0].members.filter { $0 != w } } ?? [w] }
    }

    /// Brings a hidden window of a group to the front of it. True when it was hidden.
    @discardableResult
    mutating func show(_ id: WindowID) -> Bool {
        guard let old = front(of: id), old != id else { return false }
        if focused == old { focused = id }
        swapFront(old, for: id)
        return true
    }

    /// The layouts windows remember from before they went away name the group's front, whichever that was.
    private mutating func swapFront(_ old: WindowID, for id: WindowID) {
        layout.replace(old, with: id)
        for other in away.keys { away[other]!.whole.replace(old, with: id) }
    }

    /// Windows that are no longer here leave their groups; the next in a group comes to the front.
    mutating func ungroup(_ ids: Set<WindowID>) {
        for i in groups.indices {
            guard let front = front(of: groups[i]) else { continue }
            let stay = groups[i].members.filter { !ids.contains($0) }
            if ids.contains(front), !stay.isEmpty {
                let at = groups[i].members.firstIndex(of: front)!
                let next = groups[i].members[at...].first { !ids.contains($0) } ?? stay.last!
                if focused == front { focused = next }
                swapFront(front, for: next)
            }
            groups[i].members = stay
        }
        // A group is one until its last window goes or a person takes it apart.
        groups.removeAll { $0.members.isEmpty }
    }

    /// Windows that leave for the Dock or hiding remember their place, each as its group's front, and who was with them.
    mutating func remember(_ gone: Set<WindowID>, beside: (WindowID) -> WindowID?) {
        let whole = layout
        for id in all where gone.contains(id) {
            guard let front = front(of: id) else { continue }
            var mine = whole
            mine.replace(front, with: id)
            away[id] = .init(whole: mine, beside: beside(front), mates: group(id).map { groups[$0].members } ?? [])
        }
    }

    /// Groups out of a file: each needs its one front in the layout, and a window is in one group.
    mutating func restore(_ saved: [[WindowID]]) {
        var seen = Set<WindowID>()
        for members in saved {
            let front = members.filter(layout.contains)
            guard front.count == 1, Set(members).count == members.count, seen.isDisjoint(with: members) else { continue }
            seen.formUnion(members)
            groups.append(TilingGroup(members: members))
        }
    }

    /// Takes a window out of its group and its tile.
    mutating func take(_ id: WindowID) {
        ungroup([id])
        layout.remove(id, area: area)
    }

    /// A window joins the group of another, making it one, after the one in front or where it was among its `mates`.
    mutating func join(_ id: WindowID, to other: WindowID, showing: Bool, mates: [WindowID] = []) {
        guard let front = front(of: other), front != id else { return }
        if group(front) == nil { groups.append(TilingGroup(members: [front])) }
        let i = group(front)!, members = groups[i].members
        let before = mates.prefix { $0 != id }.last(where: members.contains), after = mates.drop { $0 != id }.first(where: members.contains)
        let at = before.map { members.firstIndex(of: $0)! + 1 } ?? after.map { members.firstIndex(of: $0)! } ?? members.firstIndex(of: front)! + 1
        groups[i].members.insert(id, at: at)
        if showing { show(id) }
    }
}

extension TilingEngine {
    /// The minimums a layout is solved with: a group's is the largest of its windows', and the strip.
    func needs(_ slot: Slot) -> [WindowID: CGSize] {
        guard !slot.groups.isEmpty, !minimums.isEmpty else { return minimums }
        var out = minimums
        for g in slot.groups {
            guard let front = slot.front(of: g) else { continue }
            let each = g.members.compactMap { minimums[$0] }
            guard !each.isEmpty else { continue }
            out[front] = CGSize(width: each.map(\.width).max()!, height: each.map(\.height).max()! + TilingGroup.strip)
        }
        return out
    }

    /// The strips of tabs of a workspace.
    public func tabs(_ workspace: Int) -> [TilingTabs] {
        guard let key = key(workspace), let slot = slots[key], options.tiles(workspace) else { return [] }
        let tiles = tiles(workspace).own
        return slot.groups.compactMap { g in
            guard let front = slot.front(of: g), stowed[front] == nil, let t = tiles[front], TilingGroup.inner(t) != t, Self.strips(slot) else { return nil }
            let frame = CGRect(x: t.minX, y: t.minY, width: t.width, height: TilingGroup.strip - TilingGroup.gap)
            return TilingTabs(frame: frame, windows: g.members, front: front)
        }
    }

    /// With several windows at full size, another's window would lie over a strip.
    static func strips(_ slot: Slot) -> Bool { !slot.layout.full || slot.layout.windows.count < 2 }

    /// Makes the window's tile a group, or takes the group apart into tiles beside each other.
    static func toggleGroup(_ id: WindowID, _ slot: inout Slot) {
        guard let i = slot.group(id) else { return slot.groups.append(TilingGroup(members: [id])) }
        let members = slot.groups.remove(at: i).members
        guard let front = members.first(where: slot.layout.contains) else { return }
        // They stand in the order of their tabs.
        slot.layout.replace(front, with: members[0])
        for (m, beside) in zip(members.dropFirst(), members) { slot.layout.insert(m, beside: beside, area: slot.area) }
    }

    /// A window in a group with others goes out of it on that side; any other goes into the tile that way, which is a
    /// group from then on. False when there is none.
    func join(_ id: WindowID, toward d: TileDirection, _ slot: inout Slot) -> Bool {
        if let i = slot.group(id), slot.groups[i].members.count > 1 {
            slot.ungroup([id])
            guard let front = slot.groups[min(i, slot.groups.count - 1)].members.first(where: slot.layout.contains) else { return false }
            slot.layout.insert(id, beside: front, area: slot.area)
            slot.layout.apply(.beside(front, d), to: id, area: slot.area)
            slot.focused = id
            return true
        }
        guard let other = slot.layout.neighbor(of: id, toward: d, in: slot.area, gaps: options.gaps, minimums: needs(slot), recent: recent) else { return false }
        slot.take(id)
        slot.join(id, to: other, showing: true)
        slot.focused = id
        return true
    }

    /// The next or previous window of a group, around the end.
    static func nextInGroup(_ id: WindowID, backward: Bool, _ slot: Slot) -> WindowID? {
        guard let i = slot.group(id) else { return nil }
        let m = slot.groups[i].members
        guard m.count > 1, let at = m.firstIndex(of: id) else { return nil }
        return m[(at + (backward ? m.count - 1 : 1)) % m.count]
    }

    /// The strip of tabs under a dragged window's pointer, on its own workspace, when it isn't its own group's.
    func tabs(at point: CGPoint, for id: WindowID) -> TilingTabs? {
        guard let w = seen[id], inSight.contains(w.workspace), key(w.workspace).flatMap({ slots[$0] })?.holds(id) == true else { return nil }
        return tabs(w.workspace).first { $0.frame.contains(point) && !$0.windows.contains(id) }
    }
}

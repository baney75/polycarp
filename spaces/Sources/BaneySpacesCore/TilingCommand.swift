import CoreGraphics

/// One thing a key, the bar, the command or an agent asks tiling to do, about one workspace and its focused window.
public enum TilingCommand: Equatable, Sendable {
    case toggle
    case focus(TileDirection)
    /// The next or previous window in the layout's order, around the end.
    case cycle(backward: Bool)
    case move(TileDirection)
    case grow(TileDirection)
    case balance, flip, promote, float, full
    /// The window's tile fills the display, or the width of it, or goes back to its place.
    case zoom(TilingZoom)
    /// The window's tile becomes a group of windows in tabs, or the group comes apart.
    case group
    /// Into the tile that way, or out of its group.
    case join(TileDirection)
    case groupCycle(backward: Bool)
    /// Nil is the next one.
    case style(TileStyle?)
    /// The window goes to the next display's workspace.
    case nextDisplay
    /// The scratchpad comes over the workspace or goes away.
    case scratchpad
    /// The window goes to the scratchpad, or becomes one of this workspace's again.
    case toScratchpad
    /// The window floats on every workspace of its display, in a size of its own (`pop`) or where it is, or goes back.
    case pop, pin

    /// Every command a key can have, by the name the settings, the command line and the docs use.
    public static let named: [(name: String, title: String, command: TilingCommand)] = {
        // Built a line at a time: one long expression is more than an older Swift's type checker takes.
        var all: [(name: String, title: String, command: TilingCommand)] = []
        func add(_ name: String, _ title: String, _ command: TilingCommand) { all.append((name, title, command)) }
        add("toggle", "Tile this workspace, or stop", .toggle)
        for d in TileDirection.allCases { add("focus-\(d.rawValue)", "Focus the window \(d.phrase)", .focus(d)) }
        add("focus-next", "Focus the next tiled window", .cycle(backward: false))
        add("focus-previous", "Focus the previous tiled window", .cycle(backward: true))
        for d in TileDirection.allCases { add("move-\(d.rawValue)", "Move the tiled window \(d.rawValue)", .move(d)) }
        for d in TileDirection.allCases { add("grow-\(d.rawValue)", "Move the tiled window's edge \(d.rawValue)", .grow(d)) }
        add("balance", "Even out every split", .balance)
        add("flip", "Turn the window's split", .flip)
        add("style", "Next layout: dwindle, columns, main, scrolling, floating", .style(nil))
        add("promote", "Make the window the main one", .promote)
        add("float", "Float the window, or tile it again", .float)
        add("full", "Give the window the whole area, or put it back", .full)
        add("fullscreen", "Fill the display with the tile, or put it back", .zoom(.screen))
        add("full-width", "Give the tile the whole width, or put it back", .zoom(.width))
        add("group", "Make the tile a group of tabs, or take it apart", .group)
        for d in TileDirection.allCases { add("group-\(d.rawValue)", "Move the window into the tile \(d.phrase), or out of its group", .join(d)) }
        add("group-next", "Focus the next window of the group", .groupCycle(backward: false))
        add("group-previous", "Focus the previous window of the group", .groupCycle(backward: true))
        add("next-display", "Send the window to the next display", .nextDisplay)
        add("scratchpad", "Show the scratchpad, or put it away", .scratchpad)
        add("scratchpad-send", "Send the window to the scratchpad, or take it out", .toScratchpad)
        add("pop", "Pop the window out over every workspace, or put it back", .pop)
        add("pin", "Pin the window over every workspace where it is, or put it back", .pin)
        for s in TileStyle.allCases { add("style-\(s.rawValue)", "Tile in the \(s.rawValue) style", .style(s)) }
        return all
    }()

    /// A command by its name: "focus-left", or the words "focus left".
    public init?(words: [String]) {
        guard let c = Self.named.first(where: { $0.name == words.joined(separator: "-") }) else { return nil }
        self = c.command
    }
}

extension TileDirection {
    var phrase: String {
        switch self {
        case .left: "to the left"
        case .right: "to the right"
        case .up: "above"
        case .down: "below"
        }
    }
}

/// What the app does after a command.
public enum TilingOutcome: Equatable, Sendable {
    /// The layout changed: plan again.
    case changed
    /// Give this window the focus.
    case focus(WindowID)
    /// At the edge: the focus, or the window, crosses to the display that way.
    case cross(TileDirection, carrying: WindowID?)
    case nextDisplay(WindowID)
    case scratchpad
    case toScratchpad(WindowID)
    /// Pin this window, or let it go when it is pinned.
    case pin(WindowID, sized: Bool)
    /// Turn this workspace on or off.
    case toggle
    /// Nothing to do, and why.
    case nothing(String)
}

extension TilingEngine {
    /// Points an edge moves at a time.
    public static let step = 48.0

    public mutating func run(_ command: TilingCommand, on workspace: Int, focused: WindowID?) -> TilingOutcome {
        if command == .toggle { return workspace == options.agentWorkspace ? .nothing("the agent workspace never tiles") : .toggle }
        if command == .scratchpad { return .scratchpad }
        if command == .toScratchpad {
            if workspace == options.agentWorkspace { return .nothing("the agent workspace has no scratchpad") }
            return focused.map { .toScratchpad($0) } ?? .nothing("no window is in front")
        }
        if command == .pop || command == .pin {
            if workspace == options.agentWorkspace { return .nothing("a window of the agent workspace stays there") }
            return focused.map { .pin($0, sized: command == .pop) } ?? .nothing("no window is in front")
        }
        guard options.tiles(workspace) else { return .nothing("this workspace isn't tiled") }
        if case .style(let s) = command { return restyle(s, workspace) }
        // Without a tiled window in focus the one used last answers, so a key after a click on the desktop still works.
        guard let key = key(workspace) else { return .nothing("no window is tiled here") }
        if let focused { slots[key]?.show(focused) }
        guard let slot = slots[key] else { return .nothing("no window is tiled here") }
        if command == .float { return float(focused, slot) }
        if slot.layout.style == .floating { return run(command, floating: slot, focused: focused) }
        guard let id = focused.flatMap({ slot.layout.contains($0) ? $0 : nil }) ?? slot.focused ?? slot.layout.windows.first else {
            return .nothing("no window is tiled here")
        }
        let isTiled = focused.map { slot.layout.contains($0) } ?? false
        var layout = slot.layout
        let area = slot.area, gaps = options.gaps, minimums = needs(slot)
        switch command {
        case .focus(let d):
            guard isTiled else { return .focus(id) }
            return layout.neighbor(of: id, toward: d, in: area, gaps: gaps, minimums: minimums, recent: recent).map { .focus($0) } ?? .cross(d, carrying: nil)
        case .cycle(let backward):
            guard let next = layout.next(after: id, backward: backward), next != id else { return .nothing("there is no other tiled window here") }
            return .focus(isTiled ? next : id)
        case .move(let d):
            guard isTiled else { return .nothing("the window in front isn't tiled") }
            if layout.full { return .nothing("a window is at full size") }
            if !layout.move(id, toward: d, area: area, gaps: gaps, minimums: minimums) { return .cross(d, carrying: id) }
        case .zoom(let z):
            guard isTiled else { return .nothing("the window in front isn't tiled") }
            Self.toggle(z, id, &slots[key]!)
            return .changed
        case .grow where Self.zoom(of: id, slot) != nil: return .nothing("the window is at full size")
        case .grow(let d): grow(id, d, &layout, area, minimums)
        case .balance: layout.balance(nil)
        case .flip: layout.flip(id, area: area)
        case .promote:
            if layout.style == .main { layout.promote(id) } else if let first = layout.windows.first { layout.swap(id, first) }
        case .full: layout.full.toggle()
        case .nextDisplay: return isTiled ? .nextDisplay(id) : .nothing("the window in front isn't tiled")
        case .group, .join, .groupCycle: return group(command, isTiled ? id : nil, key)
        case .toggle, .style, .float, .scratchpad, .toScratchpad, .pop, .pin: break
        }
        guard layout != slot.layout else { return .nothing("there is nothing to change") }
        slots[key]!.layout = layout
        return .changed
    }

    private mutating func group(_ command: TilingCommand, _ id: WindowID?, _ key: TilingKey) -> TilingOutcome {
        guard let id, var slot = slots[key] else { return .nothing("the window in front isn't tiled") }
        switch command {
        case .join(let d):
            guard join(id, toward: d, &slot) else { return .nothing("there is no window that way") }
        case .groupCycle(let backward):
            guard let next = Self.nextInGroup(id, backward: backward, slot) else { return .nothing("the window isn't in a group with another") }
            return .focus(next)
        default: Self.toggleGroup(id, &slot)
        }
        slots[key] = slot
        return .changed
    }

    /// The `floating` style: windows have no tiles, so going to another is by where they stand.
    private func run(_ command: TilingCommand, floating slot: Slot, focused: WindowID?) -> TilingOutcome {
        let here = focused.flatMap { slot.holds($0) ? $0 : nil }
        switch command {
        case .focus(let d):
            guard let here else { return (slot.focused ?? slot.layout.windows.first).map { .focus($0) } ?? .nothing("there is no window here") }
            let frames = seen.filter { slot.holds($0.key) && !$0.value.away }.mapValues(\.frame)
            return TileLayout.nearest(to: here, toward: d, in: frames).map { .focus($0) } ?? .cross(d, carrying: nil)
        case .cycle(let backward):
            guard let next = slot.layout.next(after: here ?? slot.focused ?? 0, backward: backward), next != here else {
                return .nothing("there is no other window here")
            }
            return .focus(next)
        case .nextDisplay: return here.map { .nextDisplay($0) } ?? .nothing("no window is in front")
        default: return .nothing("windows float on this workspace")
        }
    }

    /// A window's edge moves one step that way: the far edge out, and at the area's own edge the near one in.
    private func grow(_ id: WindowID, _ d: TileDirection, _ layout: inout TileLayout, _ area: CGRect, _ minimums: [WindowID: CGSize]) {
        guard var f = layout.frames(in: area, gaps: options.gaps, minimums: minimums)[id] else { return }
        let atEdge = layout.neighbor(of: id, toward: d, in: area, gaps: options.gaps, minimums: minimums) == nil
        let (dx, dy) = d.axis == .horizontal ? (Self.step, 0) : (0, Self.step)
        // Toward a neighbor the edge there goes out; at the area's edge the other edge follows, which shrinks the window.
        switch (d, atEdge) {
        case (.right, false), (.down, false): f.size.width += dx; f.size.height += dy
        case (.left, false), (.up, false): f.origin.x -= dx; f.origin.y -= dy; f.size.width += dx; f.size.height += dy
        case (.right, true), (.down, true): f.origin.x += dx; f.origin.y += dy; f.size.width -= dx; f.size.height -= dy
        case (.left, true), (.up, true): f.size.width -= dx; f.size.height -= dy
        }
        layout.resize(id, to: f, area: area, gaps: options.gaps, minimums: minimums)
    }

    private mutating func restyle(_ style: TileStyle?, _ workspace: Int) -> TilingOutcome {
        guard let key = key(workspace), var slot = slots[key] else { return .nothing("no window is tiled here") }
        let all = TileStyle.allCases
        let next = style ?? all[(all.firstIndex(of: slot.layout.style)! + 1) % all.count]
        guard next != slot.layout.style else { return .nothing("it is in that style already") }
        slot.layout.setStyle(next, area: slot.area)
        slots[key] = slot
        return .changed
    }

    private mutating func float(_ focused: WindowID?, _ slot: Slot) -> TilingOutcome {
        guard let id = focused, let w = seen[id] else { return .nothing("no window is in front") }
        if w.fixed { return .nothing("a window that can't be resized always floats") }
        if w.over == .scratchpad { return .nothing("it is on the scratchpad") }
        if w.over == .pinned {
            setFloating(id, false)
            return .pin(id, sized: false)
        }
        setFloating(id, !floats(w))
        return .changed
    }

    /// Floats a window, or tiles it, whatever its app's rule says.
    public mutating func setFloating(_ id: WindowID, _ floating: Bool) {
        guard let w = seen[id], !w.fixed else { return }
        if floating { keepPlace(of: id) }
        choice[id] = options.floatApps.contains(w.bundle) == floating ? nil : floating
        asked[id] = nil
    }

    /// Lets go of a window that leaves for the scratchpad; its frame from before tiling, when it had a tile.
    public mutating func release(_ id: WindowID) -> CGRect? {
        asked[id] = nil
        stowed[id] = nil
        for key in slots.keys where slots[key]!.holds(id) { slots[key]!.take(id) }
        for key in slots.keys { slots[key]!.away[id] = nil }
        return before.removeValue(forKey: id)
    }

    /// A window got the focus between two looks: the next window opened goes beside it.
    /// True when its strip has to scroll for it, or its group shows another tab.
    @discardableResult
    public mutating func focused(_ id: WindowID) -> Bool {
        if recent.first != id, seen[id] != nil { recent = [id] + recent.filter { $0 != id } }
        var scrolls = false
        for key in slots.keys where slots[key]!.holds(id) {
            // A hidden window of a group has the focus now: its tab is the one in front.
            if slots[key]!.show(id) { scrolls = true }
            var l = slots[key]!.layout
            l.reveal(id, area: slots[key]!.area, gaps: options.gaps, minimums: needs(slots[key]!))
            scrolls = scrolls || l != slots[key]!.layout
            slots[key]!.focused = id
        }
        return scrolls
    }

    // MARK: Dragging

    /// Where a window held over a tiled workspace in sight would go, for the outline. Nil over its own tile and off every
    /// area.
    public func dropFrame(_ id: WindowID, at point: CGPoint) -> CGRect? {
        if let t = tabs(at: point, for: id) { return t.frame }
        if let (_, slot, drop) = drop(id, at: point) {
            return slot.layout.dropFrame(drop, id, area: slot.area, gaps: options.gaps, minimums: needs(slot))
        }
        // Over another display: where it lands there. A window out of sight isn't in anyone's hand.
        guard let w = seen[id], inSight.contains(w.workspace) else { return nil }
        for workspace in inSight where options.tiles(workspace) {
            guard let key = key(workspace), var slot = slots[key], !slot.holds(id), slot.area.contains(point) else { continue }
            var after = self
            after.landing[id] = point
            after.insert(id, beside: slot.focused, mirrored: options.side == .before, &slot)
            after.slots[key] = slot
            return after.frames(workspace)[id]
        }
        return nil
    }

    /// Lets a dragged window go. True when the layout changed.
    @discardableResult
    public mutating func drop(_ id: WindowID, on point: CGPoint) -> Bool {
        touched(id)
        if let t = tabs(at: point, for: id), let workspace = seen[id]?.workspace, let key = key(workspace), var slot = slots[key] {
            slot.take(id)
            slot.zoomed[id] = nil
            slot.join(id, to: t.front, showing: true)
            slot.focused = id
            slots[key] = slot
            return true
        }
        guard let (key, _, drop) = drop(id, at: point) else { return false }
        // Carried somewhere else it is a tile again.
        slots[key]!.zoomed[id] = nil
        slots[key]!.layout.apply(drop, to: id, area: slots[key]!.area)
        return true
    }

    private func drop(_ id: WindowID, at point: CGPoint) -> (TilingKey, Slot, TileDrop)? {
        for (workspace, display) in lastDisplay {
            let key = TilingKey(workspace, display)
            guard options.tiles(workspace), let slot = slots[key], slot.layout.contains(id), slot.layout.style != .floating else { continue }
            return slot.layout.drop(id, at: point, area: slot.area, gaps: options.gaps, minimums: needs(slot)).map { (key, slot, $0) }
        }
        return nil
    }

    /// A window let go over another display: it lands there, at this point, once it is that display's.
    public mutating func lands(_ id: WindowID, at point: CGPoint) { landing[id] = point }

    /// The person pulled a tiled window's edge from the frame it had and left it at `frame`. True when the layout changed.
    @discardableResult
    public mutating func resized(_ id: WindowID, to frame: CGRect, from start: CGRect? = nil) -> Bool {
        touched(id)
        for (workspace, display) in lastDisplay {
            let key = TilingKey(workspace, display)
            guard options.tiles(workspace), var slot = slots[key], slot.layout.contains(id), slot.layout.style != .floating else { continue }
            // A zoomed window has no edge of its own to pull: it goes back.
            if Self.zoom(of: id, slot) != nil { return false }
            let was = slot.layout
            slot.layout.resize(id, to: frame, from: start, area: slot.area, gaps: options.gaps, minimums: needs(slot))
            slots[key] = slot
            return slot.layout != was
        }
        return false
    }

    /// Whether a window has a tile, and where.
    public func tile(of id: WindowID) -> CGRect? {
        for (workspace, _) in lastDisplay where options.tiles(workspace) { if let f = frames(workspace)[id] { return f } }
        return nil
    }

    /// What a workspace's tiling is now, for the bar and the command line.
    public func style(of workspace: Int) -> TileStyle { key(workspace).flatMap { slots[$0]?.layout.style } ?? options.style }
    public func isFull(_ workspace: Int) -> Bool { key(workspace).flatMap { slots[$0]?.layout.full } ?? false }
    /// The tiled window used last on a workspace.
    public func last(on workspace: Int) -> WindowID? {
        key(workspace).flatMap { slots[$0] }.flatMap { $0.focused ?? $0.layout.windows.first }
    }
    public func windows(of workspace: Int) -> [WindowID] { key(workspace).flatMap { slots[$0]?.all } ?? [] }

    /// The display to the side of another, the nearest of those that share some of its height (or width).
    public static func display(_ d: TileDirection, of from: DisplayKey, in displays: [DisplayKey: CGRect]) -> DisplayKey? {
        guard let f = displays[from] else { return nil }
        return displays.filter { key, r in
            guard key != from else { return false }
            switch d {
            case .left: return r.midX < f.minX && r.minY < f.maxY && r.maxY > f.minY
            case .right: return r.midX > f.maxX && r.minY < f.maxY && r.maxY > f.minY
            case .up: return r.midY < f.minY && r.minX < f.maxX && r.maxX > f.minX
            case .down: return r.midY > f.maxY && r.minX < f.maxX && r.maxX > f.minX
            }
        }.min { a, b in (gap(f, a.value), a.key) < (gap(f, b.value), b.key) }?.key
    }

    private static func gap(_ a: CGRect, _ b: CGRect) -> Double { hypot(a.midX - b.midX, a.midY - b.midY) }

    /// The next display in a fixed order, left to right and top to bottom, around the end.
    public static func display(after from: DisplayKey, in displays: [DisplayKey: CGRect]) -> DisplayKey? {
        let order = displays.sorted { ($0.value.minX, $0.value.minY, $0.key) < ($1.value.minX, $1.value.minY, $1.key) }.map(\.key)
        guard order.count > 1, let i = order.firstIndex(of: from) else { return nil }
        return order[(i + 1) % order.count]
    }
}

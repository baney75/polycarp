import CoreGraphics

/// One window as the engine's scan found it. Sheets, dialogs, panels and popovers never get this far: the scan lists
/// standard windows only.
public struct TilingWindow: Equatable, Sendable {
    public var id: WindowID
    public var pid: Int32
    /// Its app's bundle id, for the float rules.
    public var bundle: String
    public var workspace: Int
    public var frame: CGRect
    /// It can't be resized.
    public var fixed: Bool
    /// Minimized, hidden, in full screen or filled: it leaves the tree and comes back to its place.
    public var away: Bool

    public init(id: WindowID, pid: Int32, bundle: String = "", workspace: Int, frame: CGRect, fixed: Bool = false, away: Bool = false) {
        self.id = id; self.pid = pid; self.bundle = bundle; self.workspace = workspace; self.frame = frame
        self.fixed = fixed; self.away = away
    }
}

/// What tiling looks at: the windows, and the area each workspace in sight may tile.
public struct TilingShot: Equatable, Sendable {
    public struct Place: Equatable, Sendable {
        public var display: DisplayKey
        /// The display's usable area, less the Dock, the menu bar and Polycarp's bar.
        public var area: CGRect
        public init(display: DisplayKey, area: CGRect) { self.display = display; self.area = area }
    }

    public var windows: [TilingWindow]
    /// The workspaces in sight, one a display.
    public var shown: [Int: Place]
    public var focused: WindowID?
    /// The displays' whole frames, and the corner Spaces parks windows in: what `scrolling` needs to put one out of sight.
    public var displays: [CGRect] = []
    public var corner: CGPoint?
    public init(windows: [TilingWindow], shown: [Int: Place], focused: WindowID? = nil) {
        self.windows = windows; self.shown = shown; self.focused = focused
    }
}

/// One frame to write.
public struct TilingMove: Equatable, Sendable {
    public var id: WindowID
    public var pid: Int32
    public var from: CGRect
    public var to: CGRect
}

public enum TilingSide: String, CaseIterable, Codable, Sendable { case after, before }

/// How wide a workspace's only window gets.
public enum TilingLone: Equatable, Sendable {
    case fill
    /// On a wide display, a 16:10 shape in the middle.
    case smart
    case points(Double)

    /// The widest, nil for all of the area.
    func width(in area: CGRect) -> Double? {
        switch self {
        case .fill: nil
        case .points(let w): w
        // A 16:9 display less its bar is under 2 to 1; only an ultrawide is over.
        case .smart: area.width > area.height * 2 ? (area.height * 1.6).rounded() : nil
        }
    }
}

/// What Settings and surfaces.json choose.
public struct TilingOptions: Equatable, Sendable {
    /// Whether a workspace tiles that has no choice of its own, and the ones that have.
    public var everywhere = false
    public var on: Set<Int> = []
    public var off: Set<Int> = []
    public var style = TileStyle.dwindle
    public var gaps = TileGaps()
    public var lone = TilingLone.fill
    public var side = TilingSide.after
    /// Apps whose windows float, by bundle id.
    public var floatApps: Set<String> = []
    /// The workspace agents work on never tiles.
    public var agentWorkspace: Int?

    public init() {}

    public func tiles(_ workspace: Int) -> Bool {
        guard workspace != agentWorkspace else { return false }
        return on.contains(workspace) || everywhere && !off.contains(workspace)
    }
}

/// A workspace's layout is kept for each display it was on, so a display that comes back finds its own again.
public struct TilingKey: Hashable, Codable, Comparable, Sendable {
    public var workspace: Int
    public var display: DisplayKey
    public init(_ workspace: Int, _ display: DisplayKey) { self.workspace = workspace; self.display = display }
    public static func < (a: TilingKey, b: TilingKey) -> Bool { (a.workspace, a.display) < (b.workspace, b.display) }
}

/// Every decision tiling makes, with no window in reach: it takes what the scan saw and says which frames to write. The
/// app writes them and reports where the windows landed.
public struct TilingEngine: Equatable, Sendable {
    /// Writes of one target to one window before it is left where it is, so an app that keeps moving its window, or
    /// refuses to move it, never meets an endless correction.
    public static let mostTries = 3
    /// Times a window's minimum is learned before it is taken as it is.
    public static let mostLessons = 3
    /// Frames this close are the same frame: apps round to their own grid of points.
    public static let close = 1.0
    /// A window this much over its target at most rounded up to its own grid, as a terminal does to whole cells.
    public static let grid = 24.0

    /// A window that left the tree but not the workspace.
    struct Away: Equatable, Sendable {
        /// The layout it left, with it.
        var whole: TileLayout
        var beside: WindowID?
    }

    struct Slot: Equatable, Sendable {
        var layout: TileLayout
        var area = CGRect.zero
        var away: [WindowID: Away] = [:]
        var focused: WindowID?
    }

    /// What was last asked of a window.
    struct Asked: Equatable, Sendable {
        /// Where it was when it was asked.
        var from: CGRect
        var target: CGRect
        var landed: CGRect?
        var tries: Int
        /// Its app moved it when asked, so it isn't busy.
        var answered: Bool
        /// It is on its way back to its frame from before tiling.
        var back: Bool
    }

    public internal(set) var options = TilingOptions()
    var slots: [TilingKey: Slot] = [:]
    /// Where each workspace tiled last, for one that turns up on a display it never tiled on.
    var lastDisplay: [Int: DisplayKey] = [:]
    /// Each tiled window's frame from before tiling.
    var before: [WindowID: CGRect] = [:]
    /// Windows a person floated (true) or tiled against a rule (false).
    var choice: [WindowID: Bool] = [:]
    var minimums: [WindowID: CGSize] = [:]
    /// The size a window rounded its last one up to: no minimum, and only in force for a tile that size.
    var rounded: [WindowID: CGSize] = [:]
    var lessons: [WindowID: Int] = [:]
    /// Times it rounded anew since a look last wrote nothing: more room for one can be what makes the next tile round.
    var roundings: [WindowID: Int] = [:]
    var asked: [WindowID: Asked] = [:]
    /// The windows at the last look: a tab swap is told by one that went as another came in its place.
    var seen: [WindowID: TilingWindow] = [:]
    /// The workspaces in sight at the last look.
    var inSight: Set<Int> = []
    /// Windows by last focus, the latest first.
    var recent: [WindowID] = []
    /// Where a window dragged to another display was let go, until it joins the layout there.
    var landing: [WindowID: CGPoint] = [:]
    /// Saved windows still to turn up, each under a number no window has, and the windows that were (TilingSaved.swift).
    var waiting: [WindowID: Waiting] = [:]
    var claimed: Set<WindowID> = []
    /// Windows scrolled out of sight, and where each comes back in reach when tiling lets go of it.
    public internal(set) var stowed: [WindowID: CGRect] = [:]

    public init() {}

    /// Whether anything is left to do for tiling: while false, the app takes no look at all.
    public func wanted(on shown: [Int]) -> Bool {
        shown.contains { options.tiles($0) } || !before.isEmpty || waiting.values.contains { $0.before != nil }
    }

    /// Takes new settings. A layout still in the old default style takes the new one.
    public mutating func apply(_ new: TilingOptions) {
        let old = options
        options = new
        if old.style != new.style {
            for key in slots.keys where slots[key]!.layout.style == old.style {
                slots[key]!.layout.setStyle(new.style, area: slots[key]!.area)
            }
        }
        // A new gap or width is a new target for every window, so the count of tries starts over by itself.
    }

    /// Whether a window ever takes a tile.
    func floats(_ w: TilingWindow) -> Bool {
        if w.fixed { return true }
        return choice[w.id] ?? options.floatApps.contains(w.bundle)
    }

    /// Brings every layout in sight in line with the windows there are and says which frames to write: none when nothing
    /// changed.
    public mutating func plan(_ shot: TilingShot) -> [TilingMove] {
        let windows = Dictionary(shot.windows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        inSight = Set(shot.shown.keys)
        swapTabs(windows)
        forget(windows)
        if let f = shot.focused, windows[f] != nil, recent.first != f { recent = [f] + recent.filter { $0 != f } }
        var moves: [TilingMove] = []
        // A display on its way out can have no area left for a moment: its layouts wait for a real one.
        for (workspace, place) in shot.shown.sorted(by: { $0.key < $1.key }) where TileBox(place.area).usable {
            let here = shot.windows.filter { $0.workspace == workspace }
            if options.tiles(workspace) {
                arrange(workspace, place, here, focused: shot.focused)
                for w in here { disprove(w) }
                let targets = stow(frames(workspace), place.area, shot)
                for w in here { if let t = targets[w.id], let m = move(w, to: t) { moves.append(m) } }
            }
            // A window that isn't tiled any more, on a workspace in sight, goes back where it was before.
            let tiled = options.tiles(workspace) && style(of: workspace) != .floating
            if !tiled { for w in here { stowed[w.id] = nil } }
            for w in here where !w.away && (!tiled || floats(w)) {
                guard let was = before[w.id] else { continue }
                // On the display it is on now. The frame is owed until the window is there, or won't go there.
                let to = Geometry.restoreFrame(saved: was, size: was.size, screens: [place.area])
                if workspace != options.agentWorkspace, let m = move(w, to: to, back: true) {
                    moves.append(m)
                } else {
                    before[w.id] = nil
                    asked[w.id] = nil
                }
            }
            if !options.tiles(workspace), slots.keys.contains(where: { $0.workspace == workspace }) {
                slots = slots.filter { $0.key.workspace != workspace }
                dropUnneeded()
            }
        }
        seen = windows
        if moves.isEmpty { roundings = [:] }
        return moves
    }

    /// Where the windows ended up after a write. True when something was learned, so the layouts are solved once more, or
    /// when one didn't move at all: its app may have been busy, so it is asked again.
    public mutating func landed(_ frames: [WindowID: CGRect]) -> Bool {
        var learned = false
        for (id, now) in frames {
            guard var a = asked[id] else { continue }
            let there = Self.near(now, a.target)
            let over = CGSize(width: now.width - a.target.width, height: now.height - a.target.height)
            // An app takes a place and a size one after the other: a side it left as it was may only be late.
            let late = Self.near(now, a.from) || over.width > Self.grid && abs(now.width - a.from.width) <= Self.close
                || over.height > Self.grid && abs(now.height - a.from.height) <= Self.close
            a.answered = a.answered || !Self.near(now, a.from)
            asked[id] = a
            if !there, a.tries < Self.mostTries, a.back || late && (a.tries < 2 || !a.answered) {
                if a.tries < 2 { learned = true }
                continue
            }
            if a.back {
                before[id] = nil
                asked[id] = nil
                continue
            }
            a.landed = now
            asked[id] = a
            var least = minimums[id] ?? .zero, round = rounded[id] ?? .zero
            let was = (least, round), learns = lessons[id, default: 0] < Self.mostLessons, rounds = roundings[id, default: 0] < Self.mostLessons
            if over.width > Self.grid { if learns { least.width = max(least.width, now.width) } } else if over.width > Self.close, rounds { round.width = now.width }
            if over.height > Self.grid { if learns { least.height = max(least.height, now.height) } } else if over.height > Self.close, rounds { round.height = now.height }
            guard (least, round) != was else { continue }
            if least != was.0 { lessons[id, default: 0] += 1 }
            if round != was.1 { roundings[id, default: 0] += 1 }
            minimums[id] = least == .zero ? nil : least
            rounded[id] = round == .zero ? nil : round
            learned = true
        }
        return learned
    }

    /// The person took hold of a window: what was asked of it before no longer counts, its way back neither.
    public mutating func touched(_ id: WindowID) {
        if asked.removeValue(forKey: id)?.back == true { before[id] = nil }
    }

    // MARK: The layouts

    /// The key of a workspace's layout now.
    func key(_ workspace: Int) -> TilingKey? { lastDisplay[workspace].map { TilingKey(workspace, $0) } }

    private mutating func arrange(_ workspace: Int, _ place: TilingShot.Place, _ here: [TilingWindow], focused: WindowID?) {
        let key = TilingKey(workspace, place.display)
        var slot = slots[key] ?? self.key(workspace).flatMap { slots[$0] } ?? Slot(layout: TileLayout(style: options.style))
        let fresh = slot.layout.windows.isEmpty && slot.away.isEmpty
        slot.area = place.area
        let tiling = here.filter { !floats($0) }
        let gone = Set(tiling.filter(\.away).map(\.id)).union(waiting.keys), present = Set(tiling.filter { !$0.away }.map(\.id))
        // Windows that leave together each remember the layout with all of them in it.
        let whole = slot.layout
        for id in whole.windows where !present.contains(id) {
            if gone.contains(id) { slot.away[id] = Away(whole: whole, beside: Self.sibling(of: id, in: whole)) }
            slot.layout.remove(id, area: place.area)
        }
        slot.away = slot.away.filter { gone.contains($0.key) || present.contains($0.key) }
        for w in tiling where !w.away { if let was = slot.away.removeValue(forKey: w.id) { bring(w.id, back: was, present, &slot) } }
        // Windows tiled for the first time keep the order they stand in; later ones come beside the focused one.
        let new = tiling.filter { !$0.away && !slot.layout.contains($0.id) }
        let order = fresh ? new.sorted { ($0.frame.minX, $0.frame.minY, $0.id) < ($1.frame.minX, $1.frame.minY, $1.id) }
                          : new.sorted { $0.id < $1.id }
        var beside = fresh ? nil : slot.focused
        for w in order {
            insert(w.id, beside: beside, mirrored: !fresh && options.side == .before, &slot)
            beside = w.id
        }
        // In `floating` a window stays where it is put, so there is no frame to go back to.
        for w in tiling where !w.away && before[w.id] == nil && slot.layout.style != .floating { before[w.id] = w.frame }
        slot.layout.sync(slot.layout.windows, focused: nil, area: place.area)
        if let f = focused, slot.layout.contains(f) { slot.focused = f }
        if let f = slot.focused, !slot.layout.contains(f) { slot.focused = nil }
        slot.layout.reveal(slot.focused, area: place.area, gaps: options.gaps, minimums: minimums)
        slots[key] = slot
        lastDisplay[workspace] = place.display
    }

    /// The frames to write: a window whose place in a scrolled strip is out of sight waits in the corner, at its size.
    private mutating func stow(_ frames: [WindowID: CGRect], _ area: CGRect, _ shot: TilingShot) -> [WindowID: CGRect] {
        var out = frames
        for (id, f) in frames {
            stowed[id] = nil
            guard let corner = shot.corner, id != shot.focused, !TileLayout.shows(f, in: area, displays: shot.displays) else { continue }
            out[id] = CGRect(origin: corner, size: f.size)
            stowed[id] = CGRect(x: area.midX - f.width / 2, y: f.minY, width: f.width, height: f.height).integral
        }
        return out
    }

    mutating func insert(_ id: WindowID, beside: WindowID?, mirrored: Bool, _ slot: inout Slot) {
        let neighbor = beside.flatMap { slot.layout.contains($0) ? $0 : nil } ?? slot.layout.windows.last
        slot.layout.insert(id, beside: beside, area: slot.area)
        if let point = landing.removeValue(forKey: id), let drop = slot.layout.drop(id, at: point, area: slot.area, gaps: options.gaps, minimums: minimums) {
            slot.layout.apply(drop, to: id, area: slot.area)
        } else if mirrored, let neighbor, neighbor != id {
            slot.layout.swap(id, neighbor)
        }
    }

    /// A window back from the Dock or from hiding takes the place it left, when the rest of the layout is as it was.
    /// Else it goes beside the window it was beside.
    func bring(_ id: WindowID, back was: Away, _ present: Set<WindowID>, _ slot: inout Slot) {
        var whole = was.whole
        let now = Set(slot.layout.windows)
        for other in whole.windows where other != id && !now.contains(other) { whole.remove(other, area: slot.area) }
        var without = whole
        without.remove(id, area: slot.area)
        // How it is looked at, full or scrolled, is as it is now.
        (without.full, without.scroll) = (slot.layout.full, slot.layout.scroll)
        (whole.full, whole.scroll) = (slot.layout.full, slot.layout.scroll)
        guard without == slot.layout else { return slot.layout.insert(id, beside: was.beside, area: slot.area) }
        slot.layout = whole
        // Others still away left a layout without this one: theirs has it again too, so they find their places as well.
        for other in slot.away.keys where was.whole.contains(other) {
            var back = was.whole
            (back.full, back.scroll) = (whole.full, whole.scroll)
            var trimmed = back
            for id in back.windows where !whole.contains(id) { trimmed.remove(id, area: slot.area) }
            if trimmed == whole { slot.away[other]!.whole = back }
        }
    }

    private static func sibling(of id: WindowID, in layout: TileLayout) -> WindowID? {
        let order = layout.windows
        guard let i = order.firstIndex(of: id) else { return nil }
        return i > 0 ? order[i - 1] : order.dropFirst().first
    }

    /// Where a workspace's windows go. Windows whose minimums don't fit side by side stack: the one used least shares its
    /// neighbor's tile until there is room again; the tree stays as it was asked for.
    public func frames(_ workspace: Int) -> [WindowID: CGRect] {
        guard let key = key(workspace), let slot = slots[key] else { return [:] }
        var (out, stacked) = tiles(workspace)
        let order = slot.layout.windows
        for id in stacked {
            let i = order.firstIndex(of: id)!
            let host = order[..<i].last { out[$0] != nil && !stacked.contains($0) } ?? order[i...].first { out[$0] != nil && !stacked.contains($0) }
            guard let host, var f = out[host] else { continue }
            // One wider or higher than that tile lies over the next, and not off the display.
            if let m = minimums[id], let box = options.gaps.inset(slot.area) {
                // In a strip its tile may be out of view already.
                let end = CGPoint(x: max(box.x0 + box.width, f.maxX), y: max(box.y0 + box.height, f.maxY))
                f.size = CGSize(width: max(f.width, min(m.width, box.width)), height: max(f.height, min(m.height, box.height)))
                f.origin = CGPoint(x: min(f.minX, end.x - f.width), y: min(f.minY, end.y - f.height))
            }
            out[id] = f
        }
        return out
    }

    /// The tiles of the windows that have one of their own, and the windows that share another's.
    func tiles(_ workspace: Int) -> (own: [WindowID: CGRect], stacked: [WindowID]) {
        guard let key = key(workspace), let slot = slots[key], slot.layout.style != .floating else { return ([:], []) }
        let lone = options.lone.width(in: slot.area).map { CGSize(width: $0, height: .infinity) }
        func solve(_ l: TileLayout) -> [WindowID: CGRect] {
            // A strip scrolls on what is solved: a window stacked or rounded up moves the columns after it.
            var l = l
            l.reveal(slot.focused, area: slot.area, gaps: options.gaps, minimums: minimums)
            let out = l.frames(in: slot.area, gaps: options.gaps, minimums: minimums, loneMax: lone)
            guard !l.full, let least = roundedUp(l, out, slot.area) else { return out }
            l.reveal(slot.focused, area: slot.area, gaps: options.gaps, minimums: least)
            return l.frames(in: slot.area, gaps: options.gaps, minimums: least, loneMax: lone)
        }
        guard !slot.layout.full, !fits(slot.layout, slot.area, minimums) else { return (solve(slot.layout), []) }
        var out = Set<WindowID>()
        func left() -> TileLayout {
            var l = slot.layout
            for id in slot.layout.windows where out.contains(id) { l.remove(id, area: slot.area) }
            return l
        }
        let byUse = slot.layout.windows.sorted { rank($0, slot) > rank($1, slot) }
        for id in byUse where !fits(left(), slot.area, minimums) { out.insert(id) }
        // One that left before it did any good has a tile after all.
        for id in byUse.reversed() where out.contains(id) {
            out.remove(id)
            if !fits(left(), slot.area, minimums) { out.insert(id) }
        }
        return (solve(left()), byUse.filter(out.contains))
    }

    /// The minimums with what windows rounded these tiles up to, as far as there is room. Nil when none did.
    private func roundedUp(_ layout: TileLayout, _ tiles: [WindowID: CGRect], _ area: CGRect) -> [WindowID: CGSize]? {
        var out = minimums
        for (id, r) in rounded.sorted(by: { $0.key < $1.key }) {
            guard let t = tiles[id] else { continue }
            for (side, length, tile) in [(\CGSize.width, r.width, t.width), (\.height, r.height, t.height)] where length > tile && length - tile <= Self.grid {
                var more = out
                more[id, default: .zero][keyPath: side] = length
                if fits(layout, area, more) { out = more }
            }
        }
        return out == minimums ? nil : out
    }

    /// How long ago a window had the focus: the layout's own focused window first, one never seen focused last.
    private func rank(_ id: WindowID, _ slot: Slot) -> Int {
        if id == slot.focused { return -1 }
        return recent.firstIndex(of: id) ?? recent.count + (slot.layout.windows.firstIndex(of: id) ?? 0)
    }

    private func fits(_ layout: TileLayout, _ area: CGRect, _ minimums: [WindowID: CGSize]) -> Bool {
        guard let root = layout.root, let box = options.gaps.inset(area), layout.windows.contains(where: { minimums[$0] != nil }) else { return true }
        if case .window = root { return true }
        let solver = TileSolver(root, in: box, gap: options.gaps.inner, minimums: minimums)
        let cells = solver.grown(box)
        // A strip is as long as it has to be.
        let axes = layout.strip(solver, in: box) == nil ? TileAxis.allCases : [.vertical]
        return axes.allSatisfy { solver.need(root, $0) <= cells.length($0) + 0.5 }
    }

    /// The write that puts a window on its tile, or nil when it is there, stays where it landed when asked, or has been
    /// asked often enough.
    private mutating func move(_ w: TilingWindow, to target: CGRect, back: Bool = false) -> TilingMove? {
        // Tiled again before it was back: its frame from before is owed as any tile's is.
        if !back, asked[w.id]?.back == true { asked[w.id] = nil }
        let a = asked[w.id].flatMap { Self.near($0.target, target) ? $0 : nil }
        if Self.near(w.frame, target) { return nil }
        if let a, let landed = a.landed, Self.near(w.frame, landed) { return nil }
        let tries = a?.tries ?? 0
        guard tries < Self.mostTries else { return nil }
        asked[w.id] = Asked(from: w.frame, target: target, landed: nil, tries: tries + 1, answered: a?.answered ?? false, back: back)
        return TilingMove(id: w.id, pid: w.pid, from: w.frame, to: target)
    }

    /// Seen smaller than the minimum learned: it was busy then, not at its least.
    private mutating func disprove(_ w: TilingWindow) {
        guard let m = minimums[w.id], w.frame.width < m.width - Self.close || w.frame.height < m.height - Self.close else { return }
        minimums[w.id] = CGSize(width: min(m.width, w.frame.width), height: min(m.height, w.frame.height))
    }

    // MARK: Windows that come and go

    /// A native tab that comes to the front is another window of the app at the place of one that went (closed, or no
    /// longer drawn): it takes its slot.
    private mutating func swapTabs(_ now: [WindowID: TilingWindow]) {
        var came = now.values.filter { !$0.away && seen[$0.id]?.away != false }.sorted { $0.id < $1.id }
        guard !came.isEmpty else { return }
        for gone in seen.values.filter({ !$0.away && now[$0.id]?.away != false }).sorted(by: { $0.id < $1.id }) {
            let spots = [gone.frame, asked[gone.id]?.target, asked[gone.id]?.landed].compactMap { $0 }
            guard let i = came.firstIndex(where: { w in
                w.pid == gone.pid && w.workspace == gone.workspace && spots.contains { Self.near($0, w.frame) }
            }) else { continue }
            rename(gone.id, to: came.remove(at: i).id)
        }
    }

    /// `new` has the place of `old`, and floats as it did: to a person they are one window. What else is known of `new`
    /// stays, and of `old` too, which can be a tab that isn't in front and comes out again.
    mutating func rename(_ old: WindowID, to new: WindowID) {
        for key in slots.keys {
            slots[key]!.away[new] = nil
            slots[key]!.layout.replace(old, with: new)
            if slots[key]!.focused == old { slots[key]!.focused = new }
            if let a = slots[key]!.away.removeValue(forKey: old) {
                var whole = a.whole
                whole.replace(old, with: new)
                slots[key]!.away[new] = Away(whole: whole, beside: a.beside)
            }
            for id in slots[key]!.away.keys {
                slots[key]!.away[id]!.whole.replace(old, with: new)
                if slots[key]!.away[id]!.beside == old { slots[key]!.away[id]!.beside = new }
            }
        }
        func carry<T>(_ d: inout [WindowID: T]) { if d[new] == nil, let v = d[old] { d[new] = v } }
        choice[new] = choice[old]
        // A window owed nothing is where the person has it, its other tabs too.
        if before[old] == nil { before[new] = nil }
        if let s = stowed.removeValue(forKey: old) { stowed[new] = s }
        carry(&before); carry(&minimums); carry(&rounded); carry(&lessons); carry(&roundings); carry(&asked); carry(&landing)
        recent = recent.map { $0 == old ? new : $0 }
    }

    /// Drops what is known of windows that closed, and their places on workspaces they left.
    private mutating func forget(_ now: [WindowID: TilingWindow]) {
        func alive<T>(_ d: inout [WindowID: T]) { if d.keys.contains(where: { now[$0] == nil }) { d = d.filter { now[$0.key] != nil } } }
        alive(&before); alive(&choice); alive(&minimums); alive(&rounded); alive(&lessons); alive(&roundings); alive(&asked); alive(&landing); alive(&stowed)
        recent.removeAll { now[$0] == nil }
        claimed.formIntersection(now.keys)
        for key in slots.keys {
            for id in slots[key]!.layout.windows where now[id]?.workspace != key.workspace && waiting[id] == nil {
                slots[key]!.layout.remove(id, area: slots[key]!.area)
            }
            slots[key]!.away = slots[key]!.away.filter { now[$0.key]?.workspace == key.workspace || waiting[$0.key] != nil }
        }
    }

    /// Whether two frames are the same to a person and to an app's grid.
    public static func near(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= close && abs(a.minY - b.minY) <= close
            && abs(a.width - b.width) <= close && abs(a.height - b.height) <= close
    }
}

import AppKit
import BaneySpacesCore

/// Window actions (K2, W1): halves, thirds, quarters, center, maximize, restore, grow and shrink, focus and swap by
/// direction, and the next display. The math is `WindowLayout`; this finds the window, moves it at once (no
/// animation: `Window.setFrame` turns off the app's own), reads back where it landed and keeps it inside the usable
/// area, which leaves room for Polycarp's dock while a script keeps it up.
final class WindowActionsController {
    private let spaces: Spaces
    /// The edge Polycarp's dock keeps on a screen while it stays up, and how much of it.
    private let keptDock: () -> (screen: NSScreen, edge: DockEdge, thickness: CGFloat)?
    private var memory = WindowActionMemory()

    init(spaces: Spaces, keptDock: @escaping () -> (screen: NSScreen, edge: DockEdge, thickness: CGFloat)?) {
        self.spaces = spaces
        self.keptDock = keptDock
    }

    /// Acts on the window in front, or on `wanted` when a check names one (`polycarp://window/...?window=ID`).
    func perform(_ action: WindowAction, window wanted: WindowID? = nil) {
        spaces.windowsInSight { [weak self] front, inSight in self?.run(action, wanted, front, inSight) }
    }

    private typealias Display = (key: DisplayKey, frame: CGRect, visible: CGRect)

    private func run(_ action: WindowAction, _ wanted: WindowID?, _ front: Window?, _ inSight: [Window]) {
        let target = wanted.map { id in inSight.first { $0.id == id } } ?? front
        guard let w = target, !w.isFullScreen, let frame = w.frame else {
            Trace.log("window action \(action.spelling): no window in front to act on")
            return
        }
        memory.keep(only: Set(inSight.map(\.id) + [w.id]))
        let displays = Windows.displays()
        let frames = Dictionary(displays.map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        guard let here = Geometry.display(of: frame, in: frames).flatMap({ k in displays.first { $0.key == k } }) ?? displays.first
        else { return }
        let area = usable(here)
        let others = inSight.filter { $0.id != w.id }.compactMap { o in o.frame.map { (id: o.id, frame: $0) } }

        switch action {
        case let .focus(d):
            guard let id = WindowLayout.neighbor(of: frame, toward: d, among: others), let n = spaces.model.workspace(of: id) else {
                Trace.log("window action \(action.spelling): no window that way")
                return
            }
            Trace.log("window action \(action.spelling) window=\(w.id) to=\(id)")
            spaces.focus(id, on: n)

        case let .swap(d):
            guard let id = WindowLayout.neighbor(of: frame, toward: d, among: others),
                  let o = inSight.first(where: { $0.id == id }), let theirs = o.frame else {
                Trace.log("window action \(action.spelling): no window that way")
                return
            }
            let mineTo = display(of: theirs, displays, frames) ?? here
            let theirsTo = here
            memory.willMove(w.id, from: frame)
            memory.willMove(o.id, from: theirs)
            land(w, theirs, in: usable(mineTo), as: action, step: 0, display: mineTo.key)
            land(o, frame, in: area, as: action, step: 0, display: theirsTo.key)

        case .restore:
            guard let back = memory.restore(w.id) else {
                Trace.log("window action \(action.spelling) window=\(w.id): nothing to restore")
                return
            }
            let to = display(of: back, displays, frames) ?? here
            land(w, back, in: usable(to), as: action, step: 0, display: to.key, remember: false)

        case .nextDisplay, .previousDisplay:
            guard let key = WindowLayout.display(after: here.key, in: displays.map { ($0.key, $0.frame) },
                                                 backward: action == .previousDisplay),
                  let to = displays.first(where: { $0.key == key }) else {
                Trace.log("window action \(action.spelling): one display")
                return
            }
            let toArea = usable(to)
            // A window an action placed keeps its placement on the new display; any other keeps its share of the area.
            let last = memory.last[w.id].flatMap { WindowActionMemory.same($0.landed, frame) ? $0 : nil }
            let goal: CGRect, kept: WindowAction, step: Int
            switch last?.action {
            case let .place(p)?: (goal, kept, step) = (WindowLayout.rect(p, in: toArea, step: last!.step), last!.action, last!.step)
            case .maximize?: (goal, kept, step) = (toArea, .maximize, 0)
            default: (goal, kept, step) = (WindowLayout.fit(Geometry.carry(frame, from: area, to: toArea), in: toArea), action, 0)
            }
            memory.willMove(w.id, from: frame)
            land(w, goal, in: toArea, as: kept, step: step, display: to.key, said: action)

        case .place, .center, .maximize, .grow, .shrink:
            let step = memory.step(action, window: w.id, frame: frame)
            let goal: CGRect = switch action {
            case let .place(p): WindowLayout.rect(p, in: area, step: step)
            case .center: WindowLayout.centered(frame, in: area)
            case .grow: WindowLayout.resized(frame, by: WindowLayout.resizeStep, in: area)
            case .shrink: WindowLayout.resized(frame, by: -WindowLayout.resizeStep, in: area)
            default: area
            }
            memory.willMove(w.id, from: frame)
            land(w, goal, in: area, as: action, step: step, display: here.key)
        }
    }

    /// Moves `w` to `goal` at once and reads it back. An app with a minimum size, or one that snaps to its text cells,
    /// can land bigger or shifted: then it is moved (or sized, if it must) to lie inside `area`.
    private func land(_ w: Window, _ goal: CGRect, in area: CGRect, as action: WindowAction, step: Int, display: DisplayKey,
                      said: WindowAction? = nil, remember: Bool = true) {
        w.setFrame(goal)
        var got = w.frame ?? goal
        if !area.insetBy(dx: -2, dy: -2).contains(got) {
            let inside = WindowLayout.fit(got, in: area)
            if inside.size == got.size { w.setOrigin(inside.origin) } else { w.setFrame(inside) }
            got = w.frame ?? inside
        }
        if remember { memory.landed(w.id, action, step: step, at: got) }
        spaces.windowActionMoved(w.id, to: display)
        Trace.log("window action \((said ?? action).spelling) step=\(step) window=\(w.id) target=\(Self.text(goal)) "
            + "landed=\(Self.text(got)) area=\(Self.text(area))")
    }

    private func display(of r: CGRect, _ displays: [Display], _ frames: [DisplayKey: CGRect]) -> Display? {
        Geometry.display(of: r, in: frames).flatMap { k in displays.first { $0.key == k } }
    }

    /// The display's visible frame, less the edge Polycarp's dock keeps there while a script keeps it up. A dock that
    /// comes and goes covers windows only while the pointer is on it, so it keeps nothing.
    private func usable(_ d: Display) -> CGRect {
        guard let kept = keptDock(), Windows.key(of: kept.screen) == d.key else { return d.visible }
        return WindowLayout.usable(visible: d.visible, dock: (kept.edge, kept.thickness))
    }

    static func text(_ r: CGRect) -> String {
        "\(Int(r.minX.rounded())),\(Int(r.minY.rounded())),\(Int(r.width.rounded()))x\(Int(r.height.rounded()))"
    }
}

import AppKit
import BaneySpacesCore

/// What tiling takes from Spaces: the window list of the last scan, with where the window server has each window now.
/// Nothing here asks an app.
extension Spaces {
    struct TilingView {
        var facts: [TilingFacts]
        var windows: [WindowID: Window]
        var shown: [Int: TilingShot.Place]
        var focused: WindowID?
    }

    /// The workspaces in sight, one for each display.
    var shownWorkspaces: [Int] { model.shown.isEmpty ? [model.current] : Array(model.shown.values) }

    /// The displays' frames, for a command that goes to another one.
    static func displayFrames() -> [DisplayKey: CGRect] {
        Dictionary(Windows.displays().map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
    }

    /// Nil while windows are on the move: a switch, or displays that just changed.
    func tilingView(bar: (DisplayKey) -> CGFloat) -> TilingView? {
        guard active, !switching, !displaysSettling else { return nil }
        let displays = Windows.displays()
        var shown: [Int: TilingShot.Place] = [:]
        for (i, d) in displays.enumerated() {
            guard let n = model.shown.isEmpty ? (i == 0 ? model.current : nil) : model.shown[d.key] else { continue }
            shown[n] = .init(display: d.key, area: TilingRead.area(frame: d.frame, visible: d.visible, bar: bar(d.key)))
        }
        let inSight = Set(model.home.filter { shown[$0.value] != nil }.keys)
        let places = WindowMoves.places(of: inSight)
        let full = Windows.fullScreenFrames()
        var mine: [WindowID: Window] = [:]
        var facts: [TilingFacts] = []
        for (id, n) in model.home {
            guard let w = window(id) else { continue }
            mine[id] = w
            var f = TilingFacts(id: id, pid: w.pid, bundle: "", workspace: n, frame: places[id]?.bounds)
            f.onScreen = places[id]?.onScreen ?? false
            f.minimized = !f.onScreen && isMinimized(id)
            f.parked = !inSight.contains(id) || isParked(id)
            if let frame = f.frame {
                f.filled = filledHere(id, frame: frame)
                f.screenSized = full.contains { TilingEngine.near($0, frame) }
            }
            facts.append(f)
        }
        return TilingView(facts: facts, windows: mine, shown: shown, focused: model.lastFocused[model.current])
    }
}

extension WindowMoves {
    struct Place {
        let bounds: CGRect
        let onScreen: Bool
    }

    /// `bounds(of:)`, with whether each window is drawn on the desktop macOS shows now.
    static func places(of ids: Set<WindowID>) -> [WindowID: Place] {
        describe(ids) { w, bounds in Place(bounds: bounds, onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) == true) }
    }
}

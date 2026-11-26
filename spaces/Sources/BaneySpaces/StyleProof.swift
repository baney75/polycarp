import AppKit
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_STYLE_PROOF=1 Polycarp --render <folder>` proves that nothing in the style sheet's tables is
/// parsed and then ignored: for each selector of a surface it draws and each property that selector takes, it draws the
/// surface with and without one rule that sets it, in a window that is never shown, and prints the pairs whose pixels
/// are the same. Exit 1 when there is one. The bar has its own checks; `:hover` and `transition-duration` need a pointer
/// and time, so they are left to the tests.
@MainActor
enum StyleProof {
    /// A value nobody has by default. Two where a part can have the first already.
    private static let loud: [String: [String]] = [
        "color": ["#ff00ff"], "background": ["#00ff00"], "opacity": ["0.3"], "font-family": ["Zapfino, serif"], "font-size": ["19px"],
        "font-weight": ["900", "100"], "font-style": ["italic"], "letter-spacing": ["6px"], "text-transform": ["uppercase", "lowercase"],
        "font-variant-numeric": ["tabular-nums"], "width": ["901px"], "height": ["33px"], "padding": ["7px 23px 9px 31px"], "gap": ["19px"],
        "border-radius": ["17px", "0"], "border": ["3px solid #ff00ff"], "border-bottom": ["3px solid #ff00ff"],
        "box-shadow": ["0 4px 30px #ff00ff"], "display": ["none"],
    ]
    /// A part whose corners show only on a fill or a line.
    private static let faint = "background: #123456"

    /// Digits nobody can count on in what these parts show.
    private static func cannotShow(_ t: StyleTarget, _ p: StyleProperty) -> Bool {
        p.name == "transition-duration" || (p.name == "font-variant-numeric" && !digits.contains(t))
    }
    private static let digits: Set<StyleTarget> = [.launcher, .launcherRow, .launcherTitle]

    static func run() -> Int32 {
        var failed: [String] = [], tried = 0
        for target in StyleTarget.allCases where target.surface != .bar {
            guard let scenes = scenes(target.surface) else { failed.append("\(target.surface.rawValue): no scene to draw"); continue }
            for selector in target.selectors.flatMap({ s in [s] + target.states.filter { $0 != .hover }.map { s + $0.selector } }) {
                for p in StyleProperty.all where p.applies(to: target) && !cannotShow(target, p) {
                    tried += 1
                    let fill = p.name == "border-radius" && StyleProperty.byName["background"]!.applies(to: target) ? faint + "; " : ""
                    let before = draw(scenes, "\(selector) { \(fill) }")
                    let shows = loud[p.name, default: [p.example]].contains { draw(scenes, "\(selector) { \(fill)\(p.name): \($0); }") != before }
                    if !shows { failed.append("\(selector) { \(p.name) }") }
                }
            }
        }
        failed.forEach { print("style proof: changes nothing: \($0)") }
        print("style proof: \(tried) pairs drawn, \(failed.count) change nothing")
        return failed.isEmpty ? 0 : 1
    }

    /// What a surface looks like with something in every part.
    private static func scenes(_ s: StyleSurface) -> [() -> AnyView]? {
        switch s {
        case .bar: return nil
        case .tiling:
            // The outline at the size of a small window.
            return [{ AnyView(TilingOutlineView().frame(width: 240, height: 160)) }]
        case .launcher:
            let model = LauncherModel(actions: LauncherActions())
            // Under one heading, a selected result and one that isn't, with every part.
            let list = (1...2).map { n in
                LauncherItem(id: "sample\(n)", section: "Sample", title: "Invoice 117\(n)", subtitle: "Downloads", icon: .symbol("doc"), badge: "Installed", run: {})
            }
            return [{
                model.sample(list)
                return AnyView(LauncherView(model: model).frame(width: LauncherView.size(Styles.shared.book.launcher.panel, within: 1512).width, height: 512))
            }]
        }
    }

    private static func draw(_ scenes: [() -> AnyView], _ css: String) -> [Data] {
        Styles.shared.show(StyleSheet.parse(css).sheet)
        return scenes.map { scene in
            let host = NSHostingView(rootView: scene().environment(\.controlActiveState, .key))
            let w = RenderWindow(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false
            w.appearance = NSAppearance(named: Chrome.scheme == .dark ? .darkAqua : .aqua)
            w.contentView = host
            host.frame = NSRect(origin: .zero, size: host.fittingSize)
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            defer { w.contentView = nil }
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return Data() }
            host.cacheDisplay(in: host.bounds, to: rep)
            return rep.tiffRepresentation ?? Data()
        }
    }
}

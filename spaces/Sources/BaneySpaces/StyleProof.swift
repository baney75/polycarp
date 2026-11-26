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
        "border-radius": ["17px", "0", "28px"], "border": ["3px solid #ff00ff"], "border-bottom": ["3px solid #ff00ff"],
        "box-shadow": ["0 4px 30px #ff00ff"], "display": ["none"],
    ]
    /// A part whose corners show only on a fill or a line.
    private static let faint = "background: #123456"

    /// Digits nobody can count on in what these parts show.
    private static func cannotShow(_ t: StyleTarget, _ p: StyleProperty) -> Bool {
        p.name == "transition-duration" || (p.name == "font-variant-numeric" && !digits.contains(t))
    }
    private static let digits: Set<StyleTarget> = [.launcher, .launcherRow, .launcherTitle, .switcher, .switcherItem, .switcherNumber, .switcherLabel, .switcherHint,
                                              .overview, .overviewTile, .overviewNumber, .overviewLabel, .overviewWindow, .overviewTitle,
                                              .notifications, .notificationsSection, .notificationsRow, .notificationsTitle, .notificationsText, .notificationsTime]

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
                    if !shows { failed.append("changes nothing: \(selector) { \(p.name) }") }
                }
            }
        }
        // The calendar under the clock has the notification list's buttons, but not their rules.
        let calendar: [() -> AnyView] = [{ AnyView(BarCalendar(model: CalendarModel(now: Date(timeIntervalSince1970: 1_795_000_000))) {}) }]
        if draw(calendar, "notifications .button { color: #ff00ff; font-size: 19px; }") != draw(calendar, "") {
            failed.append("notifications .button changes the calendar's buttons")
        }
        failed.forEach { print("style proof: \($0)") }
        print("style proof: \(tried) pairs drawn, \(failed.count) failed")
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
        case .switcher:
            // Apps, one app's windows, every window and workspaces: two tiles each, the first selected.
            let icon = NSWorkspace.shared.icon(forFile: "/System/Applications/Mail.app")
            let apps = SwitcherModel(), windows = SwitcherModel(), cards = SwitcherModel(), workspaces = SwitcherModel()
            cards.mode = .windows
            cards.windows = (1...2).map { .init(id: WindowID($0), title: "Inbox \($0)", workspace: $0, app: "Mail", icon: icon) }
            apps.mode = .apps
            windows.mode = .apps
            apps.apps = (1...2).map { .init(pid: pid_t($0), name: "Mail", icon: icon, workspace: $0, windows: 1, isSplit: false, titles: ["Inbox"]) }
            windows.windowBar = .init(pid: 1, name: "Mail", icon: icon, windows: (1...2).map { .init(id: $0, title: "Inbox \($0)", workspace: 1) }, selected: 0)
            workspaces.tiles = [.init(n: 1, icons: [icon], count: 11, isCurrent: true), .init(n: 2, icons: [icon], count: 1, isCurrent: false)]
            return [apps, windows, cards, workspaces].map { model in { AnyView(SwitcherView(model: model)) } }
        case .overview:
            // The workspace you're on, another with windows, and the empty ones' slots.
            let model = ViewerModel()
            let icon = NSWorkspace.shared.icon(forFile: "/System/Applications/Mail.app")
            model.tiles = Dictionary(uniqueKeysWithValues: (1...2).map { n in
                model.icons[WindowID(n)] = icon
                return (n, [Spaces.Entry(id: WindowID(n), pid: 0, app: "Mail", title: "Inbox 1171")])
            })
            return [{ AnyView(ViewerView(model: model, stillBackdrop: true).frame(width: 900, height: 560)) }]
        case .notifications:
            // Two from one app, one app quiet, with every part.
            let watcher = NoticeWatcher()
            var shelf = NoticeShelf()
            for n in 1...2 {
                let node = NoticeNode(subrole: "AXNotificationCenterBanner", label: "Mail 11, Invoice 117\(n)", stacking: "bundleIdentifier=com.apple.mail", children: [
                    NoticeNode(identifier: "title", text: "Invoice 117\(n)"), NoticeNode(identifier: "body", text: "Paid on the 11th, number 1171.")])
                shelf.take(NoticeReader.read([node]), at: Calendar.current.startOfDay(for: Date()).addingTimeInterval(11 * 3600 + 11 * 60))
            }
            watcher.sample(shelf, quiet: ["com.apple.Music": "Music"])
            return [{ AnyView(NoticeList(watcher: watcher, room: 620) {}) }]
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

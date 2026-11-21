import AppKit
import ApplicationServices
import BaneySpacesCore
import SwiftUI

/// Reads what the `app-menus` and `status` modules draw, through Accessibility, and presses what you click. No pixels are
/// copied, so neither needs Screen Recording. Both are read off the main thread, since a busy app can take its whole
/// timeout to answer (the launcher's menu read on main was one cause of the lag fixed 11-21).
enum BarReader {
    /// Where the front app's menus are read, one at a time, so the last app to come forward is the last one read.
    static let queue = DispatchQueue(label: "polycarp.bar.menus", qos: .userInitiated)
    private static let lock = NSLock()
    private static var latest: pid_t = 0

    /// The app whose menus the bar wants now. Any thread.
    static var wanted: pid_t { lock.lock(); defer { lock.unlock() }; return latest }
    static func want(_ pid: pid_t) { lock.lock(); latest = pid; lock.unlock() }

    /// The front app's menu bar: what the bar draws and, by `BarMenus.Item.index`, what a click presses.
    struct Menus {
        var items: [BarMenus.Item] = []
        var press: (Int) -> Void = { _ in }
    }

    /// Polycarp's own menus, from AppKit: asking itself through Accessibility would wait on its own main thread.
    /// The Apple menu isn't Polycarp's to open, so it is left out. Main thread only.
    static func ownMenus(name: String) -> Menus {
        let main = NSApp.mainMenu?.items ?? []
        let titles = [""] + [name] + main.dropFirst().map(\.title)
        return Menus(items: BarMenus.items(titles).filter { $0.role != .apple }) { i in
            guard i >= 1, i - 1 < main.count, let menu = main[i - 1].submenu else { return }
            menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        }
    }

    /// Another app's menus through Accessibility. On `queue`.
    static func menus(of pid: pid_t) -> Menus {
        let titles = menuBar(of: pid).map { $0.string(kAXTitleAttribute) ?? "" }
        return Menus(items: BarMenus.items(titles)) { i in
            guard titles.indices.contains(i) else { return }
            // Read again on the click: an app that rebuilt its menus since would otherwise get the wrong one pressed.
            queue.async {
                let now = menuBar(of: pid)
                let fresh = now.map { $0.string(kAXTitleAttribute) ?? "" }
                guard let at = BarMenus.place(of: i, titles: titles, in: fresh) else { return }
                AXUIElementPerformAction(now[at], kAXPressAction as CFString)
            }
        }
    }

    private static func menuBar(of pid: pid_t) -> [AXUIElement] {
        let bar: AXUIElement? = AX.app(pid).value(kAXMenuBarAttribute)
        return bar?.value(kAXChildrenAttribute) ?? []
    }

    /// One status item, with the element a click presses.
    struct Status {
        var item: BarStatus.Item
        var element: AXUIElement
    }

    /// Every other app's status items (`AXExtrasMenuBar`), in the order read. Any thread.
    static func status(of apps: [(pid: pid_t, bundle: String)]) -> [Status] {
        apps.flatMap { app -> [Status] in
            let ax = AX.app(app.pid, timeout: 0.1)
            let bar: AXUIElement? = ax.value("AXExtrasMenuBar")
            let children: [AXUIElement] = bar?.value(kAXChildrenAttribute) ?? []
            return children.map { el in
                let label = [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute]
                    .lazy.compactMap { el.string($0) }.first { !$0.isEmpty }
                let at: CGPoint? = el.value(kAXPositionAttribute, .cgPoint)
                return Status(item: BarStatus.Item(owner: app.bundle, identifier: el.string(kAXIdentifierAttribute),
                                                   label: label, x: at.map { Double($0.x) }),
                              element: el)
            }
        }
    }

    /// Presses a menu or a status item off the main thread: an app can hold the call until its menu closes.
    static func press(_ element: AXUIElement) {
        DispatchQueue.global(qos: .userInitiated).async {
            AXUIElementPerformAction(element, kAXPressAction as CFString)
        }
    }
}

/// A row that draws its items from the first (or, `fromEnd`, the last) while they fit and leaves the rest out whole
/// (`BarLayout.fit`), so a menu title is never cut.
struct FitRow: Layout {
    var spacing: CGFloat
    var fromEnd = false

    private func shown(_ subviews: Subviews, room: CGFloat?) -> (widths: [CGFloat], range: Range<Int>) {
        let widths = subviews.map { $0.sizeThatFits(.unspecified).width }
        let order = fromEnd ? widths.reversed() : widths
        let n = BarLayout.fit(order.map(Double.init), spacing: Double(spacing), room: room.map(Double.init) ?? .infinity)
        return (widths, fromEnd ? widths.count - n ..< widths.count : 0 ..< n)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let (widths, range) = shown(subviews, room: proposal.width)
        let width = range.reduce(0) { $0 + widths[$1] } + spacing * CGFloat(max(0, range.count - 1))
        let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (widths, range) = shown(subviews, room: bounds.width)
        var x = bounds.minX
        for i in subviews.indices {
            guard range.contains(i) else {
                subviews[i].place(at: CGPoint(x: -10_000, y: -10_000), proposal: .zero)
                continue
            }
            subviews[i].place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: .unspecified)
            x += widths[i] + spacing
        }
    }
}

import AppKit
import ApplicationServices
import BaneySpacesCore
import SwiftUI

/// Reads what the `app-menus` and `status` modules draw, through Accessibility, and presses what you click. No pixels are
/// copied, so neither needs Screen Recording. Both are read off the main thread, since a busy app can take its whole
/// timeout to answer (the launcher's menu read on main was one cause of the lag fixed 11-21).
///
/// What the bar draws is extra, so no read here benches its app for window tracking (`Windows.markUnresponsive`). Until
/// 2026-11-24 one did: an idle Excel or Ghostty takes over the 0.1 s the status read allows (105 ms, measured), every
/// 15 s, and while an app is benched its new window gets no workspace and its parked ones aren't brought back.
enum BarReader {
    /// One app's reads. A timeout is kept here (`missed`) and nowhere else.
    private struct Quiet {
        var missed = false

        mutating func value<T>(_ element: AXUIElement, _ attribute: String) -> T? {
            var raw: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &raw)
            if error == .cannotComplete { missed = true }
            return error == .success ? raw as? T : nil
        }

        mutating func string(_ element: AXUIElement, _ attribute: String) -> String? { value(element, attribute) }

        mutating func point(_ element: AXUIElement) -> CGPoint? {
            guard let raw: AnyObject = value(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
            var at = CGPoint.zero
            return AXValueGetValue(raw as! AXValue, .cgPoint, &at) ? at : nil
        }
    }


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
        let titles = menuTitles(menuBar(of: pid))
        return Menus(items: BarMenus.items(titles)) { i in
            guard titles.indices.contains(i) else { return }
            // Read again on the click: an app that rebuilt its menus since would otherwise get the wrong one pressed.
            queue.async {
                let now = menuBar(of: pid)
                let fresh = menuTitles(now)
                guard let at = BarMenus.place(of: i, titles: titles, in: fresh) else { return }
                AXUIElementPerformAction(now[at], kAXPressAction as CFString)
            }
        }
    }

    private static func menuBar(of pid: pid_t) -> [AXUIElement] {
        var ask = Quiet()
        guard let bar: AXUIElement = ask.value(AX.app(pid), kAXMenuBarAttribute) else { return [] }
        return ask.value(bar, kAXChildrenAttribute) ?? []
    }

    private static func menuTitles(_ bar: [AXUIElement]) -> [String] {
        var ask = Quiet()
        return bar.map { ask.string($0, kAXTitleAttribute) ?? "" }
    }

    /// One status item, with the element a click presses.
    struct Status {
        var item: BarStatus.Item
        var element: AXUIElement
    }

    /// The bar's own waits for apps that didn't answer it, and what each showed last. Read one at a time
    /// (`TopBar.readingStatus`), so nothing guards them.
    private static var statusBench = AXBench()
    private static var lastStatus: [pid_t: [Status]] = [:]

    /// Every other app's status items (`AXExtrasMenuBar`), in the order read. An app that doesn't answer keeps the items
    /// it had and is asked again later each time, so a frozen one doesn't cost its timeout at every read. One read at a
    /// time, any thread.
    static func status(of apps: [(pid: pid_t, bundle: String, launched: Date?)]) -> [Status] {
        let running = Set(apps.map(\.pid))
        statusBench.keep(running)
        lastStatus = lastStatus.filter { running.contains($0.key) }
        for app in apps where !statusBench.isBenched(app.pid, now: Date()) {
            var ask = Quiet()
            let items = status(of: app.pid, bundle: app.bundle, ask: &ask)
            if ask.missed {
                statusBench.missed(app.pid, age: app.launched.map { -$0.timeIntervalSinceNow }, now: Date())
            } else {
                statusBench.answered(app.pid)
                lastStatus[app.pid] = items
            }
        }
        return apps.flatMap { lastStatus[$0.pid] ?? [] }
    }

    private static func status(of pid: pid_t, bundle: String, ask: inout Quiet) -> [Status] {
        guard let bar: AXUIElement = ask.value(AX.app(pid, timeout: 0.1), "AXExtrasMenuBar") else { return [] }
        let children: [AXUIElement] = ask.value(bar, kAXChildrenAttribute) ?? []
        var out: [Status] = []
        for read in children {
            let role = ask.string(read, kAXRoleAttribute)
            let kids: [AXUIElement] = role == "AXGroup" ? ask.value(read, kAXChildrenAttribute) ?? [] : []
            var roles: [String?] = []
            for kid in kids { roles.append(ask.string(kid, kAXRoleAttribute)) }
            let el: AXUIElement
            switch BarStatus.pick(role: role, childRoles: roles) {
            case .itself: el = read
            case .child(let i): el = kids[i]
            case .skip: continue
            }
            var label: String?
            for attribute in [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute] where label == nil {
                if let text = ask.string(el, attribute), !text.isEmpty { label = text }
            }
            let at = ask.point(el) ?? ask.point(read)
            out.append(Status(item: BarStatus.Item(owner: bundle, identifier: ask.string(el, kAXIdentifierAttribute),
                                                   label: label, x: at.map { Double($0.x) }, y: at.map { Double($0.y) }),
                              element: el))
        }
        return out
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

import AppKit
import ApplicationServices
import BaneySpacesCore

/// Watches macOS's notification banners through Accessibility for the bar's `notifications` module and keeps what it saw
/// in a `NoticeShelf`: in memory only, so nothing here is written or logged. It runs only while a bar shows the module.
/// macOS draws no banner during a Focus or for an app set to none, so those never reach the shelf. Main thread only.
final class NoticeWatcher: ObservableObject {
    @Published private(set) var shelf = NoticeShelf()
    /// Apps filed quietly, by `Notice.key`, with the name each is shown by.
    @Published private(set) var quiet: [String: String] = [:]

    private static let bundle = "com.apple.notificationcenterui"
    private static let quietKey = "quietNotices"
    private static let events = [kAXWindowCreatedNotification, kAXCreatedNotification, kAXUIElementDestroyedNotification, kAXLayoutChangedNotification]
    private let queue = DispatchQueue(label: "polycarp.notices", qos: .utility)
    private var observer: AXObserver?
    private var pid: pid_t = 0
    private var check: Timer?
    private var again: Timer?
    private var reading = false, dirty = false

    init() {
        quiet = UserDefaults.standard.dictionary(forKey: Self.quietKey) as? [String: String] ?? [:]
        shelf.quiet = Set(quiet.keys)
    }

    /// For a rendered still.
    func sample(_ shelf: NoticeShelf, quiet: [String: String] = [:]) { self.shelf = shelf; self.quiet = quiet }

    /// On while a bar shows the module; off drops the observer and what was seen.
    func set(on: Bool) {
        guard on != (check != nil) else { return }
        guard on else {
            detach()
            check?.invalidate(); check = nil
            again?.invalidate(); again = nil
            shelf = NoticeShelf()
            shelf.quiet = Set(quiet.keys)
            return
        }
        // Notification Center can restart, and Accessibility can be allowed later: looked at again every 15 seconds.
        let t = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.attach() }
        t.tolerance = 5
        RunLoop.main.add(t, forMode: .common)
        check = t
        attach()
    }

    private func attach() {
        let now = NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundle).first?.processIdentifier ?? 0
        guard now != pid || observer == nil else { return }
        detach()
        guard now > 0, AX.isTrusted else { return }
        var made: AXObserver?
        let callback: AXObserverCallback = { _, _, _, ref in
            guard let ref else { return }
            Unmanaged<NoticeWatcher>.fromOpaque(ref).takeUnretainedValue().read()
        }
        guard AXObserverCreate(now, callback, &made) == .success, let made else { return }
        let me = Unmanaged.passUnretained(self).toOpaque()
        let app = AX.app(now)
        let added = Self.events.filter { AXObserverAddNotification(made, app, $0 as CFString, me) == .success }
        guard !added.isEmpty else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(made), .defaultMode)
        observer = made
        pid = now
        read()
    }

    private func detach() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
        pid = 0
    }

    /// Reads the banners off the main thread, one read at a time; an event during a read is read after it.
    private func read() {
        guard pid > 0 else { return }
        guard !reading else { dirty = true; return }
        reading = true
        let from = pid
        queue.async { [weak self] in
            let reading = NoticeTree.read(from)
            DispatchQueue.main.async { self?.took(reading, from: from) }
        }
    }

    /// `r` is nil when Notification Center didn't answer in full: that says nothing about what is up, so nothing changes.
    private func took(_ r: NoticeReader.Reading?, from: pid_t) {
        reading = false
        guard pid == from else { return }
        if let r {
            var next = shelf
            let came = next.take(r, at: Date())
            if next != shelf { shelf = next }
            for n in came where quiet[n.key] != nil { close(n) }
        }
        if dirty { dirty = false; read(); return }
        // A banner that changes or goes without an event: looked at again each second while one is up.
        again?.invalidate()
        guard shelf.notices.contains(where: \.live) else { return }
        let t = Timer(timeInterval: 1, repeats: false) { [weak self] _ in self?.read() }
        RunLoop.main.add(t, forMode: .common)
        again = t
    }

    // MARK: What you do with them

    func see() { if shelf.unread > 0 { shelf.see() } }

    /// Opens a notification: pressed while its banner is up, so its app shows what it is about; its app after that.
    func open(_ n: NoticeShelf.Notice) {
        if n.live { press(n) { _ in kAXPressAction } } else { openApp(n) }
        shelf.dismiss(n.id)
    }

    func dismiss(_ n: NoticeShelf.Notice) {
        close(n)
        shelf.dismiss(n.id)
    }

    func clear(_ group: NoticeShelf.Group) {
        group.notices.forEach(close)
        shelf.clear(key: group.id)
    }

    func clearAll() {
        shelf.notices.forEach(close)
        shelf.clearAll()
    }

    /// Quiet: Polycarp closes the app's banners as they come and files them without counting them.
    func setQuiet(_ key: String, name: String, _ on: Bool) {
        quiet[key] = on ? name : nil
        shelf.quiet = Set(quiet.keys)
        UserDefaults.standard.set(quiet, forKey: Self.quietKey)
        if on { shelf.notices.filter { $0.key == key }.forEach(close) }
    }

    private func close(_ n: NoticeShelf.Notice) {
        if n.live, n.banner.close != nil { press(n) { $0.close } }
    }

    /// Presses a banner only while the element there still says the same thing: banners move up as others go.
    private func press(_ n: NoticeShelf.Notice, _ action: @escaping (NoticeBanner) -> String?) {
        let from = pid
        guard from > 0 else { return }
        queue.async {
            guard let b = NoticeTree.read(from)?.banners.first(where: { $0.matches(n.banner) }), let name = action(b),
                  let el = NoticeTree.element(b.path, of: from) else { return }
            AXUIElementPerformAction(el, name as CFString)
        }
    }

    func app(_ key: String, name: String) -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: key)
            ?? NSWorkspace.shared.runningApplications.first { $0.localizedName == name && $0.activationPolicy == .regular }?.bundleURL
    }

    private func openApp(_ n: NoticeShelf.Notice) {
        guard let url = app(n.key, name: n.banner.app) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    /// Notification Center itself, as a click on macOS's clock opens it.
    func openCenter() {
        let apps = ["com.apple.controlcenter", "com.apple.systemuiserver"].flatMap { id in
            NSRunningApplication.runningApplications(withBundleIdentifier: id).map { (pid: $0.processIdentifier, bundle: id) }
        }
        queue.async {
            for app in apps {
                var ask = BarReader.Quiet()
                let items = BarReader.status(of: app.pid, bundle: app.bundle, ask: &ask)
                guard let clock = items.first(where: { ($0.item.identifier ?? "").hasSuffix("menuextra.clock") }) else { continue }
                AXUIElementPerformAction(clock.element, kAXPressAction as CFString)
                return
            }
        }
    }

    func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
    }
}

/// Notification Center's elements as `NoticeNode`s, read without benching its process (`BarReader.Quiet`). Any thread.
private enum NoticeTree {
    /// Nil when it didn't answer in full.
    static func read(_ pid: pid_t) -> NoticeReader.Reading? {
        var ask = BarReader.Quiet()
        let nodes = windows(of: pid, &ask).map { w -> NoticeNode in
            // A window past this is cut, which the reader takes as Notification Center open.
            var left = NoticeReader.maxNodes
            return node(w, depth: 0, left: &left, &ask)
        }
        return ask.missed ? nil : NoticeReader.read(nodes)
    }

    private static func windows(of pid: pid_t, _ ask: inout BarReader.Quiet) -> [AXUIElement] { ask.value(AX.app(pid), kAXWindowsAttribute) ?? [] }
    private static func children(_ el: AXUIElement, _ ask: inout BarReader.Quiet) -> [AXUIElement] { ask.value(el, kAXChildrenAttribute) ?? [] }

    private static func node(_ el: AXUIElement, depth: Int, left: inout Int, _ ask: inout BarReader.Quiet) -> NoticeNode {
        left -= 1
        let subrole = ask.string(el, kAXSubroleAttribute) ?? ""
        var actions: CFArray?
        if subrole.hasPrefix("AXNotificationCenter") { AXUIElementCopyActionNames(el, &actions) }
        var n = NoticeNode(subrole: subrole, identifier: ask.string(el, kAXIdentifierAttribute) ?? "", text: ask.string(el, kAXValueAttribute) ?? "",
                           label: ask.string(el, kAXDescriptionAttribute) ?? "", stacking: ask.string(el, "AXStackingIdentifier") ?? "",
                           actions: actions as? [String] ?? [])
        // The widgets are only a sign that Notification Center is open, so nothing under one is read.
        guard depth < NoticeReader.maxDepth, !NoticeReader.isWidget(n) else { return n }
        for c in children(el, &ask) where left > 0 { n.children.append(node(c, depth: depth + 1, left: &left, &ask)) }
        return n
    }

    static func element(_ path: [Int], of pid: pid_t) -> AXUIElement? {
        var ask = BarReader.Quiet()
        var list = windows(of: pid, &ask), at: AXUIElement?
        for i in path {
            guard list.indices.contains(i) else { return nil }
            at = list[i]
            list = children(list[i], &ask)
        }
        return at
    }
}

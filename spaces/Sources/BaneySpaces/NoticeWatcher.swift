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
    private var soonTimer: Timer?
    private var reading = false, dirty = false
    private var misses = 0, polls = 0
    /// How often each quiet notice's banner was asked to close.
    private var closing: [Int: Int] = [:]
    private var attaching = false

    init() {
        quiet = UserDefaults.standard.dictionary(forKey: Self.quietKey) as? [String: String] ?? [:]
        shelf.quiet = Set(quiet.keys)
    }

    deinit { detach() }

    /// The tab a notice's site is open in, and the site's icon (`BrowserHub`), and what goes to one.
    var place: (NoticeBanner) -> BrowserWindows.Front? = { _ in nil }
    var icon: (NoticeShelf.Notice) -> NSImage? = { _ in nil }
    var goTo: (BrowserWindows.Front) -> Void = { _ in }

    /// A download finished: filed while the list is kept.
    func add(_ b: NoticeBanner, opens place: BrowserWindows.Front) { if check != nil { shelf.add(b, opens: place, at: Date()) } }
    func dropOwn(unless held: (BrowserWindows.Front) -> Bool) {
        if shelf.notices.contains(where: { $0.place.map { !held($0) } ?? false }) { shelf.dropOwn(unless: held) }
    }
    /// A site's icon came, or its tab did.
    func sitesChanged() { if !shelf.notices.isEmpty { objectWillChange.send() } }

    /// For a rendered still.
    func sample(_ shelf: NoticeShelf, quiet: [String: String] = [:]) { self.shelf = shelf; self.quiet = quiet }

    /// On while a bar shows the module; off drops the observer and what was seen.
    func set(on: Bool) {
        guard on != (check != nil) else { return }
        guard on else {
            detach()
            check?.invalidate(); check = nil
            again?.invalidate(); again = nil
            soonTimer?.invalidate(); soonTimer = nil
            misses = 0; polls = 0; closing = [:]
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
        guard !attaching, now != pid || observer == nil else { return }
        detach()
        guard now > 0, AX.isTrusted else { return }
        var made: AXObserver?
        let callback: AXObserverCallback = { _, _, _, ref in
            guard let ref else { return }
            Unmanaged<NoticeWatcher>.fromOpaque(ref).takeUnretainedValue().soon()
        }
        guard AXObserverCreate(now, callback, &made) == .success, let made else { return }
        let me = Unmanaged.passUnretained(self).toOpaque()
        attaching = true
        // Each is a call Notification Center must answer, so not on main.
        queue.async { [weak self] in
            let app = AX.app(now)
            let answers = Self.events.map { AXObserverAddNotification(made, app, $0 as CFString, me) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.attaching = false
                // One it didn't answer is asked again in 15 seconds, with the rest.
                guard self.check != nil, answers.contains(.success), !answers.contains(.cannotComplete) else { return }
                CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(made), .commonModes)
                self.observer = made
                self.pid = now
                self.read()
            }
        }
    }

    private func detach() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        observer = nil
        pid = 0
    }

    /// An event: read a quarter second later, so a burst of them (a widget updating) is one read.
    private func soon() {
        guard !reading else { dirty = true; return }
        guard soonTimer == nil else { return }
        let t = Timer(timeInterval: 0.25, repeats: false) { [weak self] _ in self?.read() }
        RunLoop.main.add(t, forMode: .common)
        soonTimer = t
    }

    /// Reads the banners off the main thread, one read at a time; an event during a read is read after it.
    private func read() {
        soonTimer?.invalidate(); soonTimer = nil
        guard pid > 0 else { return }
        guard !reading else { dirty = true; return }
        reading = true
        let from = pid
        queue.async { [weak self] in
            let reading = NoticeTree.read(from)?.reading
            DispatchQueue.main.async { self?.took(reading, from: from) }
        }
    }

    /// `r` is nil when Notification Center didn't answer in full: that says nothing about what is up, so nothing changes.
    private func took(_ r: NoticeReader.Reading?, from: pid_t) {
        reading = false
        guard pid == from else {
            if dirty { dirty = false; read() }
            return
        }
        if let r {
            misses = 0
            var next = shelf
            let came = next.take(r, at: Date())
            if next != shelf { shelf = next }
            polls = came.isEmpty ? polls + 1 : 0
            closeQuiet()
        } else { misses += 1 }
        if dirty { dirty = false; soon(); return }
        // A banner that changes or goes without an event is looked at again each second, and each 5 once it has stayed
        // up for 30. A read that missed is tried again, each time twice as long after, up to 15 seconds.
        again?.invalidate()
        guard misses > 0 || shelf.watching else { return }
        let wait = misses > 0 ? min(15, Double(1 << min(misses - 1, 4))) : polls < 30 ? 1 : 5
        let t = Timer(timeInterval: wait, repeats: false) { [weak self] _ in self?.read() }
        RunLoop.main.add(t, forMode: .common)
        again = t
    }

    /// Closes the banners of quiet apps that are up, each asked at most three times.
    private func closeQuiet() {
        let up = shelf.notices.filter { $0.live && quiet[$0.key] != nil }
        closing = closing.filter { c in up.contains { $0.id == c.key } }
        let ask = up.filter { closing[$0.id, default: 0] < 3 }
        for n in ask { closing[n.id, default: 0] += 1 }
        close(ask)
    }

    // MARK: What you do with them

    func see() { if shelf.unread > 0 { shelf.see() } }

    /// Opens a notification: pressed while its banner is up, so its app shows what it is about; after that the tab its site
    /// is open in, else its app.
    func open(_ n: NoticeShelf.Notice) {
        shelf.dismiss(n.id)
        // A stack only spreads out when pressed.
        guard n.live, !n.banner.stack else { return openApp(n) }
        press([n.banner]) { _ in kAXPressAction } missed: { [weak self] in self?.openApp(n) }
    }

    func dismiss(_ n: NoticeShelf.Notice) {
        close([n])
        shelf.dismiss(n.id)
    }

    func clear(_ group: NoticeShelf.Group) {
        close(group.notices)
        shelf.clear(key: group.id)
    }

    func clearAll() {
        close(shelf.notices)
        shelf.clearAll()
    }

    /// Quiet: Polycarp closes the app's banners as they come and files them without counting them.
    func setQuiet(_ key: String, name: String, _ on: Bool) {
        guard !on || key != NoticeReader.unknown else { return }
        quiet[key] = on ? name : nil
        shelf.quiet = Set(quiet.keys)
        UserDefaults.standard.set(quiet, forKey: Self.quietKey)
        if on { closeQuiet() }
    }

    private func close(_ notices: [NoticeShelf.Notice]) {
        let up = notices.filter { $0.live && $0.banner.close != nil }.map(\.banner)
        if !up.isEmpty { press(up, copies: true) { $0.close } }
    }

    /// Presses the very elements whose words still say the same, all found by one read of its own before the first press:
    /// banners move up as others go. A read Notification Center didn't answer in full is tried again. `missed` is called on
    /// main when there is nothing to press. The presses themselves wait elsewhere: an app can hold one.
    private func press(_ banners: [NoticeBanner], copies: Bool = false, tries: Int = 3, _ action: @escaping (NoticeBanner) -> String?, missed: @escaping () -> Void = {}) {
        let from = pid
        guard from > 0 else { return missed() }
        queue.async { [weak self] in
            guard let tree = NoticeTree.read(from) else {
                return DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    guard tries > 1, let self else { return missed() }
                    self.press(banners, copies: copies, tries: tries - 1, action, missed: missed)
                }
            }
            let presses = NoticeReader.find(banners, in: tree.reading, copies: copies).compactMap { b in
                action(b).flatMap { name in tree.elements[b.path].map { ($0, name) } }
            }
            guard !presses.isEmpty else { return DispatchQueue.main.async(execute: missed) }
            DispatchQueue.global(qos: .userInitiated).async {
                let answers = presses.map { AXUIElementPerformAction($0, $1 as CFString) }
                // One that timed out was still asked.
                if !answers.contains(where: { $0 == .success || $0 == .cannotComplete }) { DispatchQueue.main.async(execute: missed) }
            }
        }
    }

    func app(_ key: String, name: String) -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: key)
            ?? NSWorkspace.shared.runningApplications.first { $0.localizedName == name && $0.activationPolicy == .regular }?.bundleURL
    }

    private func openApp(_ n: NoticeShelf.Notice) {
        if let place = n.place ?? place(n.banner) { return goTo(place) }
        guard let url = app(n.key, name: n.banner.app) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    /// Notification Center itself, as a click on macOS's clock opens it.
    func openCenter(tries: Int = 3) {
        let apps = ["com.apple.controlcenter", "com.apple.systemuiserver"].flatMap { id in
            NSRunningApplication.runningApplications(withBundleIdentifier: id).map { (pid: $0.processIdentifier, bundle: id) }
        }
        queue.async { [weak self] in
            var missed = false
            for app in apps {
                var ask = BarReader.Quiet()
                defer { missed = missed || ask.missed }
                let items = BarReader.status(of: app.pid, bundle: app.bundle, ask: &ask)
                guard let clock = items.first(where: { ($0.item.identifier ?? "").hasSuffix("menuextra.clock") }) else { continue }
                return BarReader.press(clock.element)
            }
            guard missed, tries > 1 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self?.openCenter(tries: tries - 1) }
        }
    }

    func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
    }
}

/// Notification Center's elements as `NoticeNode`s, read without benching its process (`BarReader.Quiet`). Any thread.
private struct NoticeTree {
    var reading: NoticeReader.Reading
    /// The notifications' elements by their path.
    var elements: [[Int]: AXUIElement]

    /// Nil when it didn't answer in full.
    static func read(_ pid: pid_t) -> NoticeTree? {
        var ask = BarReader.Quiet(strict: true), elements: [[Int]: AXUIElement] = [:]
        let windows: [AXUIElement] = ask.value(AX.app(pid), kAXWindowsAttribute) ?? []
        let nodes = windows.enumerated().map { i, w -> NoticeNode in
            // A window past this is cut, which the reader takes as Notification Center open.
            var left = NoticeReader.maxNodes
            return node(w, [i], &left, &ask, &elements)
        }
        return ask.missed ? nil : NoticeTree(reading: NoticeReader.read(nodes, close: closeNames), elements: elements)
    }

    private static func node(_ el: AXUIElement, _ path: [Int], _ left: inout Int, _ ask: inout BarReader.Quiet, _ elements: inout [[Int]: AXUIElement]) -> NoticeNode {
        left -= 1
        AXUIElementSetMessagingTimeout(el, 0.25)
        let subrole = ask.string(el, kAXSubroleAttribute) ?? ""
        var actions: CFArray?
        if subrole.hasPrefix("AXNotificationCenter") {
            elements[path] = el
            if !ask.missed, BarReader.Quiet.gone(AXUIElementCopyActionNames(el, &actions)) { ask.missed = true }
        }
        var n = NoticeNode(subrole: subrole, identifier: ask.string(el, kAXIdentifierAttribute) ?? "", text: ask.string(el, kAXValueAttribute) ?? "",
                           label: ask.string(el, kAXDescriptionAttribute) ?? "", stacking: ask.string(el, "AXStackingIdentifier") ?? "",
                           actions: actions as? [String] ?? [])
        // The widgets are only a sign that Notification Center is open, so nothing under one is read.
        guard path.count <= NoticeReader.maxDepth, !NoticeReader.isWidget(n) else { return n }
        let children: [AXUIElement] = ask.value(el, kAXChildrenAttribute) ?? []
        for (i, c) in children.enumerated() where left > 0 { n.children.append(node(c, path + [i], &left, &ask, &elements)) }
        return n
    }

    /// "Close" in English and, from Notification Center's own strings, in this Mac's language.
    private static let closeNames: Set<String> = {
        let path = "/System/Library/CoreServices/NotificationCenter.app/Contents/Resources/Localizable.loctable"
        guard let data = FileManager.default.contents(atPath: path),
              let table = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let language = Bundle.preferredLocalizations(from: Array(table.keys), forPreferences: Locale.preferredLanguages).first,
              let name = (table[language] as? [String: Any])?["Close"] as? String else { return ["Close"] }
        return ["Close", name]
    }()
}

import AppKit
import BaneySpacesCore

/// The app's side of the browsers running the Polycarp extension: the line to each, what they have open (in memory only),
/// and the person's switch for each kind (Settings > Launcher). Main thread only.
final class BrowserHub {
    static let shared = BrowserHub()
    /// The kinds switched off, by name. Settings writes it and nothing an agent can reach does.
    static let offKey = "browserSourcesOff"

    let book = BrowserBook(allowed: BrowserListing.sources(off: UserDefaults.standard.stringArray(forKey: offKey) ?? []))
    private let server = BrowserServer()
    private var links: [BrowserPeer: BrowserServer.Link] = [:]
    private var icons = BrowserIconBook<NSImage>()
    /// What is open changed; said at most ten times a second.
    var onChange: () -> Void = {}
    /// A download finished.
    var onDone: (BrowserWindows.Front) -> Void = { _ in }
    private var saying = false

    func start() {
        server.joined = { [weak self] link in
            guard let self else { return }
            self.links[link.peer] = link
            self.want(link)
        }
        server.message = { [weak self] m, link in
            guard let self, self.links[link.peer] != nil else { return }
            self.book.take(m, from: link.peer).forEach { self.onDone(.init(link.peer, $0)) }
            self.changed()
        }
        server.icon = { [weak self] i, link in
            guard let self, self.links[link.peer] != nil, let image = NSImage(data: i.png) else { return }
            if self.icons.take(image, for: i.url) { self.changed() }
        }
        server.gone = { [weak self] link in
            // A profile's line that came back before the old one was let go keeps its place.
            guard let self, self.links[link.peer] === link else { return }
            self.links[link.peer] = nil
            self.book.forget(link.peer)
            if self.links.isEmpty { self.icons.clear() }
            self.changed()
        }
        server.start()
    }

    /// Stopped, nothing is held: no browser's line, and none of its rows.
    func stop() {
        server.stop()
        for peer in links.keys { book.forget(peer) }
        links = [:]
        icons.clear()
        changed()
    }

    private func want(_ link: BrowserServer.Link) {
        link.send(["op": "browser.want", "sources": BrowserSource.allCases.filter(book.allowed.contains).map(\.rawValue)])
    }

    private func changed() {
        guard !saying else { return }
        saying = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.saying = false
            self?.onChange()
        }
    }

    func isOn(_ s: BrowserSource) -> Bool { book.allowed.contains(s) }

    /// Off drops what is held at once, and the browser is told to send it no more.
    func set(_ s: BrowserSource, _ on: Bool) {
        var now = book.allowed
        if on { now.insert(s) } else { now.remove(s) }
        UserDefaults.standard.set(BrowserSource.allCases.filter { !now.contains($0) }.map(\.rawValue), forKey: Self.offKey)
        book.allow(now)
        icons.clear()
        links.values.forEach(want)
        changed()
    }

    /// A row's site's icon, as its browser has it. Asked for the first time it is wanted; `onChange` follows.
    func icon(_ hit: BrowserHit) -> NSImage? { icon(hit.row, hit.peer) }
    func icon(_ row: BrowserRow, _ peer: BrowserPeer) -> NSImage? { icon(row.url, peer) }
    private func icon(_ url: String, _ peer: BrowserPeer) -> NSImage? {
        let (image, ask) = icons.icon(url)
        if let ask { links[peer]?.send(["op": "browser.icon", "url": ask]) }
        return image
    }

    /// A notice's site: the tab it is open in, and its icon, the browser's copy whether it is open or not.
    private func site(_ b: NoticeBanner) -> (site: String, bundleID: String)? {
        for app in Set(links.keys.map(\.bundleID)) { if let s = BrowserNotices.site(b, from: app) { return (s, app) } }
        return nil
    }
    func place(_ b: NoticeBanner) -> BrowserWindows.Front? { site(b).flatMap { book.tab(on: $0.site, of: $0.bundleID) } }
    func icon(_ n: NoticeShelf.Notice) -> NSImage? {
        if let p = n.place { return icon(p.tab.url, p.peer) }
        guard let s = site(n.banner), let peer = peers(of: s.bundleID).first else { return nil }
        return place(n.banner).flatMap { icon($0.tab.url, $0.peer) } ?? icon("https://" + s.site + "/", peer)
    }

    /// Moves a tab group to one of the browser's windows, or to a new one.
    func send(_ group: BrowserRow, in peer: BrowserPeer, to window: Any) -> Bool {
        guard let id = Int(group.key), let link = links[peer] else { return false }
        link.send(["op": "browser.group", "group": id, "window": window])
        return true
    }

    /// The front tab of each of a browser's windows that is known for sure (`BrowserWindows`).
    func fronts(of bundleID: String, _ windows: [(id: UInt32, title: String)], items: [Item]) -> [UInt32: BrowserWindows.Front] {
        guard links.keys.contains(where: { $0.bundleID == bundleID }) else { return [:] }
        return BrowserWindows.match(windows, book.fronts(of: bundleID), numbers: BrowserWindows.numbers(items, of: bundleID))
    }

    /// Searches with a browser's own engine, in a new tab there: the main browser if it is here, else the first that is.
    func searcher(main: String?) -> BrowserPeer? { links.keys.sorted { ($0.bundleID != main ? 1 : 0, $0) < ($1.bundleID != main ? 1 : 0, $1) }.first }
    /// Whether any browser is on the line.
    var isHere: Bool { !links.isEmpty }
    func peers(of bundleID: String) -> [BrowserPeer] { links.keys.filter { $0.bundleID == bundleID }.sorted() }

    /// Opens `what` (an address, a search or nothing) in a browser, in one of its windows, a new one or the one in front.
    @discardableResult
    func open(_ what: [String: Any], in peer: BrowserPeer, window: Any? = nil) -> Bool {
        guard let link = links[peer] else { return false }
        link.send(what.merging(["op": "browser.open", "window": window as Any?].compactMapValues { $0 }) { $1 })
        return true
    }

    /// Asks the row's browser for what it can only do itself. False when that browser is gone.
    @discardableResult
    func ask(_ hit: BrowserHit) -> Bool {
        guard let message = BrowserListing.ask(hit.row), let link = links[hit.peer] else { return false }
        link.send(message)
        return true
    }
}

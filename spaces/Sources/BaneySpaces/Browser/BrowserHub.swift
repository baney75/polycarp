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
    /// What is open changed; said at most ten times a second.
    var onChange: () -> Void = {}
    private var saying = false

    func start() {
        server.joined = { [weak self] link in
            guard let self else { return }
            self.links[link.peer] = link
            self.want(link)
        }
        server.message = { [weak self] m, link in
            guard let self, self.links[link.peer] != nil else { return }
            self.book.take(m, from: link.peer)
            self.changed()
        }
        server.gone = { [weak self] link in
            // A profile's line that came back before the old one was let go keeps its place.
            guard let self, self.links[link.peer] === link else { return }
            self.links[link.peer] = nil
            self.book.forget(link.peer)
            self.changed()
        }
        server.start()
    }

    /// Stopped, nothing is held: no browser's line, and none of its rows.
    func stop() {
        server.stop()
        for peer in links.keys { book.forget(peer) }
        links = [:]
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
        links.values.forEach(want)
        changed()
    }

    /// Asks the row's browser for what it can only do itself. False when that browser is gone.
    @discardableResult
    func ask(_ hit: BrowserHit) -> Bool {
        guard let message = BrowserListing.ask(hit.row), let link = links[hit.peer] else { return false }
        link.send(message)
        return true
    }
}

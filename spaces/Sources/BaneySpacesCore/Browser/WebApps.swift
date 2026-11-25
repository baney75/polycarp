import Foundation

/// A site the person made an app of: a launcher entry that opens it in a window of its own in its browser.
public struct WebApp: Codable, Equatable, Sendable {
    public let id: String
    public var name: String
    public let url: String
    /// The browser it opens in, by bundle id.
    public let browser: String
    /// The browser's copy of the site's icon when it was made, a PNG.
    public var icon: Data?
}

/// The list of them, which is the person's: made and removed in the launcher, kept in `webapps.json`.
public enum WebApps {
    public static let most = 100
    static let iconMost = 65_536

    /// What both the file and a browser's word for an app's window must look like.
    public static func isID(_ s: String) -> Bool {
        (1...40).contains(s.utf8.count) && s.utf8.allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }
    }

    /// What to call it, for the person to change: the last part of a title ("Inbox - Mail"), else the site.
    public static func name(title: String, site: String) -> String {
        var last = Substring(title)
        for mark in [" - ", " \u{2013} ", " \u{2014} ", " | ", " \u{B7} "] { last = last.range(of: mark, options: .backwards).map { last[$0.upperBound...] } ?? last }
        let name = NoticeReader.clean(String(last), most: 40).trimmingCharacters(in: .whitespaces)
        return name.isEmpty || BrowserMessage.web(title) ? site : name
    }

    /// The list with a page made an app: one made of it before in that browser takes the new name. Nil for an address
    /// that isn't a web page's, a name with nothing in it, or a full list.
    public static func adding(_ name: String, url: String, browser: String, icon: Data?, to list: [WebApp], id: String = UUID().uuidString.lowercased()) -> (list: [WebApp], app: WebApp)? {
        let name = NoticeReader.clean(name, most: 40).trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, BrowserMessage.web(url), isID(id) else { return nil }
        let icon = icon.flatMap { $0.count <= iconMost ? $0 : nil }
        var list = list
        if let i = list.firstIndex(where: { $0.url == url && $0.browser == browser }) {
            list[i].name = name
            list[i].icon = icon ?? list[i].icon
            return (list, list[i])
        }
        guard list.count < most else { return nil }
        let app = WebApp(id: id, name: name, url: url, browser: browser, icon: icon)
        return (list + [app], app)
    }

    /// The apps in the file; nil when it is there and can't be read, so nothing is written over it.
    public static func decode(_ data: Data?) -> [WebApp]? {
        guard let data else { return [] }
        guard let list = try? JSONDecoder().decode([WebApp].self, from: data) else { return nil }
        return Array(list.filter { isID($0.id) && BrowserMessage.web($0.url) && !$0.name.isEmpty }.prefix(most)).map {
            var app = $0
            if (app.icon?.count ?? 0) > iconMost { app.icon = nil } // an icon too large to have been kept goes; the app stays
            return app
        }
    }

    public static func encode(_ list: [WebApp]) -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(list)) ?? Data("[]".utf8)
    }

    /// Those whose name answers what is typed, best first.
    public static func find(_ typed: String, in list: [WebApp]) -> [WebApp] {
        let q = Fuzzy.fold(typed)
        guard !q.isEmpty else { return [] }
        let found = list.compactMap { a -> (app: WebApp, score: Int)? in Fuzzy.score(folded: q, key: SearchKey(a.name)).map { (a, $0) } }
        return found.sorted { $0.score != $1.score ? $0.score > $1.score : $0.app.name < $1.app.name }.map(\.app)
    }
}

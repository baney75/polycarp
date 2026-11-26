import Foundation

/// A site's icon as the extension sends it (`{"op":"browser.icon","url":...,"png":base64}`): the browser's own copy, never
/// loaded from the network. Anything but a small PNG is left out.
public struct BrowserIcon: Sendable {
    public let url: String
    public let png: Data
    static let most = 64 << 10

    public init?(_ data: Data) {
        guard data.count < Self.most * 2, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["op"] as? String == "browser.icon",
              let url = o["url"] as? String, let png = (o["png"] as? String).flatMap({ Data(base64Encoded: $0) }),
              png.count <= Self.most, png.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) else { return nil }
        self.url = url
        self.png = png
    }
}

/// Which icons to ask for: one a site, once, for the rows on screen. Holds at most `most` sites, the oldest let go.
/// In memory only, and emptied with the browser's record.
public struct BrowserIconBook<Image> {
    private var images: [String: Image] = [:]
    private var order: [String] = []
    /// The page each site's icon was asked for with.
    private var asked: [String: String] = [:]
    private let most: Int
    public init(most: Int = 400) { self.most = most }

    /// The icon of a page's site, or nil and the page to ask the browser about when nobody has.
    public mutating func icon(_ url: String) -> (image: Image?, ask: String?) {
        let site = BrowserMessage.site(url)
        guard !site.isEmpty else { return (nil, nil) }
        if let image = images[site] { return (image, nil) }
        guard asked[site] == nil else { return (nil, nil) }
        asked[site] = url
        order.append(site)
        if order.count > most {
            let old = order.removeFirst()
            images[old] = nil
            asked[old] = nil
        }
        return (nil, url)
    }

    /// Whether the icon was one asked for; nothing else is kept.
    public mutating func take(_ image: Image, for url: String) -> Bool {
        let site = BrowserMessage.site(url)
        guard asked[site] == url, images[site] == nil else { return false }
        images[site] = image
        return true
    }

    public mutating func clear() {
        images = [:]
        order = []
        asked = [:]
    }
}

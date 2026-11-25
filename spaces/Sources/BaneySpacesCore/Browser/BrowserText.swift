import Foundation

/// A page's readable text, which the person asked to look at (`{"op":"browser.text","tab":4,"title":...,"text":...}`).
/// Held only while the quick look is open: it isn't `Codable`, and printing, dumping or interpolating one says only its
/// size, so no log line or crash text can carry the page.
public struct BrowserText: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let tab: Int
    public let title: String
    /// Its paragraphs, each one line.
    public let paragraphs: [String]

    static let most = 100_000

    public init?(_ data: Data) {
        guard data.count <= NewTabHost.maxMessage, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              o["op"] as? String == "browser.text", BrowserMessage.flag(o["tab"]) == nil, let tab = o["tab"] as? Int,
              let text = o["text"] as? String else { return nil }
        var kept = 0
        var paragraphs: [String] = []
        for line in text.split(whereSeparator: \.isNewline) where kept < Self.most {
            let p = NoticeReader.clean(String(line), most: Self.most - kept)
            guard !p.isEmpty else { continue }
            paragraphs.append(p)
            kept += p.count
        }
        guard !paragraphs.isEmpty else { return nil }
        self.tab = tab
        self.title = NoticeReader.clean(o["title"] as? String ?? "", most: BrowserMessage.titleMost)
        self.paragraphs = paragraphs
    }

    public var description: String { "page text (\(paragraphs.count) paragraphs)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

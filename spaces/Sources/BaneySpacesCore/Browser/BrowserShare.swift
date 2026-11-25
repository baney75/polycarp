import Foundation

/// Sharing a page (spec/browser.md R-B17): a tab to the extension's Reader or library, a line in the person's notes
/// file, and text chosen on a page to the launcher. Only what the person points at moves, and only when they ask.
public enum BrowserShare {
    public enum Place: String, CaseIterable, Sendable { case reader, library }

    /// Asks the tab's browser to open it in its Reader or save it to its library; nil for a row with no web page.
    public static func send(_ tab: BrowserRow, to place: Place) -> [String: Any]? {
        guard tab.source == .tabs, BrowserMessage.web(tab.url), let id = Int(tab.key) else { return nil }
        return ["op": "browser.send", "tab": id, "to": place.rawValue]
    }

    /// Asks the tab's browser for the page's readable text, for a quick look; nil for a row with no web page.
    public static func read(_ tab: BrowserRow) -> [String: Any]? {
        guard let id = send(tab, to: .reader)?["tab"] else { return nil }
        return ["op": "browser.read", "tab": id]
    }

    /// The text asked for: from the browser asked, of the tab asked about, and in time. Anything else is dropped.
    public struct Asked: Equatable, Sendable {
        public let peer: BrowserPeer
        public let tab: Int
        public let until: Date
        public init?(_ tab: BrowserRow, in peer: BrowserPeer, at now: Date = Date(), wait: TimeInterval = 10) {
            guard let id = read(tab)?["tab"] as? Int else { return nil }
            (self.peer, self.tab, until) = (peer, id, now.addingTimeInterval(wait))
        }
        public func takes(_ text: BrowserText, from peer: BrowserPeer, at now: Date = Date()) -> Bool {
            peer == self.peer && text.tab == tab && now <= until
        }
    }

    /// `- [Title](address) 2026-11-25` and a line's end, as Markdown reads it; nil for a row with no web page.
    public static func line(_ tab: BrowserRow, on day: Date, calendar: Calendar = .current) -> String? {
        guard BrowserMessage.web(tab.url) else { return nil }
        var title = ""
        for c in tab.title { title += "\\[]*_`<>".contains(c) ? "\\\(c)" : String(c) }
        var url = ""
        for c in tab.url { url += c == "(" ? "%28" : c == ")" ? "%29" : c == " " ? "%20" : c == "<" ? "%3C" : c == ">" ? "%3E" : String(c) }
        let d = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "- [%@](%@) %04d-%02d-%02d\n", title, url, d.year ?? 0, d.month ?? 0, d.day ?? 0)
    }

    /// Adds a line at the end of the file, which is made when it isn't there. Nil when it worked, else what to tell the
    /// person.
    public static func append(_ line: String, to file: URL) -> String? {
        let fm = FileManager.default
        var folder: ObjCBool = false
        if fm.fileExists(atPath: file.path, isDirectory: &folder) {
            if folder.boolValue { return "\(file.lastPathComponent) is a folder" }
        } else if !fm.createFile(atPath: file.path, contents: nil) {
            return "Couldn't make \(file.lastPathComponent)"
        }
        guard let h = try? FileHandle(forUpdating: file) else { return "Couldn't open \(file.lastPathComponent)" }
        defer { try? h.close() }
        do {
            let end = try h.seekToEnd()
            var text = Data(line.utf8)
            if end > 0 {
                try h.seek(toOffset: end - 1)
                if try h.read(upToCount: 1) != Data([0x0A]) { text.insert(0x0A, at: 0) }
            }
            try h.write(contentsOf: text)
            return nil
        } catch {
            return "Couldn't write to \(file.lastPathComponent)"
        }
    }

    static let findMost = 200

    /// Text the person chose on a page, for the launcher (`{"op":"browser.find","text":...}`): one line of at most 200
    /// characters, or nil.
    public static func find(_ data: Data) -> String? {
        guard data.count < 4096, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              o["op"] as? String == "browser.find", let text = o["text"] as? String else { return nil }
        let clean = NoticeReader.clean(text, most: findMost)
        return clean.isEmpty ? nil : clean
    }
}

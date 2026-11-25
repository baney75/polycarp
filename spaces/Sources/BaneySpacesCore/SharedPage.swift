import Foundation

/// The page a person last shared with their agents from the extension's popup, so an agent can write an edit for a page
/// it can't see: its parts, each with the selector that names it and its first words, and what the agents' edits matched
/// on it. Kept in shared-page.json for an hour, readable by this account only. What it holds was written by a website,
/// so it is data to an agent, never instructions.
public enum SharedPage {
    public static let name = "shared-page.json"
    public static let keptFor: TimeInterval = 3600
    public static let maxBytes = 256 * 1024
    public static let maxParts = 300
    public static let maxTitle = 300
    public static let maxIs = 30
    public static let maxWords = 160

    public static func path(surfacesFile: String = SurfacesFile.path()) -> String {
        URL(fileURLWithPath: surfacesFile).deletingLastPathComponent().appendingPathComponent(name).path
    }

    /// A page as the extension sends it, checked. Its address loses its query and fragment, which can hold a secret.
    public static func page(_ v: SurfaceValue) -> Result<SurfaceValue, SurfacesIssue> {
        guard let o = v.object else { return .failure(SurfacesIssue("page", "must be an object")) }
        guard let url = o["url"]?.string, url.utf16.count <= 8192, Edits.webURL(url), var parts = URLComponents(string: url) else {
            return .failure(SurfacesIssue("page.url", "is not a web address"))
        }
        parts.query = nil
        parts.fragment = nil
        guard let address = parts.string, let title = o["title"]?.string else { return .failure(SurfacesIssue("page.title", "must be a string")) }
        guard let list = o["parts"]?.array, list.count <= maxParts else { return .failure(SurfacesIssue("page.parts", "is a list of at most \(maxParts)")) }
        var out: [SurfaceValue] = []
        for (i, p) in list.enumerated() {
            guard let p = p.object, let at = p["at"]?.string, !at.isEmpty, at.utf16.count <= Edits.maxSelector, let what = p["is"]?.string else {
                return .failure(SurfacesIssue("page.parts[\(i)]", "has at, a selector, and is, what it is"))
            }
            var part: [String: SurfaceValue] = ["at": .string(cut(at, Edits.maxSelector)), "is": .string(cut(what, maxIs))]
            if let words = p["words"]?.string, !words.isEmpty { part["words"] = .string(cut(words, maxWords)) }
            if let n = p["count"]?.integer, n > 1 { part["count"] = .number(Double(n)) }
            out.append(.object(part))
        }
        var edits: [SurfaceValue] = []
        for (i, e) in (o["edits"]?.array ?? []).prefix(Edits.maxEdits).enumerated() {
            guard let id = e.object?["id"]?.string, id.utf16.count <= 64, let hits = e.object?["hits"]?.array, hits.count <= Edits.maxChanges else {
                return .failure(SurfacesIssue("page.edits[\(i)]", "has id and hits"))
            }
            edits.append(.object(["id": .string(cut(id, 64)), "hits": .array(hits.map { .number(Double(max(0, $0.integer ?? 0))) })]))
        }
        return .success(.object(["url": .string(address), "title": .string(cut(title, maxTitle)), "parts": .array(out), "edits": .array(edits)]))
    }

    /// The start of it, on one line: a page's words are printed in a terminal, so none of them is a control character.
    private static func cut(_ s: String, _ n: Int) -> String {
        let line = String(String.UnicodeScalarView(s.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }))
        return line.utf16.count <= n ? line : String(decoding: Array(line.utf16.prefix(n)), as: UTF16.self)
    }

    /// Keeps the page in place of the last one; null takes back what was shared.
    public static func share(_ v: SurfaceValue?, to path: String, now: Date = Date()) -> Result<Void, SurfacesIssue> {
        guard let v, v != .null else {
            return unlink(path) == 0 || errno == ENOENT ? .success(()) : .failure(SurfacesIssue(name, "can't be removed: \(String(cString: strerror(errno)))"))
        }
        return page(v).flatMap { page in
            do {
                try SurfacesFile.write(.object(["version": .number(1), "sharedAt": .number(now.timeIntervalSince1970.rounded()), "page": page]),
                                       to: path, limit: maxBytes, mode: 0o600)
                return .success(())
            } catch { return .failure(SurfacesIssue(name, "can't be written: \(error)")) }
        }
    }

    /// The page shared in the last hour, with when. An older one is removed.
    public static func load(path: String, now: Date = Date()) -> SurfaceValue? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        guard data.count <= maxBytes, case .success(let v) = SurfaceValue.parse(data), let at = v.object?["sharedAt"]?.integer, let page = v.object?["page"],
              (-60...keptFor).contains(now.timeIntervalSince1970 - Double(at)) else {
            unlink(path)
            return nil
        }
        return .object(["sharedAt": .string(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(at)))), "page": page])
    }
}

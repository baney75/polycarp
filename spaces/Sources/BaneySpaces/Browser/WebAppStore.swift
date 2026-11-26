import AppKit
import BaneySpacesCore

/// The person's web apps (`webapps.json`), read once and written as they are made and removed. Main thread only.
final class WebAppStore {
    static let shared = WebAppStore(at: Spaces.folder.appendingPathComponent("webapps.json"))

    private let file: URL
    private let readable: Bool
    private(set) var list: [WebApp]
    private var images: [String: NSImage] = [:]

    init(at file: URL, list made: [WebApp] = []) {
        self.file = file
        let read = FileManager.default.fileExists(atPath: file.path) ? WebApps.decode((try? Data(contentsOf: file)) ?? Data()) : made
        readable = read != nil
        list = read ?? []
    }

    func image(_ app: WebApp) -> NSImage? {
        if let known = images[app.id] { return known }
        let image = app.icon.flatMap { NSImage(data: $0) }
        images[app.id] = image
        return image
    }

    /// Nil when it was kept, else why not.
    func add(_ name: String, url: String, browser: String, icon: NSImage?) -> String? {
        let png = icon?.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }
        guard let (list, app) = WebApps.adding(name, url: url, browser: browser, icon: png, to: list) else {
            return "It needs a name and a web page's address, and there is room for \(WebApps.most) apps."
        }
        images[app.id] = nil
        return keep(list)
    }

    func remove(_ app: WebApp) -> String? { keep(list.filter { $0.id != app.id }) }

    private func keep(_ new: [WebApp]) -> String? {
        guard readable else { return "\(file.lastPathComponent) can't be read. Fix or delete it first, so nothing in it is lost." }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try WebApps.encode(new).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { return error.localizedDescription }
        list = new
        return nil
    }
}

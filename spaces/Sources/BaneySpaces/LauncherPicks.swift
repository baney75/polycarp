import Foundation

/// What you pick from the launcher, kept on this Mac only in `launcher-picks.json` next to
/// state.json (spec/launcher.md R-L10). Every key in it is a hash: the file names no app, window
/// or query, and nothing about a pick is logged.
final class LauncherPicks {
    static let shared = LauncherPicks()
    private(set) var frecency: Frecency
    private let url = Spaces.folder.appendingPathComponent("launcher-picks.json")
    private let queue = DispatchQueue(label: "Polycarp launcher picks", qos: .utility)

    private init() {
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode(Frecency.self, from: data) {
            frecency = saved
            return
        }
        // First run: start from the launcher's recent apps, a day apart, the latest heaviest.
        var f = Frecency()
        let now = Date()
        for (i, path) in (UserDefaults.standard.stringArray(forKey: "launcherRecents") ?? []).enumerated() {
            f.picked("app:" + path, query: "", at: now - Double(i) * 86_400)
        }
        frecency = f
        save()
    }

    func picked(_ id: String, query: String) {
        frecency.picked(id, query: query)
        save()
    }

    private func save() {
        var f = frecency
        f.prune()
        let url = url
        queue.async {
            guard let data = try? JSONEncoder().encode(f) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }
}

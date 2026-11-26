import AppKit
import BaneySpacesCore

/// Layouts across restarts: kept in the app's own folder, matched to the windows there are by identity, then app and title
/// hash. A file that can't be read is a fresh start.
extension Tiling {
    private static let file = Spaces.folder.appendingPathComponent("tiling.json")
    private static let keyFile = Spaces.folder.appendingPathComponent("tiling.key")

    /// The layouts as they were kept, the first time anything tiles.
    func load() {
        guard !loaded else { return }
        loaded = true
        titleKey = TitleHash.key(at: Self.keyFile)
        savedLast = try? Data(contentsOf: Self.file)
        if let saved = TilingSaved.read(savedLast, now: Date().timeIntervalSince1970) { engine.restore(saved) }
    }

    /// Creation order among the windows of its process, for `WindowPairing`.
    private func order(_ f: TilingFacts, _ all: some Sequence<TilingFacts>) -> Int { all.filter { $0.pid == f.pid && $0.id < f.id }.count }

    func claim(_ facts: [TilingFacts]) {
        guard engine.awaits else { return }
        engine.claim(facts.map { f in
            (LiveWindow(id: f.id, bundle: f.bundle, title: spaces.title(of: f.id), order: order(f, facts), pid: f.pid, key: titleKey), f.workspace)
        })
    }

    func saveSoon() {
        guard saving == nil else { return }
        let work = DispatchWorkItem { [weak self] in self?.save() }
        saving = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    /// Writes what is kept when it changed. The disk write is off the main thread.
    func save() {
        saving?.cancel()
        saving = nil
        guard loaded else { return }
        // To the day: the age only decides what is dropped two weeks on.
        let day = (Date().timeIntervalSince1970 / 86_400).rounded(.down) * 86_400
        let saved = engine.saved { [self] id in
            guard let f = facts[id] else { return nil }
            return WindowRecord(bundle: f.bundle, title: spaces.title(of: id), order: order(f, facts.values), workspace: f.workspace,
                                frame: nil, displays: [], window: id, pid: f.pid, at: day, key: titleKey)
        }
        guard let data = saved.data(), data != savedLast else { return }
        savedLast = data
        Spaces.writer.async { PrivateFile.write(data, to: Self.file) }
    }
}

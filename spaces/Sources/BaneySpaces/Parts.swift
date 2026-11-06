import AppKit
import BaneySpacesCore
import SwiftUI

/// Which parts of Polycarp run, live: the choice in `features.toml` (`FeatureFile`), which `polycarp features` can change while
/// the app runs. The file is looked at about once a second, a stat, the way the theme file is.
final class PartsModel: ObservableObject {
    static let shared = PartsModel()

    private let path = FeatureFile.path()
    private var stamp: PolycarpThemeFile.Stamp?
    private var timer: Timer?

    @Published private(set) var current: FeatureSet
    /// False until someone picks: the welcome window asks first. An install from before this file has finished its welcome,
    /// so it counts as chosen, with everything on as it always was.
    @Published private(set) var hasChosen: Bool

    var onChange: ((FeatureSet, FeatureSet) -> Void)?
    /// The first choice was made: the app starts its parts. Nothing has run yet, so this isn't a change to apply.
    var onChosen: (() -> Void)?

    private init() {
        let saved = FeatureFile.load(path: path)
        current = saved ?? .all
        hasChosen = saved != nil || UserDefaults.standard.bool(forKey: Welcome.finishedKey)
        stamp = path.flatMap { PolycarpThemeFile.stamp($0) }
    }

    func watch() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.look() }
    }

    private func look() {
        guard let path else { return }
        let now = PolycarpThemeFile.stamp(path)
        guard now != stamp else { return }
        stamp = now
        guard let saved = FeatureFile.load(path: path) else { return hasChosen ? apply(.all) : () }
        if hasChosen { apply(saved) } else { first(saved) }
    }

    private func apply(_ new: FeatureSet) {
        let old = current
        guard new != old else { return }
        current = new
        onChange?(old, new)
    }

    private func first(_ set: FeatureSet) {
        current = set
        hasChosen = true
        onChosen?()
    }

    /// The welcome window's checkboxes, and every later change.
    func choose(_ set: FeatureSet) {
        FeatureFile.save(set, path: path)
        stamp = path.flatMap { PolycarpThemeFile.stamp($0) }
        if hasChosen { apply(set) } else { first(set) }
    }

    /// True when the switch may change this part: one part must stay on, and turning Workspaces either way restarts the app.
    func set(_ feature: Feature, on: Bool) {
        var next = current
        if on { next.on.insert(feature) } else { next.on.remove(feature) }
        guard !next.on.isEmpty else {
            return Self.tell("Polycarp needs one part on.", "To stop Polycarp entirely, quit it from the menu bar.")
        }
        if feature == .workspaces, !confirmRestart(on: on) { objectWillChange.send(); return }
        choose(next)
    }

    private func confirmRestart(on: Bool) -> Bool {
        let alert = NSAlert()
        alert.messageText = on ? "Turn on Workspaces?" : "Turn off Workspaces?"
        alert.informativeText = on
            ? "Polycarp restarts, then arranges your windows into workspaces again."
            : "Polycarp restarts. Every window comes back to this screen, and the macOS Dock and Mission Control return."
        alert.addButton(withTitle: on ? "Turn On and Restart" : "Turn Off and Restart")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private static func tell(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.runModal()
    }

    // MARK: Removing what a part downloaded

    /// What a part left on this Mac that Remove can clear. Workspaces downloads nothing, so it has no Remove.
    static func files(of feature: Feature, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [URL] {
        let support = Product.supportDir(home: home)
        let candidates: [URL]
        switch feature {
        case .workspaces: candidates = []
        case .voice: candidates = [Product.voiceDir(home: home).appendingPathComponent("models", isDirectory: true)]
        case .browser: candidates = [ExtensionCopy.destination(supportDir: support)]
        }
        return candidates.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Moves a part's downloads to the Trash, after asking. Only for a part that's off, so nothing is in use.
    func remove(_ feature: Feature) {
        let alert = NSAlert()
        switch feature {
        case .voice:
            alert.messageText = "Remove Silas's speech models?"
            alert.informativeText = "They go to the Trash. Your dictionary and history stay. Turning Silas on again downloads a model."
        case .browser:
            alert.messageText = "Remove the browser extension's copy?"
            alert.informativeText = "It goes to the Trash, and browsers lose their link to Polycarp. To take the extension out of a browser, remove it from that browser's Extensions page."
        case .workspaces:
            return
        }
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser
        var failed: [String] = []
        for url in Self.files(of: feature, home: home) {
            do { try FileManager.default.trashItem(at: url, resultingItemURL: nil) } catch { failed.append(url.lastPathComponent) }
        }
        if feature == .browser { BrowserHosts.removeParked(home: home) }
        if !failed.isEmpty { Self.tell("Some files stayed.", "Polycarp couldn't move \(failed.joined(separator: ", ")) to the Trash.") }
        objectWillChange.send()
    }
}

/// Settings > General: one switch per part, and Remove once a part is off and has something to remove.
struct PartsSection: View {
    @ObservedObject var parts: PartsModel

    var body: some View {
        SettingsGroup("Parts of Polycarp") {
            ForEach(Feature.allCases, id: \.self) { feature in
                SettingsRow(feature.title, help: feature.summary) {
                    HStack(spacing: 10) {
                        if !parts.current.contains(feature), !PartsModel.files(of: feature).isEmpty {
                            Button("Remove…") { parts.remove(feature) }
                        }
                        Toggle(feature.title, isOn: Binding(get: { parts.current.contains(feature) },
                                                            set: { parts.set(feature, on: $0) }))
                            .labelsHidden()
                    }
                }
            }
            SettingsNote("All three come with the app. A part that's off doesn't run, asks macOS for nothing and downloads nothing.")
        }
    }
}

/// The welcome window's first screen: three boxes, all ticked.
struct WelcomePartsChooser: View {
    @ObservedObject var parts: PartsModel
    @State private var picked = FeatureSet.all

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Feature.allCases, id: \.self) { feature in
                Toggle(isOn: Binding(get: { picked.contains(feature) }, set: { on in
                    if on { picked.on.insert(feature) } else { picked.on.remove(feature) }
                })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(feature.title).font(Chrome.font(13, .bold))
                        Text(feature.summary).font(Chrome.font(12)).foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.checkbox)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Chrome.shape(.settingsCell, continuous: false).fill(picked.contains(feature) ? Chrome.cell(0.08) : Color.clear))
            }
        }
        .padding(.horizontal, 20)
        HStack {
            Text("All three come with the app. Off means it doesn't run.").font(Chrome.font(11)).foregroundStyle(.secondary)
            Spacer()
            Button("Continue") { parts.choose(picked) }
                .keyboardShortcut(.defaultAction)
                .disabled(picked.on.isEmpty)
                .buttonStyle(WelcomeButtonStyle(large: true))
        }
        .padding(.horizontal, 28).padding(.vertical, 18)
    }
}

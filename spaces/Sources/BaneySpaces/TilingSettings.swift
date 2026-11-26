import AppKit
import BaneySpacesCore
import SwiftUI

/// The `tiling` settings as Settings shows and changes them. A change shows at once and is written in order behind it.
/// Main thread only.
final class TilingSettings: ObservableObject {
    static let shared = TilingSettings()

    @Published private(set) var tiling = SurfacesStore.shared.current.tiling
    /// Why the last change wasn't written.
    @Published private(set) var failed: String?
    /// Commands whose key macOS refused, and those whose key VoiceOver has now.
    @Published var refused: Set<String> = []
    @Published var toVoiceOver: Set<String> = []
    /// The command whose new key is waited for. While one is, Polycarp takes no tiling key, so it can be pressed.
    @Published var recording: String? { didSet { if oldValue != recording { onRecording() } } }
    var onRecording: () -> Void = {}
    private var writing = 0

    private init() {
        NotificationCenter.default.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in
            self?.take()
        }
    }

    private func take() { if writing == 0 { tiling = SurfacesStore.shared.current.tiling } }

    func set(_ path: String, _ value: SurfaceValue, _ change: (inout Surfaces.Tiling) -> Void) {
        change(&tiling)
        write { SurfacesOps.set("tiling." + path, value, file: SurfacesFile.path()).failure }
    }

    func toggle(_ n: Int) {
        let was = TilingOptions(tiling, agentWorkspace: Spaces.agentWorkspace), next = was.toggled(n)
        (tiling.on, tiling.off) = (next.on, next.off)
        write { Tiling.write(from: was, to: next) }
    }

    func setKey(_ name: String, _ text: String) {
        let writes = tiling.keyWrites(giving: name, text), chord = KeyChord(text)
        if let chord { for (other, c) in tiling.keys where c == chord { tiling.keys[other] = nil } }
        tiling.keys[name] = chord
        write {
            for w in writes { if let failure = SurfacesOps.set(w.path, w.value, file: SurfacesFile.path()).failure { return failure } }
            return nil
        }
    }

    private func write(_ go: @escaping () -> String?) {
        writing += 1
        Spaces.writer.async {
            let failure = go()
            DispatchQueue.main.async {
                self.failed = failure
                self.writing -= 1
                // The file's watcher may be a moment behind the write.
                if self.writing == 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.take() } }
            }
        }
    }
}

extension SurfacesOps.Result {
    var failure: String? { if case .failure(let f) = self { return f.message } else { return nil } }
}

/// Settings > Windows.
struct WindowsPane: View {
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var settings = TilingSettings.shared

    private var t: Surfaces.Tiling { settings.tiling }

    var body: some View {
        SettingsGroup("Tiling") {
            SettingsRow("Tile every workspace", help: "Windows go side by side and never overlap. \(toggleKey)one workspace at a time.") {
                Toggle("Tile every workspace", isOn: value({ t.enabled }) { v in settings.set("enabled", .bool(v)) { $0.enabled = v } }).labelsHidden()
            }
            SettingsRow("Workspaces", help: t.enabled ? "The ones that tile." : "The ones that tile while the switch above is off.") { workspaces }
            if let failed = settings.failed { SettingsNote("That wasn't saved: \(failed)", tone: .urgent) }
            LearnMore("Nothing is read or moved on a workspace that doesn't tile. Turning it off puts every window back where it was. A window that can't be resized, dialogs, full-screen windows and everything on the agent workspace are never tiled. Drag a tiled window onto another to trade places or to an edge to split it; hold the float key while you let go to leave it there.")
        }

        SettingsGroup("Layout") {
            SettingsBlock { TilingPreview(tiling: t).frame(maxWidth: .infinity) }
            SettingsRow("Style", help: styleHelp) {
                Picker("Style", selection: value({ t.style }) { v in settings.set("style", .string(v)) { $0.style = v } }) {
                    ForEach(TileStyle.allCases, id: \.rawValue) { Text($0.rawValue.capitalized).tag($0.rawValue) }
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            number("Space between windows", "gaps.inner", \.inner, 0...64)
            number("Space around them", "gaps.outer", \.outer, 0...64)
            SettingsRow("A workspace's only window", help: "Smart is a 16:10 shape in the middle of a wide display, and all of any other.") {
                Picker("A workspace's only window", selection: value({ lone }) { setLone($0) }) {
                    Text("Smart").tag("smart")
                    Text("All of it").tag("fill")
                    Text("A width").tag("points")
                }
                .labelsHidden()
            }
            if case .points(let w) = t.loneWidth {
                SettingsRow("Width") { stepper("Width", w, 400...6000, 50) { setLoneWidth($0) } }
            }
            SettingsRow("A new window goes", help: "Beside the window you are in.") {
                Picker("A new window goes", selection: value({ t.newWindow }) { v in settings.set("newWindow", .string(v)) { $0.newWindow = v } }) {
                    Text("Right or below").tag("after")
                    Text("Left or above").tag("before")
                }
                .labelsHidden()
            }
        }

        SettingsGroup("Never tiled") {
            ForEach(t.float, id: \.self) { id in
                SettingsRow(Self.name(of: id)) {
                    Button("Remove") { setFloat(t.float.filter { $0 != id }) }.accessibilityLabel("Remove \(Self.name(of: id))")
                }
            }
            SettingsRow("Add an app", help: "Its windows float, wherever you put them.") {
                Menu("Running Apps") {
                    ForEach(Self.running(without: t.float), id: \.id) { app in Button(app.name) { setFloat(t.float + [app.id]) } }
                }
            }
            SettingsRow("Hold to float a dragged window") {
                Picker("Hold to float a dragged window", selection: value({ t.floatModifier }) { v in
                    settings.set("floatModifier", .string(v.rawValue)) { $0.floatModifier = v }
                }) {
                    ForEach(Surfaces.Tiling.FloatModifier.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                .labelsHidden()
            }
        }
    }

    private var toggleKey: String { t.keys["toggle"].map { "\($0.symbols) tiles " } ?? "Pick " }

    private var workspaces: some View {
        let options = TilingOptions(t, agentWorkspace: Spaces.agentWorkspace)
        return HStack(spacing: 4) {
            ForEach(1...9, id: \.self) { n in
                let on = options.tiles(n)
                Button { settings.toggle(n) } label: {
                    Text("\(n)").font(Chrome.font(12, on ? .semibold : .regular)).frame(width: 24, height: 24)
                        .background(Chrome.shape(.settingsCell, continuous: false).fill(on ? Chrome.lit(Chrome.accent, 0.28) : Chrome.cell(0.12)))
                }
                .buttonStyle(.plain)
                .disabled(n == options.agentWorkspace)
                .accessibilityLabel("Workspace \(n)")
                .accessibilityValue(n == options.agentWorkspace ? "the agent workspace, never tiled" : on ? "tiles" : "doesn't tile")
            }
        }
    }

    private var styleHelp: String {
        switch TileStyle(rawValue: t.style) ?? .dwindle {
        case .dwindle: "A new window halves the one you are in."
        case .columns: "Windows stand side by side at full height."
        case .main: "One large window beside a stack of the rest."
        }
    }

    private var lone: String {
        switch t.loneWidth {
        case .smart: "smart"
        case .fill: "fill"
        case .points: "points"
        }
    }

    private func setLone(_ v: String) {
        switch v {
        case "fill": settings.set("loneWidth", .string(v)) { $0.loneWidth = .fill }
        case "points": setLoneWidth(1400)
        default: settings.set("loneWidth", .string("smart")) { $0.loneWidth = .smart }
        }
    }

    private func setLoneWidth(_ w: Int) { settings.set("loneWidth", .string("points:\(w)")) { $0.loneWidth = .points(w) } }

    private func setFloat(_ apps: [String]) {
        settings.set("float", .array(apps.map { .string($0) })) { $0.float = apps }
    }

    private func value<T>(_ get: @escaping () -> T, _ set: @escaping (T) -> Void) -> Binding<T> { Binding(get: get, set: set) }

    private func number(_ label: String, _ path: String, _ key: WritableKeyPath<Surfaces.Tiling, Int>, _ range: ClosedRange<Int>) -> some View {
        SettingsRow(label) { stepper(label, t[keyPath: key], range, 2) { v in settings.set(path, .number(Double(v))) { $0[keyPath: key] = v } } }
    }

    private func stepper(_ label: String, _ n: Int, _ range: ClosedRange<Int>, _ step: Int, _ set: @escaping (Int) -> Void) -> some View {
        Stepper(value: value({ n }, { set(min(max($0, range.lowerBound), range.upperBound)) }), in: range, step: step) {
            Text("\(n) pt").font(Chrome.font(12).monospacedDigit()).foregroundStyle(Chrome.muted)
        }
        .accessibilityLabel(label)
        .accessibilityValue("\(n) points")
    }

    static func name(of bundle: String) -> String {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return bundle }
        return FileManager.default.displayName(atPath: url.path)
    }

    private static func running(without listed: [String]) -> [(id: String, name: String)] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { app in
            guard let id = app.bundleIdentifier, !listed.contains(id), id != Product.bundleID else { return nil }
            return (id, app.localizedName ?? id)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

/// Four windows laid out as the settings say, by the layout code itself.
struct TilingPreview: View {
    @ObservedObject private var appearance = Appearance.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var tiling: Surfaces.Tiling

    private static let area = CGRect(x: 0, y: 0, width: 1600, height: 1000)

    private var frames: [(id: WindowID, frame: CGRect)] {
        let o = TilingOptions(tiling, agentWorkspace: nil)
        var l = TileLayout(style: o.style)
        l.sync([1, 2, 3, 4], focused: nil, area: Self.area)
        return l.frames(in: Self.area, gaps: o.gaps).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    var body: some View {
        let scale = 0.15
        ZStack(alignment: .topLeading) {
            Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(0.1))
            ForEach(frames, id: \.id) { w in
                Chrome.shape(.settingsCell, continuous: false)
                    .fill(w.id == 1 ? Chrome.accent.opacity(0.5) : Chrome.wash(0.22))
                    .frame(width: w.frame.width * scale, height: w.frame.height * scale)
                    .offset(x: w.frame.minX * scale, y: w.frame.minY * scale)
            }
        }
        .frame(width: Self.area.width * scale, height: Self.area.height * scale)
        .animation(reduceMotion ? nil : Chrome.ease(0.15), value: tiling)
        .accessibilityElement()
        .accessibilityLabel("Four windows in the \(tiling.style) style")
    }
}

/// Settings > Keys > Tiling: each command and its key. Click a key, then press the new one; Delete leaves it none.
struct TilingKeysGroup: View {
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var settings = TilingSettings.shared
    @State private var said: String?
    @State private var monitor: Any?

    var body: some View {
        SettingsGroup("Tiling") {
            if let said { SettingsNote(said, tone: .urgent) }
            if let failed = settings.failed { SettingsNote("That wasn't saved: \(failed)", tone: .urgent) }
            ForEach(TilingKeys.all, id: \.name) { command in
                SettingsRow(command.title, help: help(command.name)) {
                    Button { settings.recording == command.name ? stop() : record(command.name) } label: {
                        Text(settings.recording == command.name ? "Press a key" : settings.tiling.keys[command.name]?.symbols ?? "None")
                            .font(Chrome.font(12)).frame(minWidth: 76)
                    }
                    .accessibilityLabel("\(command.title): \(settings.tiling.keys[command.name]?.symbols ?? "no key")")
                }
            }
            LearnMore("Click a key, then press the new one. Delete takes the key away and Escape leaves it as it was. A key needs ⌃ and another modifier, or ⌘ and ⌥, so it takes nothing from the app in front. While no workspace tiles only the first key is taken. With VoiceOver on, keys with ⌃⌥ stay VoiceOver's.")
        }
        .onDisappear { stop() }
    }

    private func help(_ name: String) -> String? {
        if settings.refused.contains(name) { return "Another app has this key." }
        return settings.toVoiceOver.contains(name) ? "VoiceOver has this key while it is on." : nil
    }

    private func record(_ name: String) {
        stop()
        said = nil
        settings.recording = name
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
            if event.keyCode == 53, flags.isEmpty { stop(); return nil }
            if event.keyCode == 51, flags.isEmpty { settings.setKey(name, ""); stop(); return nil }
            switch KeyChord.read(keyCode: Int(event.keyCode), ctrl: flags.contains(.control), opt: flags.contains(.option),
                                 shift: flags.contains(.shift), cmd: flags.contains(.command)) {
            case .failure(let p): said = p.message
            case .success(let chord):
                let other = TilingKeys.all.first { $0.name != name && settings.tiling.keys[$0.name] == chord }
                settings.setKey(name, chord.text)
                said = other.map { "\(chord.symbols) was: \($0.title). That one has no key now." }
                stop()
            }
            return nil
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        settings.recording = nil
    }
}

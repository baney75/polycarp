import AppKit
import BaneySpacesCore
import SwiftUI

/// The `polycarp` command the theme editor runs: the app's own copy, or `POLYCARP_BIN` for a build run from the repo.
/// Every theme file is read, checked and written by this command; the app only asks it.
struct ThemeCommand {
    let url: URL?

    static let shared = ThemeCommand(url: resolve())

    static func resolve(bundle: URL = Bundle.main.bundleURL, env: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        let bundled = bundle.appendingPathComponent("Contents/Resources/bin/polycarp")
        if FileManager.default.isExecutableFile(atPath: bundled.path) { return bundled }
        if let b = env["POLYCARP_BIN"], b.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: b) { return URL(fileURLWithPath: b) }
        return nil
    }

    var available: Bool { url != nil }

    /// Runs one command and waits. Call it off the main thread.
    func run(_ arguments: [String], input: Data? = nil) -> ThemeCommandReply {
        guard let url else {
            return ThemeCommandReply(stdout: Data(), stderr: Data("This copy of Polycarp doesn't include the theme command.".utf8), status: 127)
        }
        let p = Process()
        p.executableURL = url
        p.arguments = arguments
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = input == nil ? FileHandle.nullDevice : inp
        do { try p.run() } catch {
            return ThemeCommandReply(stdout: Data(), stderr: Data(error.localizedDescription.utf8), status: 126)
        }
        if let input {
            // Written from another thread so a large file can't fill the pipe while this one waits on output.
            DispatchQueue.global(qos: .userInitiated).async {
                inp.fileHandleForWriting.write(input)
                try? inp.fileHandleForWriting.close()
            }
        }
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        p.waitUntilExit()
        return ThemeCommandReply(stdout: outData, stderr: errData, status: p.terminationStatus)
    }

    /// Runs `body` off the main thread and hands its answer back on it.
    static func background<T>(_ body: @escaping () -> T, then: @escaping @MainActor (T) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let v = body()
            DispatchQueue.main.async { MainActor.assumeIsolated { then(v) } }
        }
    }
}

/// Every theme, for the shelf in Settings: what each looks like, and a file to drag out. Also imports what is dropped.
@MainActor
final class ThemeLibrary: ObservableObject {
    static let shared = ThemeLibrary()

    struct Tile: Identifiable, Equatable {
        let theme: ThemeCommandReply.Listed
        /// Page, surface, text and accent, light then dark.
        var light: [RGB] = []
        var dark: [RGB] = []
        /// The theme's file, ready to drag to Finder: a user theme's own, or a built-in's text written to a temporary folder.
        var file: URL?
        var id: String { theme.name }
    }

    enum Tone { case quiet, urgent, done }

    @Published private(set) var tiles: [Tile] = []
    @Published var notice: (text: String, tone: Tone)?
    /// A dropped theme with the name of one of the person's own: replaced only if they say so.
    @Published var replacing: (name: String, file: URL, question: String)?
    /// A palette from a dropped picture, waiting for the person to make a theme from it or not.
    @Published var picture: (proposal: ThemePaletteProposal, base: String)?

    let command: ThemeCommand
    init(command: ThemeCommand = .shared) { self.command = command }

    var available: Bool { command.available }
    var names: Set<String> { Set(tiles.map(\.theme.name)) }

    func reload() {
        let command = command
        ThemeCommand.background({ () -> [Tile] in
            let list = command.run(ThemeEditorCommands.list).themes
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-themes", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return list.map { t in
                var tile = Tile(theme: t)
                for mode in ["light", "dark"] {
                    let c = ThemeDraft.section(command.run(ThemeEditorCommands.section(mode, of: t.name))) ?? [:]
                    let rgb = ["background", "surface", "foreground", "accent"].compactMap { (c[$0] as? String).flatMap(RGB.init(hex:)) }
                    if mode == "light" { tile.light = rgb } else { tile.dark = rgb }
                }
                if t.builtIn {
                    let r = command.run(ThemeEditorCommands.exportTOML(t.name))
                    if let text = r.data["toml"] as? String {
                        let f = dir.appendingPathComponent("\(t.name).toml")
                        if (try? text.write(to: f, atomically: true, encoding: .utf8)) != nil { tile.file = f }
                    }
                } else if let path = command.run(ThemeEditorCommands.editPath(t.name)).data["path"] as? String {
                    tile.file = URL(fileURLWithPath: path)
                }
                return tile
            }
        }) { [weak self] tiles in self?.tiles = tiles }
    }

    /// Customize: a copy of a built-in under a free name, opened in the editor. `then` gets the new name.
    func customize(_ base: String, then: @escaping @MainActor (String) -> Void) {
        let name = ThemeEditorCommands.copyName(base, taken: names)
        let command = command
        ThemeCommand.background({ command.run(ThemeEditorCommands.create(name, extends: base)) }) { [weak self] r in
            guard let self else { return }
            if r.ok { self.reload(); then(name) } else { self.notice = (r.message, .urgent) }
        }
    }

    /// Takes files dropped on the Appearance tab: a `.toml` is imported, a picture proposes a palette for `current`.
    func dropped(_ urls: [URL], current: String?) {
        guard let url = urls.first else { return }
        switch ThemeImport.kind(url.path) {
        case .theme: importTheme(url)
        case .picture: proposePalette(url, base: current ?? "polycarp")
        case .other: notice = ("Drop a theme file (.toml) to add it, or a picture to take its colors.", .quiet)
        }
    }

    /// The CLI checks the file first and its words are shown as they are; a built-in is never replaced and one of yours only on a yes.
    func importTheme(_ url: URL) {
        guard let data = try? Data(contentsOf: url) else {
            notice = ("\(url.lastPathComponent) couldn't be read.", .urgent); return
        }
        let command = command
        ThemeCommand.background({ () -> (ThemeCommandReply, [ThemeCommandReply.Listed]) in
            (command.run(ThemeEditorCommands.validateInput, input: data), command.run(ThemeEditorCommands.list).themes)
        }) { [weak self] checked, themes in
            guard let self else { return }
            guard checked.ok, let name = checked.data["name"] as? String else {
                self.notice = ("\(url.lastPathComponent) is not a theme Polycarp can use:\n\(checked.message)", .urgent); return
            }
            switch ThemeImport.decide(name: name, themes: themes) {
            case .refuse(let why): self.notice = (why, .urgent)
            case .ask(let question): self.replacing = (name, url, question)
            case .save: self.save(url, name: name)
            }
        }
    }

    /// After the person said yes, or when no theme had the name.
    func save(_ url: URL, name: String) {
        replacing = nil
        let command = command
        ThemeCommand.background({ command.run(ThemeEditorCommands.importFile(url.path)) }) { [weak self] r in
            guard let self else { return }
            self.notice = r.ok ? ("Added \"\(name)\". Pick it above to use it.", .done) : (r.message, .urgent)
            self.reload()
        }
    }

    func proposePalette(_ url: URL, base: String) {
        guard let pixels = ThemePicture.pixels(url) else {
            notice = ("\(url.lastPathComponent) couldn't be read as a picture.", .urgent); return
        }
        let command = command
        ThemeCommand.background({ () -> ThemePaletteProposal? in
            let light = Self.colors(command.run(ThemeEditorCommands.section("light", of: base)))
            let dark = Self.colors(command.run(ThemeEditorCommands.section("dark", of: base)))
            return ThemeEditorPalette.propose(pixels, light: light, dark: dark)
        }) { [weak self] p in
            guard let self else { return }
            if let p { self.picture = (p, base) } else { self.notice = ("That picture has no color strong enough for an accent.", .quiet) }
        }
    }

    nonisolated static func colors(_ reply: ThemeCommandReply) -> [String: RGB] {
        (ThemeDraft.section(reply) ?? [:]).compactMapValues { ($0 as? String).flatMap(RGB.init(hex:)) }
    }
}

/// A picture's pixels at thumbnail size, enough to find its colors.
enum ThemePicture {
    static func pixels(_ url: URL, side: Int = 64) -> [RGB]? {
        guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        guard let ctx = CGContext(data: &bytes, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
        var out: [RGB] = []
        out.reserveCapacity(side * side)
        for i in stride(from: 0, to: bytes.count, by: 4) where bytes[i + 3] > 128 {
            out.append(RGB(r: Double(bytes[i]) / 255, g: Double(bytes[i + 1]) / 255, b: Double(bytes[i + 2]) / 255))
        }
        return out
    }
}

/// One theme open in the editor: its fields from the schema, the draft, and Save through the CLI.
@MainActor
final class ThemeEditorModel: ObservableObject {
    @Published private(set) var sections: [ThemeFieldSection] = []
    @Published private(set) var draft: ThemeDraft?
    /// The last draft the app could draw, kept while a value is half typed.
    @Published private(set) var shown: PolycarpTheme?
    @Published private(set) var warnings: [ThemeContrastWarning] = []
    @Published var problem: String?
    @Published var notice: String?
    @Published private(set) var saving = false
    @Published var proposal: ThemePaletteProposal?

    let name: String
    let title: String
    let command: ThemeCommand

    struct LoadError: Error { let text: String }

    init(name: String, title: String, command: ThemeCommand = .shared) {
        self.name = name; self.title = title; self.command = command
    }

    /// Already loaded, for the rendered images and tests of the view.
    init(draft: ThemeDraft, sections: [ThemeFieldSection]) {
        name = draft.name; title = draft.title; command = ThemeCommand(url: nil)
        self.sections = sections
        self.draft = draft
        refresh()
    }

    func load() {
        let command = command, name = name, title = title
        ThemeCommand.background({ () -> Result<([ThemeFieldSection], ThemeDraft), LoadError> in
            let schema = command.run(ThemeEditorCommands.schema)
            guard schema.ok, let data = try? JSONSerialization.data(withJSONObject: ["data": schema.data]) else { return .failure(LoadError(text: schema.message)) }
            let sections: [ThemeFieldSection]
            switch ThemeEditorSchema.parse(data) {
            case .success(let s): sections = s
            case .failure(let e): return .failure(LoadError(text: e.description))
            }
            var values: [String: [String: Any]] = [:]
            for s in sections {
                let r = command.run(ThemeEditorCommands.section(s.name, of: name))
                guard r.ok else { return .failure(LoadError(text: r.message)) }
                values[s.name] = ThemeDraft.section(r)
            }
            return ThemeDraft.load(name: name, title: title, sections: sections, values: values).map { (sections, $0) }.mapError { LoadError(text: $0.description) }
        }) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let (sections, draft)): self.sections = sections; self.draft = draft; self.refresh()
            case .failure(let e): self.problem = e.text
            }
        }
    }

    func value(_ path: String) -> ThemeValue? { draft?[path] }

    func set(_ path: String, _ v: ThemeValue) {
        draft?.set(path, v, at: ProcessInfo.processInfo.systemUptime)
        refresh()
    }

    func undo() { draft?.undo(); refresh() }
    func redo() { draft?.redo(); refresh() }
    func revert() { draft?.revert(); refresh() }

    func accept() {
        guard let p = proposal else { return }
        draft?.set(p.changes)
        proposal = nil
        notice = "Took the picture's colors. Undo puts the old ones back."
        refresh()
    }

    func propose(from url: URL) {
        guard let pixels = ThemePicture.pixels(url), let d = draft else { problem = "\(url.lastPathComponent) couldn't be read as a picture."; return }
        proposal = ThemeEditorPalette.propose(pixels, light: d.colors("light"), dark: d.colors("dark"))
        if proposal == nil { notice = "That picture has no color strong enough for an accent." }
    }

    /// One `polycarp theme change` with every edit. The CLI checks it all and says why it refuses, in its own words.
    func save() {
        guard let d = draft, d.isEdited, !saving else { return }
        saving = true
        problem = nil
        let command = command, args = ThemeEditorCommands.save(d.name, d.changes())
        ThemeCommand.background({ command.run(args) }) { [weak self] r in
            guard let self else { return }
            self.saving = false
            if r.ok {
                self.draft?.saved()
                self.notice = "Saved. polycarp theme undo takes it back."
                ThemeLibrary.shared.reload()
            } else {
                self.problem = r.message
            }
            self.refresh()
        }
    }

    private func refresh() {
        guard let d = draft else { return }
        if let p = d.preview { shown = p }
        warnings = ThemeEditorContrast.warnings(d)
    }
}

import AppKit
import BaneySpacesCore
import SwiftUI

/// Every look, for the Looks group in Settings > Appearance, and the one `polycarp look` command at a time it runs.
@MainActor
final class LookLibrary: ObservableObject {
    static let shared = LookLibrary()

    /// A save or an import that met a look of the person's with that name: done again only if they say so.
    struct Replace: Equatable {
        enum What: Equatable { case save(title: String), file(URL) }
        let what: What
        let question: String
    }

    @Published private(set) var looks: [ThemeCommandReply.Look] = []
    @Published private(set) var canUndo = false
    /// The look clicked; until one is, the buttons are about the one in force.
    @Published var picked: String?
    /// What is running, such as "Applying Evening…", or nil.
    @Published private(set) var busy: String?
    @Published var notice: (text: String, tone: ThemeLibrary.Tone)?
    @Published var replacing: Replace?
    /// The name being typed for Save Current Look, or nil while its field is closed.
    @Published var newTitle: String?

    let command: ThemeCommand
    init(command: ThemeCommand = .shared) { self.command = command }

    var chosen: ThemeCommandReply.Look? { looks.first { $0.name == picked } ?? looks.first(where: \.current) }

    /// Reads the list off the main thread. Only the newest read lands, so one from before a change can't put the old list back.
    private var reads = 0
    func reload() {
        reads += 1
        let read = reads, command = command
        ThemeCommand.background({ command.run(LookCommands.list) }) { [weak self] r in
            guard let self, read == self.reads else { return }
            // A failed read says why, unless a command's answer is already showing.
            guard r.ok else {
                if self.busy == nil, self.notice == nil { self.notice = (r.message, .urgent) }
                return
            }
            if r.looks != self.looks { self.looks = r.looks }
            if r.canUndoLook != self.canUndo { self.canUndo = r.canUndoLook }
            if let p = self.picked, !r.looks.contains(where: { $0.name == p }) { self.picked = nil }
        }
    }

    func apply(_ look: ThemeCommandReply.Look) {
        run(LookCommands.apply(look.name), "Applying \(look.title)…") { me, r in
            me.picked = nil
            return r.data["changed"] as? Bool == false ? "That is how everything looks already." : "Applied \(look.title). Undo puts everything back as it was."
        }
    }

    func undo() {
        run(LookCommands.undo, "Undoing…") { me, _ in
            me.picked = nil
            return "Back as it was. Undo again to come forward."
        }
    }

    func save(_ title: String, replace: Bool = false) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name = LookCommands.name(for: title) else {
            notice = ("Give the look a name with a letter or a number in it, other than Polycarp.", .urgent); return
        }
        run(LookCommands.save(name, title: title, replace: replace), "Saving…", taken: .save(title: title)) { me, _ in
            me.newTitle = nil
            me.picked = name
            return "Saved \"\(title)\"."
        }
    }

    /// The CLI checks the file, and its words are shown as they are. Nothing on screen changes until Apply.
    func importFile(_ url: URL, replace: Bool = false) {
        run(LookCommands.importFile(url.path, replace: replace), "Checking \(url.lastPathComponent)…", taken: .file(url)) { me, r in
            me.picked = r.data["name"] as? String
            return "Added \"\(r.data["title"] as? String ?? url.lastPathComponent)\". Apply puts it on."
        }
    }

    func export(_ look: ThemeCommandReply.Look, to url: URL) {
        run(LookCommands.export(look.name, to: url.path), "Exporting…") { _, _ in "Exported \(look.title) to \(url.lastPathComponent)." }
    }

    /// After the person said yes.
    func replace(_ r: Replace) {
        replacing = nil
        switch r.what {
        case .save(let title): save(title, replace: true)
        case .file(let url): importFile(url, replace: true)
        }
    }

    /// Runs one command, then reads the list again. `taken` is what to ask about when the name is one of the person's own.
    private func run(_ args: [String], _ doing: String, taken: Replace.What? = nil,
                     then: @escaping @MainActor (LookLibrary, ThemeCommandReply) -> String) {
        if let busy { notice = ("\(busy) Try again when it is done.", .quiet); return }
        busy = doing
        notice = nil
        replacing = nil
        let command = command
        ThemeCommand.background({ command.run(args) }) { [weak self] r in
            guard let self else { return }
            self.busy = nil
            if r.ok {
                self.notice = (([then(self, r)] + r.notes).joined(separator: "\n"), .done)
            } else if r.code == "exists", let taken {
                self.replacing = Replace(what: taken, question: r.message.prefix(1).uppercased() + r.message.dropFirst() + ". Replace it?")
            } else {
                self.notice = (r.message, .urgent)
            }
            self.reload()
        }
    }
}

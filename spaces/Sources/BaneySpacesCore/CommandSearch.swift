import Foundation

/// Where terminal programs are, found by looking at folders. Nothing is run: not the program, not a shell to ask for its
/// PATH (R-D6). An app opened from the Dock has only the system's PATH, so the folders your shell's startup files add,
/// as far as they say them outright, and the ones installers use are looked in too.
public struct CommandSearch: Sendable {
    public let folders: [String]

    public init(folders: [String]) { self.folders = folders }

    /// This account's folders.
    public static func live(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> CommandSearch {
        let fm = FileManager.default
        func read(_ p: String) -> String? {
            guard case let .data(d) = PolycarpThemeFile.bytes(path: URL(fileURLWithPath: p).resolvingSymlinksInPath().path, limit: 256 * 1024) else { return nil }
            return String(decoding: d, as: UTF8.self)
        }
        return CommandSearch(folders: folders(path: env["PATH"], home: home, read: read,
                                              list: { (try? fm.contentsOfDirectory(atPath: $0))?.sorted() ?? [] }))
    }

    static let startupFiles = [".zshenv", ".zprofile", ".zshrc", ".profile", ".bash_profile", ".bashrc"]

    static let usual = [
        "~/.local/bin", "~/bin", "~/.claude/local", "~/.opencode/bin", "~/.grok/bin", "~/.bun/bin", "~/.cargo/bin", "~/.deno/bin",
        "~/go/bin", "~/.volta/bin", "~/.npm-global/bin", "~/Library/pnpm", "~/.local/share/mise/shims", "~/.asdf/shims",
        "~/.nix-profile/bin", "/run/current-system/sw/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin",
    ]

    /// Every folder once, in the order they are looked in: what your shell's files say, this process's PATH, the
    /// system's path files, then where installers put things.
    static func folders(path: String?, home: String, read: (String) -> String?, list: (String) -> [String]) -> [String] {
        var out: [String] = []
        func add(_ raw: some StringProtocol) {
            var f = raw.trimmingCharacters(in: .whitespaces)
            for h in ["~/", "$HOME/", "${HOME}/"] where f.hasPrefix(h) { f = home + "/" + f.dropFirst(h.count) }
            // A folder named by its place here, or by a variable that isn't known, is no folder to trust.
            guard f.hasPrefix("/"), !f.contains("$"), !f.contains("`"), !out.contains(f) else { return }
            out.append(f)
        }
        for file in startupFiles {
            for value in assignments(in: read(home + "/" + file) ?? "") { value.split(separator: ":").forEach(add) }
        }
        (path ?? "").split(separator: ":").forEach(add)
        for file in ["/etc/paths"] + list("/etc/paths.d").map({ "/etc/paths.d/" + $0 }) {
            (read(file) ?? "").split(whereSeparator: \.isNewline).forEach(add)
        }
        usual.forEach(add)
        for v in list(home + "/.nvm/versions/node").reversed() { add(home + "/.nvm/versions/node/\(v)/bin") }
        return out
    }

    /// The values a startup file sets PATH to: `export PATH="$HOME/x:$PATH"`. Nothing in the file is run or expanded but
    /// the home folder.
    static func assignments(in text: String) -> [String] {
        text.split(whereSeparator: \.isNewline).compactMap { line in
            var l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("export ") { l = l.dropFirst(7).trimmingCharacters(in: .whitespaces) }
            guard l.hasPrefix("PATH=") else { return nil }
            return l.dropFirst(5).filter { $0 != "\"" && $0 != "'" }.description
        }
    }

    /// The path of the first of `names` that is a program, the best name first whichever folder it is in.
    public func find(_ names: [String], isProgram: (String) -> Bool = CommandSearch.isProgram) -> String? {
        for name in names {
            for folder in folders where isProgram(folder + "/" + name) { return folder + "/" + name }
        }
        return nil
    }

    /// A file you may run; a folder is not one.
    public static func isProgram(_ path: String) -> Bool {
        var isFolder: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isFolder) && !isFolder.boolValue
            && FileManager.default.isExecutableFile(atPath: path)
    }
}

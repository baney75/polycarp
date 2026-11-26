import Foundation

// Running a program in the terminal you chose. What a person typed never becomes part of a command line a shell or a
// terminal reads: the words go into a job file only this account can read, the terminal is told to run Polycarp's own
// command with that file's name, and the command hands the words to the program one by one (R-D10).

/// A program, the words it gets, and the folder it starts in.
public struct TerminalJob: Codable, Equatable, Sendable {
    public let argv: [String]
    public let folder: String

    public init?(argv: [String], folder: String) {
        guard let program = argv.first, program.hasPrefix("/"), folder.hasPrefix("/"),
              !argv.contains(where: { $0.utf8.contains(0) }), !folder.utf8.contains(0),
              argv.reduce(0, { $0 + $1.utf8.count }) <= 200_000 else { return nil }
        self.argv = argv; self.folder = folder
    }

    /// The hidden command that runs one.
    public static let verb = "run-job"

    /// What the shell is told. It never changes: the program and its words are `$1` and on, each whole.
    static let shellScript = #""$@"; exec "${SHELL:-/bin/zsh}" -l"#

    /// The command the runner becomes: a login shell, for the PATH and the settings your terminal has, that runs the
    /// program and leaves you a shell when it quits. Not an interactive one: a .zshrc that ends in `exec tmux` would
    /// take it over before the program ran.
    public var exec: [String] { ["/bin/zsh", "-l", "-c", Self.shellScript, "zsh"] + argv }

    /// The folder the program is in, put first in PATH, so a program that starts another by name (`env node`) finds
    /// the one installed beside it.
    public func environment(_ env: [String: String]) -> [String: String] {
        var env = env
        let bin = (argv[0] as NSString).deletingLastPathComponent
        env["PATH"] = bin + ":" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        return env
    }
}

/// The job files: one per run, in a folder only this account can open, read once and deleted.
public struct TerminalJobs: Sendable {
    public let folder: String
    /// A job nobody picked up (the terminal didn't start) is deleted this long after it was written.
    public static let keep: TimeInterval = 600

    public init(folder: String) { self.folder = folder }

    /// Where the app writes them and the command reads them.
    public static func folder(home: URL) -> String { Product.supportDir(home: home).appendingPathComponent("jobs").path }

    /// Writes the job and the script a terminal that only opens files is given. Returns the job's name.
    public func write(_ job: TerminalJob, runner: String, now: Date = Date()) throws -> (id: String, script: String) {
        let fm = FileManager.default
        try fm.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder)
        clean(now: now)
        let id = UUID().uuidString
        try make(path(id), JSONEncoder().encode(job), 0o600)
        // Opened in a terminal, so it is a script; nothing in it came from a person.
        let words = [runner, TerminalJob.verb, id].map(TerminalLaunch.shellQuote).joined(separator: " ")
        try make(script(id), Data("#!/bin/sh\nexec \(words)\n".utf8), 0o700)
        return (id, script(id))
    }

    /// The job by that name, once: its files are gone when this returns.
    public func take(_ id: String) -> TerminalJob? {
        guard let name = UUID(uuidString: id)?.uuidString else { return nil }
        defer { for p in [path(name), script(name)] { unlink(p) } }
        guard case let .data(d) = PolycarpThemeFile.bytes(path: path(name), limit: 1024 * 1024),
              let job = try? JSONDecoder().decode(TerminalJob.self, from: d) else { return nil }
        return TerminalJob(argv: job.argv, folder: job.folder)
    }

    func clean(now: Date) {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? [] where name.hasPrefix("job-") {
            let p = folder + "/" + name
            let written = (try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date
            if let written, now.timeIntervalSince(written) > Self.keep { unlink(p) }
        }
    }

    private func path(_ id: String) -> String { folder + "/job-\(id).json" }
    private func script(_ id: String) -> String { folder + "/job-\(id).command" }

    private func make(_ path: String, _ data: Data, _ mode: mode_t) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode)
        guard fd >= 0 else { throw SurfacesFile.WriteError("can't write \(path): \(String(cString: strerror(errno)))") }
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try h.write(contentsOf: data)
        try h.close()
    }
}

/// How one terminal opens a window at a folder, and what it can be told to run.
public enum TerminalPlan: Equatable, Sendable {
    /// Ghostty's own scripting, so no second Ghostty starts: a window in the folder running the script, or a shell.
    case ghostty(folder: String, script: String?)
    /// The app opens this file or folder.
    case openFile(String)
    /// A new copy of the app with these arguments.
    case launch([String])
    /// The app's own link.
    case link(String)

    /// Nil when the terminal can't be told what to run (`DefaultAppCatalog.runsCommands`).
    public static func run(_ bundle: String, folder: String, runner: String, id: String, script: String) -> TerminalPlan? {
        let words = [runner, TerminalJob.verb, id]
        switch bundle {
        case "com.mitchellh.ghostty": return .ghostty(folder: folder, script: script)
        case "com.googlecode.iterm2", TerminalChoice.terminal: return .openFile(script)
        case "com.github.wez.wezterm": return .launch(["start", "--cwd", folder, "--"] + words)
        case "net.kovidgoyal.kitty": return .launch(["--directory", folder] + words)
        case "org.alacritty": return .launch(["--working-directory", folder, "-e"] + words)
        case "com.raphaelamorim.rio": return .launch(["--working-dir", folder, "-e"] + words)
        default: return nil
        }
    }

    /// A shell in a folder.
    public static func shell(_ bundle: String, folder: String) -> TerminalPlan {
        switch bundle {
        case "com.mitchellh.ghostty": return .ghostty(folder: folder, script: nil)
        case "com.github.wez.wezterm": return .launch(["start", "--cwd", folder])
        case "net.kovidgoyal.kitty": return .launch(["--directory", folder])
        case "org.alacritty": return .launch(["--working-directory", folder])
        case "com.raphaelamorim.rio": return .launch(["--working-dir", folder])
        case "dev.warp.Warp-Stable":
            var c = URLComponents(string: "warp://action/new_window")
            c?.queryItems = [URLQueryItem(name: "path", value: folder)]
            return c?.string.map(TerminalPlan.link) ?? .openFile(folder)
        default: return .openFile(folder)
        }
    }
}

/// What an agent is started with.
public enum AgentLaunch {
    /// How an agent takes a first prompt in its own window. Always joined to its option or after `--`, so a prompt that
    /// starts with a dash is words and never an option (one could turn off an agent's permission questions).
    public enum Prompt: Equatable, Sendable {
        /// These words, `--`, then the prompt.
        case afterDashes([String])
        /// These words, then `--option=prompt`.
        case option([String], String)
        /// The prompt alone, where the agent has no `--`: not one that starts with `-` or `@` (a file to it).
        case plain
        /// It takes none but by typing.
        case typed
    }

    static let prompts: [String: Prompt] = [
        "claude": .afterDashes([]), "codex": .afterDashes([]), "grok": .afterDashes([]), "devin": .afterDashes([]),
        "cursor-agent": .afterDashes(["agent"]), "pi": .plain, "opencode": .option([], "--prompt"),
        "gemini": .option([], "--prompt-interactive"), "qwen": .option([], "--prompt-interactive"),
        "copilot": .option([], "--interactive"), "hermes": .option(["chat", "--tui"], "--query"),
        "crush": .typed, "kimi": .typed, "amp": .typed,
    ]

    /// The words the agent gets, and the prompt when it can't be given one: it goes on the clipboard instead.
    public static func argv(_ id: String, at path: String, prompt: String?) -> (argv: [String], clipboard: String?) {
        guard let prompt, !prompt.isEmpty else { return ([path], nil) }
        switch prompts[id] ?? .typed {
        case .afterDashes(let first): return ([path] + first + ["--", prompt], nil)
        case let .option(first, name): return ([path] + first + ["\(name)=\(prompt)"], nil)
        case .plain where !prompt.hasPrefix("-") && !prompt.hasPrefix("@"): return ([path, prompt], nil)
        case .plain, .typed: return ([path], prompt)
        }
    }
}

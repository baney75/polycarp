import Foundation

// Launcher extensions: a folder of scripts with a small `extension.toml`, in the Polycarp config folder
// under `extensions/`. The format is in `spec/launcher-extensions.md`, shared with the Windows launcher.

/// One extension's manifest.
public struct ScriptExtension: Equatable, Sendable {
    public enum Output: String, Sendable { case text, list }

    /// The folder's name: the extension's id.
    public let id: String
    public let folder: URL
    public let title: String
    public let keyword: String
    public let description: String
    /// The program and its fixed arguments. What's typed after the keyword is added as one more argument.
    public let command: [String]
    public let output: Output
    public let timeout: TimeInterval

    public static let manifestName = "extension.toml"
    public static let defaultTimeout: TimeInterval = 5
    public static let maxTimeout: TimeInterval = 30

    /// Reads a manifest. Throws a message a person can act on.
    public static func parse(_ text: String, id: String, folder: URL) throws -> ScriptExtension {
        let doc: [String: LauncherTOML.Value]
        do { doc = try LauncherTOML.parse(text) } catch { throw Problem("\(manifestName) \(error)") }
        guard let title = doc["title"]?.string, !title.trimmingCharacters(in: .whitespaces).isEmpty else { throw Problem("title is missing") }
        guard let keyword = doc["keyword"]?.string?.trimmingCharacters(in: .whitespaces), !keyword.isEmpty,
              !keyword.contains(" "), !keyword.hasPrefix("!"), !keyword.hasPrefix("?") else {
            throw Problem("keyword is missing, has a space, or starts with ! or ?")
        }
        guard let list = doc["command"]?.array, !list.isEmpty else { throw Problem("command must be a list, like [\"./run.sh\"]") }
        let command = list.compactMap(\.string)
        guard command.count == list.count, !command[0].isEmpty else { throw Problem("every part of command must be text") }
        let outputText = doc["output"]?.string ?? "text"
        guard let output = Output(rawValue: outputText) else { throw Problem("output must be \"text\" or \"list\", not \"\(outputText)\"") }
        var timeout = defaultTimeout
        if let t = doc["timeout"] {
            guard let s = t.double, s > 0 else { throw Problem("timeout must be a number of seconds") }
            timeout = min(s, maxTimeout)
        }
        return ScriptExtension(id: id, folder: folder, title: title, keyword: keyword, description: doc["description"]?.string ?? "",
                               command: command, output: output, timeout: timeout)
    }

    public struct Problem: Error, Equatable, CustomStringConvertible {
        public let description: String
        init(_ d: String) { description = d }
    }

    /// The program to start: `./x` and `x/y` are in the extension's folder, `/x` is as written, and a bare
    /// name is looked up in `ExtensionRunner.searchPath`. Nil when there is no such file.
    public func program() -> String? {
        let first = command[0]
        let fm = FileManager.default
        if first.hasPrefix("/") { return fm.isExecutableFile(atPath: first) ? first : nil }
        if first.contains("/") {
            let path = folder.appendingPathComponent(first).standardizedFileURL.path
            // Inside its own folder only.
            guard path.hasPrefix(folder.standardizedFileURL.path + "/") else { return nil }
            return fm.isExecutableFile(atPath: path) ? path : nil
        }
        for dir in ExtensionRunner.searchPath.split(separator: ":") {
            let p = "\(dir)/\(first)"
            if fm.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }
}

/// What a run gave back.
public struct ExtensionRun: Equatable, Sendable {
    public var status: Int32?
    public var timedOut = false
    public var stdout = ""
    public var stderr = ""
    /// The output was longer than `ExtensionRunner.maxOutput` and was cut there.
    public var truncated = false
    /// Why it didn't start, when it didn't.
    public var failure: String?

    public var succeeded: Bool { failure == nil && !timedOut && status == 0 }
}

/// Starts an extension's program with no shell: the arguments are handed over as they are, so nothing
/// typed is ever read as a command. It runs in the extension's folder in its own process group, with
/// stdin empty and a short environment, and the whole group is stopped at the timeout.
public enum ExtensionRunner {
    public static let searchPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    public static let maxOutput = 64 * 1024
    static let maxErrors = 4 * 1024

    /// Runs and blocks until it ends or times out. Call it off the main thread.
    public static func run(_ ext: ScriptExtension, input: String) -> ExtensionRun {
        guard let program = ext.program() else {
            return ExtensionRun(failure: "\(ext.command[0]) isn't a program in \(ext.folder.path) or on the path")
        }
        var args = [program] + ext.command.dropFirst()
        if !input.isEmpty { args.append(input) }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        let env = ["PATH=\(searchPath)", "HOME=\(home)", "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8",
                   "POLYCARP_EXTENSION_DIR=\(ext.folder.path)", "POLYCARP_INPUT=\(input)"]
        return spawn(args, env: env, in: ext.folder.path, timeout: ext.timeout)
    }

    static func spawn(_ args: [String], env: [String], in dir: String, timeout: TimeInterval) -> ExtensionRun {
        var out: [Int32] = [0, 0]
        var err: [Int32] = [0, 0]
        guard pipe(&out) == 0 else { return ExtensionRun(failure: "no pipe") }
        guard pipe(&err) == 0 else { close(out[0]); close(out[1]); return ExtensionRun(failure: "no pipe") }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, out[1], 1)
        posix_spawn_file_actions_adddup2(&actions, err[1], 2)
        posix_spawn_file_actions_addchdir_np(&actions, dir)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Its own process group, so a timeout stops everything it started; only 0, 1 and 2 are inherited.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)

        var pid: pid_t = 0
        let rc = withCStrings(args) { argv in
            withCStrings(env) { envp in posix_spawn(&pid, args[0], &actions, &attr, argv, envp) }
        }
        close(out[1])
        close(err[1])
        guard rc == 0 else {
            close(out[0])
            close(err[0])
            return ExtensionRun(failure: "couldn't start \(args[0]): \(String(cString: strerror(rc)))")
        }

        var result = ExtensionRun()
        let group = DispatchGroup()
        var outData = Data(), errData = Data()
        var outCut = false, errCut = false
        let readers = DispatchQueue(label: "Polycarp extension output", attributes: .concurrent)
        readers.async(group: group) { (outData, outCut) = drain(out[0], limit: maxOutput) }
        readers.async(group: group) { (errData, errCut) = drain(err[0], limit: maxErrors) }

        let deadline = Date().addingTimeInterval(timeout)
        var status: Int32 = 0
        var ended = false
        while !ended {
            let w = waitpid(pid, &status, WNOHANG)
            if w == pid || (w == -1 && errno != EINTR) { ended = true; break }
            if Date() >= deadline {
                result.timedOut = true
                kill(-pid, SIGTERM)
                let grace = Date().addingTimeInterval(1)
                while waitpid(pid, &status, WNOHANG) == 0, Date() < grace { usleep(20_000) }
                kill(-pid, SIGKILL)
                _ = waitpid(pid, &status, 0)
                ended = true
                break
            }
            usleep(10_000)
        }
        // Anything it left running in its group would hold the pipes open.
        kill(-pid, SIGKILL)
        group.wait()
        close(out[0])
        close(err[0])
        if !result.timedOut {
            // WIFEXITED / WEXITSTATUS, which Swift doesn't import.
            result.status = (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1
        }
        result.stdout = String(decoding: outData, as: UTF8.self)
        result.stderr = String(decoding: errData, as: UTF8.self)
        result.truncated = outCut || errCut
        return result
    }

    /// Reads to the end, keeping at most `limit` bytes and throwing the rest away so the program never
    /// blocks on a full pipe.
    private static func drain(_ fd: Int32, limit: Int) -> (Data, Bool) {
        var data = Data()
        var cut = false
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(fd, &buf, buf.count)
            if n < 0, errno == EINTR { continue }
            if n <= 0 { break }
            let room = limit - data.count
            if room > 0 { data.append(contentsOf: buf[0..<min(n, room)]) }
            if n > room { cut = true }
        }
        return (data, cut)
    }

    private static func withCStrings<R>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
        var ptrs: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
        ptrs.append(nil)
        defer { for p in ptrs { free(p) } }
        return body(ptrs)
    }
}

/// An extension's output as launcher rows. `text`: one row, Return copies all of it. `list`: a row per
/// line, `title<TAB>subtitle<TAB>value`; Return opens a value that is an http(s) address and copies any
/// other (the value is the title when there is none).
public enum ExtensionOutput {
    public static let maxRows = 50

    public static func rows(_ run: ExtensionRun, of ext: ScriptExtension) -> [LauncherResult] {
        let section = ext.title
        guard run.succeeded else {
            let why: String
            if let f = run.failure { why = f } else if run.timedOut { why = "Stopped after \(ExtensionOutput.seconds(ext.timeout))" }
            else { why = "Exit status \(run.status ?? -1)" }
            let detail = run.stderr.split(separator: "\n").first.map(String.init) ?? ""
            return [LauncherResult(id: "ext-out:\(ext.id):error", section: section, title: why, subtitle: detail,
                                   symbol: "exclamationmark.triangle", placement: .top, action: .none)]
        }
        let text = run.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return [LauncherResult(id: "ext-out:\(ext.id):empty", section: section, title: "Nothing came back",
                                   symbol: "checkmark.circle", placement: .top, action: .none)]
        }
        switch ext.output {
        case .text:
            let shown = text.replacingOccurrences(of: "\n", with: " ⏎ ")
            return [LauncherResult(id: "ext-out:\(ext.id):text", section: section,
                                   title: shown.count > 200 ? String(shown.prefix(200)) + "…" : shown,
                                   subtitle: run.truncated ? "Cut at 64 KB · Return copies it" : "Return copies it",
                                   symbol: "text.alignleft", badge: "Copy", placement: .top, action: .copy(text))]
        case .list:
            return text.split(separator: "\n", omittingEmptySubsequences: true).prefix(maxRows).enumerated().map { n, line in
                let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                let title = parts[0]
                let subtitle = parts.count > 1 ? parts[1] : ""
                let value = parts.count > 2 && !parts[2].isEmpty ? parts[2] : title
                let lower = value.lowercased()
                let url = (lower.hasPrefix("https://") || lower.hasPrefix("http://")) ? URL(string: value) : nil
                return LauncherResult(id: "ext-out:\(ext.id):\(n)", section: section, title: title, subtitle: subtitle,
                                      symbol: url == nil ? "doc.on.doc" : "link", badge: url == nil ? "Copy" : "Open",
                                      placement: .top, action: url.map { .open($0) } ?? .copy(value))
            }
        }
    }

    static func seconds(_ t: TimeInterval) -> String {
        t == t.rounded() ? "\(Int(t)) s" : String(format: "%.1f s", t)
    }
}

import Foundation

// Polycarp's built-in terminal (libghostty, Ghostty's engine): what to open and the command line it runs. No AppKit and
// no libghostty here, so the CLI, the launcher and the tests share it, and it builds where the terminal doesn't.
// docs/terminal.md has the whole feature.

public enum TerminalBuild {
    /// What a build without libghostty says, once, when asked for a terminal (`polycarp-spaces term`, the launcher,
    /// bundle.sh). Universal and Intel builds and any Mac without the library compile the terminal out.
    public static let notBuilt = "terminal not built: needs the Metal Toolchain (xcodebuild -downloadComponent MetalToolchain)"
}

/// One request for a terminal: a window or the quick terminal, running a shell, a preset agent, your command, or a shell
/// on another device of your tailnet.
public struct TerminalLaunch: Equatable, Sendable {
    public enum Preset: String, CaseIterable, Sendable {
        case shell, claude, codex
        /// The program a preset runs; nil is your login shell.
        public var program: String? { self == .shell ? nil : rawValue }
        public var title: String {
            switch self {
            case .shell: "Terminal"
            case .claude: "Claude Code"
            case .codex: "Codex"
            }
        }
    }

    public var preset: Preset
    /// `--cmd`: run this instead of the preset, through your login shell.
    public var command: String?
    /// `--host`: a shell on this tailnet device (`tailscale ssh`, or `ssh` without the Tailscale command).
    public var host: String?
    /// The drop-down quick terminal instead of a new window.
    public var quick: Bool

    public init(preset: Preset = .shell, command: String? = nil, host: String? = nil, quick: Bool = false) {
        self.preset = preset; self.command = command; self.host = host; self.quick = quick
    }

    public static let usage = "usage: polycarp-spaces term [shell|claude|codex] [--cmd \"<command>\"] [--host <tailnet device>] [--quick]"

    /// The `term` command's arguments. A problem is one line for the person who typed it.
    public static func parse(_ args: [String]) -> Result<TerminalLaunch, TerminalLaunchError> {
        var launch = TerminalLaunch()
        var presetGiven = false
        var i = 0
        while i < args.count {
            let a = args[i]
            switch a {
            case "--cmd", "--host":
                guard i + 1 < args.count else { return .failure(.init("\(a) needs a value. \(usage)")) }
                let v = args[i + 1]
                if a == "--cmd" {
                    guard !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failure(.init("--cmd is empty")) }
                    launch.command = v
                } else {
                    launch.host = v
                }
                i += 2
                continue
            case "--quick": launch.quick = true
            default:
                guard !presetGiven, let p = Preset(rawValue: a) else { return .failure(.init(usage)) }
                launch.preset = p
                presetGiven = true
            }
            i += 1
        }
        if let problem = launch.problem { return .failure(problem) }
        return .success(launch)
    }

    /// Why this request can't run, or nil. `--host` opens a shell there, so it takes no command or agent (phase 1).
    public var problem: TerminalLaunchError? {
        if let host {
            guard TerminalLaunch.validHost(host) else {
                return .init("\(String(host.prefix(80)).debugDescription) isn't a tailnet device name (letters, digits, - and ., optionally user@)")
            }
            if command != nil || preset != .shell { return .init("--host opens a shell on that device; run the command there") }
        }
        if let command, command.contains("\0") { return .init("--cmd has a NUL byte") }
        return nil
    }

    // MARK: The wire

    /// As a request on the app's socket (`Wire.Request.Op.terminal`).
    public var request: Wire.Request {
        var args = [preset.rawValue]
        if quick { args.append("--quick") }
        return Wire.Request(op: .terminal, target: host, text: command, args: args)
    }

    /// The request the app got, checked again: the socket is this user's, but the app never trusts the bytes.
    public init?(request r: Wire.Request) {
        guard r.op == .terminal else { return nil }
        let args = r.args ?? []
        guard let first = args.first, let preset = Preset(rawValue: first), args.dropFirst().allSatisfy({ $0 == "--quick" }) else { return nil }
        self.init(preset: preset, command: r.text, host: r.target, quick: args.contains("--quick"))
        if problem != nil { return nil }
    }

    // MARK: The command line

    /// A tailnet device as `tailscale ssh` and `ssh` take it: a MagicDNS name (labels of letters, digits and
    /// hyphens, joined by dots) or a tailnet IPv4 address, with an optional `user@`. Nothing that starts with
    /// `-` (an option to ssh), no spaces, quotes, `$`, `;` or anything else a shell or ssh reads.
    public static func validHost(_ s: String) -> Bool {
        guard !s.isEmpty, s.utf8.count <= 253 + 33 else { return false }
        let parts = s.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return false }
        if parts.count == 2 {
            let user = parts[0]
            guard (1...32).contains(user.count), let f = user.unicodeScalars.first,
                  isLower(f) || f == "_",
                  user.unicodeScalars.allSatisfy({ isLower($0) || isDigit($0) || $0 == "_" || $0 == "-" || $0 == "." }) else { return false }
        }
        let name = parts[parts.count - 1]
        guard (1...253).contains(name.count) else { return false }
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        return labels.allSatisfy { l in
            (1...63).contains(l.count)
                && l.unicodeScalars.allSatisfy { isAlnum($0) || $0 == "-" }
                && l.first != "-" && l.last != "-"
        }
    }

    private static func isLower(_ c: Unicode.Scalar) -> Bool { c >= "a" && c <= "z" }
    private static func isDigit(_ c: Unicode.Scalar) -> Bool { c >= "0" && c <= "9" }
    private static func isAlnum(_ c: Unicode.Scalar) -> Bool { isLower(c) || isDigit(c) || (c >= "A" && c <= "Z") }

    /// One word for `/bin/sh`: single quotes, each `'` inside as `'\''`.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The command libghostty runs for this request (Ghostty hands a command with arguments to `/bin/sh -c`), or nil for
    /// your login shell. Everything else runs through `shell -l -i -c` so it finds what your shell's PATH finds
    /// (`claude` in ~/.local/bin, Homebrew). `shell` is your login shell's absolute path; `tailscale` the Tailscale
    /// command's, when there is one. Nil `self.problem` is required.
    public func commandLine(shell: String, tailscale: String?) -> String? {
        precondition(problem == nil, "commandLine on a request with a problem")
        let inner: String
        if let host {
            let ssh = tailscale.map { TerminalLaunch.shellQuote($0) + " ssh" } ?? "ssh"
            inner = "exec \(ssh) \(TerminalLaunch.shellQuote(host))"
        } else if let command {
            inner = command
        } else if let program = preset.program {
            inner = "exec \(program)"
        } else {
            return nil
        }
        return "\(TerminalLaunch.shellQuote(shell)) -l -i -c \(TerminalLaunch.shellQuote(inner))"
    }

    /// A window title until the program sets its own.
    public var title: String {
        if let host { return "Terminal on \(host)" }
        if let command { return String(command.prefix(60)) }
        return preset.title
    }

    /// A login shell's path from `$SHELL`, else zsh: absolute, plain characters only, or zsh.
    public static func loginShell(env: [String: String]) -> String {
        guard let s = env["SHELL"], s.hasPrefix("/"), s.count < 256,
              s.unicodeScalars.allSatisfy({ isAlnum($0) || "/._-+".unicodeScalars.contains($0) }) else { return "/bin/zsh" }
        return s
    }
}

public struct TerminalLaunchError: Error, Equatable, Sendable, CustomStringConvertible {
    public let description: String
    public init(_ s: String) { description = s }
}

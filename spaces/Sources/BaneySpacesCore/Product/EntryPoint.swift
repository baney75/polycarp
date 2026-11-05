import Foundation

/// What the app does with its arguments before it starts anything. `--version` and `--help` are
/// answered here and the process exits: no AppKit, no sockets, no files. (A copy started with
/// `--version` used to launch the whole app.)
public enum EntryPoint {
    public struct Immediate: Equatable {
        public var text: String
        public var code: Int32
    }

    /// Flags that only print. nil: carry on starting.
    public static func immediate(arguments: [String], info: [String: Any]?, binary: String = Product.name) -> Immediate? {
        let flags = Set(arguments.dropFirst())
        if flags.contains("--version") || flags.contains("-v") {
            return Immediate(text: versionLine(info: info), code: 0)
        }
        if flags.contains("--help") || flags.contains("-h") {
            return Immediate(text: help(binary: binary), code: 0)
        }
        return nil
    }

    public static func versionLine(info: [String: Any]?) -> String {
        let version = (info?["CFBundleShortVersionString"] as? String) ?? "unknown"
        let commit = (info?["PolycarpCommit"] as? String).map { String($0.prefix(7)) }
        return "\(Product.name) \(version)" + (commit.map { " (\($0))" } ?? "")
    }

    public static func help(binary: String) -> String {
        """
        \(Product.name): workspaces for your Mac. It lives in the menu bar.

        usage: \(binary) [--setup]
               \(binary) --bangs list|add|remove …   manage launcher bangs, then exit
               \(binary) --version                    print the version and exit
               \(binary) --help                       print this and exit

        Only one copy runs. Starting another brings the running one forward.
        For agents and hooks use the command \(Product.commandName) (also \(Product.commandAliases.joined(separator: ", "))).
        """
    }

    /// Arguments that print and exit without starting the app or taking its lock: they must work
    /// while another copy runs.
    public static let runsBesideAnotherCopy: Set<String> = ["--render", "--bangs"]

    public static func needsExclusiveCopy(arguments: [String]) -> Bool {
        Set(arguments.dropFirst()).isDisjoint(with: runsBesideAnotherCopy)
    }
}

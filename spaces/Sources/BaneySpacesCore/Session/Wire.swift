import Foundation

/// The app and the `polycarp-spaces` command (also `baneyspaces`, `ghostdeck`) talk over a Unix socket, one
/// JSON line each way. The socket is in the user's Application Support folder, so only this user's
/// processes can reach it.
public enum Wire {
    public static var supportDir: URL { Product.supportDir(home: FileManager.default.homeDirectoryForCurrentUser) }
    /// The folder of the app this one replaced. Read for fallbacks only.
    public static var legacySupportDir: URL { Product.legacySupportDir(home: FileManager.default.homeDirectoryForCurrentUser) }
    public static var socketPath: String { supportDir.appendingPathComponent(Product.socketName).path }
    /// Where the app writes its state: always its own folder.
    public static var ownStatePath: String { supportDir.appendingPathComponent("session.json").path }
    /// The live state file to read: the app's own, else a running BaneySpaces', which writes the same file. A file the
    /// old app left behind when it quit is stale, so it counts only while one of the old sockets answers.
    public static var statePath: String { statePath(dir: supportDir, legacyDir: legacySupportDir) }

    public static func statePath(dir: URL, legacyDir: URL) -> String {
        let mine = dir.appendingPathComponent("session.json").path
        let old = legacyDir.appendingPathComponent("session.json").path
        let fm = FileManager.default
        guard !fm.fileExists(atPath: mine), fm.fileExists(atPath: old) else { return mine }
        return SocketClaim.anyLive(Product.Legacy.socketNames.map { legacyDir.appendingPathComponent($0).path }) ? old : mine
    }

    /// Where the app listens: its own socket only. The old names live in the old folder and belong
    /// to a BaneySpaces that may still be running.
    public static func listenPaths(dir: URL = supportDir) -> [String] {
        [dir.appendingPathComponent(Product.socketName).path]
    }

    /// Where to reach the app, in order: the current socket, then the old app's two (`baneyspaces.sock`,
    /// `deck.sock`), so an older install or a client started before the move keeps working.
    public static func socketCandidates(dir: URL = supportDir, legacyDir: URL = legacySupportDir) -> [String] {
        listenPaths(dir: dir) + Product.Legacy.socketNames.map { legacyDir.appendingPathComponent($0).path }
    }

    public struct Request: Codable, Equatable, Sendable {
        public enum Op: String, Codable, Sendable {
            /// An agent's hook event (`event` set).
            case event
            /// Every item, as JSON.
            case list
            /// Bring an item forward: `target` is an item ID or a search.
            case focus
            /// Open `target` (a URL) in the default browser.
            case open
            /// Type `text` into the terminal `target`, as if pasted. Ghostty only.
            case send
            /// Mark `target` (or the caller's row) as needing you.
            case notify
            case ping
            /// The agent workspace: `text` is status, on, off, windows or move; `args` the rest
            /// (docs/agent-workspace-api.md).
            case agent
            /// Remote machines (local callers only): `text` is on, off or status.
            case remote
            /// Read or change a setting (`SettingKey`): `target` is its name, `text` the new value
            /// (none reads it). Agents may change how this Mac looks (Donovan, 2026-11-01), so a remote
            /// token may too; every change is logged with its caller (`caller`). Workspace and window
            /// ops stay user-only (`Remote.allows`).
            case setting
            /// The app's own updater, for `polycarp-spaces update` and `polycarp update`: `text` is status,
            /// check (ask GitHub again) or now (install the release on offer). The reply's `info` is an
            /// `UpdateReport`. Local callers only (`Remote.allows` never lets it through).
            case update
            /// A terminal in Polycarp's own window (libghostty): `args` is the preset (shell, claude, codex) and
            /// `--quick`, `text` a command, `target` a tailnet device (`TerminalLaunch`). Local callers only: a shell is
            /// never opened for another machine (`Remote.allows`).
            case terminal
            /// Show `target` (an absolute file path) in the built-in player (`polycarp-spaces play`, spec/player.md).
            /// Local callers only (`Remote.allows` never lets it through).
            case play
            /// People in Contacts (`polycarp-spaces contacts`, docs/contacts.md): `text` is find, call, facetime, message
            /// or email, `target` the query, `args` the flags (`--full`, `--text` and the draft). Never sends a message.
            /// Local callers only (`Remote.allows` never lets it through).
            case contacts
            /// Opens the app for a job (`RoleRequest`): `target` is the role, `text` a prompt for the agent, `args` the
            /// flags. Local callers only: nothing is opened for another machine (`Remote.allows`).
            case role
            /// Windows side by side (`polycarp-spaces tile`, docs/tiling.md): `args` is the request (`TilingRequest`). Answered
            /// once it is done, with a `TilingStatus`. Never over the remote socket (`Remote.allows`); the gateway runs it on this Mac
            /// for a caller with the act scope.
            case tile
            /// What an agent may see of the browser (`BrowserAgents`): `text` is tabs, `target` a few words to look
            /// for, `args` the most to answer. Off until the person turns it on in Settings. Local callers only
            /// (`Remote.allows` never lets it through).
            case browser
        }
        public var op: Op
        public var target: String?
        public var text: String?
        public var event: AgentEvent?
        public var args: [String]?
        /// Required from remote machines; ignored on the local socket.
        public var token: String?
        /// Who is asking, for the log: an agent's name or the app that ran the command. Informational only.
        /// A request from another machine is logged under its token's fingerprint as well.
        public var caller: String?

        public init(op: Op, target: String? = nil, text: String? = nil, event: AgentEvent? = nil, args: [String]? = nil,
                    token: String? = nil, caller: String? = nil) {
            self.op = op; self.target = target; self.text = text; self.event = event; self.args = args; self.token = token
            self.caller = caller
        }
    }

    public struct Reply: Codable, Equatable, Sendable {
        public var ok: Bool
        public var error: String?
        public var items: [Item]?
        public var info: [String: String]?
        /// The people `contacts find` found.
        public var contacts: [ContactSummary]?

        public init(ok: Bool, error: String? = nil, items: [Item]? = nil, info: [String: String]? = nil,
                    contacts: [ContactSummary]? = nil) {
            self.ok = ok; self.error = error; self.items = items; self.info = info; self.contacts = contacts
        }
    }

    /// Sends one request and waits up to `timeout` seconds for the reply. Nil when the app isn't running.
    /// With no `path` it tries the current socket and falls back to the old one only when nothing
    /// listens on the first (a connect failure), never after a timeout, so a request isn't sent twice.
    public static func call(_ request: Request, timeout: Double = 2, path: String? = nil) -> Reply? {
        send(request, timeout: timeout, path: path).reply
    }

    /// `call`, and whether anything took the connection. A nil reply after a connection means the app had the request and
    /// then went quiet or quit, so what it was asked to do may have happened. Not connected: nothing was sent.
    public static func send(_ request: Request, timeout: Double = 2, path: String? = nil) -> (reply: Reply?, connected: Bool) {
        for p in path.map({ [$0] }) ?? socketCandidates() {
            let (reply, connected) = exchange(request, timeout: timeout, path: p)
            if connected { return (reply, true) }
        }
        return (nil, false)
    }

    private static func exchange(_ request: Request, timeout: Double, path: String) -> (Reply?, connected: Bool) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return (nil, false) }
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - Double(Int(timeout))) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        guard var addr = address(path: path) else { return (nil, false) }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { return (nil, false) }
        guard var data = try? JSONEncoder().encode(request) else { return (nil, true) }
        data.append(0x0A)
        guard writeAll(fd, data) else { return (nil, true) }
        guard let line = readLine(fd) else { return (nil, true) }
        return (try? JSONDecoder().decode(Reply.self, from: line), true)
    }

    public static func address(path: String) -> sockaddr_un? {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        return addr
    }

    public static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = write(fd, raw.baseAddress! + off, raw.count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }

    /// Reads up to the first newline, at most `limit` bytes (4 MB unless a caller asks for less),
    /// giving up at `deadline` however slowly the bytes trickle in.
    public static func readLine(_ fd: Int32, limit: Int = 4 << 20, deadline: Date = .distantFuture) -> Data? {
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        while out.count < limit {
            let left = deadline.timeIntervalSinceNow
            guard left > 0 else { return nil }
            if deadline != .distantFuture {
                var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                guard poll(&p, 1, Int32(min(left, 60) * 1000)) > 0 else { return nil }
            }
            let n = read(fd, &buf, min(buf.count, limit - out.count))
            if n <= 0 { return out.isEmpty ? nil : out }
            if let nl = buf[0..<n].firstIndex(of: 0x0A) {
                out.append(contentsOf: buf[0..<nl])
                return out
            }
            out.append(contentsOf: buf[0..<n])
        }
        return nil
    }
}

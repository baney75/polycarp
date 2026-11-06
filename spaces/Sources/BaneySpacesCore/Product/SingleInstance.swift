import Darwin
import Foundation

/// Only one copy of Polycarp runs, however it was started. Two copies fight over the same sockets,
/// hotkeys, Dock settings and window positions, and the second one used to take the first one's
/// sockets away (the `--version` incident, 2026-11-05).
///
/// Among Polycarp copies the lock decides, alone: a lock file held for the life of the process
/// (`flock`). It catches a copy run from any path, a renamed bundle or a bare binary, and two copies
/// starting at the same moment cannot both win, which a look at the running list cannot promise.
/// BaneySpaces is another matter: it has no lock, so only a look at its bundle ID sees it, and it is
/// handled by `LegacyHandover` (an alert, then a quit), never by a silent exit.
public enum SingleInstance {
    public enum Claim {
        /// This process is the one. Keep the lock alive until exit.
        case mine(Lock)
        /// Another Polycarp holds the lock; bring it forward. `pid` is nil when it could not be told.
        case yield(to: Int32?)
    }

    /// Decides at the top of `main`.
    public static func claim(lockURL: URL, me: Int32 = getpid()) -> Claim {
        switch Lock.acquire(at: lockURL, pid: me) {
        case .acquired(let lock): return .mine(lock)
        case .busy(let holder): return .yield(to: holder)
        case .failed:
            // The folder or file can't be used. Refusing to start would leave the person with no app.
            return .mine(Lock(fd: -1, url: lockURL))
        }
    }

    public final class Lock {
        let fd: Int32
        public let url: URL
        init(fd: Int32, url: URL) { self.fd = fd; self.url = url }
        public var isHeld: Bool { fd >= 0 }
        /// For tests only.
        public var fdForTest: Int32 { fd }

        public enum Result {
            case acquired(Lock)
            /// Another process holds it; its pid when the file says.
            case busy(holder: Int32?)
            case failed
        }

        /// Takes the lock without waiting and writes this pid into the file. The descriptor is
        /// close-on-exec, so a helper the app starts can't keep the lock alive after the app dies.
        public static func acquire(at url: URL, pid: Int32 = getpid()) -> Result {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let fd = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard fd >= 0 else { return .failed }
            if flock(fd, LOCK_EX | LOCK_NB) != 0 {
                let busy = errno == EWOULDBLOCK
                var buf = [UInt8](repeating: 0, count: 32)
                let n = read(fd, &buf, buf.count - 1)
                close(fd)
                guard busy else { return .failed }
                let text = n > 0 ? String(decoding: buf[0..<n], as: UTF8.self) : ""
                return .busy(holder: Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            _ = ftruncate(fd, 0)
            let line = Array("\(pid)\n".utf8)
            _ = pwrite(fd, line, line.count, 0)
            return .acquired(Lock(fd: fd, url: url))
        }

        /// For tests: gives the lock up. The app never calls this; the lock ends with the process.
        public func release() { if fd >= 0 { close(fd) } }
    }
}

/// A Unix socket another process answers on is not ours to remove. Binding a socket path first
/// unlinks what is there, which is right for a leftover file and wrong for a live server: its
/// clients would reach the new process, and the old one would keep running with no socket.
public enum SocketClaim {
    public enum State: Equatable {
        /// Nothing at the path.
        case free
        /// A file with nobody listening (a crash left it): removed.
        case removedStale
        /// A process answers. Nothing was touched.
        case live
    }

    /// Whether something accepts connections on `path`.
    public static func isLive(path: String) -> Bool {
        guard let fdAddr = Wire.address(path: path) else { return false }
        var addr = fdAddr
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        // Never block on a server that stopped answering.
        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        return connected == 0
    }

    /// Whether any of `paths` has a process answering: how a client tells "not running" (nothing answers) from "running
    /// but slow" (something does). A socket file that is merely there proves nothing; a crash leaves one.
    public static func anyLive(_ paths: [String]) -> Bool { paths.contains { isLive(path: $0) } }

    /// Makes `path` ready to bind: leaves a live socket alone, removes a stale file.
    public static func prepare(path: String) -> State {
        guard FileManager.default.fileExists(atPath: path) else { return .free }
        if isLive(path: path) { return .live }
        unlink(path)
        return .removedStale
    }
}

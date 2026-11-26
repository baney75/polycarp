import Darwin
import Foundation

/// The browser's long line to the app (docs/newtab.md): the extension opens a native messaging port, the host it starts
/// carries each message to the app over a socket of its own (`browser.sock`) and the app's back, and stays until the
/// browser closes the port. It keeps nothing and reads nothing it carries.
public enum BrowserRelay {
    /// The first message on a port that stays open: `{"op":"browser.join"}`.
    public static let join = "browser.join"
    public static let socketName = "browser.sock"
    /// What the extension hears while the app isn't there: nothing it sends is kept, and it sends all of it again when
    /// `browser.want` says the app is back.
    public static let away = Data(#"{"op":"browser.away"}"#.utf8)

    public static func path(dir: URL = Wire.supportDir) -> String { dir.appendingPathComponent(socketName).path }

    public static func isJoin(_ message: Data) -> Bool {
        ((try? JSONSerialization.jsonObject(with: message)) as? [String: Any])?["op"] as? String == join
    }

    /// Carries messages between the port (`input`, `output`) and the app until the port closes. The app may come and go;
    /// it is looked for again every `retry` seconds.
    public static func serve(input: Int32, output: Int32, path: String, retry: TimeInterval = 3) {
        var app: Int32 = -1
        var lines = Lines()
        var nextTry = Date.distantPast
        var told = false // the port has heard `away` since the app was last there
        func leave() -> Bool {
            close(app)
            app = -1
            lines = Lines()
            nextTry = Date().addingTimeInterval(retry)
            told = true
            return Wire.writeAll(output, NewTabHost.encode(away))
        }
        defer { if app >= 0 { close(app) } }
        while true {
            if app < 0, Date() >= nextTry {
                app = connect(path)
                nextTry = Date().addingTimeInterval(retry)
                // A browser that starts before the app hears so once, as it does when the app goes.
                if app >= 0 { told = false } else if !told {
                    told = true
                    guard Wire.writeAll(output, NewTabHost.encode(away)) else { return }
                }
            }
            var fds = [pollfd(fd: input, events: Int16(POLLIN), revents: 0), pollfd(fd: app, events: Int16(POLLIN), revents: 0)]
            let wait = app >= 0 ? -1 : Int32(max(10, nextTry.timeIntervalSinceNow * 1000))
            let n = poll(&fds, 2, wait)
            if n < 0 && errno != EINTR { return }
            guard n > 0 else { continue }
            if fds[1].revents != 0, app >= 0 {
                guard let got = lines.read(app) else {
                    guard leave() else { return }
                    continue
                }
                for line in got { guard Wire.writeAll(output, NewTabHost.encode(line)) else { return } }
            }
            if fds[0].revents != 0 {
                guard let message = NewTabHost.readMessage(fd: input) else { return }
                // One line each on the socket; JSON has a raw newline only between values, where a space is the same.
                if app >= 0, !Wire.writeAll(app, Data(message.map { $0 == 0x0A ? 0x20 : $0 }) + [0x0A]), !leave() { return }
            }
        }
    }

    static func connect(_ path: String) -> Int32 {
        guard var addr = Wire.address(path: path) else { return -1 }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return -1 }
        quiet(fd)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { close(fd); return -1 }
        return fd
    }

    /// No SIGPIPE, and a write the other side won't take gives up in 5 s.
    static func quiet(_ fd: Int32) {
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// Whole lines out of a stream of bytes.
    struct Lines {
        private var rest = Data()
        /// The lines one read finished; nil at the end, on an error, or past a line of `NewTabHost.maxMessage`.
        mutating func read(_ fd: Int32) -> [Data]? {
            var buf = [UInt8](repeating: 0, count: 65_536)
            let n = Darwin.read(fd, &buf, buf.count)
            if n < 0 && (errno == EINTR || errno == EAGAIN) { return [] }
            guard n > 0 else { return nil }
            rest.append(contentsOf: buf[0..<n])
            var out: [Data] = []
            while let nl = rest.firstIndex(of: 0x0A) {
                if nl > rest.startIndex { out.append(Data(rest[rest.startIndex..<nl])) }
                rest = Data(rest[(nl + 1)...])
            }
            return rest.count > NewTabHost.maxMessage ? nil : out
        }
    }
}

/// The app's end: every browser profile that runs the extension, over `browser.sock` in the app's own folder (this
/// user's processes only). Which browser it is comes from the kernel (`LOCAL_PEERPID`, and whose child that process is),
/// never from what it says. Callbacks are on the main thread.
public final class BrowserServer {
    public final class Link {
        public let peer: BrowserPeer
        private let fd: Int32
        private let out = DispatchQueue(label: "polycarp.browser.out")
        private var closed = false
        fileprivate init(_ peer: BrowserPeer, _ fd: Int32) { self.peer = peer; self.fd = fd }

        /// One message to the extension; a link that is gone takes none.
        public func send(_ message: [String: Any]) {
            guard var data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
            data.append(0x0A)
            out.async { [self] in if !closed, !Wire.writeAll(fd, data) { shutdown(fd, SHUT_RDWR) } }
        }
        fileprivate func end() { out.sync { if !closed { closed = true; close(fd) } } }
        /// Hangs up; the reader sees the end and `gone` follows.
        public func hangUp() { out.async { [self] in if !closed { shutdown(fd, SHUT_RDWR) } } }
    }

    public var joined: (Link) -> Void = { _ in }
    public var message: (BrowserMessage, Link) -> Void = { _, _ in }
    public var gone: (Link) -> Void = { _ in }

    private let path: String
    private let identify: (Int32) -> String?
    private var listener: (fd: Int32, source: DispatchSourceRead)?
    private let io = DispatchQueue(label: "polycarp.browser", attributes: .concurrent)
    private var number = 0
    private var links: [Link] = []
    /// Profiles at once; more are turned away.
    static let most = 12

    public init(path: String = BrowserRelay.path(), identify: @escaping (Int32) -> String? = BrowserServer.browser) {
        self.path = path
        self.identify = identify
    }

    /// The browsers whose extension may join: the Chromium browsers Polycarp knows. Any other app this person runs is
    /// turned away, so a script in a terminal can't pose as a browser.
    public static func isBrowser(_ bundleID: String) -> Bool {
        ["com.baney.polycarp.browser", "org.chromium.Chromium"].contains(bundleID)
            || Catalog.known.contains { $0.bundleID == bundleID && $0.adapter == .chromium }
    }

    /// The bundle ID of the browser whose host holds the other end of `fd`.
    public static func browser(_ fd: Int32) -> String? {
        var pid: pid_t = 0
        var size = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, pid > 0 else { return nil }
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 else { return nil }
        return NewTabHost.appBundleID(of: pid_t(info.pbi_ppid)).flatMap { isBrowser($0) ? $0 : nil }
    }

    @discardableResult
    public func start() -> Bool {
        guard listener == nil else { return true }
        guard SocketClaim.prepare(path: path) != .live, var addr = Wire.address(path: path) else { return false }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        // Bound as the app's own socket is: until the chmod, the usual umask already keeps others from connecting. The umask
        // isn't changed, because it is the whole process's and another thread may be making a folder.
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(fd, 8) == 0 else { close(fd); return false }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: io)
        source.setEventHandler { [weak self] in
            while true {
                let client = accept(fd, nil, nil)
                guard client >= 0 else { return }
                guard let self else { close(client); return }
                self.io.async { self.serve(client) }
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        listener = (fd, source)
        return true
    }

    public func stop() {
        guard let l = listener else { return }
        listener = nil
        l.source.cancel()
        unlink(path)
        links.forEach { $0.hangUp() }
    }

    private func serve(_ fd: Int32) {
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
        BrowserRelay.quiet(fd)
        guard let bundleID = identify(fd) else { close(fd); return }
        let link: Link? = DispatchQueue.main.sync {
            guard listener != nil, links.count < Self.most else { return nil }
            number += 1
            let link = Link(BrowserPeer(bundleID, number), fd)
            links.append(link)
            joined(link)
            return link
        }
        guard let link else { close(fd); return }
        var lines = BrowserRelay.Lines()
        while let got = lines.read(fd) {
            // Checked here, off the main thread; only what stands goes over.
            for m in got.compactMap({ BrowserMessage($0) }) { DispatchQueue.main.async { self.message(m, link) } }
        }
        link.end()
        DispatchQueue.main.async {
            self.links.removeAll { $0 === link }
            self.gone(link)
        }
    }
}

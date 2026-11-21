import AppKit
import BaneySpacesCore

/// The window server tells Polycarp the moment a bordered window moves or resizes (SkyLight's notify procs, events 806
/// and 807, asked for those windows only), and the border moves right there in a window-server transaction, before the
/// next frame is drawn. Reading the window list to find out could not keep up: that read waits on the window server
/// while any window moves (about 7 ms, against 0.14 ms when still), so a border that followed it trailed by a frame.
///
/// Off, nothing is registered and no window is watched. The proc may run on any thread: the targets sit behind a lock.
/// AppKit never hears of these moves; `WindowBorders` reshapes a panel through AppKit only when its window's size changed.
enum BorderMoves {
    static let moved: UInt32 = 806
    static let resized: UInt32 = 807

    /// One bordered window: its border's window number, how far the border sits outside it, and the border's size now.
    struct Target: Equatable {
        var border: UInt32
        var style: WindowBorderStyle
        var size: CGSize
    }

    private typealias Proc = @convention(c) (UInt32, UnsafeMutableRawPointer?, Int, UnsafeMutableRawPointer?) -> Void
    private typealias Register = @convention(c) (Proc, UInt32, UnsafeMutableRawPointer?) -> Int32
    private typealias Request = @convention(c) (Int32, UnsafePointer<UInt32>?, Int32) -> Int32
    private typealias Bounds = @convention(c) (Int32, UInt32, UnsafeMutablePointer<CGRect>) -> Int32
    private typealias Create = @convention(c) (Int32) -> Unmanaged<CFTypeRef>?
    private typealias Move = @convention(c) (CFTypeRef, UInt32, CGPoint) -> Int32
    private typealias Commit = @convention(c) (CFTypeRef, Int32) -> Int32

    private struct Calls {
        let cid: Int32
        let register, remove: Register
        let request: Request
        let bounds: Bounds
        let create: Create
        let move: Move
        let commit: Commit
    }

    /// The SkyLight calls, or the name of the first one this macOS lacks.
    private static let calls: Result<Calls, Missing> = {
        guard let h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY) else { return .failure(Missing(name: "SkyLight")) }
        func sym<T>(_ name: String, _: T.Type) throws -> T {
            guard let p = dlsym(h, name) else { throw Missing(name: name) }
            return unsafeBitCast(p, to: T.self)
        }
        do {
            typealias Connection = @convention(c) () -> Int32
            return .success(Calls(cid: try sym("SLSMainConnectionID", Connection.self)(),
                                  register: try sym("SLSRegisterNotifyProc", Register.self),
                                  remove: try sym("SLSRemoveNotifyProc", Register.self),
                                  request: try sym("SLSRequestNotificationsForWindows", Request.self),
                                  bounds: try sym("SLSGetWindowBounds", Bounds.self),
                                  create: try sym("SLSTransactionCreate", Create.self),
                                  move: try sym("SLSTransactionMoveWindowWithGroup", Move.self),
                                  commit: try sym("SLSTransactionCommit", Commit.self)))
        } catch { return .failure(error as? Missing ?? Missing(name: "SkyLight")) }
    }()

    struct Missing: Error { var name: String }

    private static let lock = NSLock()
    private static var targets: [UInt32: Target] = [:]
    private static var latest: [UInt32: CGRect] = [:]
    private static var registered = false
    /// A main-queue hand-off is waiting (at most one; it takes the newest frames).
    private static var handing = false
    /// Told on the main queue, with the newest frames, after borders moved.
    static var onMoved: (([UInt32: CGRect]) -> Void)?
    /// For the lag probe: the time and the window's place each time a border moves, on the thread that moved it.
    static var probe: ((Double, CGPoint) -> Void)?

    private static let proc: Proc = { _, data, length, _ in
        guard let data, length >= MemoryLayout<UInt32>.size else { return }
        BorderMoves.follow(data.loadUnaligned(as: UInt32.self))
    }

    /// Registers for move and resize notices. Nil when that worked, else why not (the caller falls back).
    static func start() -> String? {
        let c: Calls
        switch calls {
        case .success(let v): c = v
        case .failure(let m): return "\(m.name) is missing"
        }
        lock.lock(); defer { lock.unlock() }
        guard !registered else { return nil }
        let a = c.register(proc, moved, nil)
        let b = c.register(proc, resized, nil)
        guard a == 0, b == 0 else {
            if a == 0 { _ = c.remove(proc, moved, nil) }
            if b == 0 { _ = c.remove(proc, resized, nil) }
            return "SLSRegisterNotifyProc answered \(a), \(b)"
        }
        registered = true
        return nil
    }

    /// Unregisters and watches nothing.
    static func stop() {
        watch([:])
        guard case .success(let c) = calls else { return }
        lock.lock(); defer { lock.unlock() }
        guard registered else { return }
        _ = c.remove(proc, moved, nil)
        _ = c.remove(proc, resized, nil)
        registered = false
    }

    /// The windows to follow from now on, by window number. Main thread.
    static func watch(_ new: [UInt32: Target]) {
        guard case .success(let c) = calls else { return }
        lock.lock()
        let changed = Set(new.keys) != Set(targets.keys)
        targets = new
        latest = latest.filter { new[$0.key] != nil }
        lock.unlock()
        guard changed else { return }
        let ids = Array(new.keys)
        _ = ids.withUnsafeBufferPointer { c.request(c.cid, $0.baseAddress, Int32($0.count)) }
    }

    /// A border's size changed on the main thread (AppKit reshaped it).
    static func reshaped(_ id: UInt32, size: CGSize) { lock.lock(); targets[id]?.size = size; lock.unlock() }

    /// Where `id` is now, by one window-server call, and its border moved there. Any thread.
    @discardableResult
    static func follow(_ id: UInt32) -> CGRect? {
        guard case .success(let c) = calls else { return nil }
        lock.lock(); let t = targets[id]; lock.unlock()
        guard let t else { return nil }
        var r = CGRect.zero
        guard c.bounds(c.cid, id, &r) == 0 else { return nil }
        let f = t.style.panelFrame(r)
        if let tx = c.create(c.cid)?.takeRetainedValue() {
            _ = c.move(tx, t.border, f.origin)
            _ = c.commit(tx, 0)
        }
        probe?(ProcessInfo.processInfo.systemUptime, r.origin)
        lock.lock()
        latest[id] = r
        let hand = !handing
        handing = true
        lock.unlock()
        if hand {
            DispatchQueue.main.async {
                lock.lock(); let frames = latest; handing = false; lock.unlock()
                onMoved?(frames)
            }
        }
        return r
    }
}

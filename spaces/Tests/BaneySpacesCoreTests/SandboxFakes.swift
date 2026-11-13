import Foundation
@testable import BaneySpacesCore

final class FakeClock: SandboxClock {
    private let lock = NSLock()
    private var t: TimeInterval = 1000
    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return t }
    func sleep(_ s: TimeInterval) {
        lock.lock(); t += s; lock.unlock()
        Thread.sleep(forTimeInterval: 0.001) // let background threads (the warm build) run
    }
    func advance(_ s: TimeInterval) { lock.lock(); t += s; lock.unlock() }
}

final class FakeProc: RunningProcess {
    static var next: Int32 = 5000
    let pid: Int32
    private let lock = NSLock()
    private var running = true
    var onRelease: (() -> Void)?
    /// A process that ignores kill, like a guest that won't stop.
    var immortal = false
    init() { FakeProc.next += 1; pid = FakeProc.next }
    func release() { onRelease?() }
    var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return running }
    func stop() { lock.lock(); running = false; lock.unlock() }
    func terminate() { if !immortal { stop() } }
    func kill() { if !immortal { stop() } }
    func waitForExit(timeout: TimeInterval) -> Bool { !isRunning }
}

/// A fake `tart`: VMs in memory, every verb recorded, failures injectable.
final class FakeTart: ProcessRunning {
    struct VM { var suspended = false; var proc: FakeProc? }
    /// Recursive, so a `withVMs` change that reads the fake (`tart.vms`, `tart.spawned`) takes it again instead of
    /// hanging on itself (review of PR 233, round 2 second-F5).
    let lock = NSRecursiveLock()
    /// Tests set these while the warm build's thread reads them, so both sides take the lock.
    private var _vms: [String: VM] = [:]
    var vms: [String: VM] { lock.lock(); defer { lock.unlock() }; return _vms }
    /// A change to the VMs is one locked step: `vms["x"] = ...` through a getter and a setter let the warm build's
    /// thread change them between the two (review of PR 233, first-F2).
    func withVMs(_ change: (inout [String: VM]) -> Void) { lock.lock(); defer { lock.unlock() }; change(&_vms) }
    var imagePulled = false
    // What the fake recorded is read under its lock: the warm build records from its own thread while a test
    // reads. An unlocked read that met an append growing the array saw it empty (TSan, 11-12: buildWarm's spawn
    // against the view test's count, which read 0 runs of the task VM and then 1).
    private var _calls: [[String]] = []
    private var _spawned: [(args: [String], proc: FakeProc)] = []
    private var _order: [String] = []
    var calls: [[String]] { lock.lock(); defer { lock.unlock() }; return _calls }
    var spawned: [(args: [String], proc: FakeProc)] { lock.lock(); defer { lock.unlock() }; return _spawned }
    var order: [String] {
        get { lock.lock(); defer { lock.unlock() }; return _order }
        set { lock.lock(); _order = newValue; lock.unlock() }
    }
    /// Adds to `order` in one locked step, so a test's note can't drop a spawn the warm build adds at the same time.
    func note(_ step: String) { lock.lock(); _order.append(step); lock.unlock() }
    var failClone = false
    var failDeleteOnce = 0          // deletes that silently do nothing
    var failResume = false
    var agentNeverAnswers = false
    var leaks: Set<String> = []     // IPs the guest can reach (a broken isolation)
    var noInternet = false
    var guestReply: String?
    var guestTruncated = false
    private var _stdinSeen: [String] = []
    var stdinSeen: [String] { lock.lock(); defer { lock.unlock() }; return _stdinSeen }
    /// Called after the lock with the process this spawn made: a hook that read `FakeProc.next` instead could see a pid
    /// the warm build's thread made in between (review of PR 206, second-F4).
    /// A test sets the hooks while the warm build's thread reads them, so both sides take the lock (round 2 second-F6).
    var onSpawn: ((_ args: [String], _ proc: FakeProc) -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onSpawn }
        set { lock.lock(); _onSpawn = newValue; lock.unlock() }
    }
    private var _onSpawn: ((_ args: [String], _ proc: FakeProc) -> Void)?
    var v6Addresses = 0
    var spawnImmortal = false
    /// Called inside `clone` so a test can delay a warm build.
    var onClone: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onClone }
        set { lock.lock(); _onClone = newValue; lock.unlock() }
    }
    private var _onClone: (() -> Void)?
    /// Set by a test while the fake answers guest commands on other threads, so it is set under the lock.
    private var _v6Leak = false
    var v6Leak: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _v6Leak }
        set { lock.lock(); _v6Leak = newValue; lock.unlock() }
    }
    var firewallState = "Firewall is disabled. (State = 0)"
    var stubFail: ProcessResult?

    func requestID(_ stdin: String?) -> String {
        guard let s = stdin, let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return "x" }
        return o["id"] as? String ?? "x"
    }

    func vmNames() -> [String] { lock.lock(); defer { lock.unlock() }; return _vms.keys.sorted() }
    func ours() -> [String] { vmNames().filter { $0.hasPrefix(SandboxPin.vmPrefix) } }

    func run(_ exe: String, _ args: [String], env: [String: String], stdin: String?, timeout: TimeInterval, outputLimit: Int) -> ProcessResult {
        lock.lock(); defer { lock.unlock() }
        _calls.append(args)
        if exe.hasSuffix("socketfilterfw") { return ProcessResult(status: 0, stdout: args.contains("--getglobalstate") ? firewallState : "") }
        if exe.hasSuffix("route") { return ProcessResult(status: 0, stdout: "   gateway: 192.168.1.1\n") }
        guard let verb = args.first else { return ProcessResult(status: 2) }
        switch verb {
        case "list":
            if args.contains("oci") { return ProcessResult(status: 0, stdout: imagePulled ? SandboxPin.image + "\n" : "") }
            if args.contains("json") {
                let items = _vms.map { "{\"Name\":\"\($0.key)\",\"Running\":\($0.value.proc?.isRunning == true)}" }
                return ProcessResult(status: 0, stdout: "[" + items.joined(separator: ",") + "]")
            }
            return ProcessResult(status: 0, stdout: _vms.keys.sorted().joined(separator: "\n"))
        case "clone":
            if failClone { return ProcessResult(status: 1, stderr: "no space left") }
            let hook = _onClone
            lock.unlock()
            hook?()
            lock.lock()
            imagePulled = true
            _vms[args[2]] = VM()
            return ProcessResult(status: 0)
        case "set": return ProcessResult(status: 0)
        case "stop": return ProcessResult(status: 0)
        case "delete":
            if failDeleteOnce > 0 { failDeleteOnce -= 1; return ProcessResult(status: 0) }
            _vms[args[1]] = nil
            return ProcessResult(status: 0)
        case "suspend":
            guard _vms[args[1]]?.proc?.isRunning == true else { return ProcessResult(status: 1, stderr: "not running") }
            _vms[args[1]]?.suspended = true
            _vms[args[1]]?.proc?.stop()
            return ProcessResult(status: 0)
        case "exec":
            let vm = args.first(where: { $0.hasPrefix(SandboxPin.vmPrefix) }) ?? args[1]
            guard let rec = _vms[vm], rec.proc?.isRunning == true, !agentNeverAnswers else { return ProcessResult(status: 1, stderr: "no agent") }
            if args.last == "/usr/bin/true" { return ProcessResult(status: 0) }
            let script = args.last ?? ""
            if script.contains("GATEWAY") { return ProcessResult(status: 0, stdout: checkOutput(script)) }
            if script.contains("V6PROBE") {
                let n = script.components(separatedBy: "echo \"V6PROBE ").count - 1
                var out = "HAS6 2\n"
                for i in 0..<n { out += "V6PROBE \(i) " + (_v6Leak && i == 0 ? "RC=0 succeeded!" : "RC=1 nc: connectx failed: Operation timed out") + "\n" }
                return ProcessResult(status: 0, stdout: out)
            }
            if script.contains("route -n get default | awk") { return ProcessResult(status: 0, stdout: "192.168.64.1\n") }
            if script.contains("IFS= read -r line") {
                _stdinSeen.append(stdin ?? "")
                if let f = stubFail { return f }
                if let g = guestReply { return ProcessResult(status: 0, stdout: g, truncated: guestTruncated) }
                return ProcessResult(status: 0, stdout: "{\"v\":1,\"id\":\"\(requestID(stdin))\",\"ok\":true,\"data\":{\"daemon\":\"stub\",\"macos\":\"26.6\"}}\n")
            }
            if script.contains("ls /tmp/bsx-dirty-* ") { return ProcessResult(status: 0, stdout: "0\n") }
            return ProcessResult(status: 0)
        default: return ProcessResult(status: 2)
        }
    }

    /// What the guest's check script would print: everything blocked unless `leaks` says otherwise.
    func checkOutput(_ script: String) -> String {
        var out = "GATEWAY 192.168.64.1\nV6 \(v6Addresses)\nWEB \(noInternet ? 7 : 0)\nCONTROL RC=0 Connection to 1.1.1.1 port 443 [tcp/https] succeeded!\n"
        out += "GWPROBE RC=1 nc: connectx to 192.168.64.1 port 5 (tcp) failed: Operation timed out\n"
        var i = 0
        for line in script.split(separator: "\n") where line.hasPrefix("probe p") {
            let ip = line.split(separator: "'").dropFirst().first.map(String.init) ?? ""
            let hit = leaks.contains(ip)
            out += "PROBE \(i) " + (hit ? "RC=0 succeeded!" : "RC=1 nc: connectx to \(ip) port 1 (tcp) failed: Operation timed out") + "\n"
            i += 1
        }
        return out
    }

    func spawn(_ exe: String, _ args: [String], env: [String: String], logPath: String?, hold: Bool) throws -> RunningProcess {
        let p = try record(args, hold: hold)
        onSpawn?(args, p)   // a copy taken under the lock, called after it, so a hook can read what the fake recorded
        return p
    }

    private func record(_ args: [String], hold: Bool) throws -> FakeProc {
        lock.lock(); defer { lock.unlock() }
        _calls.append(args)
        let vm = args.last ?? ""
        guard _vms[vm] != nil else { throw SandboxError("run_failed", "no such VM \(vm)") }
        if _vms[vm]?.suspended == true && failResume { throw SandboxError("run_failed", "cannot restore state") }
        let p = FakeProc()
        p.immortal = spawnImmortal
        p.onRelease = { [unowned self] in self.note("release") }
        _vms[vm]?.proc = p
        _vms[vm]?.suspended = false
        _spawned.append((args, p))
        _order.append("spawn " + (args.contains("--no-graphics") ? "headless" : "graphics") + (hold ? " held" : ""))
        return p
    }
}

final class FakeHostFacts: HostFactsReading {
    // Read by the warm build's self-check on its own thread while a test changes them, so both sides take the lock
    // (TSan, 11-12: buildWarm at SandboxManager.swift:680 against testTheMacsAddressesChangingStopsTheGuest).
    private let lock = NSLock()
    var facts: HostFacts {
        get { lock.lock(); defer { lock.unlock() }; return _facts }
        set { lock.lock(); _facts = newValue; lock.unlock() }
    }
    var listenerHits: Int {
        get { lock.lock(); defer { lock.unlock() }; return _listenerHits }
        set { lock.lock(); _listenerHits = newValue; lock.unlock() }
    }
    private var _listenerHits = 0
    private var _facts = HostFacts(addresses: [.init("this Mac's address on en0", "192.168.1.20", iface: "en0"), .init("this Mac's tailnet address", "100.101.102.103", iface: "utun4")],
                          router: "192.168.1.1", tailscaleInstalled: true,
                          bridge6: [.init("this Mac's IPv6 address on bridge100", "fe80::5c9b:a6ff:fe68:4164", iface: "bridge100"),
                                    .init("this Mac's IPv6 address on bridge100", "fdc5:5ced:8bd3:9a9f:1447:5955:8b2d:5e2d", iface: "bridge100")])
    final class L: ProbeListener { var port: UInt16 = 51000; var hits = 0; func accepted() -> Int { hits }; func close() {} }
    func read() -> HostFacts { facts }
    func currentAddresses() -> [String] { facts.ipv4 }
    func listener6() -> ProbeListener? { let l = L(); l.hits = listenerHits; return l }
    func listener() -> ProbeListener? { let l = L(); l.hits = listenerHits; return l }
}

final class FakeWindowHost: SandboxWindowHost {
    var workspace: Int? = 9
    var current = 1
    var log: [String] = []
    var shown: [SandboxWindows.Window] = []
    var moves: [(UInt32, Int)] = []
    var onClaim: (() -> Void)?
    func agentWorkspace() -> Int? { workspace }
    var claimResult = true
    func claim(pid: Int32, workspace: Int) -> Bool { log.append("claim \(pid)->\(workspace)"); onClaim?(); return claimResult }
    var windowsDelay: TimeInterval = 0
    func windows(of pid: Int32) -> [SandboxWindows.Window] { if windowsDelay > 0 { Thread.sleep(forTimeInterval: windowsDelay) }; return shown.filter { $0.pid == pid } }
    func move(window: UInt32, to workspace: Int) { moves.append((window, workspace)); for i in shown.indices where shown[i].id == window { shown[i].workspace = workspace }; log.append("move \(window)->\(workspace)") }
}

final class FakeMemory: MemoryReading {
    var bytes: UInt64
    init(gb: UInt64) { bytes = gb << 30 }
    func availableBytes() -> UInt64 { bytes }
}

struct Rig {
    let tart: FakeTart, clock: FakeClock, facts: FakeHostFacts, manager: SandboxManager, st: SandboxTart, dir: URL, memory: FakeMemory
    /// `availableGB` is the free memory the fake Mac reports: 0 keeps the warm clone on disk (most tests),
    /// plenty lets it stay in memory.
    static func make(enabled: Bool = true, availableGB: UInt64 = 0, hostMemoryGB: Int = 32) -> Rig {
        let memory = FakeMemory(gb: availableGB)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bsx-test-\(UUID().uuidString)")
        let ft = FakeTart(), clock = FakeClock(), facts = FakeHostFacts()
        let st = SandboxTart(tart: "/fake/tart", softnetDir: "/fake/softnet", runner: ft, clock: clock)
        let counter = Counter()
        let m = SandboxManager(tart: st, facts: facts, clock: clock, paths: SandboxPaths(root: dir),
                               settings: { SandboxSettings(enabled: enabled) }, makeID: { counter.next() }, memory: memory, hostMemoryGB: hostMemoryGB)
        return Rig(tart: ft, clock: clock, facts: facts, manager: m, st: st, dir: dir, memory: memory)
    }
}

final class Counter {
    private let lock = NSLock()
    private var n = 0
    func next() -> String { lock.lock(); defer { lock.unlock() }; n += 1; return "id\(n)" }
}

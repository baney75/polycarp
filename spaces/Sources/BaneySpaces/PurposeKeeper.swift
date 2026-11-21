import AppKit
import BaneySpacesCore
import IOKit

/// The purpose layer's place in the app: one `PurposeStore` and one `DayLedgerStore` for every surface to read, fed from
/// workspace switches, input, sleep and the lock. It draws nothing; the views read `purposes`, `ledger` and `due` and
/// listen for `PurposeStore.didChange`, `DayLedgerStore.didChange` and `PurposeKeeper.promptDue`. Main thread only.
final class PurposeKeeper {
    static let shared = PurposeKeeper()

    /// Posted on the main thread when the morning question or the evening examen becomes due (`due` says which), and
    /// when it stops being due. Once per prompt per day: a view that shows it calls `given(_:)`.
    static let promptDue = Notification.Name("PolycarpPromptDue")

    /// The ledger counts every minute; it also decides how soon a return to the Mac is seen.
    static let tickInterval: TimeInterval = 60
    private static let rhythmKey = "rhythmState"

    let purposes: PurposeStore
    let ledger: DayLedgerStore
    /// The prompt due now, if any.
    private(set) var due: Rhythm.Prompt?
    private var workspace: Int?
    /// When you came to the workspace you are on: the menu's "since 8:40".
    private(set) var arrived: Date?
    private var timer: Timer?
    private var rollover: Timer?
    private var started = false
    private var gate = PresenceGate()

    private init() {
        UserDefaults.standard.register(defaults: RhythmSettings.registered)
        let log: (String) -> Void = { line in DispatchQueue.main.async { Trace.log(line) } }
        purposes = PurposeStore(folder: Wire.supportDir, log: log)
        ledger = DayLedgerStore(folder: Wire.supportDir, log: log)
    }

    var settings: RhythmSettings { RhythmSettings(defaults: .standard) }

    /// Whether today is the Lord's Day and the surfaces rest (`restOnSunday`).
    var rests: Bool { Rhythm.rests(now: Date(), settings: settings, clock: ledger.dayClock) }

    var rhythm: RhythmState {
        get {
            guard let d = UserDefaults.standard.data(forKey: Self.rhythmKey) else { return RhythmState() }
            return (try? JSONDecoder().decode(RhythmState.self, from: d)) ?? RhythmState()
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.rhythmKey) }
    }

    func start() {
        guard !started else { return }
        started = true
        Self.isRunning = true
        timer = Timer.scheduledTimer(withTimeInterval: Self.tickInterval, repeats: true) { [weak self] _ in self?.tick() }
        timer?.tolerance = 5
        let ws = NSWorkspace.shared.notificationCenter
        let workspaceEvents: [(Notification.Name, PresenceGate.Event)] = [
            (NSWorkspace.screensDidSleepNotification, .wentAway), (NSWorkspace.willSleepNotification, .wentAway),
            (NSWorkspace.sessionDidResignActiveNotification, .wentAway), (NSWorkspace.screensDidWakeNotification, .woke),
            (NSWorkspace.didWakeNotification, .woke), (NSWorkspace.sessionDidBecomeActiveNotification, .sessionActive),
        ]
        for (name, event) in workspaceEvents {
            ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.presence(event) }
        }
        // The lock screen and the screen saver say so only through the distributed center.
        let distEvents: [(String, PresenceGate.Event)] = [
            ("com.apple.screenIsLocked", .locked), ("com.apple.screensaver.didstart", .wentAway),
            ("com.apple.screenIsUnlocked", .unlocked), ("com.apple.screensaver.didstop", .woke),
        ]
        for (name, event) in distEvents {
            DistributedNotificationCenter.default().addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
                self?.presence(event)
            }
        }
        NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            ledger.setClock(DayClock())
            purposes.setClock(DayClock())
            scheduleRollover()
        }
        purposes.rollover()
        scheduleRollover()
        tick()
    }

    /// The workspace you are on, from every model change. Only a real change reaches the ledger.
    func noteWorkspace(_ n: Int) {
        guard n != workspace else { return }
        workspace = n
        arrived = Date()
        ledger.switched(to: n)
    }

    /// A view showed `prompt`: it isn't due again today.
    func given(_ prompt: Rhythm.Prompt) {
        rhythm = Rhythm.given(prompt, now: Date(), state: rhythm, clock: ledger.dayClock)
        checkDue(idle: Self.idleSeconds())
    }

    /// Keeps tonight's examen in the journal, off the main thread, and counts the examen as given. `done` gets the file,
    /// or nil when it couldn't be written, on the main thread.
    func keepExamen(_ answers: [Journal.Answer], done: ((URL?) -> Void)? = nil) {
        let now = Date()
        let clock = ledger.dayClock
        let day = clock.day(of: now)
        let p = purposes.snapshot
        let seconds = ledger.seconds(on: day)
        given(.eveningExamen)
        DispatchQueue.global(qos: .utility).async {
            let url = try? Journal.save(day: day, answers: answers, oneThing: p.oneThing?.text, seconds: seconds,
                                        purposes: p.all, clock: clock, support: Wire.supportDir)
            DispatchQueue.main.async {
                Trace.log(url == nil ? "purpose: examen for \(day) could not be written" : "purpose: examen for \(day) kept in Journal")
                done?(url)
            }
        }
    }

    /// `polycarp-spaces purpose|one|day`.
    func answer(_ r: Wire.Request, current: Int) -> Wire.Reply {
        let ask = PurposeAPI.ask(text: r.text, args: r.args ?? [])
        let reply = PurposeAPI.answer(ask, purposes: purposes, ledger: ledger, current: current)
        // The trace says what changed and who asked, never the words: they are the user's own.
        let what: String? = switch ask {
        case .set(let n, _): "workspace \(n) purpose set"
        case .clear(let n): "workspace \(n) purpose cleared"
        case .one: "one thing set"
        case .clearOne: "one thing cleared"
        default: nil
        }
        if let what, reply.ok { Trace.log("purpose: \(what) by \(r.caller ?? "cli")") }
        return reply
    }

    /// Waits for queued writes, at quit. A launch that never started the layer (`--render`, the checks) has none, and
    /// doesn't create the stores just to flush them.
    static func flushIfStarted() {
        guard isRunning else { return }
        shared.purposes.flush()
        shared.ledger.flush()
    }
    private static var isRunning = false

    private func tick() {
        let idle = Self.idleSeconds()
        ledger.tick(idle: idle)
        // Input since the last tick counts as being at the Mac.
        if idle < Self.tickInterval { checkDue(idle: idle) }
    }

    /// Sleep, the lock and the screen saver. The ledger starts again only when the person is back (`PresenceGate`): the
    /// screen waking under the lock screen is not that.
    private func presence(_ event: PresenceGate.Event) {
        switch event {
        case .locked, .wentAway: ledger.wentAway(idle: Self.idleSeconds())
        case .unlocked, .woke, .sessionActive: break
        }
        if gate.back(after: event) { ledger.cameBack() }
        if event != .locked, event != .wentAway {
            purposes.rollover()
            scheduleRollover()
        }
    }

    /// With `idle` seconds since the last input: a prompt comes due only with someone at the Mac (`Rhythm.recentInput`).
    private func checkDue(idle: TimeInterval) {
        let now = Rhythm.due(now: Date(), idle: idle, state: rhythm, settings: settings, clock: ledger.dayClock)
        guard now != due else { return }
        due = now
        NotificationCenter.default.post(name: Self.promptDue, object: self)
    }

    /// The one thing clears at the day's start even with nobody at the Mac, so the surfaces never show yesterday's.
    private func scheduleRollover() {
        rollover?.invalidate()
        let at = purposes.nextRollover
        let t = Timer(fire: at.addingTimeInterval(1), interval: 0, repeats: false) { [weak self] _ in
            guard let self else { return }
            purposes.rollover()
            // At 4 am nobody is usually there: this clears last night's prompt, and the morning waits for input.
            checkDue(idle: Self.idleSeconds())
            scheduleRollover()
        }
        t.tolerance = 30
        RunLoop.main.add(t, forMode: .common)
        rollover = t
    }

    /// Seconds since the last keyboard, mouse or trackpad input: IOHIDSystem's HIDIdleTime, the same value
    /// `ioreg -c IOHIDSystem` prints. 0 when it can't be read, so a failed read never drops time.
    static func idleSeconds() -> TimeInterval {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        guard service != 0 else { return 0 }
        defer { IOObjectRelease(service) }
        guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? NSNumber else { return 0 }
        return value.doubleValue / 1_000_000_000
    }
}

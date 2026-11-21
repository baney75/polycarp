import AppKit
import BaneySpacesCore
import IOKit
import UserNotifications

/// The purpose layer's place in the app: one `PurposeStore` and one `DayLedgerStore` for every surface to read, fed from
/// workspace switches, input, sleep and the lock. It draws nothing; the views read `purposes`, `ledger` and `due` and
/// listen for `PurposeStore.didChange`, `DayLedgerStore.didChange` and `PurposeKeeper.promptDue`. It also keeps the
/// one-thing timer (`timer`), saved in the app's defaults so a relaunch keeps it; `OneThingTimerStore.didChange` says
/// when it starts, stops or ends. Main thread only.
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
    /// The one-thing timer's store: `polycarp-spaces timer`, the menu and the bar all go through it.
    let timers = OneThingTimerStore()
    /// The one-thing timer, running or not yet ended; nil when none was started.
    var timer: OneThingTimer? { timers.timer }
    /// Fires when the running timer comes to its end.
    private var timerEnd: Timer?
    /// The prompt due now, if any.
    private(set) var due: Rhythm.Prompt?
    private var workspace: Int?
    /// When you came to the workspace you are on, or came back to the Mac: the menu's "since 8:40".
    private(set) var arrived: Date?
    private var ticker: Timer?
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
        ticker = Timer.scheduledTimer(withTimeInterval: Self.tickInterval, repeats: true) { [weak self] _ in self?.tick() }
        ticker?.tolerance = 5
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
        NotificationCenter.default.addObserver(forName: OneThingTimerStore.didChange, object: timers, queue: nil) { [weak self] _ in
            self?.scheduleTimerEnd()
        }
        // A timer that ran out while Polycarp wasn't running ends now, quietly (`timerEnded`).
        scheduleTimerEnd()
        tick()
    }

    /// Starts the one-thing timer for `minutes` (`alarm.timerMinutes` when nil), with today's one thing, if any.
    func startTimer(minutes: Int? = nil, by who: String) {
        let m = minutes ?? SurfacesStore.shared.current.alarm.timerMinutes
        do {
            try timers.start(minutes: m, oneThing: purposes.oneThing?.text)
            Trace.log("timer: started, \(m) min, by \(who)")
        } catch {
            Trace.log("timer: not started by \(who): \(error)")
        }
    }

    /// Stops the running timer before its end.
    func stopTimer(by who: String) {
        if timers.stop() != nil { Trace.log("timer: stopped by \(who)") }
    }

    /// Sets a run loop timer for the running one-thing timer's end, or ends it now when it is already done.
    private func scheduleTimerEnd() {
        timerEnd?.invalidate()
        timerEnd = nil
        guard let t = timers.timer else { return }
        if t.done(now: Date()) { return timerEnded() }
        let fire = Timer(fire: t.endsAt, interval: 0, repeats: false) { [weak self] _ in self?.timerEnded() }
        fire.tolerance = 0.5
        RunLoop.main.add(fire, forMode: .common)
        timerEnd = fire
    }

    /// The one-thing timer came to its end: Glass once and a notification, unless it ended long ago (the Mac slept
    /// through it, or Polycarp wasn't running), when it only clears.
    private func timerEnded() {
        let now = Date()
        guard let t = timers.end(now: now) else { return scheduleTimerEnd() }
        let onTime = Alarm.ringsNow(scheduled: t.endsAt, now: now)
        Trace.log("timer: ended, \(t.minutes) min\(onTime ? "" : ", late, quietly")")
        guard onTime else { return }
        NSSound(named: "Glass")?.play()
        Self.announceEnd(t)
    }

    /// A notification that the time is up, only where Polycarp may already post them (`LegacyWatcher` asks for that).
    /// It never asks for the permission itself.
    private static func announceEnd(_ t: OneThingTimer) {
        // UNUserNotificationCenter stops the process when there's no app bundle.
        guard PermissionsModel.isAppBundle else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = "Time is up"
            content.body = t.oneThing.map { "\(t.minutes) min on: \($0)" } ?? "\(t.minutes) min"
            center.add(UNNotificationRequest(identifier: "one-thing-timer", content: content, trigger: nil))
        }
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

    /// `polycarp-spaces purpose|one|day|timer`.
    func answer(_ r: Wire.Request, current: Int) -> Wire.Reply {
        let ask = PurposeAPI.ask(text: r.text, args: r.args ?? [])
        let wasRunning = timers.timer != nil
        let reply = PurposeAPI.answer(ask, purposes: purposes, ledger: ledger, current: current, timer: timers,
                                      timerMinutes: SurfacesStore.shared.current.alarm.timerMinutes)
        // The trace says what changed and who asked, never the words: they are the user's own.
        let what: String? = switch ask {
        case .set(let n, _): "workspace \(n) purpose set"
        case .clear(let n): "workspace \(n) purpose cleared"
        case .one: "one thing set"
        case .clearOne: "one thing cleared"
        default: nil
        }
        if let what, reply.ok { Trace.log("purpose: \(what) by \(r.caller ?? "cli")") }
        switch ask {
        case .startTimer where reply.ok: Trace.log("timer: started, \(timers.timer?.minutes ?? 0) min, by \(r.caller ?? "cli")")
        case .stopTimer where reply.ok && wasRunning: Trace.log("timer: stopped by \(r.caller ?? "cli")")
        default: break
        }
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
        if gate.back(after: event) { ledger.cameBack(); arrived = Date() }
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

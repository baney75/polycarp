import Foundation

/// The second half of a workspace switch, once this workspace's windows are back and the other apps are hidden: the
/// Accessibility raise of the window that takes focus, the wait until focus has moved (`done` in timing.log), parking
/// the other workspaces' windows (`parked`), and the hides that must wait for focus.
///
/// Donovan's timing.log (83 switches, 11-16 to 11-17) put the tail here. The raise (`shown`) took p90 197 ms and max
/// 380, in steps of the 100 ms Accessibility timeout, because the app being raised was busy and answered late; the
/// main thread waited on each call. The wait for focus (`focused`, p90 53, max 310) read the front app from
/// LaunchServices, whose daemon runs in the background band when nothing boosts it, the band buildgate puts builds
/// in. Parking started only after both, so `parked` reached p90 425 and p99 953 in busy hours.
///
/// `together` (the app's order): the raise runs on `raiser`, a user-interactive queue, so a busy app holds no one
/// but itself; focus counts as moved as soon as `landed` says so (the app reads the window server, `FrontProcess`),
/// without waiting for the raise to return; parking starts right after, not behind them. A hide that would hand focus
/// elsewhere waits for focus to move (`afterFocus`). `raiseThenPark` is 5ccaa277's order, kept so `SwitchStepsTests`
/// can measure the two side by side.
public final class SwitchSteps {
    public enum Order { case raiseThenPark, together }

    public static let raiser = DispatchQueue(label: "com.baney.polycarp.switch-raise", qos: .userInteractive)

    public let order: Order
    private let queue: DispatchQueue
    private let raiseQueue: DispatchQueue
    private let waitForFocus: Bool
    private let limit: TimeInterval
    private let landed: () -> Bool
    private var raiseBack = false
    private var focusMoved = false
    private var parkDone = false
    private var held: [() -> Void] = []
    private var focused: () -> Void = {}
    private var finished: () -> Void = {}
    private var poll: DispatchSourceTimer?
    private var start = DispatchTime.now()

    /// Everything but the raise runs on `queue` (the main queue in the app) and must be called there.
    /// `waitForFocus`: something after it depends on focus having moved (a hide of the app in front, an empty
    /// workspace's fallback). Without it, focus counts as moved once the raise returns. `limit` caps the wait.
    public init(order: Order = .together, queue: DispatchQueue = .main, raiseQueue: DispatchQueue = SwitchSteps.raiser,
                waitForFocus: Bool, limit: TimeInterval = 0.5, landed: @escaping () -> Bool) {
        self.order = order
        self.queue = queue
        self.raiseQueue = raiseQueue
        self.waitForFocus = waitForFocus
        self.limit = limit
        self.landed = landed
    }

    /// - raise: the Accessibility raise, nil when there is none; whether it took goes to `raised`, on `queue`.
    /// - focused: once focus moved, or `limit` passed (`done`).
    /// - park: parks, then calls back (`parked`).
    /// - finished: once focus moved and parking is done.
    public func run(raise: (() -> Bool)?, raised: @escaping (Bool) -> Void, focused: @escaping () -> Void,
                    park: @escaping (@escaping () -> Void) -> Void, finished: @escaping () -> Void) {
        self.focused = focused
        self.finished = finished
        start = .now()
        let parked = { [self] in
            parkDone = true
            finishIfDone()
        }
        switch order {
        case .raiseThenPark:
            if let raise { raised(raise()) }
            raiseBack = true
            held.append { park(parked) }
            check()
        case .together:
            if let raise {
                raiseQueue.async { [self] in
                    let took = raise()
                    queue.async { [self] in
                        raiseBack = true
                        raised(took)
                        check()
                    }
                }
            } else {
                raiseBack = true
            }
            check()
            park(parked)
        }
        if !focusMoved { watch() }
    }

    /// Runs `work` once focus has moved: at once if it has.
    public func afterFocus(_ work: @escaping () -> Void) {
        if focusMoved { work() } else { held.append(work) }
    }

    /// Whether focus has moved by now. Moved means `landed`, or with nothing waiting on it, the raise returned.
    private func check() {
        guard !focusMoved else { return }
        let late = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds >= UInt64(limit * 1e9)
        let ready: Bool
        switch order {
        case .raiseThenPark: ready = raiseBack && (!waitForFocus || landed())
        case .together: ready = landed() || (raiseBack && !waitForFocus)
        }
        guard ready || late else { return }
        focusMoved = true
        poll?.cancel()
        poll = nil
        focused()
        let work = held
        held = []
        work.forEach { $0() }
        finishIfDone()
    }

    /// Looks again every 10 ms on `queue` (5ccaa277's interval) until focus moved or `limit` passed.
    private func watch() {
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        timer.schedule(deadline: .now() + 0.01, repeating: 0.01, leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in self?.check() }
        poll = timer
        timer.resume()
    }

    private func finishIfDone() {
        guard focusMoved, parkDone else { return }
        let done = finished
        finished = {}
        done()
    }
}

import Foundation

/// BaneySpaces and Polycarp can't run together, and BaneySpaces has no one-copy guard of its own. So Polycarp
/// deals with it from its side, in the open: one alert at launch, before anything is touched, and a watch
/// afterward for BaneySpaces being started again. Silent handover is for a second Polycarp only.
/// The decisions are here, in plain functions; the alert and the quitting are the app's.
public enum LegacyHandover {
    public static let alertTitle = "\(Product.Legacy.name) is running. \(Product.name) replaces it."
    public static let alertDetail = "Both can't run at once. \(Product.name) copies your settings and leaves \(Product.Legacy.name) installed."
    public static let continueButton = "Quit \(Product.Legacy.name) and Continue"
    public static let notNowButton = "Not Now"
    public static let didNotQuit = "\(Product.Legacy.name) didn't quit. Quit it from its menu, then open \(Product.name) again."
    public static let notificationTitle = "\(Product.Legacy.name) was closed"
    public static let notificationBody = "\(Product.name) replaces it, and the two can't run together."
    public static let quitTimeout: TimeInterval = 10

    public enum Choice { case quitAndContinue, notNow }
    public enum Outcome: Equatable {
        case carryOn
        /// The person said Not Now (or the old app never quit): exit without touching anything.
        case exit(message: String?)
    }

    /// One-shots (restoring the Dock, say) don't ask: they must work with either app running.
    public static func applies(oneShot: Bool, legacyPids: [Int32]) -> Bool { !oneShot && !legacyPids.isEmpty }

    /// Asks once, then (if allowed) quits the old app and waits up to `timeout` for it to go.
    public static func run(ask: () -> Choice,
                           quit: () -> Void,
                           isRunning: () -> Bool,
                           now: () -> Date = Date.init,
                           sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
                           timeout: TimeInterval = quitTimeout) -> Outcome {
        guard ask() == .quitAndContinue else { return .exit(message: nil) }
        quit()
        let deadline = now().addingTimeInterval(timeout)
        while isRunning() {
            if now() >= deadline { return .exit(message: didNotQuit) }
            sleep(0.25)
        }
        return .carryOn
    }

    /// While Polycarp runs: what to do when an app launches.
    public struct Watch: Equatable {
        public var quit: Bool
        public var notify: Bool
    }

    /// BaneySpaces starting is asked to quit every time; the person is told once, so a repeat doesn't nag.
    public static func onLaunch(bundleID: String?, alreadyNotified: Bool) -> Watch {
        guard bundleID == Product.Legacy.bundleID else { return Watch(quit: false, notify: false) }
        return Watch(quit: true, notify: !alreadyNotified)
    }
}

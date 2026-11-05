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

    /// Every app Polycarp replaces, by the name the alert uses. BaneySpaces first; Silas is the dictation app whose
    /// voice moved into Polycarp. Both want the same keys or the same files, so neither runs beside Polycarp.
    public static let replaced: [(name: String, bundleID: String)] = [
        (Product.Legacy.name, Product.Legacy.bundleID),
        (Product.Silas.name, Product.Silas.bundleID),
    ]
    public static var replacedBundleIDs: [String] { replaced.map(\.bundleID) }

    /// The one alert, for whichever of the old apps are running: "Silas is running. Polycarp replaces it."
    public static func alertTitle(running names: [String]) -> String {
        switch names.count {
        case 0, 1: "\(names.first ?? Product.Legacy.name) is running. \(Product.name) replaces it."
        default: "\(names.joined(separator: " and ")) are running. \(Product.name) replaces them."
        }
    }
    public static func alertDetail(running names: [String]) -> String {
        let both = names.count > 1 ? "None of them can run beside \(Product.name)." : "Both can't run at once."
        let silas = names.contains(Product.Silas.name) ? " Your dictionary, history and speech models are copied, never moved." : ""
        return "\(both) \(Product.name) copies your settings and leaves \(names.joined(separator: " and ")) installed.\(silas)"
    }
    public static func continueButton(running names: [String]) -> String { "Quit \(names.joined(separator: " and ")) and Continue" }
    public static func didNotQuit(_ names: [String]) -> String {
        "\(names.joined(separator: " and ")) didn't quit. Quit \(names.count > 1 ? "them" : "it") from the menu bar, then open \(Product.name) again."
    }

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
                           timeout: TimeInterval = quitTimeout,
                           names: [String]? = nil) -> Outcome {
        guard ask() == .quitAndContinue else { return .exit(message: nil) }
        quit()
        let deadline = now().addingTimeInterval(timeout)
        while isRunning() {
            if now() >= deadline { return .exit(message: names.map(didNotQuit) ?? didNotQuit) }
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
        guard let bundleID, replacedBundleIDs.contains(bundleID) else { return Watch(quit: false, notify: false) }
        return Watch(quit: true, notify: !alreadyNotified)
    }

    /// Whether Polycarp may take the dictation hotkey. Two apps reading the same key fight over it, and Silas keeps
    /// its own copy of the model loaded, so while Silas runs Polycarp's voice stays off and says why.
    public enum VoiceStart: Equatable {
        case start
        case refuse(reason: String)
    }
    public static let silasRunningReason = "\(Product.Silas.name) is running and has the dictation key. Quit it and \(Product.name) takes over."
    public static func voiceStart(silasPids: [Int32]) -> VoiceStart {
        silasPids.isEmpty ? .start : .refuse(reason: silasRunningReason)
    }
}

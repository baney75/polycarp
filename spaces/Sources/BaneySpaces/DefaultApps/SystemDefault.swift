import AppKit
import BaneySpacesCore

/// Makes an app the whole Mac's browser or mail app. Only Settings calls it, from a person's click, and macOS asks them
/// again: no timer, update, agent, command or socket has a way here (R-D8, `DefaultAppsPaneTests`).
enum SystemDefault {
    /// `done` gets nil when macOS uses the app now, else a line that says what it kept. Main thread.
    static func set(_ role: AppRole, to bundle: String, done: @escaping (String?) -> Void) {
        guard role.canSetEverywhere, let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else {
            return done("It isn't installed.")
        }
        next(role == .browser ? ["http", "https"] : ["mailto"], app, role, done)
    }

    private static func next(_ schemes: [String], _ app: URL, _ role: AppRole, _ done: @escaping (String?) -> Void) {
        guard let scheme = schemes.first else { return done(nil) }
        // macOS moves https along with http: asking again for what it has already would put its question up twice.
        if current(scheme) == app.standardizedFileURL { return next(Array(schemes.dropFirst()), app, role, done) }
        NSWorkspace.shared.setDefaultApplication(at: app, toOpenURLsWithScheme: scheme) { _ in
            DispatchQueue.main.async {
                // What macOS says now, not what the call returned: the person may have said no.
                guard current(scheme) == app.standardizedFileURL else {
                    let kept = current(scheme).map { LaunchServicesApps.name($0) } ?? "what it had"
                    return done("macOS kept \(kept).")
                }
                next(Array(schemes.dropFirst()), app, role, done)
            }
        }
    }

    private static func current(_ scheme: String) -> URL? {
        URL(string: scheme + "://example.com").flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0)?.standardizedFileURL }
    }
}

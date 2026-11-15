import AppKit
import BaneySpacesCore
import UserNotifications

/// BaneySpaces and Polycarp can't run together, and BaneySpaces has no guard of its own. At launch Polycarp asks
/// (`LegacyHandover`, from main.swift). While it runs, this watches for BaneySpaces being started again (a login
/// item, a double click), asks it to quit, and tells the person once why. The decisions are `LegacyHandover`'s.
final class LegacyWatcher {
    private var observer: NSObjectProtocol?
    /// One notice for each old app, so Silas's isn't hidden by BaneySpaces's.
    private var notified: Set<String> = []
    /// Whether Polycarp's own dictation is active (`VoiceGate`); Silas is asked to quit only then.
    var takesOver: () -> Bool = { true }
    /// Silas started while Polycarp runs (so the voice must step back), or went away (so it may take over).
    var onSilasStarted: () -> Void = {}
    var onSilasQuit: (Int32) -> Void = { _ in }

    func start() {
        guard observer == nil else { return }
        watchSilasQuit()
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            if app.bundleIdentifier == Product.Silas.bundleID { self.onSilasStarted() }
            self.handle(app, takesOver: self.takesOver())
        }
        // One started after main.swift's check and before the observer above was seen by neither (PR 20 sol-F5). Silas is
        // left to the voice, whose gate isn't wired yet here.
        for app in NSWorkspace.shared.runningApplications where !app.isTerminated { handle(app, takesOver: false) }
    }

    private func handle(_ app: NSRunningApplication, takesOver: Bool) {
        let id = app.bundleIdentifier
        let action = LegacyHandover.onLaunch(bundleID: id, alreadyNotified: id.map { notified.contains($0) } ?? true, takesOver: takesOver)
        if action.quit {
            Trace.log("legacy: \(app.localizedName ?? Product.Legacy.name) started while \(Product.name) runs; asking it to quit")
            app.terminate()
        }
        if action.notify, let id { notified.insert(id); tell(id) }
    }

    /// Polycarp's dictation is taking over (`VoiceEngine.takesOver`) and Silas is running: ask it to quit, tell the person once.
    func askSilasToQuit() {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Product.Silas.bundleID).filter { !$0.isTerminated }
        guard !running.isEmpty else { return }
        Trace.log("legacy: \(Product.Silas.name) is running and \(Product.name)'s dictation takes over; asking it to quit")
        running.forEach { $0.terminate() }
        if notified.insert(Product.Silas.bundleID).inserted { tell(Product.Silas.bundleID) }
    }

    private var quitObserver: NSObjectProtocol?

    /// Silas quitting hands the dictation key to Polycarp.
    func watchSilasQuit() {
        quitObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == Product.Silas.bundleID else { return }
            self?.onSilasQuit(app.processIdentifier)
        }
    }

    private func tell(_ bundleID: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return Trace.log("legacy: notifications are off, so the quit was not announced") }
            let content = UNMutableNotificationContent()
            content.title = LegacyHandover.notificationTitle(forBundleID: bundleID)
            content.body = LegacyHandover.notificationBody(forBundleID: bundleID)
            center.add(UNNotificationRequest(identifier: "legacy-closed", content: content, trigger: nil))
        }
    }
}

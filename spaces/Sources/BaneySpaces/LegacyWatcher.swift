import AppKit
import BaneySpacesCore
import UserNotifications

/// BaneySpaces and Polycarp can't run together, and BaneySpaces has no guard of its own. At launch Polycarp asks
/// (`LegacyHandover`, from main.swift). While it runs, this watches for BaneySpaces being started again (a login
/// item, a double click), asks it to quit, and tells the person once why. The decisions are `LegacyHandover`'s.
final class LegacyWatcher {
    private var observer: NSObjectProtocol?
    private var notified = false
    /// Silas started while Polycarp runs (so the voice must step back), or went away (so it may take over).
    var onSilasStarted: () -> Void = {}
    var onSilasQuit: () -> Void = {}

    func start() {
        guard observer == nil else { return }
        watchSilasQuit()
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let action = LegacyHandover.onLaunch(bundleID: app.bundleIdentifier, alreadyNotified: self.notified)
            if app.bundleIdentifier == Product.Silas.bundleID { self.onSilasStarted() }
            if action.quit {
                Trace.log("legacy: \(app.localizedName ?? Product.Legacy.name) started while \(Product.name) runs; asking it to quit")
                app.terminate()
            }
            if action.notify { self.notified = true; self.tell() }
        }
    }

    private var quitObserver: NSObjectProtocol?

    /// Silas quitting hands the dictation key to Polycarp.
    func watchSilasQuit() {
        quitObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == Product.Silas.bundleID else { return }
            self?.onSilasQuit()
        }
    }

    private func tell() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return Trace.log("legacy: notifications are off, so the quit was not announced") }
            let content = UNMutableNotificationContent()
            content.title = LegacyHandover.notificationTitle
            content.body = LegacyHandover.notificationBody
            center.add(UNNotificationRequest(identifier: "legacy-closed", content: content, trigger: nil))
        }
    }
}

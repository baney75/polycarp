import AppKit
import BaneySpacesCore

/// Keeps Polycarp's icon in the theme's colors (spec/themes.md, "The icons"). The Dock takes it at once. The app's own icon
/// file, which Finder, Spotlight and the launcher show, follows a few seconds after the last change, when this Mac has the
/// key Polycarp is signed with: the bundle is signed again with it (`AppIconSwap`), so its signature and permissions stay.
/// Without the key only the Dock changes, and the file keeps the icon the app came with. Main thread, except the file.
@MainActor
final class AppIconKeeper {
    static let shared = AppIconKeeper()

    private var shown: ThemeIcon.Colors?
    private var pending: DispatchWorkItem?
    private let queue = DispatchQueue(label: "com.baney.polycarp.app-icon", qos: .utility)
    private var observer: NSObjectProtocol?

    /// Draws the icon for the theme in force now and again after every change of theme or Dark Mode.
    func follow() {
        apply()
        observer = NotificationCenter.default.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.apply() }
        }
    }

    private func apply() {
        let colors = ThemeIcon.colors(Appearance.shared.polycarp, systemDark: Appearance.systemDark)
        guard colors != shown else { return }
        shown = colors
        if let image = ThemeIcon.image(colors, pixels: 1024) {
            NSApp.applicationIconImage = NSImage(cgImage: image, size: NSSize(width: 512, height: 512))
        }
        // The Settings picker can pass through several themes in a second; only the last one is written.
        pending?.cancel()
        let app = Bundle.main.bundleURL, tools = Bundle.main.resourceURL?.appendingPathComponent("make-browser")
        let work = DispatchWorkItem { Self.write(colors, into: app, tools: tools) }
        pending = work
        queue.asyncAfter(deadline: .now() + 3, execute: work)
    }

    private nonisolated static func write(_ colors: ThemeIcon.Colors, into app: URL, tools: URL?) {
        guard app.pathExtension == "app", let tools, let icns = ThemeIcon.icns(colors) else { return }
        guard let signer = signer(tools.appendingPathComponent("signing-identity.sh")) else { return }
        switch AppIconSwap.replace(app: app, icns: icns, signer: signer) {
        case .changed: Trace.log("app icon: now \(colors.background.hex) and \(colors.mark.hex)")
        case .unchanged: break
        case .refused(let why): Trace.log("app icon: the Dock's only, \(why)")
        }
    }

    /// The key Polycarp is signed with, from the script `polycarp browser` signs with. `--keep` never makes, restores or
    /// replaces a key: no key (exit 3) leaves the file as it is.
    private nonisolated static func signer(_ script: URL) -> AppIconSwap.Signer? {
        guard FileManager.default.fileExists(atPath: script.path) else { return nil }
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path, "--keep"]
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            if p.terminationStatus != 3 { Trace.log("app icon: the Dock's only, the signing key can't be used now") }
            return nil
        }
        let parts = text.trimmingCharacters(in: .newlines).split(separator: "\t", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty else { return nil }
        return AppIconSwap.Signer(identity: parts[0], keychain: parts[1])
    }
}

// A plain app with ordinary windows, for scripts/focus-probe.swift. The probe compiles it with swiftc into a
// throwaway .app bundle in its own temp folder (ProbeA.app, ProbeB.app...), never installs it, and removes it after.
// It reads no files and writes one: <bundle folder>/<name>.json, its pid and window numbers after each change.
//   On launch it opens one window. Opened again (`open -a`, a Dock click) it opens another 60 ms later, the way Ghostty
//   comes forward 54 ms before its new window exists (measured 10-13). A distributed notification named
//   com.baney.probe-window-app with the app's name as its object and {"do": "open" | "close" | "quit"} does that.
import AppKit

let name = ProcessInfo.processInfo.processName
let report = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("\(name).json")

final class Delegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []

    func applicationDidFinishLaunching(_ note: Notification) {
        open()
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.baney.probe-window-app"),
                                                            object: name, queue: .main) { [weak self] note in
            switch note.userInfo?["do"] as? String {
            case "open": self?.open()
            case "close": self?.close()
            case "quit": NSApp.terminate(nil)
            default: break
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { self.open() }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func open() {
        let n = windows.count
        let w = NSWindow(contentRect: NSRect(x: 180 + 40 * n, y: 180 + 30 * n, width: 420, height: 260),
                         styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.title = "\(name) \(n + 1)"
        w.isReleasedWhenClosed = false
        w.makeKeyAndOrderFront(nil)
        windows.append(w)
        write()
    }

    func close() {
        windows.popLast()?.close()
        write()
    }

    func write() {
        let body: [String: Any] = ["pid": Int(getpid()), "windows": windows.map(\.windowNumber)]
        if let data = try? JSONSerialization.data(withJSONObject: body) { try? data.write(to: report, options: .atomic) }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

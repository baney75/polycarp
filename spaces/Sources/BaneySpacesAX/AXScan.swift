import ApplicationServices
import BaneySpacesCore
import Foundation

// Private but stable since macOS 10.x: the WindowServer number behind an Accessibility window (see `Windows.swift`).
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

/// One app's answer to a scan: its window list and, for each listed element, the window number, subrole and modal flag.
/// Reading it moves and changes nothing, so `scan-bench` can run it against the apps on Donovan's Mac at any time.
public struct AXAppRead {
    public struct Element {
        public let element: AXUIElement
        /// The window server's number; nil when it couldn't be read.
        public let id: WindowID?
        /// nil when the read failed (or the number did, which skips it).
        public let subrole: String?
        public let modal: Bool?
    }

    public let pid: Int32
    /// The AXWindows read's error. `.success` with `answered` false is an answer of the wrong kind.
    public let error: AXError
    /// The app gave its window list.
    public let answered: Bool
    public let elements: [Element]
    /// A subrole or modal read on one of its elements timed out: the app went busy partway.
    public let elementTimedOut: Bool
    /// Seconds the whole read took, on whatever thread ran it.
    public let seconds: Double

    /// A timeout, of the list or of an element read.
    public var timedOut: Bool { error == .cannotComplete || elementTimedOut }
}

public enum AXScan {
    /// Each app's deadline for its window list, set with `AXUIElementSetMessagingTimeout` on its app element.
    public static let appTimeout: Float = 0.25

    /// Reads one app. Blocks the calling thread for up to the app's deadline.
    public static func read(_ pid: Int32, timeout: Float = appTimeout) -> AXAppRead {
        let start = ProcessInfo.processInfo.systemUptime
        let ax = AXUIElementCreateApplication(pid)
        // A hung app must not hang every workspace switch.
        AXUIElementSetMessagingTimeout(ax, timeout)
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &raw)
        let listed = error == .success ? raw as? [AXUIElement] : nil
        var elements: [AXAppRead.Element] = []
        var elementTimedOut = false
        for el in listed ?? [] {
            var n: CGWindowID = 0
            let id: WindowID? = _AXUIElementGetWindow(el, &n) == .success && n != 0 ? n : nil
            var subrole: String?, modal: Bool?
            if id != nil {
                var s: CFTypeRef?
                let e = AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &s)
                if e == .success { subrole = s as? String } else if e == .cannotComplete { elementTimedOut = true }
                if subrole != nil {
                    var m: CFTypeRef?
                    let e = AXUIElementCopyAttributeValue(el, kAXModalAttribute as CFString, &m)
                    if e == .success { modal = (m as? NSNumber)?.boolValue } else if e == .cannotComplete { elementTimedOut = true }
                }
            }
            elements.append(.init(element: el, id: id, subrole: subrole, modal: modal))
        }
        return AXAppRead(pid: pid, error: error, answered: listed != nil, elements: elements,
                         elementTimedOut: elementTimedOut, seconds: ProcessInfo.processInfo.systemUptime - start)
    }

    /// Every app at once, returning when the slowest has answered or run out its deadline. The calling thread waits for
    /// all of them: on the main thread one slow app holds the main thread for its whole deadline.
    public static func all(_ pids: [Int32], timeout: Float = appTimeout) -> [AXAppRead] {
        var reads = [AXAppRead?](repeating: nil, count: pids.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: pids.count) { i in
            let r = read(pids[i], timeout: timeout)
            lock.lock(); reads[i] = r; lock.unlock()
        }
        return reads.compactMap { $0 }
    }
}

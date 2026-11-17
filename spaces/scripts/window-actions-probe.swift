#!/usr/bin/env swift
// Window actions, live (K2, W1): `swift scripts/window-actions-probe.swift`.
//
// Opens one throwaway window of its own, runs window actions on it by URL (`polycarp://window/left-half?window=ID`),
// and reads back its frame from the window server after each one. Every frame must lie inside the usable area within
// 2 points, match the frame Polycarp says it landed at within 2 points, and for halves and thirds be the size the
// repeat cycle gives (1/2, 2/3, 1/3). Restore must bring back the frame from before the first action. With two
// displays it also sends the window to the next display and back.
//
// It touches no other window and takes no pointer, but its window shows on the workspace you're on, so it runs only
// when the Mac has been idle 10 minutes (HIDIdleTime): otherwise it prints "untested live" and exits 3. It needs the
// build under test installed and `defaults write com.baney.polycarp dockURLCommands -bool true` (exit 2 without it).
// Exit 0 = "window-actions-probe: pass"; 1 = a failure.
import AppKit
import CoreGraphics

func idleSeconds() -> Double {
    var iter: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"), &iter) == KERN_SUCCESS else { return 0 }
    defer { IOObjectRelease(iter) }
    let entry = IOIteratorNext(iter)
    defer { IOObjectRelease(entry) }
    var props: Unmanaged<CFMutableDictionary>?
    guard IORegistryEntryCreateCFProperties(entry, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
          let dict = props?.takeRetainedValue() as? [String: Any], let ns = dict["HIDIdleTime"] as? Int64 else { return 0 }
    return Double(ns) / 1e9
}

func shell(_ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    try? p.run()
    p.waitUntilExit()
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

let idle = idleSeconds()
guard idle >= 600 else {
    print("untested live: the Mac has been idle \(Int(idle)) s, under 10 minutes; run it again while Donovan is away")
    exit(3)
}
guard shell(["defaults", "read", "com.baney.polycarp", "dockURLCommands"]).trimmingCharacters(in: .whitespacesAndNewlines) == "1" else {
    print("not run: turn on the checks switch first: defaults write com.baney.polycarp dockURLCommands -bool true")
    exit(2)
}

let traceURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Polycarp/trace.log")
func traceEnd() -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: traceURL.path))?[.size] as? UInt64) ?? 0 }
func trace(from: UInt64) -> String {
    guard let h = try? FileHandle(forReadingFrom: traceURL) else { return "" }
    defer { try? h.close() }
    try? h.seek(toOffset: from)
    return String(data: h.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

func wait(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }

/// A frame as the window server has it: global, top-left origin, y down (Accessibility's coordinates).
func serverFrame(_ id: CGWindowID) -> CGRect? {
    guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
          let b = info[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
    return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
}

func rect(_ s: Substring) -> CGRect? {
    let p = s.split(whereSeparator: { $0 == "," || $0 == "x" }).compactMap { Double($0) }
    return p.count == 4 ? CGRect(x: p[0], y: p[1], width: p[2], height: p[3]) : nil
}

func close(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
}
func text(_ r: CGRect) -> String { "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width))x\(Int(r.height))" }

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 700, height: 500),
                      styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: false)
window.title = "window-actions-probe (throwaway)"
window.orderFrontRegardless()
wait(1.5)
let id = CGWindowID(window.windowNumber)
guard let start = serverFrame(id) else { print("not run: the probe's window never reached the window server"); exit(2) }

var failed = false
struct Landed { let target: CGRect; let landed: CGRect; let area: CGRect }

/// Runs one action on the probe's window; what Polycarp says it did, checked against the window server.
func act(_ host: String, _ name: String) -> Landed? {
    let from = traceEnd()
    _ = shell(["open", "-g", "polycarp://\(host)/\(name)?window=\(id)"])
    let spelling = "\(host) \(name)"
    for _ in 0..<40 {
        wait(0.05)
        for line in trace(from: from).split(separator: "\n") where line.contains("window action \(spelling) ") && line.contains("window=\(id) ") {
            func field(_ k: String) -> CGRect? {
                guard let r = line.range(of: "\(k)=") else { return nil }
                return rect(line[r.upperBound...].prefix { $0 != " " })
            }
            guard let t = field("target"), let l = field("landed"), let a = field("area") else { break }
            wait(0.2)
            let seen = serverFrame(id) ?? .null
            var ok = true
            if !a.insetBy(dx: -2, dy: -2).contains(seen) { print("FAIL \(spelling): \(text(seen)) is outside the area \(text(a))"); ok = false }
            if !close(seen, l) { print("FAIL \(spelling): the window server has \(text(seen)), Polycarp says it landed at \(text(l))"); ok = false }
            if ok { print("ok   \(spelling): \(text(seen)) in \(text(a))") }
            failed = failed || !ok
            return Landed(target: t, landed: seen, area: a)
        }
    }
    print("FAIL \(spelling): no trace line within 2 s (is the build under test installed?)")
    failed = true
    return nil
}

func expectWidth(_ l: Landed?, _ share: Double, _ what: String) {
    guard let l else { return }
    let want = l.area.width * share
    if abs(l.landed.width - want) > 2 { print("FAIL \(what): width \(Int(l.landed.width)), want \(Int(want))"); failed = true }
}

// A repeat cycles half, two thirds, one third.
expectWidth(act("window", "left-half"), 1.0 / 2, "left-half, first press")
expectWidth(act("window", "left-half"), 2.0 / 3, "left-half, second press")
expectWidth(act("window", "left-half"), 1.0 / 3, "left-half, third press")
expectWidth(act("window", "right-half"), 1.0 / 2, "right-half")
for name in ["top-half", "bottom-half", "top-left", "top-right", "bottom-left", "bottom-right",
             "first-third", "center-third", "last-third", "first-two-thirds", "last-two-thirds", "center", "maximize"] {
    _ = act("window", name)
}
if let m = act("window", "maximize"), !close(m.landed, m.area) {
    print("FAIL maximize: \(text(m.landed)) doesn't fill \(text(m.area))"); failed = true
}
_ = act("window", "shrink")
_ = act("window", "grow")
if NSScreen.screens.count > 1 {
    _ = act("window", "left-half")
    _ = act("window", "next-display")
    _ = act("window", "previous-display")
} else {
    print("skip next-display: one display")
}
_ = act("window", "restore")
wait(0.2)
if let back = serverFrame(id), !close(back, start) {
    print("FAIL restore: \(text(back)), want the frame from before the first action, \(text(start))"); failed = true
}

window.close()
print(failed ? "window-actions-probe: FAIL" : "window-actions-probe: pass")
exit(failed ? 1 : 0)

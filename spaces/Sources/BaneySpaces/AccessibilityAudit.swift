import AppKit
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_AX_AUDIT=1 Polycarp --render <folder>` reads the accessibility tree of every surface the render draws
/// (dock, overview, switcher, launcher, HUD, each Settings pane at full height, the helpers), the tree VoiceOver reads, and
/// fails on any control with no name (`AXAudit`). It prints one line a surface and writes `ax-audit.txt`. Offscreen only.
/// `scripts/ax-audit.sh` runs it.
@MainActor
enum AccessibilityAudit {
    static let on = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_AX_AUDIT"] == "1"
    private static var lines: [String] = []
    private static var findings: [AXAudit.Finding] = []
    private static var controls = 0

    /// SwiftUI builds the tree only for a process with an assistive app attached; VoiceOver says so by setting
    /// `AXEnhancedUserInterface` on the app. This sets it on this render process alone, before any view is drawn.
    static func start() {
        guard on else { return }
        NSApp.accessibilitySetValue(true, forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface"))
    }

    /// Reads `host`'s tree as it stands. Called by the render for every shot it saves.
    static func record(_ host: NSView, _ surface: String) {
        guard on else { return }
        let r = AXAudit.audit(node(host, depth: 0), surface: surface)
        lines.append(AXAudit.line(surface: surface, controls: r.controls, findings: r.findings.count))
        findings += r.findings
        controls += r.controls
    }

    /// Lays `view` out offscreen at `size` and reads it, saving no picture: a pane drawn taller than its window, so a lazy
    /// stack builds every row.
    static func read(_ view: some View, _ surface: String, _ size: CGSize) {
        guard on else { return }
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height)
            .environment(\.colorScheme, Chrome.scheme).environment(\.controlActiveState, .key))
        let window = RenderWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        record(host, surface)
        window.contentView = nil
    }

    /// The report, and the render's exit code: 1 on any unnamed control, or when no control could be read at all.
    static func finish(into folder: URL) -> Int32 {
        guard on else { return 0 }
        let pass = findings.isEmpty && controls > 0
        var text = lines + findings.map { "unnamed: \($0)" }
        text.append("ax audit: \(lines.count) surfaces, \(controls) controls, \(findings.count) unnamed " + (pass ? "PASS" : "FAIL"))
        let report = text.joined(separator: "\n") + "\n"
        try? report.write(to: folder.appendingPathComponent("ax-audit.txt"), atomically: true, encoding: .utf8)
        FileHandle.standardOutput.write(Data(report.utf8))
        return pass ? 0 : 1
    }

    /// One element and what's under it, ignored elements left out as VoiceOver leaves them out.
    private static func node(_ element: Any, depth: Int) -> AXAudit.Node {
        let e = element as AnyObject
        let role = (e.accessibilityRole?() ?? nil)?.rawValue ?? "AXUnknown"
        let raw = (e.accessibilityChildren?() ?? nil) ?? []
        let kids = depth < 80 ? NSAccessibility.unignoredChildren(from: raw).map { node($0, depth: depth + 1) } : []
        return AXAudit.Node(role: role, label: e.accessibilityLabel?() ?? nil, title: e.accessibilityTitle?() ?? nil,
                            placeholder: e.accessibilityPlaceholderValue?() ?? nil, children: kids)
    }
}

import Foundation

/// What VoiceOver needs from every control Polycarp draws: a role it can act on and a name it can read (gap X4). The render
/// audit (`BANEYSPACES_RENDER_AX_AUDIT=1`, `scripts/ax-audit.sh`) reads each surface's accessibility tree offscreen into
/// `Node`s and fails on any `Finding`.
public enum AXAudit {
    public struct Node: Equatable, Sendable {
        public var role: String
        public var label: String?
        public var title: String?
        public var placeholder: String?
        public var children: [Node]
        public init(role: String, label: String? = nil, title: String? = nil, placeholder: String? = nil, children: [Node] = []) {
            self.role = role; self.label = label; self.title = title; self.placeholder = placeholder; self.children = children
        }
    }

    public struct Finding: Equatable, Sendable, CustomStringConvertible {
        public let surface: String
        /// The roles from the surface down to the control, such as `AXGroup > AXButton`.
        public let path: String
        public let why: String
        public var description: String { "\(surface): \(path): \(why)" }
    }

    /// Roles a person acts on. A group, image or text is read, not used, and needs no name of its own.
    public static let controls: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor",
        "AXTextField", "AXTextArea", "AXComboBox", "AXColorWell", "AXLink", "AXDisclosureTriangle", "AXSegmentedControl",
    ]

    /// An SF Symbol's own name (`gearshape.2`, `xmark.circle.fill`), which SwiftUI reads out for an image with no label.
    private static let symbolName = try! NSRegularExpression(pattern: #"^[a-z0-9]+(\.[a-z0-9]+)+$"#)

    /// The name VoiceOver reads for a control, or nil when it has none it can say.
    public static func name(_ n: Node) -> String? {
        for s in [n.label, n.title, n.placeholder] {
            guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { continue }
            if symbolName.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil { continue }
            return t
        }
        return nil
    }

    /// Every control under `root` with no name, and how many controls there are.
    public static func audit(_ root: Node, surface: String) -> (controls: Int, findings: [Finding]) {
        var count = 0
        var found: [Finding] = []
        func walk(_ n: Node, _ path: [String]) {
            // A scroll bar's arrows and pages are AppKit's own, named by their subrole ("increment page"), not ours.
            if n.role == "AXScrollBar" { return }
            let here = path + [n.role]
            if controls.contains(n.role) {
                count += 1
                if name(n) == nil {
                    let said = [n.label, n.title].compactMap { $0 }.filter { !$0.isEmpty }.first
                    found.append(Finding(surface: surface, path: here.suffix(4).joined(separator: " > "),
                                         why: said.map { "named only by its symbol, \"\($0)\"" } ?? "no name"))
                }
            }
            n.children.forEach { walk($0, here) }
        }
        walk(root, [])
        return (count, found)
    }

    /// One line a surface for the report: `ax audit: dock.png: 31 controls, 0 unnamed`.
    public static func line(surface: String, controls: Int, findings: Int) -> String {
        "ax audit: \(surface): \(controls) controls, \(findings) unnamed"
    }
}

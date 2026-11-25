import AppKit
import BaneySpacesCore
import SwiftUI

/// The bar's button: what it draws in a slot of one size, a soft face under the pointer, and a small press. Hover is an
/// AppKit tracking area that works while Polycarp isn't the app in front, which is always: the bar never takes focus.
struct BarButton<Content: View>: View {
    @Environment(\.barFace) private var face
    /// The least width of the slot.
    var width = CGFloat(BarGeometry.slot)
    /// Room either side of a title.
    var inset: CGFloat = 0
    /// Held down by what it opened (a drawer, a list).
    var held = false
    let label: String
    var help: String?
    let action: () -> Void
    @ViewBuilder let content: Content
    @State private var over = false

    var body: some View {
        Button(action: action) {
            content
                .padding(.horizontal, inset)
                .frame(minWidth: width, minHeight: face)
        }
        .buttonStyle(BarPress(over: over, held: held))
        .background { PointerArea { over = $0 } }
        .help(help ?? label)
        .accessibilityLabel(label)
    }
}

/// The face and the press of a bar button.
private struct BarPress: ButtonStyle {
    let over: Bool
    let held: Bool
    @Environment(\.barFace) private var face

    func makeBody(configuration: Configuration) -> some View {
        let strength = configuration.isPressed ? 0.16 : held ? 0.12 : over ? 0.08 : 0
        configuration.label
            .scaleEffect(configuration.isPressed && !Chrome.reduceMotion ? 0.92 : 1)
            .animation(Chrome.ease(0.16, .row), value: configuration.isPressed)
            .background {
                BarShape.face.fill(Chrome.wash(strength)).frame(height: face)
                    .animation(Chrome.ease(over ? 0.09 : 0.16, .row), value: strength)
            }
            // The whole height of the bar takes the click, so the pointer can rest on the screen's edge.
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
    }
}

/// The corners of the bar's small parts, from the theme: square where its own are.
enum BarShape {
    static var radius: CGFloat { min(7, Chrome.radius(.dockRow)) }
    static var face: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }
}

private struct BarFaceKey: EnvironmentKey { static let defaultValue: CGFloat = 22 }

extension EnvironmentValues {
    /// The height of the face behind a bar button (`BarGeometry.face`).
    var barFace: CGFloat {
        get { self[BarFaceKey.self] }
        set { self[BarFaceKey.self] = newValue }
    }
}

/// Says when the pointer comes and goes, in an app that isn't in front, and takes no clicks itself.
struct PointerArea: NSViewRepresentable {
    let onOver: (Bool) -> Void

    func makeNSView(context: Context) -> Area { Area() }
    func updateNSView(_ view: Area, context: Context) {
        view.onOver = onOver
    }
    static func dismantleNSView(_ view: Area, coordinator: ()) { view.forget() }

    final class Area: NSView {
        var onOver: (Bool) -> Void = { _ in }
        private var area: NSTrackingArea?
        private var inside = false

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area { removeTrackingArea(area) }
            let new = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
            addTrackingArea(new)
            area = new
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func mouseEntered(with event: NSEvent) { set(true) }
        override func mouseExited(with event: NSEvent) { set(false) }
        // Taken off the screen with the pointer on it, it would stay lit.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { forget() }
        }

        private func set(_ on: Bool) {
            guard on != inside else { return }
            inside = on
            onOver(on)
        }

        func forget() {
            guard inside else { return }
            inside = false
            let onOver = onOver
            DispatchQueue.main.async { onOver(false) }
        }
    }
}

/// The rows on a notch's right: the middle's modules at the notch, the side's own at the edge (`BarSides`).
struct BarSideRow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions(by: CGSize(width: 600, height: 26))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let ideal = subviews.map { Double($0.sizeThatFits(.unspecified).width) }
        let w = BarSides.widths(lead: ideal[0], trail: ideal[1], gap: BarGeometry.group * 2, room: Double(bounds.width))
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(width: w.lead, height: bounds.height))
        subviews[1].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing,
                          proposal: ProposedViewSize(width: w.trail, height: bounds.height))
    }
}

/// The three rows of a screen without a notch: the middle's in the middle, as wide as it needs up to its share
/// (`BarSides.middle`), and the sides' in what is left either side of it.
struct BarFlatRow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions(by: CGSize(width: 1200, height: 26))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else { return }
        let w = BarSides.middle(ideal: Double(subviews[1].sizeThatFits(.unspecified).width), gap: BarGeometry.group * 2,
                                room: Double(bounds.width))
        let side = ProposedViewSize(width: w.side, height: bounds.height)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: side)
        subviews[1].place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center,
                          proposal: ProposedViewSize(width: w.middle, height: bounds.height))
        subviews[2].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing, proposal: side)
    }
}

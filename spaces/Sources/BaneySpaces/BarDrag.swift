import AppKit
import BaneySpacesCore
import SwiftUI

/// A module being moved along one bar (docs/surfaces.md, "Moving modules"; spec/bar.md R-BA1 to R-BA5). The rows are
/// measured once, at the press, so the others sliding apart never moves the slot under the pointer.
struct BarDrag: Equatable {
    let display: CGDirectDisplayID
    let from: BarSlot
    let module: Surfaces.BarModule
    let rows: [BarRowGeometry]
    /// Where the pointer took the module, from its leading edge, and the module's width.
    let grab: Double, width: Double
    /// The pointer across this bar, and whether it is still over it.
    var x: Double
    var over = true

    var target: BarSlot? { over ? BarArrange.slot(at: x, rows: rows, moving: from) : nil }
}

/// Where each row and drawn module sat on one bar the last time it was laid out, in the bar's own points.
struct BarMeasure: Equatable {
    var frames: [BarMeasureKey: CGRect] = [:]
    var width: Double = 0
    /// The notch's left and right edges, on a screen with one.
    var notch: (start: Double, end: Double)?

    static func == (a: BarMeasure, b: BarMeasure) -> Bool {
        a.frames == b.frames && a.width == b.width && a.notch?.start == b.notch?.start && a.notch?.end == b.notch?.end
    }

    /// The drawn module under `x`, by its row and index.
    func module(at x: Double) -> (slot: BarSlot, frame: CGRect)? {
        for (key, frame) in frames {
            guard case let .item(row, index) = key, x >= frame.minX, x <= frame.maxX else { continue }
            return (BarSlot(row, index), frame)
        }
        return nil
    }

    func rows(_ bar: Surfaces.Bar) -> [BarRowGeometry] {
        var drawn: [BarRow: (minX: Double, maxX: Double)] = [:]
        var items: [BarRow: [BarRowGeometry.Item]] = [:]
        for (key, f) in frames {
            switch key {
            case let .row(r): drawn[r] = (Double(f.minX), Double(f.maxX))
            case let .item(r, i): items[r, default: []].append(.init(index: i, minX: Double(f.minX), maxX: Double(f.maxX)))
            case .bar: break
            }
        }
        let counts = Dictionary(uniqueKeysWithValues: BarRow.allCases.map { ($0, BarArrange.list(bar, $0).count) })
        return BarArrange.rows(width: width, notch: notch, drawn: drawn, items: items, counts: counts)
    }
}

enum BarMeasureKey: Hashable {
    /// The bar inside its padding.
    case bar
    case row(BarRow)
    case item(BarRow, Int)
}

struct BarMeasureFrames: PreferenceKey {
    static let defaultValue: [BarMeasureKey: CGRect] = [:]
    static func reduce(value: inout [BarMeasureKey: CGRect], nextValue: () -> [BarMeasureKey: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

extension View {
    /// Reports this view's frame on the bar under `key`.
    func barMeasured(_ key: BarMeasureKey) -> some View {
        background { GeometryReader { g in Color.clear.preference(key: BarMeasureFrames.self, value: [key: g.frame(in: .named(BarDragger.space))]) } }
    }
}

/// Takes ⌘ and a press on a bar module, follows the pointer and hands the drop to `drop`. It watches Polycarp's own
/// events only, the bar's panels never take focus, and a press it doesn't take goes on to the module as before.
final class BarDragger {
    static let space = "polycarp-bar"
    private let model: TopBarModel
    /// The bar panel a window is, by display.
    private let display: (NSWindow?) -> CGDirectDisplayID?
    private let panel: (CGDirectDisplayID) -> NSWindow?
    private let drop: (BarSlot, BarSlot) -> Void
    private var mouse: Any?
    private var keys: [Any] = []

    init(model: TopBarModel, display: @escaping (NSWindow?) -> CGDirectDisplayID?, panel: @escaping (CGDirectDisplayID) -> NSWindow?,
         drop: @escaping (BarSlot, BarSlot) -> Void) {
        self.model = model; self.display = display; self.panel = panel; self.drop = drop
    }

    func start() {
        guard mouse == nil else { return }
        mouse = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] e in
            guard let self else { return e }
            return self.handle(e) ? nil : e
        }
    }

    func stop() {
        cancel()
        if let mouse { NSEvent.removeMonitor(mouse) }
        mouse = nil
    }

    /// Escape lets go of the module where it was (R-BA5).
    func cancel() {
        guard model.drag != nil else { return }
        model.drag = nil
        watchKeys(false)
        Trace.log("top bar: move canceled")
    }

    private func handle(_ e: NSEvent) -> Bool {
        switch e.type {
        case .leftMouseDown:
            guard e.modifierFlags.contains(.command), let id = display(e.window), let m = model.measure[id],
                  let hit = m.module(at: Double(e.locationInWindow.x)) else { return false }
            let list = BarArrange.list(model.bar, hit.slot.row)
            guard list.indices.contains(hit.slot.index) else { return false }
            let x = Double(e.locationInWindow.x)
            model.drag = BarDrag(display: id, from: hit.slot, module: list[hit.slot.index], rows: m.rows(model.bar),
                                 grab: x - Double(hit.frame.minX), width: Double(hit.frame.width), x: x)
            watchKeys(true)
            return true
        case .leftMouseDragged:
            guard var d = model.drag, let p = panel(d.display) else { return model.drag != nil }
            let at = NSEvent.mouseLocation
            d.x = Double(at.x - p.frame.minX)
            // A little slack below the bar, so a drag along it that dips a few points still lands.
            d.over = p.frame.insetBy(dx: 0, dy: -8).contains(at)
            if d != model.drag { model.drag = d }
            return true
        case .leftMouseUp:
            guard let d = model.drag else { return false }
            model.drag = nil
            watchKeys(false)
            if let to = d.target { drop(d.from, to) } else { Trace.log("top bar: move dropped off the bar, nothing changed") }
            return true
        default:
            return false
        }
    }

    /// Escape, while a move is under way. The panels never take the keyboard, so keys pressed in another app are
    /// watched too, and only then.
    private func watchKeys(_ on: Bool) {
        for k in keys { NSEvent.removeMonitor(k) }
        keys = []
        guard on else { return }
        let escape: (NSEvent) -> Bool = { [weak self] e in
            guard e.keyCode == 53 else { return false }
            self?.cancel()
            return true
        }
        if let g = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { _ = escape($0) }) { keys.append(g) }
        if let l = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { escape($0) ? nil : $0 }) { keys.append(l) }
    }
}

/// A menu item that runs a closure, for the bar's right-click menu.
final class BlockMenuItem: NSMenuItem {
    private let run: () -> Void
    init(_ title: String, key: String = "", run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
    }

    @available(*, unavailable) required init(coder: NSCoder) { fatalError("not from a nib") }

    @objc private func fire() { run() }
}

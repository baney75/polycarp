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
    /// Rows whose style sheet hides this module: it would draw nowhere there, so they take no drop.
    var refused: Set<BarRow> = []

    var target: BarSlot? {
        guard over, let t = BarArrange.slot(at: x, rows: rows, moving: from), !refused.contains(t.row) else { return nil }
        return t
    }
}

/// Where each row and drawn module sat on one bar the last time it was laid out, in the bar's own points.
struct BarMeasure: Equatable {
    var frames: [BarMeasureKey: CGRect] = [:]
    var width: Double = 0
    /// The notch's left and right edges, on a screen with one.
    var notch: (start: Double, end: Double)?
    /// Rows the style sheet hides, and in each row the modules it hides there.
    var closed: Set<BarRow> = []
    var hides: [BarRow: Set<Surfaces.BarModule>] = [:]

    static func == (a: BarMeasure, b: BarMeasure) -> Bool {
        a.frames == b.frames && a.width == b.width && a.notch?.start == b.notch?.start && a.notch?.end == b.notch?.end
            && a.closed == b.closed && a.hides == b.hides
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
        return BarArrange.rows(width: width, notch: notch, drawn: drawn, items: items, counts: counts, closed: closed)
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
    /// Holds the keyboard while a module moves, so Escape cancels the move and never reaches the app in front.
    private var keyPanel: ArrangeKeys?

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
        holdKeys(near: nil)
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
            let module = list[hit.slot.index]
            model.drag = BarDrag(display: id, from: hit.slot, module: module, rows: m.rows(model.bar),
                                 grab: x - Double(hit.frame.minX), width: Double(hit.frame.width), x: x,
                                 refused: Set(BarRow.allCases.filter { m.hides[$0]?.contains(module) == true }))
            holdKeys(near: panel(id))
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
            holdKeys(near: nil)
            // The lists changed under the drag (a `surfaces set`, an earlier move's write coming back): the place it was
            // taken from may hold another module now, so nothing moves.
            let list = BarArrange.list(model.bar, d.from.row)
            guard list.indices.contains(d.from.index), list[d.from.index] == d.module else {
                Trace.log("top bar: the module list changed during the move, nothing changed")
                return true
            }
            if let to = d.target { drop(d.from, to) } else { Trace.log("top bar: move dropped off the bar, nothing changed") }
            return true
        default:
            return false
        }
    }

    private func holdKeys(near panel: NSWindow?) {
        keyPanel?.orderOut(nil)
        keyPanel = nil
        guard let panel else { return }
        let k = ArrangeKeys()
        k.onEscape = { [weak self] in self?.cancel() }
        k.setFrameOrigin(NSPoint(x: panel.frame.minX, y: panel.frame.maxY - 1))
        k.makeKeyAndOrderFront(nil)
        keyPanel = k
    }
}

/// A one-point panel that takes the keyboard without bringing Polycarp forward: Escape, ⌘Z, and losing the keyboard to
/// another app each call back.
final class ArrangeKeys: NSPanel, NSWindowDelegate {
    var onEscape: () -> Void = {}
    var onUndo: () -> Void = {}
    var onResign: () -> Void = {}

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        level = .statusBar
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]
        delegate = self
    }

    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape() }
    override func keyDown(with event: NSEvent) { if event.keyCode == 53 { onEscape() } }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              event.charactersIgnoringModifiers?.lowercased() == "z" else { return super.performKeyEquivalent(with: event) }
        onUndo()
        return true
    }

    func windowDidResignKey(_ notification: Notification) { onResign() }
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

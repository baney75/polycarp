import AppKit
import BaneySpacesCore
import SwiftUI
import UniformTypeIdentifiers

/// The overview: all nine workspaces at once, placed by `OverviewLayout`. The arrow keys still move as if on the number keys' 3×3 grid.
/// Opens from the Mission Control key or ⌃↑ in place of Mission Control.
final class ViewerModel: ObservableObject {
    /// A window card being dragged: what it is, where it came from, where the cursor is.
    struct Drag {
        let entry: Spaces.Entry
        let from: Int
        var location: CGPoint
    }

    @Published var current = 1
    @Published var tiles: [Int: [Spaces.Entry]] = [:]
    @Published var hovered: Int?
    /// The tile the arrow keys picked. Kept apart from `hovered`: SwiftUI can report the pointer
    /// leaving a tile as it redraws it lit, which would drop the keyboard's pick. Only the
    /// pointer entering a tile takes over from it.
    @Published var keyed: Int?
    /// The lit tile, and the one Return goes to.
    var highlighted: Int? { keyed ?? hovered }
    @Published var drag: Drag?
    /// The drag is a real window carried up from the desktop by its title bar, not a card
    /// picked up here; the pointer belongs to that drag, so the viewer only watches it.
    @Published var carrying = false
    /// Icons supplied directly, for rendered product images with sample windows.
    var icons: [WindowID: NSImage] = [:]
    /// Each tile's frame in the viewer, to find the tile under a dragged card.
    var tileFrames: [Int: CGRect] = [:]
    var onPick: (Int) -> Void = { _ in }
    var onPickWindow: (WindowID, Int) -> Void = { _, _ in }
    var onMove: (WindowID, Int) -> Void = { _, _ in }
    var onClose: () -> Void = {}

    func load(from spaces: Spaces) {
        spaces.refresh()
        // A drag in progress keeps its cards where they are; a reload would cancel the gesture.
        guard drag == nil else { return }
        current = spaces.model.current
        tiles = Dictionary(uniqueKeysWithValues: Workspaces.range.map { ($0, spaces.entries(on: $0)) })
    }

    /// The tile a dragged card would land on, if it isn't the one it came from.
    var dropTarget: Int? {
        guard let drag else { return nil }
        return tileFrames.first { $0.value.contains(drag.location) && $0.key != drag.from }?.key
    }

    /// Forget anything left from the last time the viewer was open.
    func reset() {
        drag = nil
        carrying = false
        hovered = nil
        keyed = nil
    }

    func hover(_ n: Int, _ inside: Bool) {
        if inside { hovered = n; keyed = nil } else if hovered == n { hovered = nil }
    }

    func endDrag() {
        guard let drag else { return }
        if let to = dropTarget {
            // Show the result right away; the real move follows a moment later.
            tiles[drag.from]?.removeAll { $0.id == drag.entry.id }
            tiles[to, default: []].append(drag.entry)
            onMove(drag.entry.id, to)
        }
        withAnimation(Chrome.ease(0.15, .panelOut)) { self.drag = nil }
    }
}

private struct TileFrames: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

struct ViewerView: View {
    @ObservedObject var model: ViewerModel
    /// Redraws when Settings › Appearance changes.
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var styles = Styles.shared
    /// Every part's style, worked out once for the sheet in force (`StyleBook.overview`).
    private var sheet: OverviewStyles { styles.book.overview }
    /// Rendered images can't capture a live blur, so they draw a still backdrop instead.
    var stillBackdrop = false
    private var accent: Color { Chrome.accent }
    /// Panel style and opacity are the BaneySpaces theme's; a theme with one fill ignores them.
    private var adjustable: Bool { Chrome.spec.fill.adjustable }

    // The body is split into small pieces so every Swift compiler type-checks it quickly.
    var body: some View {
        ZStack {
            if let own = sheet.panel.background { styledBackdrop(own) } else { themeBackdrop }
            GeometryReader { g in grid(in: g.size) }
            liftedCard
        }
        .coordinateSpace(name: "viewer")
        .opacity(sheet.panel.opacity ?? 1)
        .environment(\.colorScheme, Chrome.scheme)
        .onPreferenceChange(TileFrames.self) { model.tileFrames = $0 }
    }

    // Clicking the backdrop closes the viewer, like clicking the desktop in Mission Control.
    @ViewBuilder private var themeBackdrop: some View {
        backdrop
        Chrome.black(adjustable ? appearance.settings.overviewDim : AppearanceSettings().overviewDim)
            .ignoresSafeArea().onTapGesture { model.onClose() }
        if adjustable && appearance.settings.panelStyle == .tinted {
            Chrome.accent.opacity(AppearanceSettings.tintWash).ignoresSafeArea().allowsHitTesting(false)
        }
    }

    /// The sheet's background: `glass` is the same blur the theme's is, with nothing over it.
    @ViewBuilder private func styledBackdrop(_ own: StyleBackground) -> some View {
        if own == .glass {
            if stillBackdrop { Chrome.stillBackdrop } else { Backdrop().ignoresSafeArea() }
        }
        Rectangle().fill(own == .glass ? AnyShapeStyle(Color.clear) : Styled.fill(own) ?? AnyShapeStyle(Color.clear))
            .contentShape(Rectangle()).ignoresSafeArea().onTapGesture { model.onClose() }
    }

    @ViewBuilder private var backdrop: some View {
        if (adjustable && appearance.settings.panelStyle == .solid) || (!Chrome.spec.fill.blur && !stillBackdrop) {
            Chrome.panel().ignoresSafeArea()
        } else if stillBackdrop {
            Chrome.stillBackdrop
        } else {
            Backdrop().ignoresSafeArea()
        }
    }

    /// Workspaces with windows share the screen by how many they hold, and empty ones wait in a strip (`OverviewLayout`).
    private func grid(in size: CGSize) -> some View {
        let area = CGRect(x: 48, y: 48, width: max(0, size.width - 96), height: max(0, size.height - 96 - 44))
        let plan = OverviewLayout.plan(windows: model.tiles.mapValues(\.count), current: model.current, in: area)
        return ZStack(alignment: .topLeading) {
            ForEach(Array(plan.tiles.keys).sorted(), id: \.self) { n in
                let r = plan.tiles[n]!
                tile(n, height: r.height).frame(width: r.width, height: r.height).position(x: r.midX, y: r.midY)
            }
            ForEach(Array(plan.slots.keys).sorted(), id: \.self) { n in
                let r = plan.slots[n]!
                slot(n, size: r.width).position(x: r.midX, y: r.midY)
            }
            footer.frame(width: size.width).position(x: size.width / 2, y: size.height - 48 - 12)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }

    /// An empty workspace: its number, a click to go there and a place to drop a window.
    private func slot(_ n: Int, size: CGFloat) -> some View {
        let isTarget = model.dropTarget == n
        let isHovered = model.drag == nil && model.highlighted == n
        let c = sheet.tile(current: false, hover: isHovered)
        return Text("\(n)").spaced(c.number)
            .font(Styled.font(c.number, .ui, 17, .semibold, rounded: true))
            .foregroundStyle(isTarget ? accent : c.number.ink(isHovered ? accent : Chrome.muted))
            .minimumScaleFactor(c.number.fontSize == nil ? 1 : 0.4)
            .opacity(c.number.opacity ?? 1)
            .frame(width: size, height: size)
            .background(tileShape(c, isCurrent: false, isTarget: isTarget, isHovered: isHovered))
            .opacity(isTarget ? 1 : c.box.opacity ?? 1)
            .scaleEffect(isTarget ? Chrome.grow(1.08) : 1)
            .animation(Chrome.ease(0.12, .row), value: isTarget)
            .background(GeometryReader { g in
                Color.clear.preference(key: TileFrames.self, value: [n: g.frame(in: .named("viewer"))])
            })
            .contentShape(Chrome.shape(.overviewTile, continuous: false))
            .onTapGesture { model.onPick(n) }
            .onHover { inside in model.hover(n, inside) }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(tileLabel(n, entries: [], isCurrent: false))
            .accessibilityAddTraits(.isButton)
    }

    /// The lifted card follows the cursor.
    @ViewBuilder private var liftedCard: some View {
        if let drag = model.drag {
            card(drag.entry, lifted: true)
                .frame(width: 300)
                .position(drag.location)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder private var footer: some View {
        let c = sheet.hint
        if !c.isHidden {
            Text(c.cased(hint)).spaced(c)
                .font(Styled.font(c, .ui, 12))
                .foregroundStyle(c.ink(Chrome.wash(0.7)))
                .lineLimit(c.fontSize == nil ? nil : 1).minimumScaleFactor(c.fontSize == nil ? 1 : 0.4)
                .padding(c, else: EdgeInsets())
                .frame(height: c.padding == nil && c.fontSize == nil ? 40 : nil)
                .background { StyledBack(c) }
                .opacity(c.opacity ?? 1)
        }
    }

    private var hint: String {
        model.drag == nil
                     ? "Click a workspace or press its number  ·  Arrow keys and Return work too  ·  Drag a window to another workspace  ·  Esc to close"
                     : model.carrying
                     ? "Let go over a workspace to move the window there  ·  Anywhere else leaves it here"
                     : "Drop on a workspace to move the window there"
    }

    private func tile(_ n: Int, height: CGFloat) -> some View {
        let entries = model.tiles[n] ?? []
        let isCurrent = n == model.current
        let isTarget = model.dropTarget == n
        let isHovered = model.drag == nil && model.highlighted == n
        let c = sheet.tile(current: isCurrent, hover: isHovered)
        let content = VStack(alignment: .leading, spacing: 8) {
            tileHeader(n, c, count: entries.count, isCurrent: isCurrent)
            tileBody(n, c, entries: entries, isTarget: isTarget)
        }
        return content
            .padding(c.box, else: EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14))
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .topLeading)
            .background(tileShape(c, isCurrent: isCurrent, isTarget: isTarget, isHovered: isHovered))
            .opacity(isTarget ? 1 : c.box.opacity ?? 1)
            .scaleEffect(isTarget ? Chrome.grow(1.02) : 1)
            .animation(Chrome.ease(0.12, .row), value: isTarget)
            .background(GeometryReader { g in
                Color.clear.preference(key: TileFrames.self, value: [n: g.frame(in: .named("viewer"))])
            })
            .contentShape(Chrome.shape(.overviewTile, continuous: false))
            .onTapGesture { model.onPick(n) }
            .onHover { inside in model.hover(n, inside) }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(tileLabel(n, entries: entries, isCurrent: isCurrent))
            .accessibilityAddTraits(.isButton)
    }

    private func label(_ text: String, _ c: ComputedStyle, _ size: Double, _ own: Color, _ weight: TextWeight = .regular) -> some View {
        Text(c.cased(text)).spaced(c).font(Styled.font(c, .ui, size, weight)).foregroundStyle(c.ink(own)).opacity(c.opacity ?? 1)
    }

    private func tileHeader(_ n: Int, _ c: OverviewStyles.Tile, count: Int, isCurrent: Bool) -> some View {
        // On one baseline: centered, the small caption floats above the big number's foot.
        HStack(alignment: .firstTextBaseline) {
            Text("\(n)").spaced(c.number).font(Styled.font(c.number, .ui, 22, .bold, rounded: true))
                .foregroundStyle(c.number.ink(.primary)).opacity(c.number.opacity ?? 1)
            if count > 0, !c.label.isHidden {
                label(count == 1 ? "1 window" : "\(count) windows", c.label, 12, Chrome.muted).lineLimit(c.label.hasFont ? 1 : nil)
            }
            Spacer()
            if isCurrent, !c.label.isHidden { label("You're here", c.label, 12, accent, .semibold).lineLimit(c.label.hasFont ? 1 : nil) }
        }
    }

    @ViewBuilder private func tileBody(_ n: Int, _ c: OverviewStyles.Tile, entries: [Spaces.Entry], isTarget: Bool) -> some View {
        if entries.isEmpty {
            Spacer()
            emptyLabel(c.label, isTarget: isTarget)
            Spacer()
        } else {
            windowList(n, c, entries: entries)
            if isTarget {
                Text("Move here").font(Chrome.font(10, .semibold)).foregroundStyle(accent)
            }
        }
    }

    @ViewBuilder private func emptyLabel(_ c: ComputedStyle, isTarget: Bool) -> some View {
        if isTarget {
            Text("Move here").font(Chrome.font(12)).foregroundStyle(accent).frame(maxWidth: .infinity)
        } else if !c.isHidden {
            label("Empty", c, 13, Chrome.muted).frame(maxWidth: .infinity)
        }
    }

    /// Every window has a card, and the cards fill the tile. They shrink as it fills, so none is ever hidden.
    private func windowList(_ n: Int, _ c: OverviewStyles.Tile, entries: [Spaces.Entry]) -> some View {
        GeometryReader { g in
            let grid = OverviewLayout.cards(entries.count, in: g.size)
            let columns = Array(repeating: GridItem(.fixed(grid.cardSize.width), spacing: OverviewLayout.cardGap), count: grid.columns)
            LazyVGrid(columns: columns, alignment: .leading, spacing: OverviewLayout.cardGap) {
                ForEach(entries) { e in draggableCard(e, c, from: n, size: grid.cardSize) }
            }
        }
    }

    /// The drop target is the theme's, whatever the sheet draws: a place to let go is never hidden.
    private func tileShape(_ c: OverviewStyles.Tile, isCurrent: Bool, isTarget: Bool, isHovered: Bool) -> some View {
        let border: Color
        if isTarget { border = Chrome.focusEdge(accent) } else if isCurrent { border = Chrome.focusEdge(accent.opacity(0.85)) }
        else if isHovered { border = Chrome.theme == .baneyspaces ? Chrome.wash(0.6) : Chrome.focusEdge(accent) } else { border = Chrome.edge(0.08) }
        let width = Chrome.width(.overviewTile, focused: isTarget || isCurrent || isHovered)
        let dash: [CGFloat] = isTarget ? [8, 5] : []
        return StyledBack(isTarget ? c.target : c.box, .overviewTile, continuous: false)
            .fill(Chrome.tileFill(target: isTarget))
            .overlay {
                if isTarget || c.box.border == nil || ((isCurrent || isHovered) && !c.marked) {
                    Styled.shape(c.box, else: Chrome.radius(.overviewTile), continuous: false)
                        .strokeBorder(border, style: StrokeStyle(lineWidth: width, dash: dash))
                }
            }
    }

    private func tileLabel(_ n: Int, entries: [Spaces.Entry], isCurrent: Bool) -> String {
        let apps = entries.isEmpty ? "empty" : entries.map(\.app).joined(separator: ", ")
        return "Workspace \(n)\(isCurrent ? ", current" : ""), \(apps)"
    }

    /// A window card in a tile. Click it to go to that window; drag it to another workspace.
    private func draggableCard(_ e: Spaces.Entry, _ c: OverviewStyles.Tile, from n: Int, size: CGSize) -> some View {
        let beingDragged = model.drag?.entry.id == e.id
        return bigCard(e, c, size: size)
            .opacity(beingDragged ? 0.3 : 1)
            .onHover { inside in (inside ? NSCursor.openHand : NSCursor.arrow).set() }
            .gesture(
                DragGesture(minimumDistance: 4, coordinateSpace: .named("viewer"))
                    .onChanged { v in
                        if model.drag == nil { NSCursor.closedHand.set() }
                        model.drag = ViewerModel.Drag(entry: e, from: n, location: v.location)
                    }
                    .onEnded { _ in
                        NSCursor.arrow.set()
                        model.endDrag()
                    }
            )
            .simultaneousGesture(TapGesture().onEnded { model.onPickWindow(e.id, n) })
    }

    /// A window in its tile: the app's icon large in the middle, with the app and title below. The title goes first when a
    /// card gets small, then the app's name.
    private func bigCard(_ e: Spaces.Entry, _ c: OverviewStyles.Tile, size: CGSize) -> some View {
        // Larger text in the sheet needs a larger card before it shows.
        let name = max(1, (c.window.fontSize ?? 0) / 13), line = max(name, (c.title.fontSize ?? 0) / 12)
        let icon = min(56, max(18, size.height * 0.42))
        let title = e.title.isEmpty || e.title == e.app ? "" : e.title
        return VStack(spacing: max(2, min(8, size.height * 0.05))) {
            if !c.icon.isHidden {
                Image(nsImage: model.icons[e.id] ?? NSRunningApplication(processIdentifier: e.pid)?.icon ?? NSImage())
                    .resizable().frame(width: icon, height: icon).corners(c.icon).opacity(c.icon.opacity ?? 1)
            }
            if size.height >= 52 * name {
                Text(c.window.cased(e.app)).spaced(c.window).font(Styled.font(c.window, .ui, 13, .semibold))
                    .foregroundStyle(c.window.ink(.primary)).lineLimit(1).truncationMode(.middle)
            }
            if size.height >= 84 * line, !title.isEmpty, !c.title.isHidden {
                label(title, c.title, 12, Chrome.muted).lineLimit(size.height >= 130 * line ? 2 : 1)
                    .multilineTextAlignment(.center).truncationMode(.middle)
            }
        }
        .padding(.horizontal, 8)
        .frame(width: size.width, height: size.height)
        .background(StyledBack(c.window, .overviewChip, continuous: false).fill(Chrome.cell(0.06)))
        .opacity(c.window.opacity ?? 1)
        .contentShape(Chrome.shape(.overviewChip, continuous: false))
        .help(title.isEmpty ? e.app : "\(e.app): \(title)")
    }

    private func card(_ e: Spaces.Entry, lifted: Bool) -> some View {
        let c = sheet.tile(current: false, hover: false)
        return HStack(spacing: 8) {
            Image(nsImage: model.icons[e.id] ?? NSRunningApplication(processIdentifier: e.pid)?.icon ?? NSImage())
                .resizable().frame(width: 24, height: 24)
            // One line per window: the app, then its title, trimmed in the middle if long.
            (Text(c.window.cased(e.app)).spaced(c.window).font(Styled.font(c.window, .ui, 14, .semibold)).foregroundColor(c.window.ink(.primary))
             + Text(e.title.isEmpty || e.title == e.app || c.title.isHidden ? "" : "  \(c.title.cased(e.title))").spaced(c.title)
                .font(Styled.font(c.title, .ui, 14)).foregroundColor(c.title.ink(Chrome.muted)))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StyledBack(c.window, .overviewChip, continuous: false).fill(lifted ? Chrome.liftedFill : Chrome.cell(0.06)))
        .overlay {
            if c.window.border == nil {
                Styled.shape(c.window, else: Chrome.radius(.overviewChip), continuous: false)
                    .strokeBorder(Chrome.edge(lifted ? 0.25 : 0), lineWidth: Chrome.width(.overviewChip))
            }
        }
        .shadow(color: Chrome.shadow(lifted ? 0.5 : 0), radius: 14, y: 6)
        .scaleEffect(lifted ? Chrome.grow(1.04) : 1)
    }
}

/// Blurs whatever is behind the viewer, so the tiles read cleanly over any window.
struct Backdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .fullScreenUI
        v.blendingMode = .behindWindow
        v.state = .active
        v.appearance = NSAppearance(named: .darkAqua)
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

/// A borderless panel over everything, on every display's active desktop.
final class ViewerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class ViewerController {
    private let spaces: Spaces
    private let model = ViewerModel()
    private var panel: ViewerPanel?
    private var keyMonitor: Any?
    /// Open from the moment `open()` runs until `close()` starts, not until the fade ends, so a
    /// quick second press always does the right thing.
    private(set) var isOpen = false { didSet { MissionControlKeys.viewerOpen = isOpen } }
    /// Bumped on every open, so a fade-out that finishes late can't hide a viewer reopened since.
    private var openCount = 0

    init(spaces: Spaces) {
        self.spaces = spaces
        model.onPick = { [weak self] n in
            self?.close()
            self?.spaces.switchTo(n)
        }
        model.onPickWindow = { [weak self] id, n in
            self?.close()
            self?.spaces.focus(id, on: n)
        }
        model.onMove = { [weak self] id, n in
            guard let self else { return }
            self.spaces.move(id, to: n)
            // The tile already shows the move; reload once the real one has settled.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.model.load(from: self.spaces) }
        }
        // Closing without a pick hands focus back to the workspace you were on.
        model.onClose = { [weak self] in
            guard let self else { return }
            self.close()
            self.spaces.switchTo(self.spaces.model.current)
        }
    }

    func toggle() { isOpen ? model.onClose() : open() }

    func open() {
        let clock = OpenClock(panel == nil ? "overview-first" : "overview")
        defer { clock.shown() }
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        isOpen = true
        openCount += 1
        model.reset()
        // Opened on the display under the pointer, it's about that display's workspace.
        spaces.usePointerDisplay()
        spaces.rememberFocus()
        model.load(from: spaces)
        // Titles are read again off the main thread; a change reloads the overview.
        spaces.refreshDetails()
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let frame = screen?.frame else { return }
        let p = panel ?? makePanel()
        panel = p
        p.ignoresMouseEvents = false
        p.setFrame(frame, display: true)
        p.alphaValue = 0
        // The viewer takes the keyboard so 1–9, Return and Esc reach it, not the app below.
        Windows.makeFrontmost(getpid())
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(0.12, .panelIn)
            p.animator().alphaValue = 1
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if event.keyCode == 53 { self.model.onClose(); return nil }   // Esc
            if let c = event.charactersIgnoringModifiers, let n = Int(c), Workspaces.range.contains(n) {
                self.model.onPick(n)
                return nil
            }
            if event.keyCode == 36 { self.model.onPick(self.model.highlighted ?? self.model.current); return nil }  // Return
            // The arrow keys move the highlight from tile to tile; Return goes there.
            let steps: [UInt16: GridStep] = [123: .left, 124: .right, 125: .down, 126: .up]
            if let step = steps[event.keyCode], self.model.drag == nil {
                self.model.keyed = step.from(self.model.highlighted ?? self.model.current)
                return nil
            }
            return event
        }
    }

    /// The top-left of the screen a carried window's overview is on, in window-server space.
    private var carryOrigin = CGPoint.zero
    /// That screen's whole frame, in window-server space: the overview covers it and no other.
    private var carryScreen = CGRect.null

    /// Whether the carry overview is showing over the screen holding `p` (window-server space).
    func carryCovers(_ p: CGPoint) -> Bool { isOpen && model.carrying && carryScreen.contains(p) }

    /// Opens over the screen under `p` for a window being dragged to the top of the screen, in
    /// place of Mission Control. The drag stays the window server's: the viewer takes neither
    /// the pointer nor the keyboard, and only follows where it goes. False for a window that
    /// isn't on a workspace.
    func openCarrying(_ id: WindowID, at p: CGPoint) -> Bool {
        guard !isOpen, let (entry, from) = spaces.entry(for: id) else { return false }
        // Matched in window-server space, as the drag was: at a screen's very top edge an AppKit
        // point would fall just outside it.
        let cgFrames = TopDragWatcher.screens()
        guard let mainHeight = NSScreen.screens.first?.frame.maxY,
              let i = cgFrames.firstIndex(where: { $0.contains(p) }), i < NSScreen.screens.count else { return false }
        let screen = NSScreen.screens[i]
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        isOpen = true
        openCount += 1
        model.reset()
        model.load(from: spaces)
        carryOrigin = CGPoint(x: screen.frame.minX, y: mainHeight - screen.frame.maxY)
        carryScreen = cgFrames[i]
        let panel = panel ?? makePanel()
        self.panel = panel
        panel.ignoresMouseEvents = true
        panel.setFrame(screen.frame, display: true)
        model.carrying = true
        model.drag = ViewerModel.Drag(entry: entry, from: from, location: viewerPoint(p))
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(0.12, .panelIn)
            panel.animator().alphaValue = 1
        }
        Trace.log("topDrag open window=\(id) from=\(from)")
        return true
    }

    /// The carried window's card follows the pointer.
    func carryMoved(to p: CGPoint) {
        guard isOpen, model.carrying, var d = model.drag else { return }
        d.location = viewerPoint(p)
        model.drag = d
    }

    /// The button came up at `p` (nil when the drag ended some other way): the workspace the window was let go over, if
    /// not its own. Closes.
    func endCarrying(at p: CGPoint?) -> Int? {
        guard isOpen, model.carrying else { return nil }
        let target = model.dropTarget
        let at = p.map { "\(Int($0.x.rounded())),\(Int($0.y.rounded()))" } ?? "none"
        Trace.log("topDrag release at=\(at) target=\(target.map(String.init) ?? "none")")
        close()
        return target
    }

    /// The pointer in the viewer's own space, which SwiftUI lays out inside the safe area: below
    /// the camera housing on a Mac with a notch, so tile frames start that far down.
    private func viewerPoint(_ p: CGPoint) -> CGPoint {
        let inset = panel?.contentView?.safeAreaInsets ?? NSEdgeInsetsZero
        return CGPoint(x: p.x - carryOrigin.x - inset.left, y: p.y - carryOrigin.y - inset.top)
    }

    func close() {
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        guard isOpen, let p = panel else { return }
        isOpen = false
        model.reset()
        let count = openCount
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = Chrome.duration(0.1, .panelOut)
            p.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, self.openCount == count, !self.isOpen else { return }
            p.orderOut(nil)
        })
    }

    private func makePanel() -> ViewerPanel {
        let p = ViewerPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.contentView = NSHostingView(rootView: ViewerView(model: model).environment(\.colorScheme, .dark))
        return p
    }
}

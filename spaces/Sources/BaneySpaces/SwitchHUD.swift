import AppKit
import BaneySpacesCore
import SwiftUI

/// A brief, quiet confirmation of a keyboard switch: the 3×3 grid with the new workspace
/// lit, the way the volume overlay confirms a key. It never takes focus or clicks. Off unless
/// `showSwitchHUD` is set (`SwitchHUDPolicy`).
final class SwitchHUD {
    static var stored: Bool? { UserDefaults.standard.object(forKey: SwitchHUDPolicy.defaultsKey) as? Bool }
    static var enabled: Bool {
        get { SwitchHUDPolicy.enabled(stored: stored) }
        set { UserDefaults.standard.set(newValue, forKey: SwitchHUDPolicy.defaultsKey) }
    }

    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?
    private let model = HUDModel()

    /// `occupied` lights the workspaces that have windows; `icons` are the apps on `n`.
    /// `display`: the display the workspace went to (with several), else the one under the pointer.
    func show(_ n: Int, occupied: Set<Int> = [], icons: [NSImage] = [], display: DisplayKey? = nil) {
        guard SwitchHUD.enabled else { return }
        model.current = n
        model.occupied = occupied
        model.icons = icons
        let p = panel ?? makePanel()
        panel = p
        if let host = p.contentView { host.layoutSubtreeIfNeeded(); p.setContentSize(host.fittingSize) }
        if let screen = display.flatMap(Windows.screen(for:)) ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main {
            let size = p.frame.size
            p.setFrameOrigin(NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.minY + screen.frame.height * 0.16))
        }
        hideWork?.cancel()
        p.alphaValue = 1
        p.orderFrontRegardless()
        let work = DispatchWorkItem { [weak p] in
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = Chrome.duration(0.18, .panelOut)
                p?.animator().alphaValue = 0
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55, execute: work)
    }

    private func makePanel() -> NSPanel {
        let host = NSHostingView(rootView: HUDView(model: model))
        let size = host.fittingSize
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        p.contentView = host
        return p
    }
}

final class HUDModel: ObservableObject {
    @Published var current = 1
    @Published var occupied: Set<Int> = []
    @Published var icons: [NSImage] = []
}

/// The 3×3 grid as the number keys lay it out: the workspace you went to filled in its own
/// color with its number, workspaces with windows lit, empty ones faint. Below, its name and apps.
struct HUDView: View {
    @ObservedObject var model: HUDModel
    /// Redraws when Settings › Appearance changes.
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var styles = Styles.shared
    /// Every part's style, worked out once for the sheet in force (`StyleBook.hud`).
    private var sheet: HUDStyles { styles.book.hud }

    var body: some View {
        let sheet = sheet, label = sheet.label, text = sheet.text, icon = sheet.icon
        let gap = sheet.panel.gap.map { CGFloat($0) } ?? 5
        return VStack(spacing: 12) {
            VStack(spacing: gap) {
                ForEach(0..<3, id: \.self) { row in
                    HStack(spacing: gap) {
                        ForEach(1...3, id: \.self) { col in cell(row * 3 + col) }
                    }
                }
            }
            HStack(spacing: 6) {
                Text(label.cased("Workspace \(model.current)")).spaced(label).font(Styled.font(label, .ui, 13, .semibold))
                    .foregroundStyle(label.ink(Chrome.wash())).opacity(label.opacity ?? 1)
                if model.icons.isEmpty {
                    if !text.isHidden {
                        Text(text.cased("Empty")).spaced(text).font(Styled.font(text, .ui, 12, .medium))
                            .foregroundStyle(text.ink(Chrome.wash(0.45))).opacity(text.opacity ?? 1)
                    }
                } else if !icon.isHidden {
                    HStack(spacing: -3) {
                        ForEach(Array(model.icons.enumerated()), id: \.offset) { _, image in
                            Image(nsImage: image).resizable().frame(width: 18, height: 18).corners(icon)
                        }
                    }
                    .opacity(icon.opacity ?? 1)
                }
            }
            .frame(height: label.hasFont || text.hasFont ? nil : 18)
            .frame(minHeight: 18)
        }
        .padding(sheet.panel, else: EdgeInsets(top: 16, leading: 18, bottom: 16, trailing: 18))
        .background(Chrome.panelBackground(.hudPanel, style: sheet.panel))
        .opacity(sheet.panel.opacity ?? 1)
        .padding(28)
        .environment(\.colorScheme, Chrome.scheme)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Workspace \(model.current)")
    }

    private func cell(_ n: Int) -> some View {
        let on = n == model.current
        let used = model.occupied.contains(n)
        let c = sheet.cell(current: on), box = c.box
        // The one you switched to keeps its workspace's color, and the number that reads on it, until the sheet marks it.
        let own = on && !c.marked
        let ink = own && !c.recolored ? Chrome.onTint(n) : box.ink(on ? Chrome.onTint(n) : Chrome.wash(used ? 0.6 : 0.25), dim: on || used ? 1 : 0.5)
        return StyledBack(box, .hudCell).fill(on ? Chrome.workspace(n) : Chrome.cell(used ? 0.2 : 0.07)).marking(own)
            .overlay {
                if box.border == nil || own {
                    Styled.shape(box, else: Chrome.radius(.hudCell))
                        .strokeBorder(on ? Chrome.focusEdge(Chrome.wash(0.35)) : Chrome.edge(used ? 0.12 : 0.05), lineWidth: Chrome.width(.hudCell))
                }
            }
            .overlay(Text("\(n)").spaced(box).font(Styled.font(box, .ui, on ? 17 : 11, .bold, rounded: true))
                .foregroundStyle(ink).minimumScaleFactor(box.fontSize == nil ? 1 : 0.4))
            .frame(width: 40, height: 30)
            .opacity(box.opacity ?? 1)
            .shadow(color: Chrome.shadow(own ? 0.6 : 0, color: Chrome.workspace(n)), radius: 8)
    }
}

import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Permissions: every macOS permission Polycarp uses, with its live state, a plain reason and one button that
/// does the right thing for its kind (`Permissions.action`). The ones the parts you use need come first; the rest wait,
/// closed, under Optional. Polycarp never changes a permission itself: each button asks macOS or opens its pane.
struct PermissionsPane: View {
    /// The old-grant fix on the Accessibility row, from `SetupModel` (its reset code lives there).
    struct StaleFix {
        var shown: Bool
        var busy: Bool
        var run: () -> Void
    }

    @ObservedObject private var model = PermissionsModel.shared
    @ObservedObject private var parts = PartsModel.shared
    @ObservedObject private var appearance = Appearance.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var fix: StaleFix?
    /// A row's button was pressed, before it acts.
    var onAsk: (PermissionID) -> Void
    @State private var optionalOpen = false

    init(fix: StaleFix? = nil, onAsk: @escaping (PermissionID) -> Void = { _ in }, optionalOpen: Bool = false) {
        self.fix = fix
        self.onAsk = onAsk
        _optionalOpen = State(initialValue: optionalOpen)
    }

    var body: some View {
        let plan = Permissions.plan(states: model.states, features: parts.current)
        VStack(alignment: .leading, spacing: 18) {
            SettingsGroup {
                SettingsBlock {
                    HStack(spacing: 10) {
                        Image(systemName: plan.left == 0 ? "checkmark.shield.fill" : "hand.raised.fill")
                            .font(Chrome.font(18)).foregroundStyle(plan.left == 0 ? Chrome.done : Chrome.accent)
                            .accessibilityHidden(true)
                        Text(Permissions.summary(plan)).font(Chrome.font(13, .medium)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            SettingsGroup("For what you use") {
                if plan.needed.isEmpty {
                    SettingsNote("The parts you have on need nothing from macOS.")
                }
                ForEach(plan.needed) { row in rowView(row, next: plan.next) }
            }

            if !plan.optional.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Button { optionalOpen.toggle() } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "chevron.right").font(Chrome.font(9, .bold)).rotationEffect(.degrees(optionalOpen ? 90 : 0))
                            Text("Optional").font(Chrome.font(12, .semibold))
                            Text("\(plan.optional.count)").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                        }
                        .foregroundStyle(Chrome.muted)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Optional permissions")
                    .accessibilityValue(optionalOpen ? "expanded" : "collapsed")
                    if optionalOpen {
                        SettingsGroup {
                            ForEach(plan.optional) { row in rowView(row) }
                        }
                        .transition(.opacity)
                    }
                }
            }

            SettingsGroup {
                LearnMore("Polycarp never turns a permission on or off by itself. Each button asks macOS, which shows its own box, or opens the right list in System Settings. For a list, a small panel with Polycarp's icon shows beside System Settings: drag the icon into the list, then switch it on. Without a mouse, click + under the list, pick Polycarp in Applications, then switch it on. You can turn any of these off there at any time.")
            }
        }
        .animation(reduceMotion ? nil : Chrome.ease(0.15), value: optionalOpen)
        .background(WindowReader { PermissionsModel.shared.watch($0) })
    }

    @ViewBuilder private func rowView(_ row: Permissions.Row, next: PermissionID? = nil) -> some View {
        PermissionRowView(entry: row.entry, state: row.state, optional: row.optional, stops: row.stops, prominent: row.id == next) {
            onAsk(row.id)
            PermissionsModel.shared.perform(row.id)
        } accessory: {
            if row.id == .automation { AutomationTargetsList(model: model) }
            if row.id == .accessibility, row.state != .granted, let fix, fix.shown {
                HStack(spacing: 10) {
                    Text("Already on and still waiting? macOS can keep an old permission from an earlier copy. This clears it and asks again.")
                        .font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button(fix.busy ? "Fixing…" : "Fix Permission", action: fix.run).disabled(fix.busy)
                }
            }
        }
    }
}

/// One permission: a state mark, its name, a plain reason, and one button. Settings > Permissions and the welcome window
/// both draw their rows with this, so a permission looks and acts the same wherever it's asked for.
struct PermissionRowView<Accessory: View>: View {
    @ObservedObject private var appearance = Appearance.shared
    let entry: PermissionEntry
    let state: PermissionState
    var title: String?
    var reason: String?
    var optional = false
    var stops: [String] = []
    /// The row you're on (the welcome walk): tinted, with the full reason.
    var emphasized = false
    /// Return presses this row's button.
    var isDefault = false
    /// The accent button: the one row to do next. The others are quiet, so a page of them never shouts.
    var prominent = false
    var buttonTitle: String?
    /// The welcome walk: the button under the reason, only on the step you're on, with "Not now" beside it.
    var walk: Walk?
    struct Walk {
        var showsButton: Bool
        var skip: (() -> Void)?
    }
    let action: () -> Void
    @ViewBuilder var accessory: () -> Accessory

    init(entry: PermissionEntry, state: PermissionState, title: String? = nil, reason: String? = nil, optional: Bool = false,
         stops: [String] = [], emphasized: Bool = false, isDefault: Bool = false, prominent: Bool? = nil, buttonTitle: String? = nil,
         walk: Walk? = nil, action: @escaping () -> Void, @ViewBuilder accessory: @escaping () -> Accessory) {
        self.entry = entry; self.state = state; self.title = title; self.reason = reason; self.optional = optional
        self.stops = stops; self.emphasized = emphasized; self.isDefault = isDefault; self.buttonTitle = buttonTitle; self.walk = walk
        self.prominent = prominent ?? (emphasized || isDefault)
        self.action = action; self.accessory = accessory
    }

    private var granted: Bool { state == .granted }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            mark.frame(width: 20).padding(.top, 1)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .center, spacing: 8) {
                    Text(title ?? entry.title).font(Chrome.font(13, .semibold))
                    if !granted {
                        Text(state.word).font(Chrome.font(11, .medium)).foregroundStyle(state == .unknown ? Chrome.muted : Chrome.working)
                            .fixedSize()
                    }
                    if entry.blocksStart && !optional { PermissionTag(text: "Required") }
                    if optional { PermissionTag(text: "Optional") }
                    Spacer(minLength: 8)
                    trailing
                }
                Text(reason ?? "\(entry.purpose) \(entry.never)")
                    .font(Chrome.font(12)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                if !granted {
                    if !stops.isEmpty {
                        Text("Without it: \(stops.joined(separator: " · "))")
                            .font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let way = Permissions.keyboardWay(entry), walk?.showsButton ?? true {
                        Text(way).font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let walk, walk.showsButton {
                        HStack(spacing: 10) {
                            button
                            if let skip = walk.skip { Button("Not now", action: skip) }
                        }
                        .padding(.top, 2)
                    }
                }
                accessory()
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(emphasized ? Chrome.cell(0.08) : Color.clear)
        .overlay(alignment: .top) { Rectangle().fill(Chrome.edge(0.14)).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title ?? entry.title), \(state.word)")
    }

    @ViewBuilder private var mark: some View {
        switch state {
        case .granted: Image(systemName: "checkmark.circle.fill").font(Chrome.font(16)).foregroundStyle(Chrome.done)
        case .denied: Image(systemName: "minus.circle").font(Chrome.font(16)).foregroundStyle(Chrome.working)
        case .notAsked: Image(systemName: "circle.dashed").font(Chrome.font(16)).foregroundStyle(Chrome.working)
        case .unknown: Image(systemName: "circle").font(Chrome.font(16)).foregroundStyle(Chrome.muted)
        }
    }

    @ViewBuilder private var trailing: some View {
        if granted {
            SettingsStatusLabel(text: state.word)
        } else if walk == nil {
            button
        }
    }

    @ViewBuilder private var button: some View {
        if let label = buttonTitle ?? Permissions.buttonTitle(entry, state) {
            Button(label, action: action)
                .keyboardShortcut(isDefault ? KeyboardShortcut.defaultAction : nil)
                .buttonStyle(PermissionButtonStyle(prominent: prominent))
                .fixedSize()
        }
    }
}

extension PermissionRowView where Accessory == EmptyView {
    init(entry: PermissionEntry, state: PermissionState, title: String? = nil, reason: String? = nil, optional: Bool = false,
         stops: [String] = [], emphasized: Bool = false, isDefault: Bool = false, prominent: Bool? = nil, buttonTitle: String? = nil,
         action: @escaping () -> Void) {
        self.init(entry: entry, state: state, title: title, reason: reason, optional: optional, stops: stops, emphasized: emphasized,
                  isDefault: isDefault, prominent: prominent, buttonTitle: buttonTitle, action: action) { EmptyView() }
    }
}

/// Automation, one app at a time: macOS asks about each app Polycarp scripts the first time it's used. Only installed apps.
private struct AutomationTargetsList: View {
    @ObservedObject var model: PermissionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.targets.isEmpty {
                Text("None of the apps Polycarp scripts are installed.").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
            }
            ForEach(model.targets) { row in
                HStack(spacing: 8) {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: row.path)).resizable().frame(width: 18, height: 18)
                        .accessibilityHidden(true)
                    Text(row.target.name).font(Chrome.font(12, .medium))
                    Text(row.target.why).font(Chrome.font(11)).foregroundStyle(Chrome.muted).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(Permissions.automationWord(row.state)).font(Chrome.font(11, .medium))
                        .foregroundStyle(row.state == .granted ? Chrome.done : row.state == .unknown ? Chrome.muted : Chrome.working)
                    switch Permissions.automationAction(row.state) {
                    case .none: EmptyView()
                    case .ask: Button("Allow") { model.askAutomation(row) }.controlSize(.small)
                    case .openSettings: Button("Open") { model.askAutomation(row) }.controlSize(.small)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if model.targets.contains(where: { $0.state == .unknown }) {
                Text("An app that isn't running can't be checked. macOS asks the first time Polycarp reads it.")
                    .font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 4)
    }
}

/// The row's button in the theme: the accent with the theme's text on it for the one to do next, a quiet cell for the rest.
struct PermissionButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Chrome.font(12, .semibold))
            .foregroundStyle(prominent && isEnabled ? Chrome.onAccent : Chrome.wash(isEnabled ? 0.92 : 0.45))
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(Chrome.shape(.settingsCell, continuous: false).fill(prominent && isEnabled ? Chrome.accent : Chrome.cell(0.12)))
            .overlay(Chrome.shape(.settingsCell, continuous: false).strokeBorder(prominent ? Color.clear : Chrome.edge(0.2), lineWidth: Chrome.width(.settingsCell)))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// A small label on a row. A type, not a helper named `tag`: from another view that name is SwiftUI's own `.tag()`.
struct PermissionTag: View {
    let text: String
    var body: some View {
        Text(text).font(Chrome.font(10, .medium)).foregroundStyle(Chrome.muted)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(Chrome.cell(0.1)))
    }
}

/// Hands back the window a view is in, so the model reads only while that window is on screen.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow?) -> Void
    func makeNSView(context: Context) -> ReaderView { ReaderView(found: found) }
    func updateNSView(_ view: ReaderView, context: Context) {}

    final class ReaderView: NSView {
        let found: (NSWindow?) -> Void
        init(found: @escaping (NSWindow?) -> Void) { self.found = found; super.init(frame: .zero) }
        required init?(coder: NSCoder) { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { found(window) }
        }
    }
}

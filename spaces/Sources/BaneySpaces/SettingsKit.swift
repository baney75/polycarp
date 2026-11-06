import AppKit
import SwiftUI

/// The pieces every Settings section is built from, so the tabs look like one window: a soft rounded group, rows with the label on
/// the left and the control on the right, a hairline between rows, one line of help under a setting, and a "Learn more" for the rest.
/// Every color is a Chrome token; none is a literal. A view with no closure input keeps `appearance` so a theme change redraws it:
/// SwiftUI otherwise sees the same inputs and skips it, and `Chrome` is a plain static that tells it nothing.

extension Chrome {
    /// A palette role as a color (done, working, urgent, sunken…).
    static func role(_ name: String) -> Color { Appearance.color(look.color(name)) }
    /// Status colors come from the theme, not from the system's green and orange.
    static var done: Color { role("done") }
    static var working: Color { role("working") }
    static var urgent: Color { role("urgent") }
    /// The dock's "finished while you were away" count, and its legend in Settings.
    static var finished: Color { working }
    /// Quiet text: help lines, headers, units.
    static var muted: Color { wash(0.62) }
    /// The sidebar, one step below the pane.
    static var sunken: Color { role("sunken").opacity(look.palette.isDark ? 0.45 : 0.55) }
}

/// A titled group of rows in a soft rounded container.
struct SettingsGroup<Content: View>: View {
    var title: String?
    @ViewBuilder var content: () -> Content

    init(_ title: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title).font(Chrome.font(12, .semibold)).foregroundStyle(Chrome.muted)
                    .padding(.horizontal, 4).accessibilityAddTraits(.isHeader)
            }
            // The first row's top hairline sits one point above the container and is clipped away.
            VStack(spacing: 0) { content() }
                .padding(.top, -1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Chrome.cell(0.07))
                .clipShape(Chrome.shape(.settingsCallout, continuous: false))
                .overlay(Chrome.shape(.settingsCallout, continuous: false).strokeBorder(Chrome.edge(0.14), lineWidth: Chrome.width(.settingsCallout)))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One setting: the label (and at most one line of help) on the left, the control on the right.
struct SettingsRow<Control: View>: View {
    var label: String
    var help: String?
    @ViewBuilder var control: () -> Control

    init(_ label: String, help: String? = nil, @ViewBuilder control: @escaping () -> Control) {
        self.label = label; self.help = help; self.control = control
    }

    var body: some View {
        SettingsBlock {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(Chrome.font(13))
                    if let help {
                        Text(help).font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                control().fixedSize()
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// A full-width row for content that is not a label and a control: a legend, a list, a note.
struct SettingsBlock<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .overlay(alignment: .top) { Rectangle().fill(Chrome.edge(0.14)).frame(height: 1) }
    }
}

/// A line of quiet text in a group, such as a status or a warning.
struct SettingsNote: View {
    enum Tone { case quiet, urgent, done }
    @ObservedObject private var appearance = Appearance.shared
    var text: String
    var tone: Tone = .quiet
    init(_ text: String, tone: Tone = .quiet) { self.text = text; self.tone = tone }
    var body: some View {
        SettingsBlock {
            Text(text).font(Chrome.font(11)).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(tone == .urgent ? Chrome.urgent : tone == .done ? Chrome.done : Chrome.muted)
        }
    }
}

/// The long version of a help line, closed until asked for.
struct LearnMore: View {
    @ObservedObject private var appearance = Appearance.shared
    var text: String
    @State private var open = false
    init(_ text: String) { self.text = text }
    var body: some View {
        SettingsBlock {
            VStack(alignment: .leading, spacing: 6) {
                Button { open.toggle() } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.right").font(Chrome.font(9, .bold)).rotationEffect(.degrees(open ? 90 : 0))
                        Text("Learn more").font(Chrome.font(11, .medium))
                    }
                    .foregroundStyle(Chrome.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Learn more")
                .accessibilityValue(open ? "expanded" : "collapsed")
                if open { Text(text).font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
            }
        }
        .animation(reduceMotion ? nil : Chrome.ease(0.15), value: open)
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
}

/// An on or off status: a check and a word in the theme's done color, or a dot in its working color.
struct SettingsStatusLabel: View {
    @ObservedObject private var appearance = Appearance.shared
    var text: String
    var done = true
    var body: some View {
        Label(text, systemImage: done ? "checkmark.circle.fill" : "circle.dashed")
            .font(Chrome.font(12, .medium))
            .foregroundStyle(done ? Chrome.done : Chrome.working)
    }
}

// MARK: - The sidebar

private extension View {
    /// The sidebar draws its own ring on the selected row, so the system's goes. macOS 13 has no way to remove it.
    @ViewBuilder func settingsNoSystemFocusRing() -> some View {
        if #available(macOS 14, *) { focusEffectDisabled() } else { self }
    }
}

/// The sections in the order and groups the sidebar shows. A test pins that every `SettingsTab` is listed exactly once.
enum SettingsSidebar {
    struct Group { var header: String?; var tabs: [SettingsTab] }
    static let groups: [Group] = [
        Group(header: nil, tabs: [.general, .keys, .dock, .appearance, .launcher]),
        Group(header: "Your tools", tabs: [.voice, .browser, .agents]),
        Group(header: "System", tabs: [.automation, .updates]),
    ]
    static var order: [SettingsTab] { groups.flatMap(\.tabs) }
    static let width: CGFloat = 190
    static let windowSize = CGSize(width: 760, height: 560)
}

struct SettingsSidebarView: View {
    @ObservedObject private var appearance = Appearance.shared
    @Binding var selection: SettingsTab
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(SettingsSidebar.groups.enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: 2) {
                    if let h = group.header {
                        Text(h).font(Chrome.font(11, .semibold)).foregroundStyle(Chrome.muted)
                            .padding(.horizontal, 10).padding(.bottom, 2).accessibilityAddTraits(.isHeader)
                    }
                    ForEach(group.tabs) { tab in row(tab) }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.top, 46).padding(.bottom, 14)
        .frame(width: SettingsSidebar.width, alignment: .topLeading)
        .frame(maxHeight: .infinity)
        .background(Chrome.sunken)
        .focusable()
        .settingsNoSystemFocusRing()
        .focused($focused)
        .onMoveCommand { direction in
            let order = SettingsSidebar.order
            guard let i = order.firstIndex(of: selection) else { return }
            switch direction {
            case .up: if i > 0 { selection = order[i - 1] }
            case .down: if i < order.count - 1 { selection = order[i + 1] }
            default: break
            }
        }
    }

    private func row(_ tab: SettingsTab) -> some View {
        let on = selection == tab
        return Button { selection = tab } label: {
            HStack(spacing: 8) {
                Group {
                    // Silas's mark is its own pen, tinted like the symbols beside it.
                    if let symbol = tab.symbol { Image(systemName: symbol).font(Chrome.font(13)) }
                    else { Image(nsImage: SilasMark.templateImage(size: 15)).renderingMode(.template) }
                }
                .frame(width: 20)
                Text(tab.rawValue).font(Chrome.font(13, on ? .semibold : .regular))
                Spacer(minLength: 0)
            }
            .foregroundStyle(on ? Chrome.onAccent : Chrome.wash())
            .padding(.horizontal, 10).padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(Chrome.shape(.settingsCell, continuous: false).fill(on ? Chrome.accent : Color.clear))
            // The focus ring: the keyboard's place, drawn on the selected row while the sidebar has the keyboard.
            .overlay(Chrome.shape(.settingsCell, continuous: false).strokeBorder(Chrome.wash(0.9), lineWidth: on && focused ? 2 : 0).padding(1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.rawValue)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}

import AppKit
import BaneySpacesCore
import SwiftUI

/// Notifications by app, newest first, in the theme's panel.
struct NoticeList: View {
    static let width: CGFloat = 372
    @ObservedObject var watcher: NoticeWatcher
    @ObservedObject private var appearance = Appearance.shared
    let room: CGFloat
    var trusted = AX.isTrusted
    let close: () -> Void

    private var groups: [NoticeShelf.Group] { watcher.shelf.groups }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if groups.isEmpty { empty } else {
                ViewThatFits(in: .vertical) {
                    list
                    ScrollView { list }.scrollIndicators(.automatic)
                }
                .frame(maxHeight: max(160, room - (watcher.quiet.isEmpty ? 92 : 124)))
            }
            footer
        }
        .frame(width: Self.width)
        .background(Chrome.panelBackground(.launcherMini))
        .clipShape(Chrome.shape(.launcherMini))
        .environment(\.colorScheme, Chrome.scheme)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Notifications").font(Chrome.font(14, .semibold)).foregroundStyle(Chrome.wash())
            Spacer(minLength: 8)
            if !groups.isEmpty { BarPanelButton("Clear all") { watcher.clearAll() } }
        }
        .padding(.leading, 16).padding(.trailing, 10).padding(.top, 12).padding(.bottom, 8)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(groups) { g in
                VStack(alignment: .leading, spacing: 2) {
                    groupHeader(g)
                    ForEach(g.notices) { n in
                        NoticeRow(notice: n, icon: watcher.icon(n), open: { watcher.open(n); close() }, dismiss: { watcher.dismiss(n) })
                    }
                }
            }
        }
        .padding(.horizontal, 8).padding(.bottom, 10)
        .frame(width: Self.width, alignment: .leading)
    }

    private func groupHeader(_ g: NoticeShelf.Group) -> some View {
        let isQuiet = watcher.quiet[g.id] != nil
        return HStack(spacing: 7) {
            if let url = watcher.app(g.id, name: g.app) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 16, height: 16)
            }
            Text(g.app).font(Chrome.font(12, .semibold)).foregroundStyle(Chrome.wash(0.8)).lineLimit(1)
            Spacer(minLength: 8)
            if g.notices.allSatisfy(\.named) {
                BarPanelButton(symbol: isQuiet ? "bell.slash.fill" : "bell.slash", isQuiet ? "Show \(g.app)'s banners again" : "Keep \(g.app) quiet") {
                    watcher.setQuiet(g.id, name: g.app, !isQuiet)
                }
            }
            BarPanelButton(symbol: "xmark", "Clear \(g.app)") { watcher.clear(g) }
        }
        .padding(.leading, 8)
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(trusted ? "Nothing new" : "Polycarp needs Accessibility to list notifications")
                .font(Chrome.font(13, .medium)).foregroundStyle(Chrome.wash(0.85))
            Text(trusted ? "New banners are kept here. During a Focus macOS shows none, so look in Notification Center."
                              : "Allow it in Polycarp's Settings, under Permissions.")
                .font(Chrome.font(12)).foregroundStyle(Chrome.wash(0.75))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.top, 2).padding(.bottom, 14)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Chrome.edge(0.14).frame(height: 1)
            if !watcher.quiet.isEmpty {
                HStack(spacing: 4) {
                    Text("Quiet").font(Chrome.font(11.5)).foregroundStyle(Chrome.wash(0.72))
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 2) {
                            ForEach(watcher.quiet.sorted { $0.value < $1.value }, id: \.key) { key, name in
                                BarPanelButton(name, help: "Show \(name)'s banners again") { watcher.setQuiet(key, name: name, false) }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
            HStack(spacing: 2) {
                BarPanelButton("Notification Center") { close(); watcher.openCenter() }
                Spacer(minLength: 8)
                BarPanelButton("Settings") { close(); watcher.openSettings() }
            }
            .padding(.horizontal, 10).padding(.bottom, 8)
        }
    }
}

private struct NoticeRow: View {
    let notice: NoticeShelf.Notice
    /// The site's, for a browser's.
    let icon: NSImage?
    let open: () -> Void
    let dismiss: () -> Void
    @State private var over = false

    var body: some View {
        let b = notice.banner
        let heading = [b.title, b.subtitle, b.body].first { !$0.isEmpty } ?? b.app
        let when = notice.at.formatted(Calendar.current.isDateInToday(notice.at) ? .dateTime.hour().minute() : .dateTime.month().day().hour().minute())
        ZStack(alignment: .topTrailing) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let icon {
                            Image(nsImage: icon).resizable().interpolation(.high).frame(width: 14, height: 14)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                        }
                        if !notice.seen { Chrome.mark().fill(Chrome.accent).frame(width: 6, height: 6) }
                        Text(heading).font(Chrome.font(13, .semibold)).foregroundStyle(Chrome.wash()).lineLimit(heading == b.body ? 3 : 1).multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Text(when).font(Chrome.font(11)).foregroundStyle(Chrome.wash(0.72)).opacity(over ? 0 : 1)
                    }
                    if !b.subtitle.isEmpty, heading != b.subtitle { Text(b.subtitle).font(Chrome.font(12, .medium)).foregroundStyle(Chrome.wash(0.8)).lineLimit(1) }
                    if !b.body.isEmpty, heading != b.body {
                        Text(b.body).font(Chrome.font(12)).foregroundStyle(Chrome.wash(0.75)).lineLimit(3).multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Chrome.shape(.launcherRow).fill(Chrome.cell(over ? 0.12 : 0.06)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel([notice.seen ? "" : "New", b.app, b.title, b.subtitle, b.body, when].filter { !$0.isEmpty }.joined(separator: ", "))
            .accessibilityAction(named: "Dismiss", dismiss)
            BarPanelButton(symbol: "xmark", "Dismiss", action: dismiss).opacity(over ? 1 : 0).padding(3)
        }
        .onHover { over = $0 }
    }
}

/// A quiet text or symbol button of a bar panel, lit under the pointer.
struct BarPanelButton: View {
    let symbol: String?
    let label: String
    let help: String
    let action: () -> Void
    @State private var over = false

    init(symbol: String? = nil, _ label: String, help: String? = nil, action: @escaping () -> Void) {
        self.symbol = symbol; self.label = label; self.help = help ?? label; self.action = action
    }

    var body: some View {
        Button(action: action) {
            Group {
                if let symbol { Image(systemName: symbol).font(.system(size: 11, weight: .medium)).frame(width: 24, height: 24) } else {
                    Text(label).font(Chrome.font(12, .medium)).lineLimit(1).padding(.horizontal, 8).frame(height: 26)
                }
            }
            .foregroundStyle(Chrome.wash(over ? 1 : 0.8))
            .background(Chrome.shape(.launcherThumb).fill(over ? Chrome.cell(0.14) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

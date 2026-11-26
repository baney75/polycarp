import AppKit
import BaneySpacesCore
import SwiftUI

/// Notifications by app, newest first, in the theme's panel.
struct NoticeList: View {
    static let width: CGFloat = 372
    @ObservedObject var watcher: NoticeWatcher
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var styles = Styles.shared
    /// Every part's style, worked out once for the sheet in force (`StyleBook.notifications`).
    private var sheet: NotificationsStyles { styles.book.notifications }
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
                .frame(maxHeight: max(160, room - (watcher.quiet.isEmpty ? 92 : 124) - sheet.more))
            }
            footer
        }
        .padding(sheet.panel, else: EdgeInsets())
        .frame(width: Self.width)
        .background(Chrome.panelBackground(.launcherMini, style: sheet.panel))
        .clipShape(Styled.shape(sheet.panel, else: Chrome.radius(.launcherMini)))
        .opacity(sheet.panel.opacity ?? 1)
        .environment(\.colorScheme, Chrome.scheme)
    }

    private var header: some View {
        let c = sheet.heading
        return HStack(spacing: 8) {
            Text(c.cased("Notifications")).spaced(c).font(Styled.font(c, .ui, 14, .semibold)).foregroundStyle(c.ink(Chrome.wash())).opacity(c.opacity ?? 1)
            Spacer(minLength: 8)
            if !groups.isEmpty { BarPanelButton("Clear all", style: sheet.button) { watcher.clearAll() } }
        }
        .padding(.leading, 16).padding(.trailing, 10).padding(.top, 12).padding(.bottom, 8)
    }

    private var list: some View {
        let gap = sheet.panel.gap.map { CGFloat($0) } ?? 2
        return VStack(alignment: .leading, spacing: 12 + gap) {
            ForEach(groups) { g in
                VStack(alignment: .leading, spacing: gap) {
                    groupHeader(g)
                    ForEach(g.notices) { n in
                        NoticeRow(notice: n, icon: watcher.icon(n), open: { watcher.open(n); close() }, dismiss: { watcher.dismiss(n) })
                    }
                }
            }
        }
        .padding(.horizontal, 8).padding(.bottom, 10)
        .frame(width: Self.width - (sheet.panel.padding.map { CGFloat($0.left + $0.right) } ?? 0), alignment: .leading)
    }

    private func groupHeader(_ g: NoticeShelf.Group) -> some View {
        let isQuiet = watcher.quiet[g.id] != nil, c = sheet.section, icon = sheet.icon
        return HStack(spacing: 7) {
            if !icon.isHidden, let url = watcher.app(g.id, name: g.app) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 16, height: 16)
                    .corners(icon).opacity(icon.opacity ?? 1)
            }
            Text(c.cased(g.app)).spaced(c).font(Styled.font(c, .ui, 12, .semibold)).foregroundStyle(c.ink(Chrome.wash(0.8), dim: 0.8)).lineLimit(1)
            Spacer(minLength: 8)
            if g.notices.allSatisfy(\.named) {
                BarPanelButton(symbol: isQuiet ? "bell.slash.fill" : "bell.slash", isQuiet ? "Show \(g.app)'s banners again" : "Keep \(g.app) quiet", style: sheet.button) {
                    watcher.setQuiet(g.id, name: g.app, !isQuiet)
                }
            }
            BarPanelButton(symbol: "xmark", "Clear \(g.app)", style: sheet.button) { watcher.clear(g) }
        }
        .padding(c, else: EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 0))
        .background { StyledBack(c) }
        .opacity(c.opacity ?? 1)
    }

    private var empty: some View {
        let title = sheet.row(hover: false).title, text = sheet.row(hover: false).text
        return VStack(alignment: .leading, spacing: 4) {
            Text(title.cased(trusted ? "Nothing new" : "Polycarp needs Accessibility to list notifications")).spaced(title)
                .font(Styled.font(title, .ui, 13, .medium)).foregroundStyle(title.ink(Chrome.wash(0.85))).opacity(title.opacity ?? 1)
            Text(text.cased(trusted ? "New banners are kept here. During a Focus macOS shows none, so look in Notification Center."
                              : "Allow it in Polycarp's Settings, under Permissions.")).spaced(text)
                .font(Styled.font(text, .ui, 12)).foregroundStyle(text.ink(Chrome.wash(0.75))).opacity(text.opacity ?? 1)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.top, 2).padding(.bottom, 14)
    }

    private var footer: some View {
        let c = sheet.footer
        return VStack(alignment: .leading, spacing: 6) {
            if c.border == nil { Chrome.edge(0.14).frame(height: 1) }
            if !watcher.quiet.isEmpty {
                HStack(spacing: 4) {
                    Text(c.cased("Quiet")).spaced(c).font(Styled.font(c, .ui, 11.5)).foregroundStyle(c.ink(Chrome.wash(0.72)))
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 2) {
                            ForEach(watcher.quiet.sorted { $0.value < $1.value }, id: \.key) { key, name in
                                BarPanelButton(name, help: "Show \(name)'s banners again", style: sheet.button) { watcher.setQuiet(key, name: name, false) }
                            }
                        }
                    }
                }
                .padding(.horizontal, c.padding == nil ? 16 : 8)
            }
            HStack(spacing: 2) {
                BarPanelButton("Notification Center", style: sheet.button) { close(); watcher.openCenter() }
                Spacer(minLength: 8)
                BarPanelButton("Settings", style: sheet.button) { close(); watcher.openSettings() }
            }
            .padding(.horizontal, c.padding == nil ? 10 : 0).padding(.bottom, c.padding == nil ? 8 : 0)
        }
        .padding(c, else: EdgeInsets())
        .background { StyledBack(c) }
        .opacity(c.opacity ?? 1)
    }
}

private struct NoticeRow: View {
    let notice: NoticeShelf.Notice
    /// The site's, for a browser's.
    let icon: NSImage?
    let open: () -> Void
    let dismiss: () -> Void
    @ObservedObject private var styles = Styles.shared
    @State private var over = false

    var body: some View {
        let c = styles.book.notifications.row(hover: over)
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
                        Text(c.title.cased(heading)).spaced(c.title).font(Styled.font(c.title, .ui, 13, .semibold)).foregroundStyle(c.title.ink(Chrome.wash()))
                            .opacity(c.title.opacity ?? 1).lineLimit(heading == b.body ? 3 : 1).multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        if !c.time.isHidden {
                            Text(c.time.cased(when)).spaced(c.time).font(Styled.font(c.time, .ui, 11)).foregroundStyle(c.time.ink(Chrome.wash(0.72)))
                                .lineLimit(c.time.hasFont ? 1 : nil).opacity(over ? 0 : c.time.opacity ?? 1)
                        }
                    }
                    if !b.subtitle.isEmpty, heading != b.subtitle {
                        Text(c.text.cased(b.subtitle)).spaced(c.text).font(Styled.font(c.text, .ui, 12, .medium)).foregroundStyle(c.text.ink(Chrome.wash(0.8)))
                            .opacity(c.text.opacity ?? 1).lineLimit(1)
                    }
                    if !b.body.isEmpty, heading != b.body {
                        Text(c.text.cased(b.body)).spaced(c.text).font(Styled.font(c.text, .ui, 12)).foregroundStyle(c.text.ink(Chrome.wash(0.75)))
                            .opacity(c.text.opacity ?? 1).lineLimit(3).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(c.box, else: EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(StyledBack(c.box, .launcherRow).fill(Chrome.cell(over ? 0.12 : 0.06)).marking(over && !c.marked))
                .opacity(c.box.opacity ?? 1)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel([notice.seen ? "" : "New", b.app, b.title, b.subtitle, b.body, when].filter { !$0.isEmpty }.joined(separator: ", "))
            .accessibilityAction(named: "Dismiss", dismiss)
            BarPanelButton(symbol: "xmark", "Dismiss", style: styles.book.notifications.button, action: dismiss).opacity(over ? 1 : 0).padding(3)
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
    /// Its look in style.css, at rest and under the pointer (`notifications .button`); nil draws the theme's alone.
    let style: ((Bool) -> ComputedStyle)?
    @ObservedObject private var styles = Styles.shared
    @State private var over = false

    init(symbol: String? = nil, _ label: String, help: String? = nil, style: ((Bool) -> ComputedStyle)? = nil, action: @escaping () -> Void) {
        self.symbol = symbol; self.label = label; self.help = help ?? label; self.style = style; self.action = action
    }

    var body: some View {
        let c = style?(over) ?? .empty, plain = style?(false) ?? .empty
        Button(action: action) {
            Group {
                if let symbol { Image(systemName: symbol).font(.system(size: 11, weight: .medium)).frame(width: 24, height: 24) } else {
                    Text(c.cased(label)).spaced(c).font(Styled.font(c, .ui, 12, .medium)).lineLimit(1).padding(.horizontal, 8)
                        .frame(height: c.fontSize == nil ? 26 : nil).frame(minHeight: 26)
                }
            }
            .foregroundStyle(c.ink(Chrome.wash(over ? 1 : 0.8)))
            .background(StyledBack(c, .launcherThumb).fill(over ? Chrome.cell(0.14) : .clear).marking(over && !c.marks(over: plain)))
            .opacity(c.opacity ?? 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

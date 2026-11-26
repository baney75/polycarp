import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings › Default apps: each job, the app that does it and who decided. A row is the same height before and
/// after its answer comes, so nothing moves.
struct DefaultAppsPane: View {
    @ObservedObject private var store = DefaultAppsStore.shared
    @ObservedObject private var appearance = Appearance.shared
    @State private var problem: [AppRole: String] = [:]

    var body: some View {
        ForEach(DefaultAppsText.groups, id: \.title) { group in
            SettingsGroup(group.title) {
                ForEach(group.roles, id: \.self) { role in
                    row(role)
                    if let p = problem[role] { SettingsNote(p, tone: .urgent) }
                }
            }
        }
        SettingsGroup {
            ForEach(store.now.warnings, id: \.self) { SettingsNote($0, tone: .urgent) }
            LearnMore("A choice here is what Polycarp's keys, launcher and commands use. Choices are lines under [defaults] in \(Self.file), and editing the file works as well. An app you remove keeps its place until it is back.")
        }
        .onAppear { store.showIcons() }
        // macOS's own defaults change in System Settings, without a word.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in store.refresh() }
    }

    private static let terminal = NSImage(systemSymbolName: "terminal", accessibilityDescription: nil)
    private static let file = (DefaultAppsFile.path() as NSString).abbreviatingWithTildeInPath

    // MARK: A row

    private enum Pick: Hashable { case automatic, app(DefaultApp), other }

    private func row(_ role: AppRole) -> some View {
        let r = store.now.resolved[role]
        return SettingsBlock {
            HStack(spacing: 12) {
                icon(r?.app, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(role.title).font(Chrome.font(13))
                    Text(r.map { DefaultAppsText.line($0, system: store.now.system[role]) } ?? " ")
                        .font(Chrome.font(11.5)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                picker(role, r)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(role.title)
    }

    private func picker(_ role: AppRole, _ r: ResolvedDefault?) -> some View {
        let on = picked(r)
        return LazyPopUp(label: role.title, shown: item(role, r, on)) {
            let first = [item(role, r, .automatic), nil], last = [nil, item(role, r, .other)]
            let apps: [LazyPopUp.Item?] = (r?.candidates ?? []).map { item(role, r, .app($0.app)) }
            let gone: [LazyPopUp.Item?] = r?.gone.map { [item(role, r, .app($0))] } ?? []
            return first + apps + gone + last
        }
        .frame(width: 215)
    }

    /// One line of a job's list, as a menu shows it.
    private func item(_ role: AppRole, _ r: ResolvedDefault?, _ p: Pick) -> LazyPopUp.Item {
        func line(_ title: String, _ c: DefaultCandidate?) -> LazyPopUp.Item {
            let image = c.flatMap { store.icons[$0.app] ?? Self.terminal }
            return LazyPopUp.Item(title: title, image: image, on: p == picked(r)) { pick(role, r, p) }
        }
        switch p {
        case .automatic:
            let system = store.now.system[role]
            return line(DefaultAppsText.automatic(role, r, system: system), system ?? (r?.source == .you ? nil : r?.app))
        case .other: return line("Other app…", nil)
        case .app(let app):
            guard let c = r?.candidates.first(where: { $0.app == app }) else {
                return line("\(DefaultAppCatalog.name(app, for: role)) (not installed)", nil)
            }
            return line(DefaultAppsText.item(c), c)
        }
    }

    private func picked(_ r: ResolvedDefault?) -> Pick {
        guard let r else { return .automatic }
        if let gone = r.gone { return .app(gone) }
        return r.source == .you ? r.app.map { .app($0.app) } ?? .automatic : .automatic
    }

    /// A program wears a terminal, and a job nobody does a dashed square, the same size as an app's icon.
    @ViewBuilder private func icon(_ c: DefaultCandidate?, size: CGFloat) -> some View {
        if let c, let image = store.icons[c.app] {
            Image(nsImage: image).resizable().frame(width: size, height: size).accessibilityHidden(true)
        } else {
            Image(systemName: c == nil ? "questionmark.app.dashed" : "terminal")
                .font(Chrome.font(size * 0.62)).foregroundStyle(Chrome.muted)
                .frame(width: size, height: size).accessibilityHidden(true)
        }
    }

    // MARK: Choosing

    private func pick(_ role: AppRole, _ r: ResolvedDefault?, _ p: Pick) {
        switch p {
        case .automatic: choose(role, nil)
        case .other: other(role)
        case .app(let app):
            guard let c = r?.candidates.first(where: { $0.app == app }) else { return }
            take(role, c.app, c.name)
        }
    }

    private func take(_ role: AppRole, _ app: DefaultApp, _ name: String) {
        choose(role, app)
    }

    private func choose(_ role: AppRole, _ app: DefaultApp?) {
        store.choose(role, app) { problem[role] = $0.map { "Not saved: \($0)" } }
    }

    /// Any app on the disk.
    private func other(_ role: AppRole) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.prompt = "Choose"
        panel.message = "Choose an app for \(role.title.lowercased())."
        panel.begin { answer in
            guard answer == .OK, let url = panel.url else { return }
            guard let id = Bundle(url: url)?.bundleIdentifier, let app = DefaultApp(id: id, role: role) else {
                problem[role] = "\(url.lastPathComponent) can't be chosen: it has no bundle identifier."
                return
            }
            take(role, app, LaunchServicesApps.name(url))
        }
    }
}

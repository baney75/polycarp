import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings › Default apps: each job, the app that does it and who decided. A row is the same height before and
/// after its answer comes, so nothing moves.
struct DefaultAppsPane: View {
    @ObservedObject private var store = DefaultAppsStore.shared
    @ObservedObject private var appearance = Appearance.shared
    /// Picked, and waiting for "here, or everywhere?".
    @State private var asking: (role: AppRole, app: DefaultApp, name: String)?
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
            LearnMore("A choice here is what Polycarp’s keys, launcher and commands use. Picking a browser or a mail app asks whether other apps should use it too; macOS asks you again before it changes that. Choices are lines under [defaults] in \(Self.file), and editing the file works as well. An app you remove keeps its place until it is back.")
        }
        .onAppear { store.showIcons() }
        // macOS's own defaults change in System Settings, without a word.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in store.refresh() }
        .confirmationDialog(question, isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })) {
            if let a = asking {
                Button("Everywhere on This Mac") { everywhere(a.role, a.app) }
                Button("Polycarp Only") { choose(a.role, a.app) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Everywhere changes macOS’s own default, for links in every app. macOS asks you too before it does.")
        }
    }

    private static let file = (DefaultAppsFile.path() as NSString).abbreviatingWithTildeInPath

    private var question: String {
        guard let a = asking else { return "" }
        return a.role == .browser ? "Use \(a.name) as the browser everywhere?" : "Use \(a.name) for mail everywhere?"
    }

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
        Picker(role.title, selection: Binding(get: { picked(r) }, set: { pick(role, r, $0) })) {
            Text(DefaultAppsText.automatic(role, r, system: store.now.system[role])).tag(Pick.automatic)
            Divider()
            ForEach(r?.candidates ?? [], id: \.app.id) { c in
                Label { Text(DefaultAppsText.item(c)) } icon: { icon(c, size: 16) }.tag(Pick.app(c.app))
            }
            if let gone = r?.gone {
                Text("\(DefaultAppCatalog.name(gone, for: role)) (not installed)").tag(Pick.app(gone))
            }
            Divider()
            Text("Other app…").tag(Pick.other)
        }
        .labelsHidden()
        .frame(width: 190)
        .accessibilityLabel(role.title)
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
        if DefaultAppsText.asksWhere(role, app, system: store.now.system[role]) { asking = (role, app, name) } else { choose(role, app) }
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
                problem[role] = "\(url.lastPathComponent) can’t be chosen: it has no bundle identifier."
                return
            }
            take(role, app, LaunchServicesApps.name(url))
        }
    }

    /// macOS first: when the person says no to it, the old choice stays, here too.
    private func everywhere(_ role: AppRole, _ app: DefaultApp) {
        guard case .app(let bundle) = app else { return }
        SystemDefault.set(role, to: bundle) { refused in
            if let refused {
                problem[role] = "Nothing changed. \(refused)"
                store.refresh()
            } else {
                choose(role, app)
            }
        }
    }
}

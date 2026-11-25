import AppKit
import BaneySpacesCore
import SwiftUI

/// The `agents` module: how many agents need you, over the accent, and how many are at work, a step quieter.
struct AgentsFace: View {
    let agents: BarAgents
    let style: ComputedStyle

    var body: some View {
        HStack(spacing: 9) {
            if agents.needYou > 0 {
                HStack(spacing: 5) {
                    Chrome.mark().fill(Chrome.accent).frame(width: 7, height: 7)
                    BarWords.text("\(agents.needYou)", style, .semibold).monospacedDigit().foregroundStyle(style.ink(Chrome.wash()))
                }
            }
            if agents.working > 0 || agents.needYou == 0 {
                HStack(spacing: 5) {
                    Image(systemName: "circle.dotted").font(.system(size: 11.5, weight: .semibold))
                    BarWords.text("\(agents.working)", style).monospacedDigit()
                }
                .foregroundStyle(style.ink(Chrome.wash(0.72)))
            }
        }
    }
}

/// The list the `agents` module opens: the agents that need you, then the ones at work. Choose one to go to it.
struct AgentsList: View {
    static let width: CGFloat = 340
    @ObservedObject var model: TopBarModel
    @ObservedObject private var appearance = Appearance.shared
    let room: CGFloat
    let open: (String) -> Void
    let close: () -> Void

    var body: some View {
        let rows = model.agents.rows
        VStack(alignment: .leading, spacing: 0) {
            Text("Agents").font(Chrome.font(14, .semibold)).foregroundStyle(Chrome.wash())
                .padding(.leading, 16).padding(.top, 14).padding(.bottom, 10)
            if rows.isEmpty {
                Text("None working").font(Chrome.font(13)).foregroundStyle(Chrome.wash(0.75)).padding(.horizontal, 16).padding(.bottom, 16)
            } else {
                ViewThatFits(in: .vertical) {
                    list(rows)
                    ScrollView { list(rows) }.scrollIndicators(.automatic)
                }
                .frame(maxHeight: max(160, room - 48))
            }
        }
        .frame(width: Self.width, alignment: .leading)
        .background(Chrome.panelBackground(.launcherMini))
        .clipShape(Chrome.shape(.launcherMini))
        .environment(\.colorScheme, Chrome.scheme)
    }

    private func list(_ rows: [BarAgents.Row]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            section("Needs you", rows.filter(\.needsYou))
            section("Working", rows.filter { !$0.needsYou })
        }
        .padding(.horizontal, 8).padding(.bottom, 10)
        .frame(width: Self.width, alignment: .leading)
    }

    @ViewBuilder private func section(_ title: String, _ rows: [BarAgents.Row]) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Chrome.font(11.5, .medium)).foregroundStyle(Chrome.muted).padding(.leading, 8)
                ForEach(rows) { r in AgentRow(row: r) { close(); open(r.id) } }
            }
        }
    }
}

private struct AgentRow: View {
    let row: BarAgents.Row
    let go: () -> Void
    @State private var over = false

    var body: some View {
        Button(action: go) {
            HStack(spacing: 10) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: SessionController.appPath(row.bundleID))).resizable().frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.title).font(Chrome.font(13, .medium)).foregroundStyle(Chrome.wash()).lineLimit(1)
                    Text(row.detail).font(Chrome.font(11.5)).foregroundStyle(Chrome.wash(0.72)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                if row.workspace > 0 {
                    Text("\(row.workspace)").font(Chrome.font(11, .medium)).monospacedDigit().foregroundStyle(Chrome.wash(0.75))
                        .frame(minWidth: 20, minHeight: 20).background(Chrome.shape(.launcherKey).fill(Chrome.cell(0.12)))
                }
                if row.needsYou { Chrome.mark().fill(Chrome.accent).frame(width: 7, height: 7) }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Chrome.shape(.launcherRow).fill(Chrome.cell(over ? 0.12 : 0.06)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over = $0 }
        .accessibilityLabel([row.needsYou ? "Needs you" : "Working", row.title, row.detail, row.workspace > 0 ? "workspace \(row.workspace)" : ""]
            .filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

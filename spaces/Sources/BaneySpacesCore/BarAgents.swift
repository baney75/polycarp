import Foundation

/// The coding agents the bar's `agents` module counts: the ones that finished or ask something you haven't seen, and the
/// ones at work.
public struct BarAgents: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        /// What it asks, or its app and folder.
        public let detail: String
        public let bundleID: String
        /// The workspace it is on when that isn't this one, or 0.
        public let workspace: Int
        public let needsYou: Bool
    }

    /// The ones that need you, in the order they asked, then the ones at work.
    public let rows: [Row]

    public init(items: [Item] = [], unseen: [String] = []) {
        let asked = unseen.compactMap { id in items.first { $0.id == id } }
        let working = items.filter { $0.activity == .working && !unseen.contains($0.id) }
        rows = asked.map { Row($0, needsYou: true) } + working.map { Row($0, needsYou: false) }
    }

    public var needYou: Int { rows.filter(\.needsYou).count }
    public var working: Int { rows.count - needYou }

    /// "2 agents need you, 1 working", for the button and VoiceOver.
    public var label: String {
        let asks = needYou == 0 ? nil : needYou == 1 ? "1 agent needs you" : "\(needYou) agents need you"
        let works = working == 0 ? nil : asks != nil ? "\(working) working" : working == 1 ? "1 agent working" : "\(working) agents working"
        let all = [asks, works].compactMap { $0 }
        return all.isEmpty ? "No agents working" : all.joined(separator: ", ")
    }
}

extension BarAgents.Row {
    init(_ item: Item, needsYou: Bool) {
        let place = [item.appName, item.detail].filter { !$0.isEmpty }.joined(separator: " · ")
        self.init(id: item.id, title: item.label, detail: needsYou && !item.notice.isEmpty ? item.notice : place,
                  bundleID: item.bundleID, workspace: item.workspace, needsYou: needsYou)
    }
}

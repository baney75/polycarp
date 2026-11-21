import Foundation

/// What the morning sheet and the evening examen show, worked out apart from drawing so tests can pin it.
public enum RhythmSheets {
    /// The morning sheet's words. The Kierkegaard lines are translated from the Danish (Søren Kierkegaards Skrifter,
    /// public domain): Purity of Heart (SKS 8:221) and For Self-Examination (SKS 13:53).
    public static let morningTitle = "What is this day for?"
    public static let morningLine = "Purity of heart is to will one thing. (Kierkegaard)"
    public static let examenTitle = "Evening examen"
    public static let examenLine = "Not looking at the mirror, but seeing yourself in it. (Kierkegaard)"
    public static let tomorrowQuestion = "Tomorrow's one thing"

    /// The most workspaces the morning sheet lists, so it stays one card.
    public static let mostRows = 6

    /// The workspaces the morning sheet asks about: every one with windows or a purpose and the one you are on, in
    /// number order, at most `mostRows` (the current one is always kept).
    public static func morningRows(inUse: Set<Int>, named: [Int: String], current: Int) -> [Int] {
        let all = inUse.union(named.keys).union([current]).filter { Workspaces.range.contains($0) }.sorted()
        guard all.count > mostRows else { return all }
        var keep = Array(all.prefix(mostRows))
        if !keep.contains(current) { keep[mostRows - 1] = current }
        return keep.sorted()
    }

    /// One line of the examen's record of the day: a workspace, its name, its time and its share of the longest.
    public struct TimeRow: Equatable, Sendable {
        public let workspace: Int
        public let label: String
        public let time: String
        public let share: Double
    }

    /// Where the day went, longest first: workspaces with at least a minute, at most five, each named by its purpose.
    public static func timeRows(seconds: [Int: Int], named: [Int: String]) -> [TimeRow] {
        let kept = seconds.filter { $0.value >= 60 }.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(5)
        guard let most = kept.first?.value else { return [] }
        return kept.map { n, s in
            TimeRow(workspace: n, label: named[n].flatMap { $0.isEmpty ? nil : $0 } ?? "Workspace \(n)",
                    time: Journal.duration(s), share: Double(s) / Double(most))
        }
    }

    /// The examen as the journal keeps it: every question in order (a blank one reads "No answer" there), and tomorrow's
    /// one thing last when one was named.
    public static func answers(_ texts: [String], tomorrow: String, questions: [String] = Rhythm.examenQuestions) -> [Journal.Answer] {
        var out = zip(questions, texts).map { Journal.Answer(question: $0, text: $1.trimmingCharacters(in: .whitespacesAndNewlines)) }
        let next = tomorrow.trimmingCharacters(in: .whitespacesAndNewlines)
        if !next.isEmpty { out.append(Journal.Answer(question: tomorrowQuestion, text: next)) }
        return out
    }
}

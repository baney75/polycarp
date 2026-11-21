import Foundation

/// The evening examen's answers, one Markdown file per day in the support folder's Journal folder
/// (`Journal/2026-11-21.md`). Local only: nothing here is sent anywhere, and the support folder is not a synced one.
/// The day's time on each workspace goes at the end as a short table.
public enum Journal {
    public static let folderName = "Journal"

    public struct Answer: Equatable, Sendable {
        public var question: String
        public var text: String
        public init(question: String, text: String) { self.question = question; self.text = text }
    }

    public static func folder(in support: URL) -> URL { support.appendingPathComponent(folderName, isDirectory: true) }

    public static func url(for day: PurposeDay, in support: URL) -> URL {
        folder(in: support).appendingPathComponent("\(day).md")
    }

    /// The page for `day`. `seconds` is the ledger's day (`DayLedger.seconds(on:)`), `purposes` each workspace's purpose.
    public static func markdown(day: PurposeDay, answers: [Answer], oneThing: String?, seconds: [Int: Int],
                                purposes: [Int: String], clock: DayClock) -> String {
        var lines = ["# Examen, \(weekdayName(clock.weekday(of: day))) \(day)", ""]
        if let one = oneThing.flatMap({ Purposes.clean($0, limit: Purposes.oneThingLimit) }) {
            lines += ["The one thing: \(one)", ""]
        }
        for a in answers {
            lines += ["## \(Purposes.clean(a.question, limit: 200) ?? "Question")", ""]
            let text = a.text.trimmingCharacters(in: .whitespacesAndNewlines)
            lines += [text.isEmpty ? "_No answer._" : text, ""]
        }
        lines += ["## The day", ""]
        let worked = seconds.filter { $0.value > 0 }.sorted { $0.key < $1.key }
        if worked.isEmpty {
            lines += ["No time recorded.", ""]
        } else {
            lines += ["| Workspace | Purpose | Time |", "| --- | --- | --- |"]
            for (n, s) in worked { lines.append("| \(n) | \(cell(purposes[n] ?? "")) | \(duration(s)) |") }
            lines += ["| Total | | \(duration(worked.map(\.value).reduce(0, +))) |", ""]
        }
        return lines.joined(separator: "\n")
    }

    /// Writes the page for `day` in one step, replacing an earlier one from the same day (the examen is kept once a day;
    /// keeping it again rewrites the page with the newer answers). Disk work: call it off the main thread.
    @discardableResult
    public static func save(day: PurposeDay, answers: [Answer], oneThing: String?, seconds: [Int: Int], purposes: [Int: String],
                            clock: DayClock, support: URL) throws -> URL {
        let url = url(for: day, in: support)
        let text = markdown(day: day, answers: answers, oneThing: oneThing, seconds: seconds, purposes: purposes, clock: clock)
        try PurposeFile.write(Data(text.utf8), to: url)
        return url
    }

    /// "2 h 05 min", "12 min", "under a minute".
    public static func duration(_ seconds: Int) -> String {
        let minutes = seconds / 60
        if minutes == 0 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        return String(format: "%d h %02d min", minutes / 60, minutes % 60)
    }

    /// A table cell: a pipe would end the cell early.
    static func cell(_ text: String) -> String { text.replacingOccurrences(of: "|", with: "\\|") }

    static func weekdayName(_ weekday: Int) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return names.indices.contains(weekday - 1) ? names[weekday - 1] : ""
    }
}

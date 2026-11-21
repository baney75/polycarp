import Foundation

/// One day as the purpose layer counts it: from 4 am local to 4 am the next morning, so a late night still belongs to
/// the day it started in. Written as "2026-11-21" in every file, which also sorts in date order.
public struct PurposeDay: Hashable, Comparable, Codable, Sendable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) { self.year = year; self.month = month; self.day = day }

    /// "2026-11-21", or nil for anything else.
    public init?(_ text: String) {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, text.count == 10, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else { return nil }
        self.init(year: parts[0], month: parts[1], day: parts[2])
    }

    public var description: String { String(format: "%04d-%02d-%02d", year, month, day) }

    public static func < (a: PurposeDay, b: PurposeDay) -> Bool { (a.year, a.month, a.day) < (b.year, b.month, b.day) }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let day = PurposeDay(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a day: \(text)"))
        }
        self = day
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(description)
    }
}

/// Turns instants into purpose days and back, in one time zone. Always the Gregorian calendar, whatever calendar the
/// Mac is set to, so a day written today reads back the same next year.
public struct DayClock: Sendable {
    /// The hour a new day starts. Before it, the night still belongs to yesterday.
    public static let startHour = 4

    public let timeZone: TimeZone
    public let calendar: Calendar

    public init(timeZone: TimeZone = .autoupdatingCurrent) {
        self.timeZone = timeZone
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        calendar = c
    }

    /// The day `date` falls in: its local date, or the one before when it is earlier than 4 am.
    public func day(of date: Date) -> PurposeDay {
        let c = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        let local = PurposeDay(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
        return (c.hour ?? 0) < Self.startHour ? adding(-1, to: local) : local
    }

    /// When `day` starts: 4 am local on its date. DST changes at 2 am in the places that have them, so 4 am exists on
    /// every date; were it skipped, the calendar moves it to the next hour that does.
    public func start(of day: PurposeDay) -> Date { time(on: day, hour: Self.startHour) }

    /// When `day` ends, which is when the next one starts. A DST day is 23 or 25 hours long.
    public func end(of day: PurposeDay) -> Date { start(of: adding(1, to: day)) }

    /// `hour`:00 local on `day`'s own date. Hours before 4 am still land on that date, which is the night before `day` ends.
    public func time(on day: PurposeDay, hour: Int) -> Date {
        let c = DateComponents(year: day.year, month: day.month, day: day.day, hour: hour)
        return calendar.date(from: c) ?? Date(timeIntervalSince1970: 0)
    }

    /// The day `n` days after `day` (before, when `n` is negative).
    public func adding(_ n: Int, to day: PurposeDay) -> PurposeDay {
        // Noon is never skipped or doubled by DST, so the arithmetic lands on the right date.
        let noon = calendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 12)) ?? Date()
        let moved = calendar.date(byAdding: .day, value: n, to: noon) ?? noon
        let c = calendar.dateComponents([.year, .month, .day], from: moved)
        return PurposeDay(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
    }

    /// 1 is Sunday, 7 is Saturday.
    public func weekday(of day: PurposeDay) -> Int { calendar.component(.weekday, from: time(on: day, hour: 12)) }
}

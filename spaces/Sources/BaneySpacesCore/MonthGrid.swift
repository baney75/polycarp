import Foundation

/// The days the bar's calendar draws for a month: six weeks, so the panel keeps its height from month to month.
public struct MonthGrid: Equatable, Sendable {
    public struct Day: Equatable, Sendable, Identifiable {
        public let date: Date
        public let number: Int
        /// In the month itself, not the end of the one before or the start of the next.
        public let inMonth: Bool
        public let isToday: Bool
        public let isWeekend: Bool
        public var id: Date { date }
    }

    /// The month's first day.
    public let month: Date
    public let days: [Day]
    /// The short weekday names, from the calendar's first day of the week.
    public let weekdays: [String]

    public init(of date: Date, today: Date, calendar: Calendar = .current) {
        let first = calendar.dateInterval(of: .month, for: date)?.start ?? calendar.startOfDay(for: date)
        let before = (calendar.component(.weekday, from: first) - calendar.firstWeekday + 7) % 7
        month = first
        // Noon, so a day that starts at 1 AM (a clock change at midnight) is still its own.
        let noon = calendar.date(byAdding: .hour, value: 12, to: first) ?? first
        days = (0 ..< 42).compactMap { i in
            guard let day = calendar.date(byAdding: .day, value: i - before, to: noon) else { return nil }
            return Day(date: day, number: calendar.component(.day, from: day),
                       inMonth: calendar.isDate(day, equalTo: first, toGranularity: .month),
                       isToday: calendar.isDate(day, inSameDayAs: today), isWeekend: calendar.isDateInWeekend(day))
        }
        let names = calendar.veryShortStandaloneWeekdaySymbols
        weekdays = names.indices.map { names[($0 + calendar.firstWeekday - 1) % names.count] }
    }

    /// The month `by` months on from this one.
    public func month(by months: Int, calendar: Calendar = .current) -> Date {
        calendar.date(byAdding: .month, value: months, to: month) ?? month
    }
}

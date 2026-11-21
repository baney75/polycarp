import Foundation
@testable import BaneySpacesCore

/// Clocks and folders for the purpose layer's tests. Chicago has DST (2026: March 8 and November 1, both at 2 am).
enum PurposeFixture {
    static let chicago = DayClock(timeZone: TimeZone(identifier: "America/Chicago")!)
    static let tokyo = DayClock(timeZone: TimeZone(identifier: "Asia/Tokyo")!)

    /// A local time in `clock`'s zone. `first` picks the earlier of a doubled hour (DST's end), else the later.
    static func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0, _ clock: DayClock = chicago, first: Bool = true) -> Date {
        var c = clock.calendar
        c.timeZone = clock.timeZone
        let comps = DateComponents(year: y, month: m, day: d, hour: h, minute: min)
        let found = c.nextDate(after: Date(timeIntervalSince1970: 0), matching: comps, matchingPolicy: .strict,
                               repeatedTimePolicy: first ? .first : .last, direction: .forward)
        return found ?? c.date(from: comps)!
    }

    static func day(_ text: String) -> PurposeDay { PurposeDay(text)! }

    static func folder() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("purpose-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A clock the test moves by hand.
    final class Now: @unchecked Sendable {
        var date: Date
        init(_ date: Date) { self.date = date }
    }
}

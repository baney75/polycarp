import Foundation

/// The words the top bar shows, worked out apart from drawing so they can be pinned by tests.
public enum BarText {
    /// The hour of prayer for a clock hour: Vigils through the night, Lauds at dawn, then Terce, Sext, None, Vespers
    /// and Compline.
    public static func prayerHour(_ hour: Int) -> String {
        switch hour {
        case 0..<5: "Vigils"
        case 5..<9: "Lauds"
        case 9..<12: "Terce"
        case 12..<15: "Sext"
        case 15..<18: "None"
        case 18..<21: "Vespers"
        default: "Compline"
        }
    }

    /// The part of the day in plain words.
    public static func partOfDay(_ hour: Int) -> String {
        switch hour {
        case 5..<12: "morning"
        case 12..<17: "afternoon"
        case 17..<21: "evening"
        default: "night"
        }
    }

    /// The day and the hour in words: "Saturday, Terce", or with `names` off "Saturday morning". Sunday is the Lord's
    /// Day either way.
    public static func hour(_ date: Date, calendar: Calendar = .current, names: Bool) -> String {
        let h = calendar.component(.hour, from: date)
        let weekday = calendar.component(.weekday, from: date)
        let sunday = weekday == 1
        let day = sunday ? "The Lord's Day" : calendar.weekdaySymbols[weekday - 1]
        if names { return "\(day), \(prayerHour(h))" }
        return sunday ? "The Lord's Day, \(partOfDay(h))" : "\(day) \(partOfDay(h))"
    }

    /// "3:05" or "15:05": no AM or PM; the hour module says what part of the day it is.
    public static func clock(_ date: Date, calendar: Calendar = .current, format: Surfaces.ClockFormat) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        let h = c.hour ?? 0, m = c.minute ?? 0
        let shown = format == .twentyFourHour ? h : (h % 12 == 0 ? 12 : h % 12)
        return String(format: "%d:%02d", shown, m)
    }

    /// "November 21".
    public static func date(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.month, .day], from: date)
        return "\(calendar.monthSymbols[(c.month ?? 1) - 1]) \(c.day ?? 1)"
    }

    /// The next whole minute, when the clock and the hour next change.
    public static func nextMinute(after date: Date, calendar: Calendar = .current) -> Date {
        calendar.nextDate(after: date, matching: DateComponents(second: 0), matchingPolicy: .nextTime) ?? date.addingTimeInterval(60)
    }

    /// The battery as the bar shows it: nothing without a battery, and nothing while it is charged and on power, so a
    /// healthy machine shows no meter.
    public static func battery(percent: Int?, charging: Bool, onPower: Bool) -> String? {
        guard let percent else { return nil }
        if onPower && !charging && percent >= 95 { return nil }
        return charging ? "\(percent)% charging" : "\(percent)%"
    }
}

/// Where the top bar puts its modules.
public enum BarLayout {
    /// The three places on a screen. A screen with a notch has no middle: the middle's modules follow the left's,
    /// before the camera housing.
    public static func places(_ bar: Surfaces.Bar, notch: Bool) -> (left: [Surfaces.BarModule], center: [Surfaces.BarModule], right: [Surfaces.BarModule]) {
        notch ? (bar.left + bar.center, [], bar.right) : (bar.left, bar.center, bar.right)
    }

    /// The modules the bar draws today. App menus, status icons and custom modules are kept in the file but not drawn:
    /// macOS 27 lets no app mirror the status icons, and app menus still come down from the top edge.
    public static func drawn(_ m: Surfaces.BarModule) -> Bool {
        switch m {
        case .appMenus, .status, .custom: false
        default: true
        }
    }

    /// The workspace dots: every workspace with windows, and the one you're on, in number order.
    public static func dots(occupied: Set<Int>, current: Int) -> [Int] {
        Array(occupied.union([current])).filter { Workspaces.range.contains($0) }.sorted()
    }

    /// Whether the system menu bar stays in view on a screen, where it would cover Polycarp's bar. Without a notch, a
    /// shown bar takes the top of the visible frame away and an auto-hidden one leaves it whole. With a notch the strip
    /// is kept either way, so the setting (`_HIHideMenuBar`) decides.
    public static func systemBarShown(frameMaxY: Double, visibleMaxY: Double, notch: Bool, hideMenuBar: Bool) -> Bool {
        if hideMenuBar { return false }
        return notch || frameMaxY - visibleMaxY > 1
    }
}

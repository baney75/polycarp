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

    /// "3:05" or "15:05": no AM or PM, since the hour module says what part of the day it is. With the day, as Omarchy's
    /// bar has it: "Saturday 10:04 PM" or "Saturday 22:04", the 12 hour form with AM or PM since it stands alone.
    public static func clock(_ date: Date, calendar: Calendar = .current, format: Surfaces.ClockFormat) -> String {
        let c = calendar.dateComponents([.hour, .minute, .weekday], from: date)
        let h = c.hour ?? 0, m = c.minute ?? 0
        let shown = format.twentyFour ? h : (h % 12 == 0 ? 12 : h % 12)
        let time = String(format: "%d:%02d", shown, m)
        guard format.withDay else { return time }
        let day = calendar.weekdaySymbols[(c.weekday ?? 1) - 1]
        if format.twentyFour { return "\(day) \(time)" }
        return "\(day) \(time) \(h < 12 ? calendar.amSymbol : calendar.pmSymbol)"
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

    /// The battery as the bar shows it: only off power or while charging. On power and not charging shows nothing,
    /// whatever the charge, so a Mac held at a charge limit (80%, say) shows no meter all day.
    public static func battery(percent: Int?, charging: Bool, onPower: Bool) -> String? {
        guard let percent else { return nil }
        if onPower && !charging { return nil }
        return charging ? "\(percent)% charging" : "\(percent)%"
    }
}

/// Where the top bar puts its modules. A screen with a notch has no middle: the middle's modules sit beside the camera
/// housing, on its right, where the left's menus can't run into them (`BarSides`).
public enum BarLayout {
    /// The modules the bar draws today. Custom modules are kept in the file but not drawn; the island split is a place,
    /// not a module.
    public static func drawn(_ m: Surfaces.BarModule) -> Bool {
        switch m {
        case .custom, .split: false
        default: true
        }
    }

    /// A place's modules as islands, split at each `|`, without the modules not drawn and the islands left empty.
    public static func islands(_ modules: [Surfaces.BarModule]) -> [[Surfaces.BarModule]] {
        modules.split(separator: .split, omittingEmptySubsequences: false)
            .map { $0.filter(drawn) }
            .filter { !$0.isEmpty }
    }

    /// How many of a row's items fit in `room`, from the first: a title is left out whole, never cut.
    public static func fit(_ widths: [Double], spacing: Double, room: Double) -> Int {
        var used = 0.0
        for (i, w) in widths.enumerated() {
            used += (i == 0 ? 0 : spacing) + w
            if used > room + 0.5 { return i }
        }
        return widths.count
    }

    /// The bar's window level, from the normal window level: one under it, so any window covers the bar (review of
    /// #587: over windows, the bar hid the traffic lights of a window zoomed to the top of the screen).
    public static let levelBelowWindows = -1

    /// The middle place's share of a screen without a notch; the left and right share the rest.
    public static let middleShare = 0.44

    /// Whether the system menu bar stays in view on a screen, where it would cover Polycarp's bar. Without a notch, a
    /// shown bar takes the top of the visible frame away and an auto-hidden one leaves it whole. With a notch the strip
    /// is kept either way, so the setting (`_HIHideMenuBar`) decides.
    public static func systemBarShown(frameMaxY: Double, visibleMaxY: Double, notch: Bool, hideMenuBar: Bool) -> Bool {
        if hideMenuBar { return false }
        return notch || frameMaxY - visibleMaxY > 1
    }
}

/// What the `workspaces` module draws: a number for each workspace, as Omarchy's bar has them.
public enum BarWorkspaces {
    /// How the workspace you're on stands out from the others, which are drawn muted.
    public enum Marker: Equatable, Sendable {
        /// Full foreground over a short accent line.
        case underline
        /// The number on an accent block.
        case block
    }

    /// Every workspace with windows, and the one you're on, in number order.
    public static func shown(occupied: Set<Int>, current: Int) -> [Int] {
        Array(occupied.union([current])).filter { Workspaces.range.contains($0) }.sorted()
    }

    /// The marker for a theme's indicator: the block for a theme that draws its numbers in blocks (`number-block`,
    /// Omarchy's), the underline for every other, so the built-in look is the underline.
    public static func marker(_ indicator: ThemeIndicator) -> Marker {
        indicator == .numberBlock ? .block : .underline
    }
}

/// What the `app-menus` module draws: the front app's menu bar as Accessibility reads it (`AXMenuBar`), worked out apart
/// from the reading. Clicking a title presses that menu, which macOS opens as it would from its own bar.
public enum BarMenus {
    public enum Role: Equatable, Sendable {
        /// The Apple menu, drawn as the logo.
        case apple
        /// The app's own menu, in its name, drawn in bold.
        case app
        case menu
    }

    public struct Item: Equatable, Sendable {
        /// Its place among the menu bar's children, the one pressed on a click.
        public var index: Int
        public var title: String
        public var role: Role

        public init(index: Int, title: String, role: Role) {
            self.index = index; self.title = title; self.role = role
        }
    }

    /// The menu bar's titles in order: the Apple menu first, the app's menu second, then its menus. A menu with no
    /// title (an icon only) is left out, since there is nothing to draw for it.
    public static func items(_ titles: [String]) -> [Item] {
        titles.enumerated().compactMap { i, raw in
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            switch i {
            case 0: return Item(index: 0, title: "Apple", role: .apple)
            case 1: return t.isEmpty ? nil : Item(index: 1, title: t, role: .app)
            default: return t.isEmpty ? nil : Item(index: i, title: t, role: .menu)
            }
        }
    }

    /// Where the menu drawn at `index` (read as `titles`) is now (`fresh`): the same place when its title is still
    /// there, else the first menu with its title, else nil. The Apple menu is always first.
    public static func place(of index: Int, titles: [String], in fresh: [String]) -> Int? {
        guard titles.indices.contains(index) else { return nil }
        if index == 0 { return fresh.isEmpty ? nil : 0 }
        let title = titles[index]
        if fresh.indices.contains(index), fresh[index] == title { return index }
        return fresh.firstIndex(of: title)
    }
}

/// What the `status` module draws: every app's status items as Accessibility reads them (`AXExtrasMenuBar`), the
/// macOS ones as symbols and an app's own as that app's icon. No pixels are copied, so it needs no Screen Recording.
public enum BarStatus {
    public struct Item: Equatable, Sendable {
        /// The owning app's bundle id, "" when it has none.
        public var owner: String
        /// `AXIdentifier`: macOS names its own `com.apple.menuextra.<name>`; most apps set none.
        public var identifier: String?
        /// `AXDescription`, else `AXTitle`, else `AXHelp`: what it says it is.
        public var label: String?
        /// Its place along the macOS bar, when Accessibility gives one.
        public var x: Double?
        /// Its top, in Accessibility's coordinates (0 is the top of the main display). An item macOS hid for want of
        /// room sits off every bar, as the ones behind macOS 27's "Show Hidden Menu Bar Items" do.
        public var y: Double?

        public init(owner: String, identifier: String? = nil, label: String? = nil, x: Double? = nil, y: Double? = nil) {
            self.owner = owner; self.identifier = identifier; self.label = label; self.x = x; self.y = y
        }

        /// One of macOS's own: Wi-Fi, the battery, Control Center and the rest.
        public var isSystem: Bool {
            (identifier ?? "").hasPrefix("com.apple.") || owner.hasPrefix("com.apple.")
        }

        /// What it is called in a tooltip and to VoiceOver.
        public var name: String {
            if let label, !label.isEmpty { return label }
            if let id = identifier, let last = id.split(separator: ".").last { return String(last) }
            return owner.isEmpty ? "Status item" : owner
        }
    }

    /// macOS's own items by a word in their identifier or label, first match wins, with the symbol each is drawn as.
    static let symbols: [(String, String)] = [
        ("wifi", "wifi"), ("wi-fi", "wifi"),
        ("controlcenter", "switch.2"), ("control center", "switch.2"),
        ("clock", "clock"),
        ("sound", "speaker.wave.2"), ("volume", "speaker.wave.2"),
        ("focus", "moon"), ("donotdisturb", "moon"),
        ("bluetooth", "wave.3.right"),
        ("spotlight", "magnifyingglass"),
        ("screenmirroring", "rectangle.on.rectangle"), ("display", "display"),
        ("timemachine", "clock.arrow.circlepath"), ("time machine", "clock.arrow.circlepath"),
        ("vpn", "lock.shield"),
        ("textinput", "keyboard"), ("keyboard", "keyboard"),
        ("nowplaying", "play.circle"), ("now playing", "play.circle"),
        ("userswitcher", "person.crop.circle"),
        ("accessibility", "accessibility"),
        ("siri", "mic"),
        ("airdrop", "dot.radiowaves.up.forward"),
    ]

    /// The symbol a macOS item is drawn as; nil for an app's own, drawn as its app's icon. The battery shows its charge
    /// (`battery(percent:charging:)`); a macOS item the list doesn't know is a plain dot, so it can still be clicked.
    public static func symbol(_ item: Item, percent: Int? = nil, charging: Bool = false) -> String? {
        guard item.isSystem else { return nil }
        if isBattery(item) { return battery(percent: percent, charging: charging) }
        let words = ((item.identifier ?? "") + " " + (item.label ?? "")).lowercased()
        return symbols.first { words.contains($0.0) }?.1 ?? "circle.fill"
    }

    /// How a child of `AXExtrasMenuBar` is read, by its role and its children's.
    public enum Pick: Equatable, Sendable {
        /// The item itself: an app's `AXMenuBarItem`, or one whose role didn't answer.
        case itself
        /// The menu bar item inside it, at this index of its children. macOS 27 wraps each of its own in an `AXGroup`
        /// that carries no name; the item inside has the `com.apple.menuextra.<name>` identifier and is what to press.
        case child(Int)
        /// Not a status item, such as macOS 27's "Show Hidden Menu Bar Items" button.
        case skip
    }

    public static func pick(role: String?, childRoles: [String?] = []) -> Pick {
        switch role {
        case nil, "AXMenuBarItem": return .itself
        case "AXGroup": return childRoles.firstIndex { $0 == "AXMenuBarItem" }.map(Pick.child) ?? .skip
        default: return .skip
        }
    }

    /// Whether macOS has hidden an item off its bar: its top is on none of the bars (`barTops`, one per display, in
    /// Accessibility's coordinates). An item with no place read is kept.
    public static func parked(_ item: Item, barTops: [Double]) -> Bool {
        guard let y = item.y else { return false }
        return !barTops.contains { y >= $0 - 2 && y < $0 + 50 }
    }

    /// How the battery glyph is drawn, as macOS draws its own: filled to the charge, yellow in Low Power Mode, red when
    /// nearly empty on battery, a bolt while charging and a plug on power but not charging (a full battery, or one held
    /// back by Optimized Charging).
    public struct BatteryLook: Equatable, Sendable {
        public enum Tint: Equatable, Sendable { case normal, lowPower, critical }
        public enum Badge: Equatable, Sendable { case none, bolt, plug }
        public var fill: Double
        public var tint: Tint
        public var badge: Badge

        public init(fill: Double, tint: Tint, badge: Badge) {
            self.fill = fill
            self.tint = tint
            self.badge = badge
        }
    }

    public static func batteryLook(percent: Int?, charging: Bool, onPower: Bool, lowPower: Bool) -> BatteryLook {
        let fill = percent.map { min(1, max(0, Double($0) / 100)) } ?? 1
        let tint: BatteryLook.Tint = lowPower ? .lowPower : ((percent ?? 100) <= 10 && !onPower && !charging ? .critical : .normal)
        let badge: BatteryLook.Badge = charging ? .bolt : (onPower ? .plug : .none)
        return BatteryLook(fill: fill, tint: tint, badge: badge)
    }

    /// Whether an item is macOS's battery, drawn as `batteryLook` rather than a symbol.
    public static func isBattery(_ item: Item) -> Bool {
        item.isSystem && ((item.identifier ?? "") + " " + (item.label ?? "")).lowercased().contains("battery")
    }

    /// The battery symbol for a charge, in quarters. The bolt comes only with a full one (SF Symbols has no other), so a
    /// low battery charging still reads as low.
    public static func battery(percent: Int?, charging: Bool) -> String {
        guard let percent else { return charging ? "battery.100percent.bolt" : "battery.100percent" }
        let quarter = min(100, max(0, Int((Double(percent) / 25).rounded()) * 25))
        return quarter == 100 && charging ? "battery.100percent.bolt" : "battery.\(quarter)percent"
    }

    /// The items the bar draws, left to right: in the order macOS puts them when every place is known, else as read;
    /// without the ones a module of the bar already shows (the clock beside `clock` or `date`, the battery beside
    /// `battery`) and the ones macOS hid off its bar (`parked`).
    public static func shown(_ items: [Item], modules: [Surfaces.BarModule], barTops: [Double] = [0]) -> [Item] {
        shown(items, \.self, modules: modules, barTops: barTops)
    }

    /// `shown` for anything that carries an item, such as the app's read of one with what to press.
    public static func shown<T>(_ list: [T], _ item: (T) -> Item, modules: [Surfaces.BarModule],
                                barTops: [Double] = [0]) -> [T] {
        let clock = modules.contains(.clock) || modules.contains(.date)
        let battery = modules.contains(.battery)
        let kept = list.filter { entry in
            let it = item(entry)
            if parked(it, barTops: barTops) { return false }
            guard it.isSystem else { return true }
            let words = ((it.identifier ?? "") + " " + (it.label ?? "")).lowercased()
            if clock, words.contains("clock") { return false }
            if battery, isBattery(it) { return false }
            return true
        }
        let places = kept.map { item($0).x }
        guard !places.contains(where: { $0 == nil }) else { return kept }
        // A stable sort: two items at one place keep the order they were read in.
        return kept.indices.sorted { (places[$0]!, $0) < (places[$1]!, $1) }.map { kept[$0] }
    }
}


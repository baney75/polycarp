import Foundation

/// The idle screen (`idle.*` in surfaces.json, Martyr Night by default): when it comes up, when it goes, and what it
/// shows, worked out apart from drawing so tests can pin it. From across the room it says which machine this is and
/// what time it is, with one verse and one line of Kierkegaard.
public enum IdleScreen {
    /// One line of Kierkegaard, translated here from the Danish (Søren Kierkegaards Skrifter, public domain; the English
    /// editions are still under copyright), with where it is from.
    public struct Line: Equatable, Sendable {
        public let text: String
        public let source: String
    }

    public static let kierkegaard: [Line] = [
        Line(text: "Purity of heart is to will one thing.", source: "Purity of Heart, 1847 (SKS 8)"),
        Line(text: "If the fear of God is the beginning of wisdom, silence is the beginning of the fear of God.",
             source: "The Lily in the Field and the Bird of the Air, 1849 (SKS 11)"),
        Line(text: "Life is understood backward, but it must be lived forward.", source: "Journals, 1843 (SKS 18)"),
        Line(text: "Not looking at the mirror, but seeing yourself in it.", source: "For Self-Examination, 1851 (SKS 13)"),
    ]

    /// What one screen shows. Nil parts are left off.
    public struct Content: Equatable, Sendable {
        public let name: String?
        public let time: String?
        public let verse: Verse?
        public let line: Line?
    }

    /// The idle screen's words at `date`. Martyr Night and the field show what `idle.show*` allows; `verse` is one verse
    /// on black and nothing else. The verse turns each hour, so a long night isn't one verse; the Kierkegaard line turns
    /// each day.
    public static func content(_ idle: Surfaces.Idle, at date: Date, machine: String, twentyFourHour: Bool,
                               timeZone: TimeZone = .current) -> Content {
        let verse = Verses.pick(.hourly, at: date, timeZone: timeZone)
        if idle.style == .verse { return Content(name: nil, time: nil, verse: verse, line: nil) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let day = Verses.localDay(date, timeZone)
        let name = spaced(machine)
        return Content(name: idle.showMachineName && !name.isEmpty ? name : nil,
                       time: BarText.clock(date, calendar: cal, format: twentyFourHour ? .twentyFourHour : .twelveHour),
                       verse: idle.showVerse ? verse : nil,
                       line: idle.showKierkegaard ? kierkegaard[day % kierkegaard.count] : nil)
    }

    /// The machine's name as the idle screen sets it: capitals with a space between each letter ("R E C T O R Y 1"), or
    /// plain capitals when it is too long to read that way.
    public static func spaced(_ name: String, longest: Int = 16) -> String {
        let upper = name.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard upper.count <= longest else { return upper }
        return upper.map(String.init).joined(separator: " ")
    }

    /// Whether to come up now, with `idle` seconds since the last input. Never while an app keeps the display awake (a
    /// video playing, a call), which is how those apps say someone is watching without touching anything, and never
    /// once macOS has the screen (`systemHasScreen`: its screen saver running, the session locked, every display
    /// asleep), so the cover isn't waiting behind them when someone comes back.
    public static func shouldStart(idle: TimeInterval, settings: Surfaces.Idle, displayHeldAwake: Bool,
                                   systemHasScreen: Bool = false) -> Bool {
        settings.enabled && !displayHeldAwake && !systemHasScreen && idle >= Double(settings.startAfterMinutes) * 60
    }

    /// Whether there was input between two looks: the time since the last input went down. A little slack, because
    /// the count is read twice a second and isn't exact.
    public static func inputSince(lastIdle: TimeInterval, idle: TimeInterval) -> Bool { idle + 0.25 < lastIdle }

    /// How far the words have drifted at `date`, in points: a few points a minute along a slow loop, so no letter sits on
    /// the same pixels all night.
    public static func drift(at date: Date, reach: Double = 14) -> (x: Double, y: Double) {
        let minute = (date.timeIntervalSince1970 / 60).rounded(.down)
        return (sin(minute / 7) * reach, cos(minute / 11) * reach * 0.6)
    }

    /// Martyr Night's colors (the Martyr design system's night mode, as sRGB hex): the sky from its top to its foot, the
    /// words, the quieter words, the faintest, and the gold of the name and the embers.
    public enum Night {
        public static let skyTop: UInt32 = 0x140F12
        public static let skyFoot: UInt32 = 0x21191D
        public static let text: UInt32 = 0xEEE5D5
        public static let muted: UInt32 = 0xB9AAA6
        public static let faint: UInt32 = 0x9C8782
        public static let gold: UInt32 = 0xD5B66F
        public static let ember: UInt32 = 0xDFB866
    }

    /// How often the idle screen looks for its moment, and how often, once up, it looks for input.
    public static let watchInterval: TimeInterval = 15
    public static let wakeInterval: TimeInterval = 0.5
}

/// Martyr Night's sky: a few still stars and embers that rise slowly and fade. Positions are fractions of the screen,
/// with y measured from the top, and depend only on the seed and the time, so a render is the same every run.
public enum IdleSky {
    public struct Ember: Equatable, Sendable {
        public let x: Double
        public let size: Double
        public let speed: Double
        public let phase: Double
        public let sway: Double
    }

    public struct Star: Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let size: Double
        public let phase: Double
    }

    /// Few enough to cost almost nothing at the frame rate the idle screen draws at.
    public static let emberCount = 28
    public static let starCount = 60
    public static let framesPerSecond: Double = 15

    public static func embers(count: Int = emberCount, seed: UInt64 = 0x4D41_5254) -> [Ember] {
        var r = Random(seed)
        return (0..<count).map { _ in
            Ember(x: r.next(), size: 1.5 + r.next() * 2.5, speed: 0.012 + r.next() * 0.02, phase: r.next(), sway: 0.004 + r.next() * 0.01)
        }
    }

    public static func stars(count: Int = starCount, seed: UInt64 = 0x5354_4152) -> [Star] {
        var r = Random(seed)
        // In the upper part of the screen, above the words.
        return (0..<count).map { _ in Star(x: r.next(), y: r.next() * 0.55, size: 0.6 + r.next() * 1.2, phase: r.next()) }
    }

    /// An ember at `t` seconds: where it is and how bright. It rises from below the bottom edge to two thirds of the way
    /// up, swaying a little, and fades out as it climbs.
    public static func place(_ e: Ember, at t: Double) -> (x: Double, y: Double, alpha: Double) {
        let climb = (e.phase + t * e.speed).truncatingRemainder(dividingBy: 1)
        let y = 1.02 - climb * 0.68
        let x = e.x + sin((t * e.speed * 40 + e.phase) * 2 * .pi) * e.sway
        let alpha = climb < 0.1 ? climb / 0.1 : max(0, 1 - (climb - 0.1) / 0.9)
        return (x, y, alpha * 0.8)
    }

    /// A star's brightness at `t`: a slow twinkle between dim and bright.
    public static func twinkle(_ s: Star, at t: Double) -> Double {
        0.35 + 0.3 * (0.5 + 0.5 * sin((t / 6 + s.phase) * 2 * .pi))
    }

    /// A small fixed generator (SplitMix64), so the sky is the same on every run and every machine.
    struct Random {
        var state: UInt64
        init(_ seed: UInt64) { state = seed }
        mutating func next() -> Double {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            z ^= z >> 31
            return Double(z >> 11) / Double(1 << 53)
        }
    }
}

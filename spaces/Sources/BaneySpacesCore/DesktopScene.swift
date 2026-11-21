import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// The desktop scene from surfaces.json (`desktop.*`): a field, an olive tree, still water or a plain page, under the
// light of the hour, with one short verse. Drawn here with CoreGraphics and CoreText into a picture the size of a display,
// so `WallpaperKeeper` sets it like any theme picture and the person's own comes back the same way.

/// The light the scene is drawn in.
public enum DaylightPhase: String, CaseIterable, Sendable {
    case dawn, day, dusk, night

    /// The phase at `date`: dawn from 45 minutes before sunrise to 75 after, dusk from 75 minutes before sunset to 45
    /// after, day between, night otherwise. Sunrise and sunset come from `Sun.times`.
    public static func at(_ date: Date, timeZone: TimeZone = .current, latitude: Double = Sun.defaultLatitude) -> DaylightPhase {
        guard let t = Sun.times(on: date, timeZone: timeZone, latitude: latitude) else {
            // Polar day or night: the sun neither rises nor sets.
            return Sun.isPolarDay(on: date, timeZone: timeZone, latitude: latitude) ? .day : .night
        }
        let now = date.timeIntervalSince1970
        if now < t.rise - 45 * 60 || now >= t.set + 45 * 60 { return .night }
        if now < t.rise + 75 * 60 { return .dawn }
        if now >= t.set - 75 * 60 { return .dusk }
        return .day
    }

    /// The next moment after `date` when the phase may change (one of today's or tomorrow's four edges).
    public static func nextChange(after date: Date, timeZone: TimeZone = .current, latitude: Double = Sun.defaultLatitude) -> Date {
        let cal = Self.calendar(timeZone)
        var edges: [Double] = []
        for offset in 0...1 {
            guard let day = cal.date(byAdding: .day, value: offset, to: date), let t = Sun.times(on: day, timeZone: timeZone, latitude: latitude) else { continue }
            edges += [t.rise - 45 * 60, t.rise + 75 * 60, t.set - 75 * 60, t.set + 45 * 60]
        }
        let now = date.timeIntervalSince1970
        if let next = edges.filter({ $0 > now + 1 }).min() { return Date(timeIntervalSince1970: next) }
        return cal.startOfDay(for: cal.date(byAdding: .day, value: 1, to: date) ?? date.addingTimeInterval(86_400))
    }

    static func calendar(_ tz: TimeZone) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = tz
        return c
    }
}

/// Sunrise and sunset without asking where you are: the longitude is the time zone's standard meridian (15 degrees an
/// hour) and the latitude a temperate default. Off by up to half an hour at a zone's edges, which the phases' wide edges
/// absorb, and no location permission is needed.
public enum Sun {
    public static let defaultLatitude = 40.0

    /// Seconds since 1970 of sunrise and sunset on `date`'s local day; nil when the sun doesn't rise or doesn't set.
    public static func times(on date: Date, timeZone: TimeZone, latitude: Double) -> (rise: Double, set: Double)? {
        guard let s = solar(on: date, timeZone: timeZone, latitude: latitude), abs(s.cosOmega) <= 1 else { return nil }
        let halfDay = acos(s.cosOmega) * 180 / .pi * 4 * 60
        return (s.noon - halfDay, s.noon + halfDay)
    }

    static func isPolarDay(on date: Date, timeZone: TimeZone, latitude: Double) -> Bool {
        (solar(on: date, timeZone: timeZone, latitude: latitude)?.cosOmega ?? 0) < -1
    }

    /// Solar noon (seconds since 1970) and the cosine of the sunrise hour angle, NOAA's short form.
    private static func solar(on date: Date, timeZone: TimeZone, latitude: Double) -> (noon: Double, cosOmega: Double)? {
        let cal = DaylightPhase.calendar(timeZone)
        let ymd = cal.dateComponents([.year, .month, .day], from: date)
        let utc = DaylightPhase.calendar(TimeZone(identifier: "UTC")!)
        guard let midnightUTC = utc.date(from: ymd), let n = cal.ordinality(of: .day, in: .year, for: date) else { return nil }
        let standardOffset = Double(timeZone.secondsFromGMT(for: date)) - timeZone.daylightSavingTimeOffset(for: date)
        let longitude = standardOffset / 3600 * 15
        let b = 2 * Double.pi / 365 * Double(n - 81)
        let declination = 23.44 * Double.pi / 180 * sin(b)
        let equationOfTime = 9.87 * sin(2 * b) - 7.53 * cos(b) - 1.5 * sin(b)
        let noonMinutes = 720 - 4 * longitude - equationOfTime
        let phi = latitude * .pi / 180
        // -0.833 degrees: the sun's disc and the air's bending put sunrise a little before the center crosses the horizon.
        let h0 = -0.833 * Double.pi / 180
        let cosOmega = (sin(h0) - sin(phi) * sin(declination)) / (cos(phi) * cos(declination))
        return (midnightUTC.timeIntervalSince1970 + noonMinutes * 60, cosOmega)
    }
}

/// One verse as the desktop shows it: BSB text, verbatim (a whole verse or a run of words from one), and its reference.
public struct Verse: Equatable, Sendable {
    public let ref: String
    public let text: String
    public init(_ ref: String, _ text: String) { self.ref = ref; self.text = text }
}

/// The verses the desktop turns through. Berean Standard Bible, public domain since 2023-04-30; every text is the BSB's
/// own words, checked against its plain-text edition, with superscriptions ("A Psalm of David.") left off.
public enum Verses {
    public static let desktop: [Verse] = [
        Verse("Psalm 86:11", "Give me an undivided heart, that I may fear Your name."),
        Verse("Luke 10:42", "But only one thing is necessary."),
        Verse("Matthew 6:28", "Consider how the lilies of the field grow: They do not labor or spin."),
        Verse("Psalm 46:10", "Be still and know that I am God"),
        Verse("Psalm 118:24", "This is the day that the LORD has made; we will rejoice and be glad in it."),
        Verse("Lamentations 3:22-23",
              "Because of the loving devotion of the LORD we are not consumed, for His mercies never fail. They are new every morning; great is Your faithfulness!"),
        Verse("Psalm 52:8", "But I am like an olive tree flourishing in the house of God; I trust in the loving devotion of God forever and ever."),
        Verse("Psalm 90:12", "So teach us to number our days, that we may present a heart of wisdom."),
        Verse("Matthew 6:33", "But seek first the kingdom of God and His righteousness, and all these things will be added unto you."),
        Verse("Psalm 23:1-2", "The LORD is my shepherd; I shall not want. He makes me lie down in green pastures; He leads me beside quiet waters."),
        Verse("Psalm 5:3", "In the morning, O LORD, You hear my voice; at daybreak I lay my plea before You and wait in expectation."),
        Verse("Matthew 11:28", "Come to Me, all you who are weary and burdened, and I will give you rest."),
        Verse("Psalm 62:1", "In God alone my soul finds rest; my salvation comes from Him."),
        Verse("Isaiah 26:3", "You will keep in perfect peace the steadfast of mind, because he trusts in You."),
        Verse("Matthew 6:34", "Therefore do not worry about tomorrow, for tomorrow will worry about itself. Today has enough trouble of its own."),
        Verse("Psalm 121:1-2", "I lift up my eyes to the hills. From where does my help come? My help comes from the LORD, the Maker of heaven and earth."),
        Verse("John 14:27", "Peace I leave with you; My peace I give to you."),
        Verse("Psalm 19:1", "The heavens declare the glory of God; the skies proclaim the work of His hands."),
        Verse("Micah 6:8",
              "He has shown you, O man, what is good. And what does the LORD require of you but to act justly, to love mercy, and to walk humbly with your God?"),
        Verse("Psalm 51:10", "Create in me a clean heart, O God, and renew a right spirit within me."),
        Verse("Proverbs 3:5-6", "Trust in the LORD with all your heart, and lean not on your own understanding; in all your ways acknowledge Him, and He will make your paths straight."),
        Verse("Matthew 5:8", "Blessed are the pure in heart, for they will see God."),
        Verse("Psalm 16:11", "You have made known to me the path of life; You will fill me with joy in Your presence, with eternal pleasures at Your right hand."),
        Verse("John 15:5", "I am the vine and you are the branches."),
        Verse("Psalm 1:3", "He is like a tree planted by streams of water, yielding its fruit in season, whose leaf does not wither, and who prospers in all he does."),
        Verse("Philippians 4:6", "Be anxious for nothing, but in everything, by prayer and petition, with thanksgiving, present your requests to God."),
        Verse("Psalm 139:23-24", "Search me, O God, and know my heart; test me and know my concerns. See if there is any offensive way in me; lead me in the way everlasting."),
        Verse("Isaiah 40:31",
              "But those who wait upon the LORD will renew their strength; they will mount up with wings like eagles; they will run and not grow weary, they will walk and not faint."),
        Verse("Psalm 143:8", "Let me hear Your loving devotion in the morning, for I have put my trust in You."),
        Verse("Psalm 113:3", "From where the sun rises to where it sets, the name of the LORD is praised."),
        Verse("Psalm 4:8", "I will lie down and sleep in peace, for You alone, O LORD, make me dwell in safety."),
    ]

    /// The verse with this reference, ignoring case, extra spaces and a dash for the hyphen; nil when the list lacks it.
    public static func find(_ ref: String, in list: [Verse] = desktop) -> Verse? {
        let key = normal(ref)
        return list.first { normal($0.ref) == key }
    }

    private static func normal(_ s: String) -> String {
        s.lowercased().replacingOccurrences(of: "\u{2013}", with: "-").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// The verse for `date`: a new one each local day or each hour, or the fixed one. A fixed reference the list lacks
    /// turns daily, so the desktop still shows Scripture, not nothing.
    public static func pick(_ rotation: Surfaces.VerseRotation, at date: Date, timeZone: TimeZone = .current, list: [Verse] = desktop) -> Verse? {
        guard !list.isEmpty else { return nil }
        let cal = DaylightPhase.calendar(timeZone)
        let day = localDay(date, timeZone)
        switch rotation {
        case .daily: return list[day % list.count]
        case .hourly: return list[(day * 24 + cal.component(.hour, from: date)) % list.count]
        case let .fixed(ref): return find(ref, in: list) ?? list[day % list.count]
        }
    }

    /// Days since 1970 by the local calendar: it turns at local midnight. (`ordinality(of:in: .era)` turns at UTC midnight.)
    static func localDay(_ date: Date, _ tz: TimeZone) -> Int {
        let start = DaylightPhase.calendar(tz).startOfDay(for: date)
        return Int(((start.timeIntervalSince1970 + Double(tz.secondsFromGMT(for: start))) / 86_400).rounded())
    }

    /// When `pick` next gives a different verse: the next local midnight or hour; never, for a fixed one it found.
    public static func nextChange(_ rotation: Surfaces.VerseRotation, after date: Date, timeZone: TimeZone = .current, list: [Verse] = desktop) -> Date? {
        let cal = DaylightPhase.calendar(timeZone)
        switch rotation {
        case let .fixed(ref) where find(ref, in: list) != nil: return nil
        case .hourly: return cal.nextDate(after: date, matching: DateComponents(minute: 0, second: 0), matchingPolicy: .nextTime)
        default: return cal.nextDate(after: date, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime)
        }
    }
}

/// A desktop scene to draw: what, in which light, with which verse where.
public struct DesktopScene: Equatable, Sendable {
    /// The painted scenes. `solid` and `image:` are the theme's own pictures, not drawn here.
    public enum Kind: String, CaseIterable, Sendable { case field, olive, water, parchment }

    public var kind: Kind
    public var phase: DaylightPhase
    public var verse: Verse?
    public var versePosition: Surfaces.VersePosition

    public init(kind: Kind, phase: DaylightPhase, verse: Verse?, versePosition: Surfaces.VersePosition) {
        self.kind = kind; self.phase = phase; self.verse = verse; self.versePosition = versePosition
    }

    /// The scene `desktop` asks for at `date`, or nil when it asks for the theme's solid or a picture file. With
    /// `followDaylight` off the light is day, or night while the system is dark.
    public static func of(_ desktop: Surfaces.Desktop, at date: Date, timeZone: TimeZone = .current, systemDark: Bool) -> DesktopScene? {
        let kind: Kind
        switch desktop.scene {
        case .field: kind = .field
        case .olive: kind = .olive
        case .water: kind = .water
        case .parchment: kind = .parchment
        case .solid, .image: return nil
        }
        let phase = desktop.followDaylight ? DaylightPhase.at(date, timeZone: timeZone) : (systemDark ? .night : .day)
        let verse = desktop.verse ? Verses.pick(desktop.verseRotation, at: date, timeZone: timeZone) : nil
        return DesktopScene(kind: kind, phase: phase, verse: verse, versePosition: desktop.versePosition)
    }

    /// When the scene `desktop` asks for may next look different: a phase edge or a verse change, whichever is first.
    public static func nextChange(_ desktop: Surfaces.Desktop, after date: Date, timeZone: TimeZone = .current) -> Date? {
        let light = desktop.followDaylight ? DaylightPhase.nextChange(after: date, timeZone: timeZone) : nil
        let verse = desktop.verse ? Verses.nextChange(desktop.verseRotation, after: date, timeZone: timeZone) : nil
        return [light, verse].compactMap { $0 }.min()
    }

    /// The file name: it changes with anything drawn, so the Dock and each Space never keep a stale picture.
    public func fileName(width: Int, height: Int) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in "\(verse?.ref ?? "")|\(verse?.text ?? "")|\(versePosition.rawValue)".utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return "scene-\(kind.rawValue)-\(phase.rawValue)-" + String(format: "%08llx", h & 0xffff_ffff) + "-\(width)x\(height).png"
    }

    // MARK: Drawing

    /// The colors of one light.
    struct Palette {
        var sky: [(RGB, CGFloat)]
        var glow: RGB
        var glowAt: CGPoint
        var hills: [RGB]
        var stem: RGB
        var petal: RGB
        var bird: RGB?
        var text: RGB
        var ref: RGB
        var stars: Bool
    }

    static func hex(_ v: UInt32) -> RGB { RGB(r: Double((v >> 16) & 0xff) / 255, g: Double((v >> 8) & 0xff) / 255, b: Double(v & 0xff) / 255) }

    func palette() -> Palette {
        switch phase {
        case .day:
            return Palette(sky: [(Self.hex(0xEFE6CF), 0), (Self.hex(0xF3EBD8), 0.46), (Self.hex(0xE3DCC4), 0.62), (Self.hex(0xC9CDAF), 1)],
                           glow: Self.hex(0xFFF6DA), glowAt: CGPoint(x: 1152, y: 400), hills: [0xD6D7BC, 0xC3C8A5, 0xAEB68F].map(Self.hex),
                           stem: Self.hex(0x59693F), petal: Self.hex(0xF6F3E8), bird: Self.hex(0x4A4E41), text: Self.hex(0x3E4236), ref: Self.hex(0x5F6451), stars: false)
        case .dawn:
            return Palette(sky: [(Self.hex(0xDCD3D0), 0), (Self.hex(0xEEDCCB), 0.44), (Self.hex(0xF2DEC2), 0.6), (Self.hex(0xC6C6AA), 1)],
                           glow: Self.hex(0xFFE1BA), glowAt: CGPoint(x: 400, y: 560), hills: [0xD2CFB6, 0xBDBF9E, 0xA6AC88].map(Self.hex),
                           stem: Self.hex(0x56653D), petal: Self.hex(0xF7EEE2), bird: Self.hex(0x4F5045), text: Self.hex(0x3E4236), ref: Self.hex(0x5F6451), stars: false)
        case .dusk:
            return Palette(sky: [(Self.hex(0xC9C3C4), 0), (Self.hex(0xE4CDB8), 0.42), (Self.hex(0xEBC9A3), 0.6), (Self.hex(0xA9AC8E), 1)],
                           glow: Self.hex(0xF6C994), glowAt: CGPoint(x: 1280, y: 580), hills: [0xC1BDA2, 0xA7AA8B, 0x8E9676].map(Self.hex),
                           stem: Self.hex(0x4C5936), petal: Self.hex(0xF1E4D3), bird: Self.hex(0x45463D), text: Self.hex(0x34372D), ref: Self.hex(0x50553F), stars: false)
        case .night:
            return Palette(sky: [(Self.hex(0x181A20), 0), (Self.hex(0x202329), 0.6), (Self.hex(0x272A25), 1)],
                           glow: Self.hex(0x8F96A8), glowAt: CGPoint(x: 1240, y: 220), hills: [0x30342C, 0x2A2E26, 0x232620].map(Self.hex),
                           stem: Self.hex(0x7E8D63), petal: Self.hex(0xBFBBAA), bird: nil, text: Self.hex(0xD3CFBE), ref: Self.hex(0x9A9E8A), stars: true)
        }
    }

    /// The verse sits on the right: the land is drawn mirrored, so the lilies stand opposite it, never under it.
    var mirrored: Bool { [.bottomRight, .topRight].contains(versePosition) }

    /// The scene as a PNG of `width` by `height` pixels (sRGB). Nil for a size of zero.
    public func png(width: Int, height: Int) -> Data? {
        guard let image = image(width: width, height: height) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    func image(width: Int, height: Int) -> CGImage? {
        guard width > 0, height > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let p = palette()
        let w = CGFloat(width), h = CGFloat(height)
        func color(_ c: RGB, _ a: CGFloat = 1) -> CGColor { CGColor(colorSpace: space, components: [c.r, c.g, c.b, a])! }

        // The sky, top to bottom, in pixel space (CoreGraphics' y runs up).
        let sky = kind == .parchment ? parchmentSky(p) : p.sky
        if let g = CGGradient(colorsSpace: space, colors: sky.map { color($0.0) } as CFArray, locations: sky.map(\.1)) {
            ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: h), end: .zero, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }

        // The land is drawn on a 1600 by 1000 canvas that covers the display, cropped to it, centered.
        let scale = max(w / 1600, h / 1000)
        ctx.saveGState()
        ctx.translateBy(x: w / 2, y: h / 2)
        ctx.scaleBy(x: mirrored ? -scale : scale, y: -scale)
        ctx.translateBy(x: -800, y: -500)
        if kind != .parchment { drawLand(ctx, p, color: color, space: space) }
        ctx.restoreGState()

        if let verse { drawVerse(verse, in: ctx, width: w, height: h, palette: p, color: color) }
        return ctx.makeImage()
    }

    private func parchmentSky(_ p: Palette) -> [(RGB, CGFloat)] {
        phase == .night ? [(Self.hex(0x1F211C), 0), (Self.hex(0x1A1C18), 1)] : [(Self.hex(0xF7F3E7), 0), (Self.hex(0xEFE9D8), 1)]
    }

    private func drawLand(_ ctx: CGContext, _ p: Palette, color: (RGB, CGFloat) -> CGColor, space: CGColorSpace) {
        // The sun's or moon's soft light.
        if let g = CGGradient(colorsSpace: space, colors: [color(p.glow, phase == .night ? 0.35 : 0.95), color(p.glow, 0)] as CFArray, locations: [0, 1]) {
            ctx.drawRadialGradient(g, startCenter: p.glowAt, startRadius: 0, endCenter: p.glowAt, endRadius: 480, options: [])
        }
        if phase == .night {
            ctx.setFillColor(color(Self.hex(0xE9E2CF), 0.9))
            ctx.fillEllipse(in: CGRect(x: p.glowAt.x - 18, y: p.glowAt.y - 18, width: 36, height: 36))
            ctx.setFillColor(color(Self.hex(0xE9E2CF), 0.55))
            // A fixed scatter, so the picture is the same every time it is drawn.
            for (x, y, r) in [(180, 120, 1.6), (310, 260, 1.2), (520, 90, 1.4), (690, 210, 1.0), (860, 140, 1.5), (980, 300, 1.1),
                              (1420, 120, 1.3), (1520, 260, 1.0), (420, 380, 1.0), (1080, 80, 1.2), (240, 450, 0.9), (1360, 400, 0.9)] as [(CGFloat, CGFloat, CGFloat)] {
                ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
            }
        }

        if kind == .water { drawWater(ctx, p, color: color, space: space); return }

        // Three hills, far to near.
        let hills: [(CGFloat, CGPoint, CGPoint, CGPoint, CGPoint, CGPoint)] = [
            (610, CGPoint(x: 300, y: 585), CGPoint(x: 520, y: 600), CGPoint(x: 800, y: 590), CGPoint(x: 1300, y: 575), CGPoint(x: 1600, y: 600)),
            (690, CGPoint(x: 350, y: 660), CGPoint(x: 700, y: 700), CGPoint(x: 1000, y: 676), CGPoint(x: 1400, y: 650), CGPoint(x: 1600, y: 680)),
            (790, CGPoint(x: 400, y: 760), CGPoint(x: 800, y: 800), CGPoint(x: 1200, y: 770), CGPoint(x: 1500, y: 760), CGPoint(x: 1600, y: 775)),
        ]
        for (i, hill) in hills.enumerated() {
            let (startY, c1, c2, mid, c4, end) = hill
            // The smooth curve's first control point mirrors the one before it across the middle point.
            let c3 = CGPoint(x: 2 * mid.x - c2.x, y: 2 * mid.y - c2.y)
            let path = CGMutablePath()
            path.move(to: CGPoint(x: -400, y: startY))
            path.addLine(to: CGPoint(x: 0, y: startY))
            path.addCurve(to: mid, control1: c1, control2: c2)
            path.addCurve(to: end, control1: c3, control2: c4)
            path.addLine(to: CGPoint(x: 2000, y: end.y))
            path.addLine(to: CGPoint(x: 2000, y: 1400))
            path.addLine(to: CGPoint(x: -400, y: 1400))
            path.closeSubpath()
            ctx.addPath(path)
            ctx.setFillColor(color(p.hills[i], 1))
            ctx.fillPath()
        }

        if kind == .olive { drawOlive(ctx, p, color: color) } else { drawLilies(ctx, p, color: color) }

        if let bird = p.bird {
            ctx.setStrokeColor(color(bird, 0.5))
            ctx.setLineWidth(1.6)
            ctx.setLineCap(.round)
            for (x, y, s) in [(1090.0, 330.0, 8.0), (1150, 300, 6)] as [(CGFloat, CGFloat, CGFloat)] {
                ctx.move(to: CGPoint(x: x, y: y))
                ctx.addQuadCurve(to: CGPoint(x: x + 2 * s, y: y), control: CGPoint(x: x + s, y: y - s * 0.9))
                ctx.addQuadCurve(to: CGPoint(x: x + 4 * s, y: y), control: CGPoint(x: x + 3 * s, y: y - s * 0.9))
                ctx.strokePath()
            }
        }
    }

    private func drawLilies(_ ctx: CGContext, _ p: Palette, color: (RGB, CGFloat) -> CGColor) {
        ctx.setLineCap(.round)
        ctx.setLineWidth(2.2)
        let alpha: CGFloat = phase == .night ? 0.7 : 0.85
        // Stem foot, stem bend, flower base, flower size.
        let lilies: [(CGFloat, CGFloat, CGFloat)] = [(1180, 760, 1.0), (1240, 812, 0.86), (1300, 846, 0.72)]
        for (x, top, s) in lilies {
            let stem = CGMutablePath()
            stem.move(to: CGPoint(x: x, y: 1000))
            stem.addCurve(to: CGPoint(x: x + 6 * s, y: top), control1: CGPoint(x: x - 4, y: 900), control2: CGPoint(x: x + 10, y: 820 + (top - 760)))
            ctx.addPath(stem)
            ctx.setStrokeColor(color(p.stem, alpha))
            ctx.strokePath()
            // A leaf partway up.
            let leaf = CGMutablePath()
            let ly = 1000 - (1000 - top) * 0.45
            leaf.move(to: CGPoint(x: x + 1, y: ly))
            leaf.addQuadCurve(to: CGPoint(x: x + 34 * s, y: ly - 30 * s), control: CGPoint(x: x + 30 * s, y: ly - 2))
            leaf.addQuadCurve(to: CGPoint(x: x + 1, y: ly), control: CGPoint(x: x + 8 * s, y: ly - 26 * s))
            ctx.addPath(leaf)
            ctx.setFillColor(color(p.stem, alpha * 0.8))
            ctx.fillPath()
            // Three petals: two out to the sides, one up the middle.
            let base = CGPoint(x: x + 6 * s, y: top)
            for (dx, dy, lean) in [(-20.0, -30.0, -1.0), (20, -30, 1), (0, -40, 0)] as [(CGFloat, CGFloat, CGFloat)] {
                let tip = CGPoint(x: base.x + dx * s, y: base.y + dy * s)
                let petal = CGMutablePath()
                petal.move(to: base)
                petal.addQuadCurve(to: tip, control: CGPoint(x: base.x + (dx - 12 + lean * 4) * s, y: base.y + dy * 0.4 * s))
                petal.addQuadCurve(to: base, control: CGPoint(x: base.x + (dx + 12 + lean * 4) * s, y: base.y + dy * 0.7 * s))
                ctx.addPath(petal)
                ctx.setFillColor(color(p.petal, alpha))
                ctx.setStrokeColor(color(p.stem, alpha))
                ctx.setLineWidth(1.8)
                ctx.drawPath(using: .fillStroke)
            }
        }
    }

    private func drawOlive(_ ctx: CGContext, _ p: Palette, color: (RGB, CGFloat) -> CGColor) {
        let trunk = CGMutablePath()
        trunk.move(to: CGPoint(x: 1196, y: 810))
        trunk.addCurve(to: CGPoint(x: 1210, y: 610), control1: CGPoint(x: 1220, y: 740), control2: CGPoint(x: 1186, y: 670))
        trunk.addCurve(to: CGPoint(x: 1246, y: 612), control1: CGPoint(x: 1222, y: 600), control2: CGPoint(x: 1236, y: 602))
        trunk.addCurve(to: CGPoint(x: 1236, y: 810), control1: CGPoint(x: 1226, y: 680), control2: CGPoint(x: 1258, y: 750))
        trunk.closeSubpath()
        ctx.addPath(trunk)
        ctx.setFillColor(color(phase == .night ? Self.hex(0x3A3B32) : Self.hex(0x6B6650), 1))
        ctx.fillPath()
        let shade = phase == .night ? Self.hex(0x3A4031) : Self.hex(0x6A7247)
        let leaves = phase == .night ? Self.hex(0x434A38) : Self.hex(0x7C8455)
        let light = phase == .night ? Self.hex(0x4D553F) : Self.hex(0x96A070)
        // Olive crowns are loose and uneven: overlapping clumps, darker underneath, catching light on top.
        let clumps: [(CGFloat, CGFloat, CGFloat, CGFloat, RGB, CGFloat)] = [
            (1120, 612, 54, 26, shade, 0.95), (1196, 622, 70, 28, shade, 0.95), (1300, 616, 62, 26, shade, 0.95), (1356, 598, 40, 20, shade, 0.9),
            (1100, 584, 50, 30, leaves, 0.95), (1168, 566, 64, 36, leaves, 0.95), (1250, 560, 72, 38, leaves, 0.95), (1330, 574, 56, 30, leaves, 0.95),
            (1206, 520, 58, 32, leaves, 0.95), (1286, 516, 44, 26, leaves, 0.95), (1146, 530, 38, 22, leaves, 0.95),
            (1180, 540, 34, 16, light, 0.8), (1262, 528, 38, 15, light, 0.8), (1320, 556, 26, 12, light, 0.75), (1124, 568, 24, 11, light, 0.7),
        ]
        for (x, y, rx, ry, c, a) in clumps {
            ctx.setFillColor(color(c, a))
            ctx.fillEllipse(in: CGRect(x: x - rx, y: y - ry, width: rx * 2, height: ry * 2))
        }
    }

    private func drawWater(_ ctx: CGContext, _ p: Palette, color: (RGB, CGFloat) -> CGColor, space: CGColorSpace) {
        // A far shore, then still water to the bottom edge.
        let shore = CGMutablePath()
        shore.move(to: CGPoint(x: -400, y: 700))
        shore.addCurve(to: CGPoint(x: 2000, y: 690), control1: CGPoint(x: 500, y: 650), control2: CGPoint(x: 1100, y: 700))
        shore.addLine(to: CGPoint(x: 2000, y: 830))
        shore.addLine(to: CGPoint(x: -400, y: 830))
        shore.closeSubpath()
        ctx.addPath(shore)
        ctx.setFillColor(color(p.hills[0], 1))
        ctx.fillPath()
        let meadow = CGMutablePath()
        meadow.move(to: CGPoint(x: -400, y: 780))
        meadow.addCurve(to: CGPoint(x: 2000, y: 770), control1: CGPoint(x: 600, y: 750), control2: CGPoint(x: 1200, y: 790))
        meadow.addLine(to: CGPoint(x: 2000, y: 830))
        meadow.addLine(to: CGPoint(x: -400, y: 830))
        meadow.closeSubpath()
        ctx.addPath(meadow)
        ctx.setFillColor(color(p.hills[1], 1))
        ctx.fillPath()
        let deep: (RGB, RGB) = phase == .night ? (Self.hex(0x1F2A2A), Self.hex(0x172020)) : (Self.hex(0x9DB7B2), Self.hex(0x5E8582))
        if let g = CGGradient(colorsSpace: space, colors: [color(deep.0, 1), color(deep.1, 1)] as CFArray, locations: [0, 1]) {
            ctx.saveGState()
            ctx.clip(to: CGRect(x: -400, y: 828, width: 2400, height: 572))
            ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 828), end: CGPoint(x: 0, y: 1000), options: [.drawsAfterEndLocation])
            ctx.restoreGState()
        }
        ctx.setStrokeColor(color(phase == .night ? Self.hex(0x8F96A8) : Self.hex(0xF6F3E8), phase == .night ? 0.25 : 0.45))
        ctx.setLineWidth(1.4)
        ctx.setLineCap(.round)
        for (x, y, len) in [(980.0, 850.0, 160.0), (1120, 872, 220), (860, 900, 120), (1240, 930, 260), (1020, 965, 180)] as [(CGFloat, CGFloat, CGFloat)] {
            ctx.move(to: CGPoint(x: x, y: y))
            ctx.addLine(to: CGPoint(x: x + len, y: y))
            ctx.strokePath()
        }
    }

    /// The verse in serif italic, its reference under it in small spaced capitals, placed by `versePosition` with a margin
    /// clear of the menu bar and the Dock.
    private func drawVerse(_ verse: Verse, in ctx: CGContext, width w: CGFloat, height h: CGFloat, palette p: Palette, color: (RGB, CGFloat) -> CGColor) {
        let size = max(12, h * 0.0215)
        let serif = Self.font(["IowanOldStyle-Italic", "Georgia-Italic", "Times-Italic"], size: size)
        let small = Self.font(["IowanOldStyle-Italic", "Georgia-Italic", "Times-Italic"], size: size * 0.8)
        let label = CTFontCreateUIFontForLanguage(.emphasizedSystem, size * 0.56, nil) ?? Self.font(["Helvetica-Bold"], size: size * 0.56)

        let align: CTTextAlignment
        switch versePosition {
        case .bottomLeft, .topLeft: align = .left
        case .bottomRight, .topRight: align = .right
        case .bottomCenter, .topCenter, .center: align = .center
        }
        var a = align
        var lineHeight = size * 1.42
        var spacing = size * 0.45
        let style = withUnsafeBytes(of: &a) { ab in
            withUnsafeBytes(of: &lineHeight) { lb in
                withUnsafeBytes(of: &spacing) { sb in
                    [CTParagraphStyleSetting(spec: .alignment, valueSize: ab.count, value: ab.baseAddress!),
                     CTParagraphStyleSetting(spec: .minimumLineHeight, valueSize: lb.count, value: lb.baseAddress!),
                     CTParagraphStyleSetting(spec: .maximumLineHeight, valueSize: lb.count, value: lb.baseAddress!),
                     CTParagraphStyleSetting(spec: .paragraphSpacingBefore, valueSize: sb.count, value: sb.baseAddress!)]
                }
            }
        }
        let paragraph = CTParagraphStyleCreate(style, style.count)

        let body = NSMutableAttributedString()
        let textColor = color(p.text, 1)
        for (piece, isSmall) in Self.smallCaps("\u{201C}" + verse.text + "\u{201D}") {
            body.append(NSAttributedString(string: piece, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): isSmall ? small : serif,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): textColor,
                NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
            ]))
        }
        body.append(NSAttributedString(string: "\n" + verse.ref.uppercased() + " \u{00B7} BSB", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): label,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(p.ref, 1),
            NSAttributedString.Key(kCTKernAttributeName as String): size * 0.56 * 0.08,
            NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
        ]))

        let setter = CTFramesetterCreateWithAttributedString(body)
        let maxWidth = w * (versePosition == .center ? 0.42 : 0.34)
        let fit = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: 0), nil,
                                                               CGSize(width: maxWidth, height: .greatestFiniteMagnitude), nil)
        let boxW = ceil(maxWidth), boxH = ceil(fit.height) + 2
        let margin = w * 0.05
        let x: CGFloat
        switch align {
        case .left: x = margin
        case .right: x = w - margin - boxW
        default: x = (w - boxW) / 2
        }
        let y: CGFloat  // the box's bottom edge, y up
        switch versePosition {
        case .bottomLeft, .bottomCenter, .bottomRight: y = h * 0.2
        case .topLeft, .topCenter, .topRight: y = h - h * 0.12 - boxH
        case .center: y = (h - boxH) / 2
        }
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: CGRect(x: x, y: y, width: boxW, height: boxH), transform: nil), nil)
        CTFrameDraw(frame, ctx)
    }

    /// The first font of `names` the Mac has, else the system's.
    static func font(_ names: [String], size: CGFloat) -> CTFont {
        for n in names {
            let f = CTFontCreateWithName(n as CFString, size, nil)
            if CTFontCopyPostScriptName(f) as String == n { return f }
        }
        return CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
    }

    /// `text` in runs, with the letters after the first of LORD and GOD marked small: the BSB prints the divine name in
    /// small capitals, and full capitals would shout in an italic line.
    static func smallCaps(_ text: String) -> [(String, Bool)] {
        var out: [(String, Bool)] = []
        var rest = Substring(text)
        while let r = rest.range(of: #"\b(LORD|GOD)\b"#, options: .regularExpression) {
            let word = rest[r]
            out.append((String(rest[..<r.lowerBound]) + String(word.prefix(1)), false))
            out.append((String(word.dropFirst()), true))
            rest = rest[r.upperBound...]
        }
        if !rest.isEmpty { out.append((String(rest), false)) }
        return out
    }
}

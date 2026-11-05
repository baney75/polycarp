import CoreText
import Foundation

/// A theme's font family resolved to one face of the weight asked for. A family name alone is not
/// enough: `Font.custom` takes a face's name (the Nerd Font's regular face is not named like its
/// family), and a nudge up or down from one face (`NSFontManager.convertWeight`) ignores the weight
/// the surface asked for, so a launcher's regular text came out light.
public enum FontFace {
    /// Core Text's weight scale (-1...1) for each weight a surface asks for.
    public static func trait(_ w: TextWeight) -> Double {
        switch w {
        case .regular: 0
        case .medium: 0.23
        case .semibold: 0.3
        case .bold: 0.4
        case .heavy: 0.56
        }
    }

    /// The families this Mac has, by name.
    public static var installedFamilies: Set<String> {
        Set((CTFontManagerCopyAvailableFontFamilyNames() as? [String]) ?? [])
    }

    /// The first family in `families` that is installed, as one face: the upright one whose weight is
    /// nearest `weight`. Nil when none is installed.
    public static func resolve(families: [String], weight: TextWeight, size: Double) -> CTFont? {
        guard let family = firstAvailable(families, installed: installedFamilies) else { return nil }
        if family == systemSerif { return systemSerifFace(weight: weight, size: size) }
        if family == systemMonospace { return systemMonospaceFace(weight: weight, size: size) }
        let query = CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: family] as CFDictionary)
        guard let faces = CTFontDescriptorCreateMatchingFontDescriptors(query, nil) as? [CTFontDescriptor] else { return nil }
        let upright = faces.filter { !isItalic($0) }
        let want = trait(weight)
        let best = (upright.isEmpty ? faces : upright).min { abs(weightTrait($0) - want) < abs(weightTrait($1) - want) }
        return best.map { CTFontCreateWithFontDescriptor($0, CGFloat(size), nil) }
    }

    /// The first name in `families` this Mac can draw, spelled the way the Mac spells it. Family names
    /// match without regard to case, as they do in CSS, so `georgia` finds Georgia on every surface. An
    /// exact match wins, so a catalog theme's font resolves as it always did.
    static func firstAvailable(_ families: [String], installed: Set<String>) -> String? {
        var byLowercase: [String: String] = [:]
        for name in installed.sorted() where byLowercase[name.lowercased()] == nil { byLowercase[name.lowercased()] = name }
        for family in families {
            if family == systemSerif || family == systemMonospace || installed.contains(family) { return family }
            if let spelled = byLowercase[family.lowercased()] { return spelled }
        }
        return nil
    }

    /// A stand-in family name in a list for "the system's serif face" (New York), which is no installed family
    /// and has no name Core Text lists. It always resolves, so a stack ending in `serif` draws serif.
    public static let systemSerif = ".AppleSystemUIFontSerif"

    /// The same stand-in for the system's monospaced face (SF Mono), so a stack ending in `monospace` draws monospace.
    public static let systemMonospace = ".AppleSystemUIFontMonospaced"

    /// The system font in its serif design, at the weight nearest `weight`.
    public static func systemSerifFace(weight: TextWeight, size: Double) -> CTFont? {
        systemFace(design: "NSCTFontUIFontDesignSerif", weight: weight, size: size)
    }

    /// The system font in its monospaced design, at the weight nearest `weight`.
    public static func systemMonospaceFace(weight: TextWeight, size: Double) -> CTFont? {
        systemFace(design: "NSCTFontUIFontDesignMonospaced", weight: weight, size: size)
    }

    private static func systemFace(design: String, weight: TextWeight, size: Double) -> CTFont? {
        guard let ui = CTFontCreateUIFontForLanguage(.system, CGFloat(size), nil) else { return nil }
        let traits: [CFString: Any] = ["NSCTFontUIFontDesignTrait" as CFString: design, kCTFontWeightTrait: trait(weight)]
        let d = CTFontDescriptorCreateCopyWithAttributes(CTFontCopyFontDescriptor(ui), [kCTFontTraitsAttribute: traits] as CFDictionary)
        return CTFontCreateWithFontDescriptor(d, CGFloat(size), nil)
    }

    /// A face's weight on Core Text's scale.
    public static func weight(of font: CTFont) -> Double { weightTrait(CTFontCopyFontDescriptor(font)) }

    private static func traits(_ d: CTFontDescriptor) -> [CFString: Any] {
        (CTFontDescriptorCopyAttribute(d, kCTFontTraitsAttribute) as? [CFString: Any]) ?? [:]
    }

    private static func weightTrait(_ d: CTFontDescriptor) -> Double {
        (traits(d)[kCTFontWeightTrait] as? NSNumber)?.doubleValue ?? 0
    }

    private static func isItalic(_ d: CTFontDescriptor) -> Bool {
        let symbolic = (traits(d)[kCTFontSymbolicTrait] as? NSNumber)?.uint32Value ?? 0
        return symbolic & CTFontSymbolicTraits.traitItalic.rawValue != 0
    }
}

/// What a surface draws in when no face resolves for a theme's font family. `system-sans` is the system
/// font and a Polycarp theme's own family key (`PolycarpTheme.fontKey`) falls back to it; every other
/// catalog family keeps the monospaced system font it always had.
public enum FontFallback: Equatable, Sendable {
    case proportional, monospaced

    public static func forFamily(_ key: String) -> FontFallback {
        key == "system-sans" || key == PolycarpTheme.fontKey ? .proportional : .monospaced
    }
}

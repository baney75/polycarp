import Foundation

/// What the voice part of Polycarp is called: Silas. The older separate app is "the Silas app" wherever the two need telling
/// apart. "Dictation" is an activity ("Dictation is paused"), never the product's name.
public enum SilasName {
    public static let name = "Silas"
    /// The first thing a person reads about it.
    public static let description = "Silas: hold a key, speak and it types."
    // The older separate app is `Product.Silas.phrase` ("the Silas app"); `LegacyHandover.sentence` capitalizes it at the start of a sentence.
    /// The first line of the menu: Silas's state.
    public static func menuTitle(_ state: String) -> String { "\(name): \(state)" }
}

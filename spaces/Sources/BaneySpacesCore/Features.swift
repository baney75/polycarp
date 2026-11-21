import Foundation

/// The parts of Polycarp, as the permission catalog names who uses what. Workspaces is the only one, and it is always on:
/// nothing turns it off, and an old `features.toml` (written while the browser or dictation was a part) is not read.
public enum Feature: String, CaseIterable, Sendable {
    case workspaces
}

public struct FeatureSet: Equatable, Sendable {
    public var on: Set<Feature>

    public init(_ on: Set<Feature>) { self.on = on }
    public static let all = FeatureSet(Set(Feature.allCases))

    public func contains(_ feature: Feature) -> Bool { on.contains(feature) }
}

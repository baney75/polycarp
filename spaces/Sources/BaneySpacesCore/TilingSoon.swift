/// When tiling looks next. A look asked for sooner than the one pending takes its place; a later one waits for it, so a
/// slow retry never holds up a new window.
public enum TilingSoon {
    /// Whether a look due at `asked` replaces the one pending, due at `pending` (nil when none is).
    public static func replaces(pending: Double?, asked: Double) -> Bool { pending.map { asked < $0 } ?? true }
}

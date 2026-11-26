/// The tiling keys Polycarp takes from macOS now, of the ones the person has.
public struct TilingShortcuts: Equatable, Sendable {
    public struct Key: Equatable, Sendable {
        public let name: String
        public let chord: KeyChord
    }

    public let keys: [Key]
    /// Commands whose key is left to VoiceOver while it is on: ⌃⌥ is how it is spoken to.
    public let toVoiceOver: [String]

    /// Only the key that turns tiling on is taken while no workspace tiles, so the rest stay the front app's. `keep` are
    /// commands whose key stays: a window off the scratchpad, or one pinned, can always be got back.
    public init(_ t: Surfaces.Tiling, voiceOver: Bool, keep: Set<String> = []) {
        var mine: [Key] = [], its: [String] = []
        for command in TilingKeys.all where t.anywhere || command.name == "toggle" || keep.contains(command.name) {
            guard let chord = t.keys[command.name] else { continue }
            if voiceOver, chord.modifiers.isSuperset(of: [.ctrl, .opt]) { its.append(command.name) } else { mine.append(Key(name: command.name, chord: chord)) }
        }
        (keys, toVoiceOver) = (mine, its)
    }
}

public extension Surfaces.Tiling {
    /// The writes to surfaces.json that give `name` the key `text` ("" for none). A command that has the key now gives it
    /// up first, so the file holds no two commands on one key after any of them.
    func keyWrites(giving name: String, _ text: String) -> [(path: String, value: SurfaceValue)] {
        let others = KeyChord(text).map { c in keys.filter { $0.key != name && $0.value == c }.map(\.key).sorted() } ?? []
        return others.map { ("tiling.keys." + $0, SurfaceValue.string("")) } + [("tiling.keys." + name, .string(text))]
    }
}

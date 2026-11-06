import Foundation

/// When Polycarp's voice listens for the dictation key. Plain decisions, tested without the library.
///
/// Silas stays the working dictation until Polycarp's has worked: Polycarp takes the key only when the person has voice
/// on, a speech model is installed (an imported Silas model counts) and the import from Silas has finished. Until then
/// no key is listened to, Silas is left alone, and the Voice tab says what is missing.
public enum VoiceGate {
    /// The person's own switch survives a restart.
    public static let enabledKey = "voiceEnabled"

    public static func userEnabled(_ defaults: UserDefaults) -> Bool { defaults.object(forKey: enabledKey) as? Bool ?? true }

    public enum Reason: Equatable, Sendable {
        /// The person turned dictation off. Only the person turns it back on.
        case userOff
        /// No speech model yet.
        case needsModel
        /// Silas's data hasn't finished coming across.
        case importPending
        /// Silas has the key right now. Clears when Silas quits.
        case silasRunning
    }

    public enum Decision: Equatable, Sendable {
        case start
        case wait(Reason)
    }

    /// Whether Polycarp would take the key if Silas weren't in the way: voice on, a model, the import done. This is also
    /// what lets Polycarp ask a running Silas to quit; while it's false Silas is never touched.
    public static func takesOver(userEnabled: Bool, modelInstalled: Bool, importFinished: Bool) -> Reason? {
        if !userEnabled { return .userOff }
        if !importFinished { return .importPending }
        if !modelInstalled { return .needsModel }
        return nil
    }

    public static func decide(userEnabled: Bool, modelInstalled: Bool, importFinished: Bool, silasPids: [Int32]) -> Decision {
        if let why = takesOver(userEnabled: userEnabled, modelInstalled: modelInstalled, importFinished: importFinished) { return .wait(why) }
        return silasPids.isEmpty ? .start : .wait(.silasRunning)
    }

    /// THE gate. Polycarp's dictation is taking over right now only when voice is on, a finished model is in Polycarp's own
    /// folder and the import from Silas is really finished (not pending, not half done). The engine, the watcher and the
    /// launch alert all ask this, so none of them can ask Silas to quit while the other would leave it working.
    public static func takesOverNow(userEnabled: Bool, voiceDir: URL, silasDir: URL) -> Bool {
        takesOver(userEnabled: userEnabled, modelInstalled: hasModel(in: [voiceDir]),
                  importFinished: VoiceImport.isFinished(silasDir: silasDir, newDir: voiceDir)) == nil
    }

    /// What the Voice tab and the menu say while the key isn't listened to. Nil for a person's own Off (the switch says it).
    public static func message(_ r: Reason) -> String? {
        switch r {
        case .userOff: nil
        case .needsModel: "Dictation is waiting for a speech model. Download one in Settings > Silas."
        case .importPending: "Dictation is waiting for \(Product.Silas.phrase)'s data to finish coming across. It tries again the next time \(Product.name) starts."
        case .silasRunning: LegacyHandover.silasRunningReason
        }
    }

    /// Any speech model whose download finished (`.complete`), in the folders given: Polycarp's own and, before the
    /// import has run, Silas's.
    public static func hasModel(in supportDirs: [URL]) -> Bool {
        let fm = FileManager.default
        for dir in supportDirs {
            let models = dir.appendingPathComponent(VoiceImport.modelsFolder, isDirectory: true)
            for name in (try? fm.contentsOfDirectory(atPath: models.path)) ?? []
            where fm.fileExists(atPath: models.appendingPathComponent(name).appendingPathComponent(".complete").path) { return true }
        }
        return false
    }
}

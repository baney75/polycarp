import Foundation

/// What the player shows a file as. Foundation only and decided by the file's extension, so the type check costs no disk
/// read and a Windows build can use it as is (spec/player.md, R-P1).
public enum MediaKind: String, Codable, Sendable, CaseIterable {
    case audio, video, photo

    /// Whether it has a time line: play, pause, seek, volume, Now Playing.
    public var timed: Bool { self != .photo }
}

public enum PlayerMedia {
    public static let audio: Set<String> = ["mp3", "m4a", "flac", "wav", "aac"]
    public static let video: Set<String> = ["mp4", "mov", "m4v", "mkv"]
    /// The camera raw formats ImageIO decodes, by their usual extensions.
    public static let raw: Set<String> = ["dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2",
                                          "pef", "srw", "3fr", "erf", "iiq", "rwl", "raw"]
    public static let photo: Set<String> = Set(["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"]).union(raw)

    /// Extensions macOS's AVFoundation may refuse. The player tries them and says so when it can't, rather than
    /// leaving a black window.
    public static let maybeUnplayable: Set<String> = ["mkv"]

    public static func kind(ofExtension ext: String) -> MediaKind? {
        let e = ext.lowercased()
        if audio.contains(e) { return .audio }
        if video.contains(e) { return .video }
        if photo.contains(e) { return .photo }
        return nil
    }

    /// The kind of the file at `path` (a path or a bare name), or nil when the player doesn't open it.
    public static func kind(of path: String) -> MediaKind? {
        kind(ofExtension: (path as NSString).pathExtension)
    }

    /// The line the player shows when the system can't play a file it opened.
    public static func cannotPlay(_ path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        if maybeUnplayable.contains(ext) {
            return "macOS can't play this .\(ext) file. AVFoundation opens only some \(ext) files; IINA or VLC plays the rest."
        }
        return ext.isEmpty ? "macOS can't play this file." : "macOS can't play this .\(ext) file."
    }

    /// Every extension the player opens, for help text: sorted, comma separated.
    public static var extensionList: String {
        (audio.union(video).union(photo)).sorted().joined(separator: ", ")
    }
}

/// Positions as the player's bar shows them: "0:05", "12:34", "1:02:03".
public enum PlayerTime {
    public static func format(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let s = Int(seconds.rounded(.down))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        let ss = sec < 10 ? "0\(sec)" : "\(sec)"
        if h > 0 { return "\(h):\(m < 10 ? "0\(m)" : "\(m)"):\(ss)" }
        return "\(m):\(ss)"
    }
}

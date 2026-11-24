import Foundation

/// `polycarp-spaces skill install`: the agent skill from the app bundle into ~/.claude/skills/polycarp-spaces.
/// The skill was installed as `baneyspaces` before; that copy goes once the new one is written, but only when it is
/// the product's own (its frontmatter says `name: baneyspaces`). Anything else under the old name stays.
public enum SkillInstall {
    public static let name = "polycarp-spaces"
    public static let oldName = "baneyspaces"

    public static func dest(home: URL) -> URL {
        home.appendingPathComponent(".claude/skills/\(name)/SKILL.md")
    }

    public static func oldDir(home: URL) -> URL {
        home.appendingPathComponent(".claude/skills/\(oldName)")
    }

    /// True when the frontmatter's `name:` line is exactly `name: baneyspaces`, the text the product installed before
    /// the rename. A hand copy under another name, text with no frontmatter, or a quoted name is not ours to remove.
    public static func isOldProductCopy(_ text: String) -> Bool {
        // isNewline, not "\n": Swift reads "\r\n" as one Character.
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        guard lines.first == "---" else { return false }
        for line in lines.dropFirst() {
            if line == "---" { return false }
            guard line.hasPrefix("name:") else { continue }
            return line.dropFirst("name:".count).trimmingCharacters(in: .whitespaces) == oldName
        }
        return false
    }

    /// Writes `bundle` (the app's SKILL.md, nil when it isn't beside the binary) to `dest(home:)`, replacing whatever
    /// file is there. Returns the lines to print.
    public static func install(bundle: Data?, home: URL) -> String {
        guard let bundle else { return "couldn't find SKILL.md beside the binary; install Polycarp with make install" }
        let fm = FileManager.default
        let dest = dest(home: home)
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bundle.write(to: dest, options: .atomic)
        } catch { return "couldn't write \(dest.path): \(error.localizedDescription)" }
        var lines = ["installed \(dest.path)"]
        let old = oldDir(home: home)
        // A real folder only (attributesOfItem doesn't follow a symlink), holding the product's own SKILL.md.
        if (try? fm.attributesOfItem(atPath: old.path)[.type]) as? FileAttributeType == .typeDirectory,
           let text = try? String(contentsOf: old.appendingPathComponent("SKILL.md"), encoding: .utf8),
           isOldProductCopy(text),
           (try? fm.removeItem(at: old)) != nil {
            lines.append("removed \(old.path)")
        }
        return lines.joined(separator: "\n")
    }
}

import CoreServices
import Foundation

/// Puts a new icon file in an app bundle and keeps its code signature whole (spec/themes.md, "The icons"). Finder's own
/// custom icon (`NSWorkspace.setIcon`) adds a resource fork and Finder info, which `codesign --strict` refuses, so the icon
/// goes into the bundle instead: into a copy beside it on the same disk, which is signed again by the same identity with
/// its identifier, entitlements and requirement kept, checked, and only then swapped in at once. Anything that fails leaves
/// the app as it was. Slow (a copy and a signature): never on the main thread.
public enum AppIconSwap {
    public enum Outcome: Equatable, Sendable {
        case changed
        /// The bundle already holds this icon.
        case unchanged
        case refused(String)
    }

    /// The identity that signs the copy, and the keychain it is in; "-" with no keychain signs ad hoc.
    public struct Signer: Equatable, Sendable {
        public let identity: String
        public let keychain: String?

        public init(identity: String, keychain: String?) {
            self.identity = identity
            self.keychain = keychain
        }
    }

    public static func replace(app: URL, icns: Data, signer: Signer) -> Outcome {
        let fm = FileManager.default
        guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              var name = info["CFBundleIconFile"] as? String, !name.contains("/")
        else { return .refused("the app names no icon file") }
        if !name.hasSuffix(".icns") { name += ".icns" }
        let icon = "Contents/Resources/\(name)"
        if (try? Data(contentsOf: app.appendingPathComponent(icon))) == icns { return .unchanged }
        guard whole(app) else { return .refused("its signature is not whole now, so it is left alone") }
        guard let requirement = requirement(app), let before = cdhash(app) else { return .refused("its signature can't be read") }
        // Only the code's own hash: a new signature would be a new app to macOS, which then asks for its permissions again.
        guard !requirement.contains("cdhash") else { return .refused("its signature has no requirement of its own") }
        let folder: URL
        do {
            folder = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true)
        } catch { return .refused("no room beside it: \(error.localizedDescription)") }
        defer { try? fm.removeItem(at: folder) }
        let copy = folder.appendingPathComponent(app.lastPathComponent)
        do {
            try fm.copyItem(at: app, to: copy)
            try icns.write(to: copy.appendingPathComponent(icon), options: .atomic)
        } catch { return .refused("the copy failed: \(error.localizedDescription)") }
        var sign = ["--force", "--preserve-metadata=identifier,entitlements,requirements,flags,runtime", "--sign", signer.identity]
        if let keychain = signer.keychain { sign += ["--keychain", keychain] }
        guard run(sign + [copy.path]).status == 0 else { return .refused("signing the copy failed") }
        guard whole(copy) else { return .refused("the signed copy is not whole") }
        guard self.requirement(copy) == requirement else { return .refused("the copy's requirement is not the app's") }
        // An update that went in meanwhile is newer than the copy: keep it.
        guard cdhash(app) == before else { return .refused("the app changed meanwhile") }
        guard renamex_np(copy.path, app.path, UInt32(RENAME_SWAP)) == 0 else {
            return .refused("the swap failed: \(String(cString: strerror(errno)))")
        }
        // Finder, the Dock and Spotlight look again at a bundle whose date moved.
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: app.path)
        LSRegisterURL(app as CFURL, true)
        return .changed
    }

    /// `codesign --verify --deep --strict`.
    public static func whole(_ app: URL) -> Bool {
        run(["--verify", "--deep", "--strict", app.path]).status == 0
    }

    /// The designated requirement, as `codesign -d -r-` prints it; an implied one (ad hoc) starts with "# ".
    public static func requirement(_ app: URL) -> String? {
        let out = run(["-d", "-r-", app.path])
        guard out.status == 0 else { return nil }
        return out.text.split(separator: "\n").first { $0.hasPrefix("designated =>") || $0.hasPrefix("# designated =>") }.map(String.init)
    }

    static func cdhash(_ app: URL) -> String? {
        let out = run(["-d", "-vvv", app.path])
        guard out.status == 0 else { return nil }
        return out.text.split(separator: "\n").first { $0.hasPrefix("CDHash=") }.map(String.init)
    }

    /// codesign with these arguments: its exit status and everything it printed.
    static func run(_ arguments: [String]) -> (status: Int32, text: String) {
        let p = Process(), pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        p.arguments = arguments
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, "") }
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return (p.terminationStatus, text)
    }
}

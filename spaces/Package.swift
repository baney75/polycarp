// swift-tools-version: 5.9
import Foundation
import PackageDescription

// An absolute path, because the linker's working directory isn't always the package's.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

// The terminal (libghostty, built by scripts/build-ghostty.sh into ghostty/lib, Apple silicon only). It links when the
// library is there; POLYCARP_TERMINAL=0 leaves it out (bundle.sh does for universal builds) and =1 asks for it. Without
// it the Terminal code compiles out and says "terminal not built". The environment is part of SwiftPM's manifest cache
// key, a file's existence isn't: after a first build of the library, pass POLYCARP_TERMINAL=1 once.
let ghosttyLib = "\(root)/ghostty/lib"
let terminal: Bool = {
    switch ProcessInfo.processInfo.environment["POLYCARP_TERMINAL"] {
    case "0": return false
    case "1": return true
    default: return FileManager.default.fileExists(atPath: "\(ghosttyLib)/libghostty.a")
    }
}()

let package = Package(
    name: "BaneySpaces",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "BaneySpaces", targets: ["BaneySpaces"]),
        .executable(name: "baneyspaces-cli", targets: ["baneyspaces-cli"]),
    ],
    targets: [
        // The launcher's matcher and ranking: Foundation only, no Apple frameworks, so other platforms
        // can build it as is. The rules it follows are written in spec/launcher.md. Optimized in
        // debug builds too, so `swift test` times the matcher as it ships (LatencyTests).
        .target(name: "LauncherMatch", swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]),
        // The launcher's people matcher (docs/contacts.md): no Foundation, optimized in debug builds too, so
        // `swift test` times it as it ships (ContactsSpeedTests).
        .target(name: "ContactsMatch", swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]),
        // The launcher's matcher for the browser's tabs, bookmarks, history and downloads: no Foundation, optimized in
        // debug builds too, so `swift test` times it as it ships (BrowserTableTests).
        .target(name: "BrowserMatch", swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]),
        // Which window lives where, and where hidden windows go: no AppKit, fully unit-tested.
        .target(name: "BaneySpacesCore", dependencies: ["BrowserMatch", "ContactsMatch"]),
        // libghostty's C header, as upstream ships it at the pin (build-ghostty.sh checks it is the same).
        .systemLibrary(name: "CGhostty", path: "Sources/CGhostty"),
        // The menu bar app: hotkeys, Accessibility and moving real windows.
        .executableTarget(
            name: "BaneySpaces",
            dependencies: ["BaneySpacesCore"] + (terminal ? ["CGhostty"] : []),
            swiftSettings: terminal ? [.define("POLYCARP_TERMINAL")] : [],
            linkerSettings: terminal
                ? [.unsafeFlags(["-L\(ghosttyLib)", "-lghostty", "-lc++"])]
                    + ["Carbon", "CoreText", "CoreVideo", "IOSurface", "Metal", "QuartzCore"].map { .linkedFramework($0) }
                : []),
        // `baneyspaces`, the command for hooks, agents and you. Foundation only, so it starts in milliseconds.
        .executableTarget(name: "baneyspaces-cli", dependencies: ["BaneySpacesCore"]),
        .testTarget(name: "BaneySpacesCoreTests", dependencies: ["BaneySpacesCore", "BrowserMatch"]),
        // The ranking table and the 2,000-entry latency check for the launcher's matcher.
        .testTarget(name: "LauncherMatchTests", dependencies: ["LauncherMatch"]),
    ]
)

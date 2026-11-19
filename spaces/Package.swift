// swift-tools-version: 5.9
import Foundation
import PackageDescription

// agent-desktop's C library, built by scripts/build-engine.sh into engine/lib. Nothing calls it since computer use moved
// to Tychicus; it stays linked until the engine wiring (build, bundle, release, update) is taken out on its own.
// An absolute path, because the linker's working directory isn't always the package's.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

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
        // Which window lives where, and where hidden windows go: no AppKit, fully unit-tested.
        .target(name: "BaneySpacesCore"),
        // agent-desktop's C header (see the note at the top).
        .systemLibrary(name: "CAgentDesktop", path: "Sources/CAgentDesktop"),
        // The menu bar app: hotkeys, Accessibility and moving real windows.
        // The engine's library sits in Contents/Frameworks in the bundle; `engine/lib` is where a
        // `swift build` finds it.
        .executableTarget(
            name: "BaneySpaces",
            dependencies: ["BaneySpacesCore", "CAgentDesktop"],
            linkerSettings: [
                .unsafeFlags([
                    "-L\(root)/engine/lib", "-lagent_desktop_ffi",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "\(root)/engine/lib",
                ]),
            ]),
        // `baneyspaces`, the command for hooks, agents and you. Foundation only, so it starts in milliseconds.
        .executableTarget(name: "baneyspaces-cli", dependencies: ["BaneySpacesCore"]),
        .testTarget(name: "BaneySpacesCoreTests", dependencies: ["BaneySpacesCore"]),
        // The ranking table and the 2,000-entry latency check for the launcher's matcher.
        .testTarget(name: "LauncherMatchTests", dependencies: ["LauncherMatch"]),
    ]
)

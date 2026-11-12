// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The hands engine (agent-desktop's C library, built by scripts/build-engine.sh into engine/lib).
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
        // Which window lives where, and where hidden windows go: no AppKit, fully unit-tested.
        .target(name: "BaneySpacesCore"),
        // agent-desktop's C header, for the hands engine in the app.
        .systemLibrary(name: "CAgentDesktop", path: "Sources/CAgentDesktop"),
        // The voice core's C header (core/ffi). The library, scripts/build-core.sh's core-lib/libpolycarp_core.a,
        // is linked into the BaneySpaces target, so dictation runs inside the app's own process.
        .target(name: "CPolycarpCore"),
        // The agent cursor's renderer: Core Animation layers in click-through overlay panels. AppKit, no SwiftUI.
        .target(name: "BaneySpacesCursor", dependencies: ["BaneySpacesCore"]),
        // The menu bar app: hotkeys, Accessibility, moving real windows, and the hands agents use.
        // The engine's library sits in Contents/Frameworks in the bundle; `engine/lib` is where a
        // `swift build` finds it.
        .executableTarget(
            name: "BaneySpaces",
            dependencies: ["BaneySpacesCore", "BaneySpacesCursor", "CAgentDesktop", "CPolycarpCore"],
            linkerSettings: [
                .unsafeFlags([
                    "-L\(root)/engine/lib", "-lagent_desktop_ffi",
                    // The voice core is a static library; these are the system pieces its Rust dependencies use.
                    "-L\(root)/core-lib", "-lpolycarp_core", "-lc++", "-liconv",
                    "-framework", "CoreML", "-framework", "Metal", "-framework", "IOKit",
                    "-framework", "AudioToolbox", "-framework", "CoreAudio", "-framework", "AVFoundation",
                    "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CoreFoundation",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "\(root)/engine/lib",
                ]),
            ]),
        // `baneyspaces`, the command for hooks, agents and you. Foundation only, so it starts in milliseconds.
        .executableTarget(name: "baneyspaces-cli", dependencies: ["BaneySpacesCore"]),
        // `swift run -c release cursor-probe`: 100 glides on an offscreen overlay, frame times and the real pointer.
        .executableTarget(name: "cursor-probe", dependencies: ["BaneySpacesCore", "BaneySpacesCursor"],
                          // scripts/ holds many files; the cursor probe is the only one SwiftPM builds. Named here, not
                          // found by listing the folder: SwiftPM caches the evaluated manifest, so a list made while the
                          // manifest runs goes stale when a script is added, and the new script is then compiled into
                          // this target (PR 146 broke `make install` that way).
                          path: "scripts", sources: ["cursor-probe.swift"]),
        .testTarget(name: "BaneySpacesCoreTests", dependencies: ["BaneySpacesCore"]),
        // The overlay's real layers: marks attached, cursors surviving a display change, the panel never key or main.
        .testTarget(name: "BaneySpacesCursorTests", dependencies: ["BaneySpacesCore", "BaneySpacesCursor"]),
    ]
)

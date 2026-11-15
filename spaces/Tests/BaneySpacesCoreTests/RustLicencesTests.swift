import Foundation
import XCTest

/// The app links Rust crates (the polycarp command, the voice core, the hands engine) and must carry their licences.
/// Before scripts/rust-licenses.py, the licenses folder named none of them.
final class RustLicencesTests: XCTestCase {
    func testBundleWritesAndRequiresTheRustCratesLicences() throws {
        let bundle = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("scripts/bundle.sh"), encoding: .utf8)
        XCTAssertTrue(bundle.contains("scripts/rust-licenses.py --out \"$APP/Contents/Resources/licenses/polycarp-rust-crates.txt\""), "bundle.sh writes it")
        for root in ["../cli/Cargo.toml:polycarp", "../core/ffi/Cargo.toml:polycarp-core", "engine/.src/Cargo.toml:agent-desktop-ffi"] {
            XCTAssertTrue(bundle.contains(root), "every Rust piece the app ships: \(root)")
        }
        XCTAssertTrue(bundle.contains("[ -s \"$APP/Contents/Resources/licenses/polycarp-rust-crates.txt\" ] ||"), "bundle.sh refuses an app without them")
    }

    /// A workspace of path crates only, so cargo needs no network: the shipped crate's normal dependencies are listed with
    /// their licence text; dev and build dependencies, and our own path crates, are not.
    func testOnlyTheLinkedCratesAreListedWithTheirLicenceText() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("rust-licences-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        func crate(_ path: String, _ toml: String, files: [String: String] = [:]) throws {
            let dir = tmp.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("src"), withIntermediateDirectories: true)
            try ("[package]\n" + toml).write(to: dir.appendingPathComponent("Cargo.toml"), atomically: true, encoding: .utf8)
            try "".write(to: dir.appendingPathComponent("src/lib.rs"), atomically: true, encoding: .utf8)
            for (name, text) in files { try text.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8) }
        }
        let pkg = { (name: String) in "name = \"\(name)\"\nversion = \"1.0.0\"\nedition = \"2021\"\n" }
        try crate("own/app", pkg("app") + """
        [dependencies]
        dep = { path = "../../third/dep" }
        mine = { path = "../mine" }
        [dev-dependencies]
        devdep = { path = "../../third/devdep" }
        [build-dependencies]
        builddep = { path = "../../third/builddep" }
        """)
        try crate("own/mine", pkg("mine"), files: ["LICENSE": "our own code"])
        try crate("third/dep", pkg("dep") + "license = \"MIT\"\n[dependencies]\nnolic = { path = \"../nolic\" }\n", files: ["LICENSE-MIT": "dep licence text"])
        try crate("third/nolic", pkg("nolic") + "license = \"MIT\"\nauthors = [\"Ann Author\"]\n")
        try crate("third/devdep", pkg("devdep"), files: ["LICENSE": "devdep licence text"])
        try crate("third/builddep", pkg("builddep"), files: ["LICENSE": "builddep licence text"])

        let manifest = tmp.appendingPathComponent("own/app/Cargo.toml").path
        guard try run(["cargo", "generate-lockfile", "--offline", "--manifest-path", manifest]) == 0 else { throw XCTSkip("cargo isn't usable here") }
        let out = tmp.appendingPathComponent("out.txt")
        let script = HandsSourceTests.root.appendingPathComponent("scripts/rust-licenses.py").path
        XCTAssertEqual(try run(["python3", script, "--out", out.path, "--own", tmp.appendingPathComponent("own").path, manifest + ":app"]), 0)
        let text = try String(contentsOf: out, encoding: .utf8)
        XCTAssertTrue(text.contains("dep 1.0.0 (MIT)\n" + String(repeating: "=", count: 72) + "\ndep licence text"), text)
        XCTAssertTrue(text.contains("nolic 1.0.0 (MIT)") && text.contains("Copyright Ann Author."), "a dependency's dependency, credited without a file: \(text)")
        for absent in ["devdep", "builddep", "our own code", "app 1.0.0", "mine 1.0.0"] {
            XCTAssertFalse(text.contains(absent), "\(absent) isn't linked or is ours: \(text)")
        }
    }

    private func run(_ args: [String]) throws -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        return p.terminationStatus
    }
}

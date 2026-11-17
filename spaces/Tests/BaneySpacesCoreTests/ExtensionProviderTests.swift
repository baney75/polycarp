import XCTest
@testable import BaneySpacesCore

final class ExtensionProviderTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-ext-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    /// An extension folder with a manifest and an executable `run.sh`.
    @discardableResult
    private func make(_ id: String, manifest: String, script: String) throws -> URL {
        let dir = root.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try manifest.write(to: dir.appendingPathComponent("extension.toml"), atomically: true, encoding: .utf8)
        let s = dir.appendingPathComponent("run.sh")
        try ("#!/bin/sh\n" + script).write(to: s, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: s.path)
        return dir
    }

    private func ext(_ id: String, _ manifest: String, _ script: String) throws -> ScriptExtension {
        let dir = try make(id, manifest: manifest, script: script)
        return try ScriptExtension.parse(manifest, id: id, folder: dir)
    }

    func testTheProviderOffersRunsOnReturnAndShowsTheOutput() throws {
        try make("wc", manifest: "title = \"Word Count\"\nkeyword = \"wc\"\ncommand = [\"./run.sh\"]\n",
                 script: "printf '%s' \"$1\" | wc -w | tr -d ' '\n")
        try make("broken", manifest: "title = ", script: "")
        try make("zdup", manifest: "title = \"Dup\"\nkeyword = \"WC\"\ncommand = [\"./run.sh\"]\n", script: "")
        let store = LauncherExtensionStore(folder: root)
        let p = ExtensionProvider(store: store)
        p.opened()
        XCTAssertEqual(store.extensions.map(\.id), ["wc"])
        XCTAssertEqual(store.problems.count, 2)

        let offer = p.results(for: "wc  the quick brown fox ")
        XCTAssertEqual(offer.map(\.action), [.runExtension(query: "wc the quick brown fox")])
        XCTAssertEqual(offer.first?.placement, .top)
        XCTAssertEqual(p.results(for: "word co").first?.placement, .normal)
        XCTAssertEqual(p.results(for: "w"), [])
        XCTAssertEqual(p.results(for: "wcx"), [])

        let done = expectation(description: "ran")
        p.run("wc the quick brown fox") { done.fulfill() }
        wait(for: [done], timeout: 10)
        let out = p.results(for: "wc the quick  brown fox".replacingOccurrences(of: "  ", with: " "))
        XCTAssertEqual(out.map(\.title), ["4"])
        XCTAssertEqual(out.first?.action, .copy("4"))
        // Typing on drops the old output.
        XCTAssertEqual(p.results(for: "wc the quick brown fox jumps").map(\.action), [.runExtension(query: "wc the quick brown fox jumps")])

        let menu = p.listing("")
        XCTAssertEqual(menu.first?.action, .fill("wc "))
        XCTAssertEqual(menu.last?.action, .command(provider: "extensions", id: "folder"))

        // A new extension shows in the main search without opening the menu.
        try make("upper", manifest: "title = \"Upper\"\nkeyword = \"up\"\ncommand = [\"tr\", \"a-z\", \"A-Z\"]\n", script: "")
        XCTAssertEqual(ExtensionProvider(store: LauncherExtensionStore(folder: root)).results(for: "up x").map(\.action), [.runExtension(query: "up x")])
    }

    func testTheLauncherRunsThemAndFindsTheFolder() throws {
        let src = try String(contentsOfFile: LauncherProviderSeamTests.source("Sources/BaneySpaces/Launcher.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("case .runExtension(let query)"))
        XCTAssertEqual(LauncherExtensionStore.defaultFolder(env: ["POLYCARP_CONFIG_DIR": "/tmp/pc"])?.path, "/tmp/pc/extensions")
        XCTAssertTrue(LauncherProviders.standard(env: ["POLYCARP_CONFIG_DIR": "/tmp/pc"]).contains { $0.name == "extensions" })
    }
}

final class ProviderMemoryTests: XCTestCase {
    private func footprint() -> Int64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
    }

    func testAllProvidersWithAFullClipboardHistoryAddUnder5MB() {
        let before = footprint()
        let providers = LauncherProviders.standard()
        var history = ClipboardHistory()
        let chunk = String(repeating: "x", count: 10_000)
        for i in 0..<400 { history.add("\(i) \(chunk)", at: Date(), app: nil) }
        for q in ["12*7", "5 km in mi", "move 3", "fill", ";date", "wc hello", "safari"] {
            for _ in 0..<50 { _ = LauncherProviders.results(providers, for: q) }
        }
        let added = footprint() - before
        print("launcher providers memory: +\(added / 1024) KB with clipboard history full (\(history.entries.count) entries, \(history.entries.reduce(0) { $0 + $1.text.utf8.count } / 1024) KB of text)")
        XCTAssertLessThan(added, 5 * 1024 * 1024)
        withExtendedLifetime((providers, history)) {}
    }
}

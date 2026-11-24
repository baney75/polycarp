import Foundation
import XCTest

/// Polycarp's browser extension is the one in extension/, staged into Contents/Resources/extension. The old agent side
/// panel (its copy in ~/Library/Application Support/Polycarp/Extension, the bundled polycarp-browser host and its
/// native messaging manifests) was removed; nothing here may install or update any of it again.
final class OldBrowserExtensionTests: XCTestCase {
    private let old = ["Polycarp/Extension", "Extension.stamp", "ExtensionCopy", "Resources/browser", "polycarp-browser",
                       "com.polycarp.browser", "ai.tabkyra.bridge"]

    private func files(_ dir: String, _ ext: String) -> [URL] {
        let base = SourceText.root.appendingPathComponent(dir)
        let all = FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        return all.filter { $0.pathExtension == ext }
    }

    func testNothingInstallsTheOldSidePanel() throws {
        let sources = files("Sources", "swift")
        XCTAssertFalse(sources.isEmpty)
        // install-app.sh and uninstall.sh only take the old pieces away, so they may name them.
        let shipping = sources + files("scripts", "sh").filter { $0.lastPathComponent != "install-app.sh" }
            + [SourceText.root.appendingPathComponent("extension/scripts/stage.sh")]
        for url in shipping {
            let text = try String(contentsOf: url, encoding: .utf8)
            for name in old {
                XCTAssertFalse(text.contains(name), "\(url.lastPathComponent) names \(name)")
            }
        }
    }

    func testTheOneExtensionIsStagedIntoTheApp() throws {
        let bundle = try String(contentsOf: SourceText.root.appendingPathComponent("scripts/bundle.sh"), encoding: .utf8)
        XCTAssertTrue(bundle.contains(#"Contents/Resources/extension""#))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(contentsOf: SourceText.root.appendingPathComponent("extension/manifest.json"))) as? [String: Any])
        XCTAssertEqual(manifest["name"] as? String, "Polycarp")
        XCTAssertNil(manifest["side_panel"], "the side panel left with the agent extension")
    }
}

import BaneySpacesCore
import CryptoKit
import JavaScriptCore
import XCTest

/// The new tab page's own files (extension/newtab): the field logic run as the page runs it, and the manifest the host
/// trusts.
final class NewTabPageTests: XCTestCase {
    private func logic() throws -> JSContext {
        let ctx = try XCTUnwrap(JSContext())
        ctx.exceptionHandler = { _, e in XCTFail("logic.js threw: \(e?.toString() ?? "?")") }
        ctx.evaluateScript(try Repo.text("extension/newtab/logic.js"))
        return ctx
    }

    private func act(_ ctx: JSContext, _ typed: String, template: String = "https://duckduckgo.com/?q={query}",
                     cmd: Bool = false) -> (kind: String, value: String) {
        let r = ctx.objectForKeyedSubscript("PolycarpNewTab").objectForKeyedSubscript("act")
            .call(withArguments: [typed, template, cmd])!
        let kind = r.objectForKeyedSubscript("kind").toString() ?? ""
        let value = r.objectForKeyedSubscript("url")
        return (kind, value?.isUndefined == false ? value!.toString() : "")
    }

    func testReturnOpensAnAddressAndSearchesEverythingElse() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "  ").kind, "none")
        XCTAssertEqual(act(ctx, "https://dbaney.com/polycarp").value, "https://dbaney.com/polycarp")
        XCTAssertEqual(act(ctx, "dbaney.com").value, "https://dbaney.com")
        XCTAssertEqual(act(ctx, "github.com/baney75/polycarp").value, "https://github.com/baney75/polycarp")
        XCTAssertEqual(act(ctx, "localhost:3000/x").value, "http://localhost:3000/x")
        XCTAssertEqual(act(ctx, "192.168.1.4:8080").value, "http://192.168.1.4:8080")
        let s = act(ctx, "purity of heart")
        XCTAssertEqual(s.kind, "search")
        XCTAssertEqual(s.value, "https://duckduckgo.com/?q=purity%20of%20heart")
        XCTAssertEqual(act(ctx, "Psalm 118:24").kind, "search", "a verse reference is words, not a host")
        XCTAssertEqual(act(ctx, "e.g. lilies").kind, "search", "words with spaces are never an address")
    }

    func testOnlyAWebAddressIsOpened() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "javascript:alert(1)").kind, "search")
        XCTAssertEqual(act(ctx, "data:text/html,hi").kind, "search")
        XCTAssertEqual(act(ctx, "ftp://example.com").kind, "search")
        XCTAssertEqual(act(ctx, "chrome://settings").kind, "search", "a page can't open browser pages")
        XCTAssertEqual(act(ctx, "file:///Users/me/notes.pdf").kind, "search", "nor files")
    }

    func testTheSearchUsesTheConfiguredTemplateOrFallsBack() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "a&b", template: "https://search.brave.com/search?q={query}&source=web").value,
                       "https://search.brave.com/search?q=a%26b&source=web")
        XCTAssertEqual(act(ctx, "x", template: "http://evil.example/?q={query}").value, "https://duckduckgo.com/?q=x",
                       "only an https template with {query}")
        XCTAssertEqual(act(ctx, "x", template: "https://no-slot.example/").value, "https://duckduckgo.com/?q=x")
    }

    /// 2026-11-22: the page never asks what the hour is for. Cmd+Return names nothing; it opens or searches like Return,
    /// and the page has no question, no naming and no workspace chips.
    func testThePageNeverAsksWhatTheHourIsFor() throws {
        let ctx = try logic()
        XCTAssertEqual(act(ctx, "Gannon letter", cmd: true).kind, "search")
        XCTAssertEqual(act(ctx, "dbaney.com", cmd: true).kind, "open")
        for file in ["newtab.html", "newtab.js", "logic.js", "manifest.json"] {
            let text = try Repo.text("extension/newtab/\(file)").lowercased()
            for word in ["this hour", "is for", "purpose", "chips", "op: \"name\"", "op: \"go\"", "one " + "thing"] {
                XCTAssertFalse(text.contains(word), "\(file) still says \(word)")
            }
        }
    }

    /// Chrome derives an unpacked extension's ID from its manifest key; the host's manifest allows only that ID. If the
    /// key and `NewTabHost.extensionID` ever part, the page can't reach Polycarp.
    func testTheManifestKeyGivesTheIDTheHostAllows() throws {
        let data = try XCTUnwrap(Repo.text("extension/newtab/manifest.json").data(using: .utf8))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let key = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(manifest["key"] as? String)))
        let hex = SHA256.hash(data: key).prefix(16).map { String(format: "%02x", $0) }.joined()
        let letters = Array("abcdefghijklmnop")
        let id = String(hex.map { letters[Int(String($0), radix: 16)!] })
        XCTAssertEqual(id, NewTabHost.extensionID)
        XCTAssertEqual((manifest["chrome_url_overrides"] as? [String: String])?["newtab"], "newtab.html")
        XCTAssertEqual(manifest["permissions"] as? [String], ["nativeMessaging"], "nothing beyond talking to Polycarp")
    }

    func testThePageLoadsNothingFromTheNetwork() throws {
        for file in ["newtab.html", "newtab.css", "newtab.js", "logic.js"] {
            let text = try Repo.text("extension/newtab/\(file)")
            for line in text.split(separator: "\n") where line.contains("http://") || line.contains("https://") {
                let s = String(line)
                // logic.js names URL shapes and the fallback search; nothing is fetched from them.
                XCTAssertTrue(file == "logic.js", "\(file): \(s)")
            }
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "\(file): no dashes")
        }
    }
}

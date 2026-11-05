import XCTest
@testable import BaneySpacesCore

/// The product is called Polycarp. The Swift modules keep the name BaneySpaces, so what a person
/// sees is checked here: no string literal in Sources/ may say BaneySpaces unless it is on the list
/// below. Comments are not strings and are not checked.
final class ProductNameTests: XCTestCase {
    /// Files where a string may name BaneySpaces, and why. Keep this short; a new entry needs a reason.
    static let allowed: [String: String] = [
        "Sources/BaneySpacesCore/Product/Product.swift": "the legacy names: migration reads them, nothing shows them",
    ]

    /// Every string literal in Swift source: `"…"`, `#"…"#` and `"""…"""`, with `\(…)` interpolations
    /// kept inside the literal that holds them. Line and block comments are skipped.
    static func literals(in source: String) -> [String] {
        let c = Array(source.unicodeScalars)
        var i = 0
        var found: [String] = []

        func starts(_ s: String, at k: Int) -> Bool {
            let u = Array(s.unicodeScalars)
            return k + u.count <= c.count && Array(c[k..<k + u.count]) == u
        }

        /// Reads the literal starting at `i` (on a `#` or `"`), leaves `i` after it, returns its text.
        func literal() -> String {
            var hashes = 0
            while c[i] == "#" { hashes += 1; i += 1 }
            let pounds = String(repeating: "#", count: hashes)
            let multi = starts("\"\"\"", at: i)
            i += multi ? 3 : 1
            let close = (multi ? "\"\"\"" : "\"") + pounds
            var text = ""
            while i < c.count {
                if starts(close, at: i) { i += close.unicodeScalars.count; return text }
                if c[i] == "\\" && starts("\\" + pounds + "(", at: i) {
                    // An interpolation: code up to its matching paren; strings inside are literals too.
                    i += 2 + hashes
                    var depth = 1
                    text += "\\("
                    while i < c.count && depth > 0 {
                        if c[i] == "\"" || (c[i] == "#" && starts("#\"", at: i)) {
                            found.append(literal())
                            continue
                        }
                        if c[i] == "(" { depth += 1 } else if c[i] == ")" { depth -= 1 }
                        text.unicodeScalars.append(c[i]); i += 1
                    }
                    continue
                }
                if c[i] == "\\" && hashes == 0 && i + 1 < c.count { text.unicodeScalars.append(c[i]); i += 1 }
                text.unicodeScalars.append(c[i]); i += 1
            }
            return text
        }

        while i < c.count {
            if starts("//", at: i) { while i < c.count && c[i] != "\n" { i += 1 }; continue }
            if starts("/*", at: i) {
                var depth = 1; i += 2
                while i < c.count && depth > 0 {
                    if starts("/*", at: i) { depth += 1; i += 2 } else if starts("*/", at: i) { depth -= 1; i += 2 } else { i += 1 }
                }
                continue
            }
            if c[i] == "\"" || (c[i] == "#" && (starts("#\"", at: i) || starts("##\"", at: i))) {
                found.append(literal()); continue
            }
            i += 1
        }
        return found
    }

    private func swiftFiles() -> [URL] {
        let root = Repo.root.appendingPathComponent("Sources")
        let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        return e.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    func testNoStringInSourcesSaysBaneySpaces() throws {
        var hits: [String] = []
        for file in swiftFiles() {
            let rel = String(file.path.dropFirst(Repo.root.path.count + 1))
            if Self.allowed[rel] != nil { continue }
            let text = try String(contentsOf: file, encoding: .utf8)
            for lit in Self.literals(in: text) where lit.contains("BaneySpaces") {
                hits.append("\(rel): \(lit.prefix(90))")
            }
        }
        XCTAssertEqual(hits, [], "A person would read these as the product name. Say Polycarp (or add the file to ProductNameTests.allowed with a reason).")
    }

    func testTheScannerSeesStringsAndSkipsComments() {
        let src = ##"""
        // "BaneySpaces" in a comment
        /* "BaneySpaces" in a block /* nested */ still comment */
        let a = "Hello BaneySpaces"
        let b = #"raw "BaneySpaces" here"#
        let c = """
        multi BaneySpaces
        """
        let d = "x \("inner BaneySpaces") y"
        let e = "plain \"quoted\" text"
        """##
        let lits = Self.literals(in: src)
        XCTAssertEqual(lits.filter { $0.contains("BaneySpaces") }.count, 4, "\(lits)")
        XCTAssertTrue(lits.contains("plain \\\"quoted\\\" text"))
    }

    func testSwiftAndShellAgreeOnTheNames() throws {
        let env = try Repo.text("scripts/product.env")
        func value(_ key: String) -> String? {
            env.split(separator: "\n").first { $0.hasPrefix(key + "=") }
                .map { String($0.dropFirst(key.count + 1)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
        }
        XCTAssertEqual(value("PRODUCT_NAME"), Product.name)
        XCTAssertEqual(value("BUNDLE_ID"), Product.bundleID)
        XCTAssertEqual(value("EXECUTABLE"), Product.name)
        XCTAssertEqual(value("CLI_NAME"), Product.commandName)
        XCTAssertEqual(value("CLI_ALIASES"), Product.commandAliases.joined(separator: " "))
        XCTAssertEqual(value("SUPPORT_FOLDER"), Product.supportFolder)
        XCTAssertEqual(value("LEGACY_NAME"), Product.Legacy.name)
        XCTAssertEqual(value("LEGACY_BUNDLE_ID"), Product.Legacy.bundleID)
        XCTAssertEqual(value("LEGACY_SUPPORT_FOLDER"), Product.Legacy.supportFolder)
    }

    func testTheInfoPlistHasTheNewIdentity() throws {
        let plist = try Repo.text("Resources/Info.plist")
        XCTAssertTrue(plist.contains("<key>CFBundleExecutable</key><string>Polycarp</string>"))
        XCTAssertTrue(plist.contains("<key>CFBundleIdentifier</key><string>com.baney.polycarp</string>"))
        XCTAssertTrue(plist.contains("<key>CFBundleName</key><string>Polycarp</string>"))
        XCTAssertTrue(plist.contains("<key>CFBundleDisplayName</key><string>Polycarp</string>"))
        XCTAssertFalse(plist.contains("com.baney.baneyspaces"))
    }

    func testTheReleaseRequirementNamesTheAppsIdentifier() throws {
        let req = try Repo.text("scripts/release-requirement.txt")
        XCTAssertTrue(req.hasPrefix("identifier \"\(Product.bundleID)\" and certificate leaf = H\""), req)
    }
}

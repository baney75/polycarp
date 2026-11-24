import XCTest
@testable import BaneySpacesCore

/// `polycarp-spaces skill install` against a made-up home folder (spec cases C1 to C5): the skill goes to
/// ~/.claude/skills/polycarp-spaces, and the old `baneyspaces` copy goes only when it is the product's own.
final class SkillInstallTests: XCTestCase {
    private let fm = FileManager.default
    private var home: URL!
    private let bundle = "---\nname: polycarp-spaces\ndescription: test\n---\n\n# Body\n"

    override func setUpWithError() throws {
        home = fm.temporaryDirectory.appendingPathComponent("bs-skill-\(UUID().uuidString)").resolvingSymlinksInPath()
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? fm.removeItem(at: home) }

    private func path(_ p: String) -> URL { home.appendingPathComponent(p) }

    private func write(_ p: String, _ text: String) throws {
        try fm.createDirectory(at: path(p).deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: path(p), atomically: true, encoding: .utf8)
    }

    private func read(_ p: String) throws -> String { try String(contentsOf: path(p), encoding: .utf8) }

    private func exists(_ p: String) -> Bool { (try? fm.attributesOfItem(atPath: path(p).path)) != nil }

    private func install(_ text: String?) -> String { SkillInstall.install(bundle: text.map { Data($0.utf8) }, home: home) }

    private let newSkill = ".claude/skills/polycarp-spaces/SKILL.md"
    private let oldDir = ".claude/skills/baneyspaces"

    // C1
    func testAnEmptyHomeGetsTheSkillUnderTheNewName() throws {
        let out = install(bundle)
        XCTAssertEqual(try read(newSkill), bundle)
        XCTAssertFalse(exists(oldDir))
        XCTAssertEqual(out, "installed \(path(newSkill).path)")
    }

    // C2
    func testTheProductsOldCopyIsRemovedAfterTheWrite() throws {
        try write("\(oldDir)/SKILL.md", "---\nname: baneyspaces\ndescription: old\n---\n\n# BaneySpaces\n")
        let out = install(bundle)
        XCTAssertEqual(try read(newSkill), bundle)
        XCTAssertFalse(exists(oldDir), "the product's old copy is still there")
        XCTAssertEqual(out, "installed \(path(newSkill).path)\nremoved \(path(oldDir).path)")
    }

    // R-K2: the product's text, but with a file the user added beside it: the folder stays.
    func testAnOldCopyWithTheUsersOwnFilesBesideItIsKept() throws {
        try write("\(oldDir)/SKILL.md", "---\nname: baneyspaces\n---\n")
        try write("\(oldDir)/notes.md", "mine")
        let out = install(bundle)
        XCTAssertEqual(try read(newSkill), bundle)
        XCTAssertEqual(try read("\(oldDir)/notes.md"), "mine")
        XCTAssertFalse(out.contains("removed"), out)
    }

    // C3
    func testAnOldDirUnderAnotherNameIsKept() throws {
        try write("\(oldDir)/SKILL.md", "---\nname: something-else\n---\n")
        let out = install(bundle)
        XCTAssertEqual(try read(newSkill), bundle)
        XCTAssertEqual(try read("\(oldDir)/SKILL.md"), "---\nname: something-else\n---\n")
        XCTAssertFalse(out.contains("removed"), out)
    }

    // R3: no SKILL.md in the old dir, or the old dir a symlink: left alone.
    func testAnOldDirWithoutSkillOrALinkedOneIsKept() throws {
        try write("\(oldDir)/notes.txt", "mine")
        _ = install(bundle)
        XCTAssertEqual(try read("\(oldDir)/notes.txt"), "mine")

        try fm.removeItem(at: path(oldDir))
        try write("dotfiles/skill/SKILL.md", "---\nname: baneyspaces\n---\n")
        try fm.createSymbolicLink(at: path(oldDir), withDestinationURL: path("dotfiles/skill"))
        let out = install(bundle)
        XCTAssertNotNil(try? fm.destinationOfSymbolicLink(atPath: path(oldDir).path), "the linked dir was removed")
        XCTAssertEqual(try read("dotfiles/skill/SKILL.md"), "---\nname: baneyspaces\n---\n")
        XCTAssertFalse(out.contains("removed"), out)
    }

    // C4
    func testAnyTextAtTheNewPathIsReplaced() throws {
        try write(newSkill, "a stale hand copy\n")
        _ = install(bundle)
        XCTAssertEqual(try read(newSkill), bundle)
    }

    // C5
    func testAMissingBundleWritesAndRemovesNothing() throws {
        try write("\(oldDir)/SKILL.md", "---\nname: baneyspaces\n---\n")
        let out = install(nil)
        XCTAssertEqual(out, "couldn't find SKILL.md beside the binary; install Polycarp with make install")
        XCTAssertEqual(try read("\(oldDir)/SKILL.md"), "---\nname: baneyspaces\n---\n")
        XCTAssertFalse(exists(newSkill))
    }

    // R3: a failed write removes nothing.
    func testAFailedWriteRemovesNothing() throws {
        try write("\(oldDir)/SKILL.md", "---\nname: baneyspaces\n---\n")
        // A file where the new skill's folder goes: the write can't happen.
        try write(".claude/skills/polycarp-spaces", "in the way")
        let out = install(bundle)
        XCTAssertTrue(out.hasPrefix("couldn't write "), out)
        XCTAssertTrue(exists("\(oldDir)/SKILL.md"))
    }

    // The R3 decision on its own.
    func testOnlyTheProductsOwnFrontmatterCountsAsTheOldCopy() {
        XCTAssertTrue(SkillInstall.isOldProductCopy("---\nname: baneyspaces\ndescription: x\n---\nbody\n"))
        XCTAssertTrue(SkillInstall.isOldProductCopy("---\r\nname: baneyspaces\r\n---\r\n"))
        XCTAssertTrue(SkillInstall.isOldProductCopy("---\nname:baneyspaces  \n---\n"))
        XCTAssertFalse(SkillInstall.isOldProductCopy("---\nname: something-else\n---\n"))
        XCTAssertFalse(SkillInstall.isOldProductCopy("---\nname: polycarp-spaces\n---\n"))
        XCTAssertFalse(SkillInstall.isOldProductCopy("---\nname: baneyspaces-fork\n---\n"))
        XCTAssertFalse(SkillInstall.isOldProductCopy("---\nname: \"baneyspaces\"\n---\n"))
        XCTAssertFalse(SkillInstall.isOldProductCopy("name: baneyspaces\n"), "no frontmatter")
        XCTAssertFalse(SkillInstall.isOldProductCopy("---\ndescription: x\n---\nname: baneyspaces\n"), "after the frontmatter")
        XCTAssertFalse(SkillInstall.isOldProductCopy(""))
    }

    // R1: the bundled skill carries the new name.
    func testTheBundledSkillIsNamedPolycarpSpaces() throws {
        let skill = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("skill/SKILL.md")
        let lines = try String(contentsOf: skill, encoding: .utf8).split(separator: "\n").prefix(3)
        XCTAssertEqual(Array(lines.prefix(2)), ["---", "name: polycarp-spaces"])
    }
}
